-- ============================================================================
-- GENERATED FILE — do not hand-edit.
-- The `tc` cloud Team Collections schema is maintained declaratively in
-- supabase/schemas/tc/*.sql (see [db.migrations].schema_paths in config.toml).
-- This migration is their concatenation, in dependency order, and is what
-- `supabase db reset`/`db push` actually run.
--
-- We concatenate rather than use `supabase db diff` to build this initial
-- migration because the diff tools (pg-schema-diff and migra) silently drop
-- COMMENT ON statements and every GRANT EXECUTE ON FUNCTION — which would
-- leave the RPCs uncallable and the schema undocumented. Concatenation is
-- lossless. Regenerate with: team-collections/regen-init-migration.sh
-- ============================================================================


-- ==== 01_schema.sql ====

-- Team Collections cloud schemas + enum types.
-- Declarative source of truth (see CONTRACTS.md, "Database: declarative schema"): edit these
-- files, then run team-collections/regen-init-migration.sh. Applied in file order.
--
-- `tc` holds everything that belongs to Team Collections. `core` holds what is about a person
-- rather than a collection (core.users); it is not exposed through PostgREST, and only
-- SECURITY DEFINER functions in `tc` reach it.
CREATE SCHEMA IF NOT EXISTS core;

CREATE SCHEMA IF NOT EXISTS tc;

CREATE TYPE tc.member_role AS ENUM (
    'admin',
    'member'
);


-- ==== 02_functions.sql ====

-- Team Collections cloud: all functions (RPCs, transaction `_tx` helpers,
-- trigger functions, and internal helpers). Created before the tables they
-- reference, so body validation is deferred here (Postgres late-binds plpgsql;
-- this SET covers the LANGUAGE sql functions too).
--
-- Conventions:
--   - A book is named by (collection_id, instance_id) in every RPC; tc.books.id is internal.
--   - A person is a core.users.id (uuid). tc.current_user_id() maps the JWT sub to it, and is
--     NULL for someone with no user row, who is then a member of nothing.
--   - Lock order in the check-in functions: the check-in attempt row, then the book row.
set check_function_bodies = false;
CREATE OR REPLACE FUNCTION tc._checkin_reap_book(p_book_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_new_book boolean;
    v_book     tc.books%ROWTYPE;
    v_released integer;
BEGIN
    -- Lock order is attempt rows, then book row, as in checkin_start_tx, checkin_finish_tx
    -- and checkin_abort_tx: the updates below lock the book first and the attempts after, so
    -- without this a start/abort on the same book (holding its attempt row and waiting for
    -- the book) and this sweep, run from another request, would deadlock.
    PERFORM 1 FROM tc.checkin_attempts
    WHERE book_id = p_book_id AND status = 'open' AND expires_at < now()
    ORDER BY id
    FOR UPDATE;

    SELECT * INTO v_book FROM tc.books WHERE id = p_book_id;

    IF NOT FOUND THEN
        RETURN;
    END IF;
    v_new_book := v_book.current_version IS NULL;

    -- A send-only lock (no checkout GUID) exists only for its check-in, so it goes when
    -- that check-in expires; otherwise nobody could release it without an admin.
    UPDATE tc.books b
    SET locked_by = NULL, locked_by_machine = NULL, locked_at = NULL
    WHERE b.id = p_book_id
      AND b.locked_by IS NOT NULL
      AND b.checkout_guid_hash IS NULL
      AND EXISTS (
          SELECT 1 FROM tc.checkin_attempts t
          WHERE t.book_id = p_book_id AND t.status = 'open' AND t.expires_at < now()
            AND t.started_by = b.locked_by AND t.checkout_guid_hash IS NULL
      )
      AND NOT EXISTS (
          SELECT 1 FROM tc.checkin_attempts t
          WHERE t.book_id = p_book_id AND t.started_by = b.locked_by
            AND t.status = 'open' AND t.expires_at >= now()
      );
    GET DIAGNOSTICS v_released = ROW_COUNT;

    -- A committed book's lock was visible to teammates: record its release (CheckOutReleased,
    -- type = 101, on behalf of the holder) so polling clients see it. A new book is invisible.
    IF v_released > 0 AND NOT v_new_book THEN
        INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name, message)
        VALUES (v_book.collection_id, v_book.id, 101, v_book.locked_by, v_book.name,
                'check-in expired');
    END IF;

    IF v_new_book THEN
        -- Deleting the book cascades its (expired, still-open) attempts.
        DELETE FROM tc.books
        WHERE id = p_book_id
          AND current_version IS NULL
          AND EXISTS (
              SELECT 1 FROM tc.checkin_attempts t
              WHERE t.book_id = p_book_id AND t.status = 'open' AND t.expires_at < now()
          )
          -- never reap while ANOTHER still-live open attempt exists
          AND NOT EXISTS (
              SELECT 1 FROM tc.checkin_attempts t
              WHERE t.book_id = p_book_id AND t.status = 'open' AND t.expires_at >= now()
          );
    ELSE
        UPDATE tc.checkin_attempts
        SET status = 'expired'
        WHERE book_id = p_book_id AND status = 'open' AND expires_at < now();
    END IF;
END;
$$;

COMMENT ON FUNCTION tc._checkin_reap_book(p_book_id uuid) IS 'Internal: reaps the expired open check-in attempts of one book. A send-only lock an expired check-in took (no checkout GUID) is released (with a CheckOutReleased event for a committed book); a real checkout is left untouched. A never-committed new book is then deleted outright; an existing book has the stale attempts marked expired.';

CREATE OR REPLACE FUNCTION tc._checkout_guid_hash(p_guid text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
    -- NULL in, NULL out, so a missing GUID never matches a stored hash.
    SELECT encode(sha256(convert_to(lower(p_guid), 'UTF8')), 'hex')
$$;

COMMENT ON FUNCTION tc._checkout_guid_hash(p_guid text) IS 'Internal: the stored form of a checkout GUID (tc.books.checkout_guid_hash): lowercase hex SHA-256 of the UTF-8 bytes of the GUID''s lowercase string form. Clients compute the same value to compare their .checkout file with checkoutGuidHash (CONTRACTS.md, "Checkout GUID").';

CREATE OR REPLACE FUNCTION tc._claim_current_user(p_name text, p_create boolean) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_sub   text := tc.current_authentication_id();
    v_email text := tc.current_user_email();
    v_name  text := NULLIF(btrim(p_name), '');
    v_id    uuid;
BEGIN
    IF v_sub IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT u.id INTO v_id FROM core.users u WHERE u.authentication_id = v_sub FOR UPDATE;

    IF NOT FOUND THEN
        -- Claiming an unclaimed user, or creating a row, gives the row the token's email, and
        -- users.email is unique: an unverified token must never take someone else's address.
        IF NOT tc.jwt_email_verified() OR v_email IS NULL THEN
            RAISE EXCEPTION 'email_not_verified: a verified email is required' USING ERRCODE = '28000';
        END IF;

        FOR i IN 1..2 LOOP
            -- An unclaimed user with this email (a carried-over checkout's holder) becomes
            -- this person, so the checkouts are already theirs.
            UPDATE core.users u
            SET    authentication_id = v_sub
            WHERE  u.email = v_email AND u.authentication_id IS NULL
            RETURNING u.id INTO v_id;
            EXIT WHEN v_id IS NOT NULL;

            IF NOT p_create AND NOT EXISTS (
                SELECT 1 FROM tc.members m WHERE m.email = v_email AND m.user_id IS NULL
            ) THEN
                -- Nothing to join: no row is needed.
                RETURN NULL;
            END IF;

            INSERT INTO core.users (authentication_id, email)
            VALUES (v_sub, v_email)
            ON CONFLICT DO NOTHING
            RETURNING id INTO v_id;
            EXIT WHEN v_id IS NOT NULL;

            -- A concurrent call for this login made the row first, or the email belongs to
            -- another row: a claimed one (another login), or an unclaimed one made meanwhile,
            -- which the second pass claims.
            SELECT u.id INTO v_id FROM core.users u WHERE u.authentication_id = v_sub;
            EXIT WHEN v_id IS NOT NULL;
        END LOOP;

        IF v_id IS NULL THEN
            RAISE EXCEPTION 'email_in_use: % belongs to another login', v_email
                USING ERRCODE = 'P0001';
        END IF;
    END IF;

    -- The token's verified email is the person's current one, unless another row already has
    -- it (settling that is a support task); the name is kept when none is sent.
    UPDATE core.users u
    SET    email = CASE
                       WHEN v_email IS NOT NULL AND tc.jwt_email_verified()
                            AND NOT EXISTS (SELECT 1 FROM core.users o
                                            WHERE o.email = v_email AND o.id <> u.id)
                           THEN v_email
                       ELSE u.email
                   END,
           name  = COALESCE(v_name, u.name)
    WHERE  u.id = v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION tc._claim_current_user(p_name text, p_create boolean) IS 'Internal (claim_memberships, create_collection): returns the caller''s core.users.id, creating or claiming the row if needed. A row found by the JWT sub gets its email refreshed from the verified token (unless another row has that email) and, when p_name is given, its name. Otherwise, with a verified email (else 28000 email_not_verified): claims the unclaimed user with that email; or, when p_create or an invitation to that email exists, creates a row; or returns NULL (nothing to join). An email already used by another login raises P0001 email_in_use.';

CREATE OR REPLACE FUNCTION tc._clear_checkout_on_unlock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.locked_by IS NULL THEN
        NEW.checkout_guid_hash := NULL;
    ELSIF NEW.locked_by IS DISTINCT FROM OLD.locked_by
          AND NEW.checkout_guid_hash IS NOT DISTINCT FROM OLD.checkout_guid_hash
          AND NOT (OLD.locked_by IS NOT NULL
                   AND current_setting('tc.checkout_takeover', true) = 'on') THEN
        -- The lock changed hands without the new holder being issued a GUID: the old
        -- holder's GUID must not survive. The one deliberate exception is
        -- checkout_book_takeover, which hands the same GUID to the new account.
        NEW.checkout_guid_hash := NULL;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tc._clear_checkout_on_unlock() IS 'Internal: clears tc.books.checkout_guid_hash whenever locked_by is cleared (and whenever the lock changes hands without a new GUID being set, except in checkout_book_takeover, which keeps the GUID on purpose), so every unlock path (unlock_book, force_unlock, members_remove, checkin_finish_tx, future ones) stays consistent without each having to remember the column.';

CREATE OR REPLACE FUNCTION tc._event_order_lock_key(p_collection_id uuid) RETURNS bigint
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT hashtextextended('tc.history_events:' || p_collection_id::text, 0)
$$;

COMMENT ON FUNCTION tc._event_order_lock_key(p_collection_id uuid) IS 'Internal: the transaction-scoped advisory lock key that orders a collection''s event ids against its cursor readers. Every event insert holds it SHARED until commit (tc._history_events_assign_id); get_changes and get_collection_state take it EXCLUSIVE before reading, so they never return a cursor (max_event_id) past an id whose transaction has not committed yet.';

CREATE OR REPLACE FUNCTION tc._history_events_assign_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.id IS NOT NULL THEN
        RAISE EXCEPTION 'tc.history_events.id is assigned by the history_events_assign_id_tg trigger'
            USING ERRCODE = '428C9';
    END IF;
    -- Shared, so writers never wait for one another; held until commit, so a cursor reader
    -- (which takes it exclusive) waits for this event's transaction to finish, and no id is
    -- handed out while the reader reads. Without this, an event whose transaction commits
    -- after one with a higher id could be skipped for good: a poll between the two commits
    -- would return the higher id as the cursor.
    PERFORM pg_advisory_xact_lock_shared(tc._event_order_lock_key(NEW.collection_id));
    NEW.id := nextval('tc.history_events_id_seq');
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tc._history_events_assign_id() IS 'Trigger function (BEFORE INSERT on tc.history_events): assigns the event id from tc.history_events_id_seq only after taking the collection''s event-order lock (tc._event_order_lock_key) SHARED, so get_changes/get_collection_state, which take it exclusive, see every id below their cursor committed (or rolled back). An explicitly supplied id is refused (428C9).';

CREATE OR REPLACE FUNCTION tc._lock_holder_json(p_user_id uuid, p_machine text, p_locked_at timestamp with time zone) RETURNS json
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT CASE WHEN p_user_id IS NULL THEN NULL ELSE json_build_object(
        'userId',   p_user_id,
        'name',     (SELECT u.name FROM core.users u WHERE u.id = p_user_id),
        'email',    (SELECT u.email FROM core.users u WHERE u.id = p_user_id),
        'machine',  p_machine,
        'lockedAt', p_locked_at
    ) END
$$;

COMMENT ON FUNCTION tc._lock_holder_json(p_user_id uuid, p_machine text, p_locked_at timestamp with time zone) IS 'Internal: the "holder" object of a LockHeldByOther error: {userId, name, email, machine, lockedAt}, or NULL when nobody holds the lock.';

CREATE OR REPLACE FUNCTION tc._normalize_email(p_email text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT lower(normalize(btrim(p_email), NFC))
$$;

COMMENT ON FUNCTION tc._normalize_email(p_email text) IS 'Internal: the stored form of an email address (core.users.email, tc.members.email): trimmed, NFC-normalized and lowercased. NULL in, NULL out.';

CREATE OR REPLACE FUNCTION tc._normalize_proposed_files(p_files jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_out  jsonb;
    v_bad  jsonb;
    v_dups jsonb;
BEGIN
    IF p_files IS NULL OR jsonb_typeof(p_files) <> 'array' THEN
        RAISE EXCEPTION '%', json_build_object('error', 'InvalidManifest',
            'detail', 'files must be an array')::text USING ERRCODE = 'PT400';
    END IF;

    -- Every entry needs a usable relative path, a sha256 and a non-negative size.
    SELECT jsonb_agg(e) INTO v_bad
    FROM jsonb_array_elements(p_files) e
    WHERE jsonb_typeof(e) <> 'object'
       OR jsonb_typeof(e->'path') IS DISTINCT FROM 'string'
       OR e->>'path' = ''
       OR left(e->>'path', 1) = '/'
       OR EXISTS (SELECT 1 FROM unnest(string_to_array(e->>'path', '/')) seg
                  WHERE seg IN ('', '.', '..'))
       OR jsonb_typeof(e->'sha256') IS DISTINCT FROM 'string'
       OR e->>'sha256' = ''
       OR CASE WHEN jsonb_typeof(e->'size') = 'number'
               THEN (e->>'size')::numeric < 0
                    OR (e->>'size')::numeric <> trunc((e->>'size')::numeric)
                    -- the size columns are bigint
                    OR (e->>'size')::numeric > 9223372036854775807
               ELSE true END;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION '%', json_build_object('error', 'InvalidManifest',
            'detail', 'bad file entries', 'entries', v_bad)::text USING ERRCODE = 'PT400';
    END IF;

    -- Sorted by path, so two starts proposing the same files in a different order store the
    -- same manifest (a start resumes an open attempt only if its proposal is identical).
    SELECT jsonb_agg(jsonb_build_object(
               'path',   normalize(e->>'path', NFC),
               'sha256', e->>'sha256',
               'size',   (e->>'size')::bigint
           ) ORDER BY normalize(e->>'path', NFC) COLLATE "C")
    INTO v_out
    FROM jsonb_array_elements(p_files) e;

    -- Two spellings of one name (or a plain duplicate) would collapse onto one S3 key.
    SELECT jsonb_agg(d.p ORDER BY d.p) INTO v_dups
    FROM (
        SELECT e->>'path' AS p
        FROM jsonb_array_elements(COALESCE(v_out, '[]'::jsonb)) e
        GROUP BY e->>'path'
        HAVING count(*) > 1
    ) d;
    IF v_dups IS NOT NULL THEN
        RAISE EXCEPTION '%', json_build_object('error', 'InvalidManifest',
            'detail', 'duplicate paths after NFC normalization', 'paths', v_dups)::text
            USING ERRCODE = 'PT400';
    END IF;

    RETURN COALESCE(v_out, '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION tc._normalize_proposed_files(p_files jsonb) IS 'Internal: validates a proposed manifest [{path, sha256, size}] and returns it with every path NFC-normalized, sorted by path (byte order). Raises PT400 InvalidManifest for a non-array, an entry lacking a relative path (empty, leading "/", or an empty/"."/".." segment), sha256 or non-negative size, or two entries whose paths are equal after normalization. Used by both start RPCs so the diff, the stored attempt, changedPaths and the committed manifest agree on each path''s spelling.';

CREATE OR REPLACE FUNCTION tc._touch_member(p_collection_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- The caller's row is keyed the way tc.is_member keys it: (collection_id, user_id),
    -- unique by members_claimed_user_uq. The 10-minute throttle keeps a 60-second poller to
    -- about one row write per member per 10 minutes; any other call is an index lookup that
    -- writes nothing.
    UPDATE tc.members
    SET    last_seen_at = now()
    WHERE  collection_id = p_collection_id
      AND  user_id       = tc.current_user_id()
      AND  (last_seen_at IS NULL OR last_seen_at < now() - interval '10 minutes');
END;
$$;

COMMENT ON FUNCTION tc._touch_member(p_collection_id uuid) IS 'Internal: records that the caller had the collection open, setting their own tc.members.last_seen_at in that collection to now() unless it is already less than 10 minutes old. Called by get_collection_state and get_changes after their membership check. Touches only that one row: emits no history event and no realtime broadcast (the only trigger on tc.members, the last-admin guard, returns at once for an update that leaves role alone). Not callable by clients.';

CREATE OR REPLACE FUNCTION tc.add_palette_colors(p_collection_id uuid, p_palette text, p_colors text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
    v_color   text;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    FOREACH v_color IN ARRAY p_colors LOOP
        INSERT INTO tc.color_palette_entries (collection_id, palette, color, added_by)
        VALUES (p_collection_id, p_palette, v_color, v_user_id)
        ON CONFLICT (collection_id, palette, color) DO NOTHING;
    END LOOP;
END;
$$;

COMMENT ON FUNCTION tc.add_palette_colors(p_collection_id uuid, p_palette text, p_colors text[]) IS 'CONTRACTS.md: add_palette_colors — union merge; insert-on-conflict-do-nothing. Any member may call.';

CREATE OR REPLACE FUNCTION tc.checkin_abort_tx(p_transaction_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid := tc.current_user_id();
    v_tx      tc.checkin_attempts%ROWTYPE;
BEGIN
    IF tc.current_authentication_id() IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;

    -- No global reap here (checkin_start_tx and collection_files_start_tx do it): run first,
    -- it could delete this very attempt along with its never-finished book and turn a
    -- successful abort into a 404; run while holding this row's lock, two concurrent aborts
    -- could deadlock on each other's rows.

    -- FOR UPDATE, like checkin_finish_tx (which also locks this row first): abort and a
    -- concurrent finish then take turns, and whichever runs second sees the other's final
    -- status instead of overwriting a just-finished attempt with 'aborted'.
    SELECT * INTO v_tx FROM tc.checkin_attempts WHERE id = p_transaction_id FOR UPDATE;
    IF NOT FOUND THEN
        -- Nothing (any longer) to abort. Aborting a never-committed new book deletes the book,
        -- and with it this very row, so a retry after a lost response lands here and must
        -- succeed like any other repeat abort. It reveals nothing about anyone's attempts.
        RETURN;
    END IF;
    IF v_tx.started_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION '%', '{"error":"forbidden"}' USING ERRCODE = 'PT403';
    END IF;

    IF v_tx.status = 'aborted' THEN
        RETURN; -- idempotent
    END IF;
    IF v_tx.status = 'finished' THEN
        RAISE EXCEPTION '%', '{"error":"already_finished"}' USING ERRCODE = 'PT409';
    END IF;

    UPDATE tc.checkin_attempts SET status = 'aborted'
    WHERE id = p_transaction_id;

    -- Roll back a never-finished new book entirely (fully invisible, as designed).
    -- Existing books keep a real checkout (one with a GUID) — aborting a Send is not
    -- the same as releasing a Checkout.
    PERFORM 1 FROM tc.books WHERE id = v_tx.book_id AND current_version IS NULL;
    IF FOUND AND NOT EXISTS (
        SELECT 1 FROM tc.checkin_attempts
        WHERE book_id = v_tx.book_id AND status = 'open'
    ) THEN
        DELETE FROM tc.books WHERE id = v_tx.book_id AND current_version IS NULL;
    END IF;

    -- A send-only lock (start took the free book, with no checkout GUID) exists only for
    -- this check-in, so it goes with it; a real checkout stays.
    IF v_tx.checkout_guid_hash IS NULL THEN
        -- A committed book's lock was visible to teammates, so its release is recorded
        -- (CheckOutReleased, type = 101) for polling clients to see; a new book is invisible.
        WITH released AS (
            UPDATE tc.books
            SET locked_by = NULL, locked_by_machine = NULL, locked_at = NULL
            WHERE id = v_tx.book_id
              AND locked_by = v_user_id
              AND checkout_guid_hash IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM tc.checkin_attempts
                  WHERE book_id = v_tx.book_id AND started_by = v_user_id AND status = 'open'
              )
            RETURNING id, collection_id, name, current_version
        )
        INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
        SELECT r.collection_id, r.id, 101, v_user_id, r.name
        FROM released r
        WHERE r.current_version IS NOT NULL;
    END IF;
END;
$$;

COMMENT ON FUNCTION tc.checkin_abort_tx(p_transaction_id uuid) IS 'Internal to the checkin-abort edge function. Idempotent, including for an attempt id that no longer exists (e.g. removed with the new book a first abort rolled back): that is a no-op success, not 404. Someone else''s attempt is PT403. Rolls back a never-finished new book entirely; releases an existing book''s send-only lock (taken by checkin-start with no checkout GUID), with a CheckOutReleased event; leaves a real checkout untouched.';

CREATE OR REPLACE FUNCTION tc.checkin_finish_tx(p_transaction_id uuid, p_user_id uuid, p_comment text, p_keep_checked_out boolean, p_captured jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
-- Service-role only (see 04_security.sql and the checkin-finish edge function). The
-- caller is p_user_id, which the edge function established from the caller's own JWT
-- via tc.current_caller(); auth.jwt() here is the service role and is never consulted.
DECLARE
    v_user_id     uuid := p_user_id;
    v_tx          tc.checkin_attempts%ROWTYPE;
    v_book        tc.books%ROWTYPE;
    v_missing     text[];
    v_final       jsonb;
    v_was_new     boolean;
    v_keep        boolean;   -- keep the lock (keepCheckedOut on a real checkout)
    v_new_version bigint;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;

    -- FOR UPDATE: a concurrent retry of the same finish waits here until the first
    -- commits, then sees status = 'finished' and returns that result (idempotent),
    -- instead of racing it to the same version. A checkin-start that resumes or aborts
    -- this attempt locks it too, so it runs wholly before or after this finish.
    SELECT * INTO v_tx FROM tc.checkin_attempts WHERE id = p_transaction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '%', '{"error":"transaction_not_found"}' USING ERRCODE = 'PT404';
    END IF;
    IF v_tx.started_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION '%', '{"error":"forbidden"}' USING ERRCODE = 'PT403';
    END IF;
    -- Membership can have been revoked since start.
    IF NOT EXISTS (
        SELECT 1 FROM tc.members m
        WHERE m.collection_id = v_tx.collection_id AND m.user_id = v_user_id
    ) THEN
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;

    IF v_tx.status = 'finished' THEN
        -- Idempotent retry: return the previously-committed result unchanged.
        RETURN jsonb_build_object('version', v_tx.resulting_book_version);
    END IF;

    -- A newer checkin-start replaced this attempt: the newer Send carries on.
    IF v_tx.status = 'aborted' THEN
        RAISE EXCEPTION '%', '{"error":"transaction_aborted"}' USING ERRCODE = 'PT409';
    END IF;

    -- (No status update here: raising would roll it back. The expiry time alone refuses
    -- the call, and reap_expired_checkin_attempts marks the row later.)
    IF v_tx.status = 'expired' OR v_tx.expires_at < now() THEN
        RAISE EXCEPTION '%', '{"error":"TransactionExpired"}' USING ERRCODE = 'PT410';
    END IF;

    -- ---- Re-check, under a row lock, what start checked: the caller still holds the
    --      book's lock, and the book is still at the version this attempt was based on.
    --      Otherwise (e.g. an admin force-unlocked the book and someone else checked in
    --      meanwhile) committing would overwrite newer work and could clear the other
    --      person's lock. base_book_version is the book's current version as start saw it
    --      (NULL for a new book's first commit, which then requires the book still to
    --      have no version). ------------------------------------------------------
    SELECT * INTO v_book FROM tc.books WHERE id = v_tx.book_id FOR UPDATE;
    -- Deleted since start: committing would add a version nobody can see.
    IF v_book.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION '%', '{"error":"book_not_found"}' USING ERRCODE = 'PT404';
    END IF;
    IF v_book.locked_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION '%', json_build_object(
            'error', 'LockHeldByOther',
            'holder', tc._lock_holder_json(v_book.locked_by, v_book.locked_by_machine, v_book.locked_at)
        )::text USING ERRCODE = 'PT409';
    END IF;
    -- The caller must also still hold the checkout that start saw: if it moved to another
    -- copy meanwhile (released and checked out again elsewhere), this copy's upload must
    -- not be committed. A send-only lock (start took a free book or created a new one)
    -- has no hash, and must still have none.
    IF v_book.checkout_guid_hash IS DISTINCT FROM v_tx.checkout_guid_hash THEN
        RAISE EXCEPTION '%', '{"error":"CheckoutElsewhere"}' USING ERRCODE = 'PT409';
    END IF;
    IF v_book.current_version IS DISTINCT FROM v_tx.base_book_version THEN
        RAISE EXCEPTION '%', json_build_object(
            'error', 'BaseVersionSuperseded',
            'currentVersion', v_book.current_version
        )::text USING ERRCODE = 'PT409';
    END IF;

    -- ---- Verify every changed path was captured (uploaded + checksum-verified
    --      by the edge function before calling us) -------------------------
    SELECT COALESCE(array_agg(cp), '{}') INTO v_missing
    FROM unnest(v_tx.changed_paths) cp
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(p_captured) AS c(path text, "s3VersionId" text)
        WHERE c.path = cp AND c."s3VersionId" IS NOT NULL
    );

    IF array_length(v_missing, 1) > 0 THEN
        -- The attempt stays OPEN so the client can re-upload and retry.
        RAISE EXCEPTION '%', json_build_object(
            'error', 'MissingOrBadUploads', 'paths', to_jsonb(v_missing)
        )::text USING ERRCODE = 'PT409';
    END IF;

    -- ---- Build the final manifest: proposed_files, with s3_version_id from
    --      p_captured for changed paths and from the book's current files for
    --      everything else. ---------------------------------------------------
    SELECT jsonb_agg(jsonb_build_object(
               'path', f.path,
               'sha256', f.sha256,
               'size', f.size,
               's3VersionId', COALESCE(
                   (SELECT c."s3VersionId" FROM jsonb_to_recordset(p_captured) AS c(path text, "s3VersionId" text)
                    WHERE c.path = f.path),
                   (SELECT bf.s3_version_id FROM tc.book_files bf
                    WHERE bf.book_id = v_tx.book_id AND bf.path = f.path)
               )
           ))
    INTO v_final
    FROM jsonb_to_recordset(v_tx.proposed_files) AS f(path text, sha256 text, size bigint);

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE(v_final, '[]'::jsonb)) e
        WHERE e->>'s3VersionId' IS NULL
    ) THEN
        -- Defensive: a path was neither captured now nor among the book's current files.
        RAISE EXCEPTION '%', json_build_object('error', 'MissingOrBadUploads',
            'paths', (SELECT jsonb_agg(e->>'path') FROM jsonb_array_elements(v_final) e
                      WHERE e->>'s3VersionId' IS NULL))::text
            USING ERRCODE = 'PT409';
    END IF;

    v_was_new := v_book.current_version IS NULL;
    -- keepCheckedOut keeps only a real checkout (one with a GUID). A send-only lock is
    -- always released: keeping it would leave the book locked with no GUID for any copy to
    -- check in, unlock or delete with.
    v_keep := p_keep_checked_out AND v_tx.checkout_guid_hash IS NOT NULL;
    v_new_version := COALESCE(v_book.current_version, 0) + 1;

    DELETE FROM tc.book_files WHERE book_id = v_tx.book_id;

    INSERT INTO tc.book_files (book_id, path, sha256, size_bytes, s3_version_id)
    SELECT v_tx.book_id, e->>'path', e->>'sha256', (e->>'size')::bigint, e->>'s3VersionId'
    FROM jsonb_array_elements(COALESCE(v_final, '[]'::jsonb)) e;

    UPDATE tc.books
    SET current_version = v_new_version,
        current_checksum = v_tx.checksum,
        name = v_tx.proposed_name,
        -- keepCheckedOut keeps the checkout GUID as well; releasing the lock clears it
        -- (books_clear_checkout_on_unlock).
        locked_by = CASE WHEN v_keep THEN locked_by ELSE NULL END,
        locked_by_machine = CASE WHEN v_keep THEN locked_by_machine ELSE NULL END,
        locked_at = CASE WHEN v_keep THEN locked_at ELSE NULL END
    WHERE id = v_tx.book_id AND locked_by = v_user_id;

    IF v_was_new THEN
        INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_version, book_name, bloom_version)
        VALUES (v_tx.collection_id, v_tx.book_id, 2, v_user_id, v_new_version, v_tx.proposed_name, v_tx.client_version);
    END IF;

    INSERT INTO tc.history_events (
        collection_id, book_id, type, by_user_id,
        book_version, book_name, message, bloom_version
    )
    VALUES (
        v_tx.collection_id, v_tx.book_id, 1, v_user_id,
        v_new_version, v_tx.proposed_name, p_comment, v_tx.client_version
    );

    UPDATE tc.checkin_attempts
    SET status = 'finished', resulting_book_version = v_new_version
    WHERE id = p_transaction_id;

    -- 'manifest' is NOT part of the CONTRACTS.md response ({version} only) — it is extra
    -- data for the edge function's own use (writing the manifest backups to S3); the edge
    -- function must not forward it to the client.
    RETURN jsonb_build_object('version', v_new_version, 'manifest', v_final);
END;
$$;

COMMENT ON FUNCTION tc.checkin_finish_tx(p_transaction_id uuid, p_user_id uuid, p_comment text, p_keep_checked_out boolean, p_captured jsonb) IS 'Internal to the checkin-finish edge function; service-role only, because it trusts p_captured (S3 version-ids the edge function verified). p_user_id identifies the caller, established by the edge function from the caller''s own JWT (tc.current_caller). Locks the attempt and book rows, re-checks that the caller started the attempt, is still a member, still holds the book''s lock under the same checkout GUID (NULL for a send-only lock, which must still be NULL), and that the book is still at the attempt''s base version. Single atomic DB transaction: the book''s next version number, replacement of its book_files, book update, lock release (which clears the checkout GUID; keepCheckedOut keeps both, but only for a real checkout: a send-only lock is always released), history events (Created and CheckIn for a new book), attempt close. Returns {version, manifest}. Idempotent when re-called (even concurrently) on an already-finished attempt. Raises PT401/PT403/PT404/PT409 (transaction_aborted, LockHeldByOther, CheckoutElsewhere, BaseVersionSuperseded, MissingOrBadUploads)/PT410 (expired).';

CREATE OR REPLACE FUNCTION tc.checkin_start_tx(p_collection_id uuid, p_instance_id uuid, p_proposed_name text, p_base_version bigint, p_checksum text, p_client_version text, p_files jsonb, p_checkout_guid text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id   uuid := tc.current_user_id();
    v_name      text := normalize(p_proposed_name, NFC);
    v_book_id   uuid;
    v_book      tc.books%ROWTYPE;
    v_created   boolean := false;   -- this call created the (new) book's row
    v_files     jsonb;
    v_changed   text[];
    v_existing  tc.checkin_attempts%ROWTYPE;
    v_tx_id     uuid;
BEGIN
    IF tc.current_authentication_id() IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;

    IF NOT tc.is_client_version_supported(p_client_version) THEN
        RAISE EXCEPTION '%', json_build_object(
            'error', 'ClientOutOfDate',
            'minVersion', tc.min_supported_client_version()
        )::text USING ERRCODE = 'PT426';
    END IF;

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;

    -- NFC-normalize (and validate) the proposed manifest up front, so the diff, the
    -- stored attempt, the returned changedPaths (the S3 keys the client uploads to) and
    -- the committed manifest all use the same spelling of every path.
    v_files := tc._normalize_proposed_files(p_files);

    PERFORM tc.reap_expired_checkin_attempts();

    -- ---- Find the book, or create a new book's row -----------------------------------
    -- Lock order is attempt row, then book row, as in checkin_finish_tx and checkin_abort_tx,
    -- so a re-sent start racing this user's own finish waits instead of deadlocking. The
    -- open attempt is locked BEFORE it is compared below, so a finish of it either commits
    -- first (and this start no longer finds it open) or finds it resumed as it was, or
    -- aborted. The loop only repeats if the row appears or vanishes under us (a concurrent
    -- first check-in, or an abort deleting a never-committed book).
    FOR i IN 1..3 LOOP
        v_existing := NULL;
        SELECT b.id INTO v_book_id FROM tc.books b
        WHERE b.collection_id = p_collection_id AND b.instance_id = p_instance_id;

        IF FOUND THEN
            SELECT * INTO v_existing FROM tc.checkin_attempts
            WHERE book_id = v_book_id AND started_by = v_user_id AND status = 'open'
            FOR UPDATE;

            SELECT * INTO v_book FROM tc.books WHERE id = v_book_id FOR UPDATE;
            EXIT WHEN FOUND;
        ELSE
            -- A first check-in is a send, not a checkout: the row is locked to the sender with
            -- no checkout GUID, and stays invisible to teammates until it commits.
            INSERT INTO tc.books (collection_id, instance_id, name, locked_by, locked_at)
            VALUES (p_collection_id, p_instance_id, v_name, v_user_id, now())
            ON CONFLICT (collection_id, instance_id) DO NOTHING
            RETURNING * INTO v_book;
            IF FOUND THEN
                v_created := true;
                EXIT;
            END IF;
        END IF;
    END LOOP;

    IF v_book.id IS NULL THEN
        RAISE EXCEPTION 'checkin_start_tx: the book row kept changing; try again'
            USING ERRCODE = '40001';
    END IF;

    IF NOT v_created THEN
        -- A deleted book (tombstone) is not there to check in to: finishing would add a
        -- version nobody can see.
        IF v_book.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION '%', '{"error":"book_not_found"}' USING ERRCODE = 'PT404';
        END IF;

        IF v_book.locked_by IS NOT NULL AND v_book.locked_by <> v_user_id THEN
            RAISE EXCEPTION '%', json_build_object(
                'error', 'LockHeldByOther',
                'holder', tc._lock_holder_json(v_book.locked_by, v_book.locked_by_machine, v_book.locked_at)
            )::text USING ERRCODE = 'PT409';
        END IF;

        -- Our own lock on a committed book: only the copy holding the current checkout GUID
        -- may check in. The caller holds the book in another copy (moved, duplicated, another
        -- computer's) otherwise. A send-only lock (an unfinished check-in of ours that took
        -- the book while it was free) has no GUID and is resumed by sending none (a NULL hash
        -- matches a NULL hash); sending a GUID for it means that .checkout is obsolete. Our
        -- own never-committed book is resumed with the same user and instance id alone.
        IF v_book.locked_by = v_user_id
           AND v_book.current_version IS NOT NULL
           AND tc._checkout_guid_hash(p_checkout_guid) IS DISTINCT FROM v_book.checkout_guid_hash THEN
            RAISE EXCEPTION '%', '{"error":"CheckoutElsewhere"}' USING ERRCODE = 'PT409';
        END IF;

        IF p_base_version IS NOT NULL
           AND v_book.current_version IS DISTINCT FROM p_base_version THEN
            RAISE EXCEPTION '%', json_build_object(
                'error', 'BaseVersionSuperseded',
                'currentVersion', v_book.current_version
            )::text USING ERRCODE = 'PT409';
        END IF;

        -- Take a free book's lock for the send only: it gets no checkout GUID, and finish,
        -- abort and expiry release it. Our own lock keeps its GUID.
        IF v_book.locked_by IS NULL THEN
            UPDATE tc.books
            SET locked_by = v_user_id, locked_at = now()
            WHERE id = v_book.id
            RETURNING * INTO v_book;

            IF v_book.current_version IS NOT NULL THEN
                -- Record the CheckOut event (type = 0) exactly as checkout_book does, so
                -- other clients' get_changes/realtime pick up the new lock state. (A
                -- never-committed book stays invisible until its first commit.)
                INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
                VALUES (v_book.collection_id, v_book.id, 0, v_user_id, v_book.name);
            END IF;
        END IF;
    END IF;

    -- ---- Diff the proposed manifest against the book's current files -----------------
    SELECT COALESCE(array_agg(f.path ORDER BY f.path COLLATE "C"), '{}') INTO v_changed
    FROM jsonb_to_recordset(v_files) AS f(path text, sha256 text, size bigint)
    WHERE NOT EXISTS (
        SELECT 1 FROM tc.book_files bf
        WHERE bf.book_id = v_book.id
          AND bf.path = f.path
          AND bf.sha256 = f.sha256
          AND bf.size_bytes = f.size
    );

    -- ---- Resume the caller's open attempt only if it is identical; else replace it ----
    -- base_book_version records the book's current version as of NOW (which equals
    -- p_base_version whenever the client sent one, having passed the check above), and
    -- checkout_guid_hash the book's checkout: checkin_finish_tx refuses to commit if either
    -- has changed.
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.proposed_files = v_files
           AND v_existing.changed_paths = v_changed
           AND v_existing.checksum IS NOT DISTINCT FROM p_checksum
           AND v_existing.base_book_version IS NOT DISTINCT FROM v_book.current_version
           AND v_existing.checkout_guid_hash IS NOT DISTINCT FROM v_book.checkout_guid_hash
           AND v_existing.proposed_name = v_name THEN
            UPDATE tc.checkin_attempts
            SET expires_at = now() + INTERVAL '48 hours',
                client_version = p_client_version
            WHERE id = v_existing.id;
            v_tx_id := v_existing.id;
        ELSE
            -- A finish of it now answers transaction_aborted. A new book keeps its row.
            UPDATE tc.checkin_attempts SET status = 'aborted' WHERE id = v_existing.id;
        END IF;
    END IF;

    IF v_tx_id IS NULL THEN
        INSERT INTO tc.checkin_attempts (
            collection_id, book_id, started_by, proposed_name, base_book_version,
            changed_paths, client_version, proposed_files, checksum, checkout_guid_hash
        )
        VALUES (
            p_collection_id, v_book.id, v_user_id, v_name, v_book.current_version,
            v_changed, p_client_version, v_files, p_checksum, v_book.checkout_guid_hash
        )
        RETURNING id INTO v_tx_id;
    END IF;

    -- Check-in never issues a checkout GUID: the client makes its own, for checkout_book.
    RETURN jsonb_build_object(
        'transactionId', v_tx_id,
        'changedPaths', to_jsonb(v_changed)
    );
END;
$$;

COMMENT ON FUNCTION tc.checkin_start_tx(p_collection_id uuid, p_instance_id uuid, p_proposed_name text, p_base_version bigint, p_checksum text, p_client_version text, p_files jsonb, p_checkout_guid text) IS 'Internal to the checkin-start edge function. NFC-normalizes and validates the proposed manifest (PT400 InvalidManifest). No book with p_instance_id in the collection: creates the row, locked to the caller for the send only (no checkout GUID, no current version, invisible to teammates). Otherwise, under row locks: a deleted book is PT404; a lock held by someone else PT409 LockHeldByOther (+holder); the caller''s own checkout of a committed book needs p_checkout_guid to match its checkout_guid_hash (else PT409 CheckoutElsewhere; a send-only lock, with no hash, matches only no GUID); the caller''s own never-committed book needs only the same user and instance id; p_base_version, when sent, must equal the current version (else PT409 BaseVersionSuperseded); a free book gets a send-only lock and a CheckOut event (type=0), as checkout_book emits. Diffs the manifest against the book''s current files. The caller''s open attempt for the book is resumed (same id, new expiry) only if its proposal is identical (files, changed paths, checksum, base version, GUID snapshot, proposed name), and otherwise aborted and a new attempt opened. Returns {transactionId, changedPaths}. Raises PT400/PT401/PT403/PT404/PT409/PT426 per the CONTRACTS.md checkin-start error list.';

CREATE OR REPLACE FUNCTION tc.checkout_book(p_collection_id uuid, p_instance_id uuid, p_machine text, p_checkout_guid text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id     uuid;
    v_book_id     uuid;
    v_updated     integer;   -- row count from the conditional UPDATE (0 or 1)
    v_row         tc.books%ROWTYPE;
    v_guid_hash   text;
BEGIN
    v_user_id := tc.current_user_id();

    -- The client makes the checkout GUID and saves it in its .checkout file BEFORE asking,
    -- so a checkout whose response is lost can still be recognized (and retried) as its own.
    IF p_checkout_guid IS NULL OR btrim(p_checkout_guid) = '' THEN
        RAISE EXCEPTION 'invalid_checkout_guid: a checkout GUID is required' USING ERRCODE = '22023';
    END IF;
    v_guid_hash := tc._checkout_guid_hash(p_checkout_guid);

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    SELECT b.id INTO v_book_id
    FROM tc.books b
    WHERE b.collection_id = p_collection_id AND b.instance_id = p_instance_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Race-free conditional UPDATE. Only a FREE book can be checked out: a book the caller
    -- already holds under a different GUID keeps it, because replacing it would silently
    -- orphan the copy holding the current one (the caller may be in another copy of the
    -- collection). Only the GUID's hash is stored.
    UPDATE tc.books
    SET    locked_by          = v_user_id,
           locked_by_machine  = p_machine,
           locked_at          = now(),
           checkout_guid_hash = v_guid_hash
    WHERE  id = v_book_id
      AND  deleted_at IS NULL
      AND  locked_by IS NULL;

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    -- Fetch resulting row
    SELECT * INTO v_row FROM tc.books WHERE id = v_book_id;

    IF v_updated > 0 THEN
        -- Emit CheckOut event (type = 0)
        INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
        VALUES (v_row.collection_id, v_book_id, 0, v_user_id, v_row.name);

        RETURN jsonb_build_object(
            'success',           true,
            'locked_by',         v_user_id,
            'locked_by_machine', p_machine,
            'locked_at',         v_row.locked_at
        );
    ELSIF v_row.locked_by = v_user_id
          AND v_row.deleted_at IS NULL
          AND v_row.checkout_guid_hash = v_guid_hash THEN
        -- A retry of a checkout that already succeeded (its response was lost): the same
        -- success, with nothing changed and no second CheckOut event.
        RETURN jsonb_build_object(
            'success',           true,
            'locked_by',         v_row.locked_by,
            'locked_by_machine', v_row.locked_by_machine,
            'locked_at',         v_row.locked_at
        );
    ELSIF v_row.locked_by = v_user_id THEN
        -- Already checked out to the caller under another GUID (in another copy, or a
        -- send-only check-in lock with no GUID): nothing changes.
        RETURN jsonb_build_object(
            'success',           false,
            'locked_by_me',      true,
            'locked_by',         v_row.locked_by,
            'locked_by_machine', v_row.locked_by_machine,
            'locked_at',         v_row.locked_at
        );
    ELSE
        -- Lock held by someone else (or the book is deleted)
        RETURN jsonb_build_object(
            'success',           false,
            'locked_by',         v_row.locked_by,
            'locked_by_machine', v_row.locked_by_machine,
            'locked_at',         v_row.locked_at
        );
    END IF;
END;
$$;

COMMENT ON FUNCTION tc.checkout_book(p_collection_id uuid, p_instance_id uuid, p_machine text, p_checkout_guid text) IS 'CONTRACTS.md: checkout_book — conditional lock (race-free UPDATE WHERE locked_by IS NULL). The client supplies the checkout GUID (non-empty, else 22023 invalid_checkout_guid), having saved it in its .checkout file first; only its hash (tc.books.checkout_guid_hash) is stored and the GUID is never returned. Non-member 42501; unknown book P0002. A free book is locked with that hash. A book already locked by the caller with the SAME hash succeeds again with no change and no event (idempotent retry after a lost response). A book locked by the caller with a different (or no) hash returns {success: false, locked_by_me: true} and keeps it (replacing it would orphan the copy holding it). Returns {success, locked_by, locked_by_machine, locked_at, locked_by_me (only when the caller''s under another GUID)}; locked_by is a core.users id. Emits a CheckOut event (type=0) only when it takes a free lock.';

CREATE OR REPLACE FUNCTION tc.checkout_book_takeover(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text, p_machine text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id     uuid;
    v_book_id     uuid;
    v_updated     integer;   -- row count from the conditional UPDATE (0 or 1)
    v_row         tc.books%ROWTYPE;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;

    SELECT b.id INTO v_book_id FROM tc.books b
    WHERE b.collection_id = p_collection_id AND b.instance_id = p_instance_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION '%', '{"error":"book_not_found"}' USING ERRCODE = 'PT404';
    END IF;

    -- Race-free conditional UPDATE: only takes the lock from a DIFFERENT user, and only
    -- when the caller presents that lock's checkout GUID. Only the copy that checked the book
    -- out has the GUID (in the book folder's .checkout file; for a carried-over checkout, in
    -- the old shared folder's Migration Keys file), so presenting it proves the caller is
    -- working in THAT local copy — something no other member can fake: members can read
    -- only the GUID's hash, and the hash is not accepted here. p_machine is just recorded for
    -- display.
    --
    -- The GUID is NOT rotated: the copy that presented it keeps working under the new
    -- account. tc.checkout_takeover tells books_clear_checkout_on_unlock that this change
    -- of holder keeps the hash on purpose; it is switched off again straight after.
    PERFORM set_config('tc.checkout_takeover', 'on', true);
    UPDATE tc.books
    SET    locked_by          = v_user_id,
           locked_by_machine  = p_machine,
           locked_at          = now()
    WHERE  id = v_book_id
      AND  deleted_at IS NULL
      AND  locked_by IS NOT NULL
      AND  locked_by <> v_user_id
      AND  checkout_guid_hash IS NOT NULL
      AND  p_checkout_guid IS NOT NULL
      AND  checkout_guid_hash = tc._checkout_guid_hash(p_checkout_guid);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    PERFORM set_config('tc.checkout_takeover', 'off', true);

    -- Fetch resulting row
    SELECT * INTO v_row FROM tc.books WHERE id = v_book_id;

    IF v_updated > 0 THEN
        -- Emit CheckOut event (type = 0) -- same event type an ordinary checkout_book success
        -- emits, since from the audit trail's point of view this genuinely is B checking the
        -- book out; the preceding history already shows A's own checkout, so the handoff reads
        -- naturally without needing a new event-type constant shared across client/server.
        INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
        VALUES (v_row.collection_id, v_book_id, 0, v_user_id, v_row.name);

        RETURN jsonb_build_object(
            'success',           true,
            'locked_by',         v_user_id,
            'locked_by_machine', p_machine,
            'locked_at',         v_row.locked_at
        );
    ELSE
        -- Nothing to take over (already ours, unlocked, or the GUID is missing/wrong).
        RETURN jsonb_build_object(
            'success',           false,
            'locked_by',         v_row.locked_by,
            'locked_by_machine', v_row.locked_by_machine,
            'locked_at',         v_row.locked_at
        );
    END IF;
END;
$$;

COMMENT ON FUNCTION tc.checkout_book_takeover(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text, p_machine text) IS 'CONTRACTS.md: checkout_book_takeover — atomically reassigns a book''s lock from a DIFFERENT user to the caller, but ONLY when the caller presents the lock''s current checkout GUID (kept in the local copy''s .checkout file, or a Migration Keys file for a carried-over checkout); only its hash is stored and compared, and presenting the hash does not work. The GUID is kept (not rotated), so the same copy goes on checking in under the new account. p_machine is recorded with the new lock for display but grants nothing. Returns {success, locked_by, locked_by_machine, locked_at}. Emits a CheckOut event (type=0) only when the lock actually changed hands.';

CREATE OR REPLACE FUNCTION tc.claim_memberships(p_name text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
    v_email   text;
BEGIN
    IF NOT tc.jwt_email_verified() THEN
        RAISE EXCEPTION 'email_not_verified: claiming memberships requires a verified email'
            USING ERRCODE = '28000';
    END IF;

    v_email   := tc.current_user_email();
    v_user_id := tc._claim_current_user(p_name, false);

    IF v_user_id IS NOT NULL THEN
        -- Fill user_id on the invitations to this email, except in a collection the person
        -- has already joined (e.g. under an earlier email): a user appears once per collection.
        UPDATE tc.members m
        SET    user_id    = v_user_id,
               claimed_at = now()
        WHERE  m.email = v_email
          AND  m.user_id IS NULL
          AND  NOT EXISTS (
                   SELECT 1 FROM tc.members o
                   WHERE o.collection_id = m.collection_id AND o.user_id = v_user_id
               );
    END IF;

    RETURN jsonb_build_object('userId', v_user_id);
END;
$$;

COMMENT ON FUNCTION tc.claim_memberships(p_name text) IS 'CONTRACTS.md: claim_memberships — Bloom calls it at every sign-in, with p_name = the first and last name from its Registration dialog. Requires a verified email (else 28000 email_not_verified). Finds the caller''s core.users row by the JWT sub, or claims the unclaimed user with the token''s email, or creates a row when an invitation to that email exists (tc._claim_current_user); refreshes users.email and sets users.name; fills user_id on every invitation to that email. Returns {userId} (NULL when the caller has no row, i.e. nothing to join).';

CREATE OR REPLACE FUNCTION tc.collection_files_finish_tx(p_transaction_id uuid, p_user_id uuid, p_captured jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
-- Service-role only; p_user_id is the caller, as in checkin_finish_tx.
DECLARE
    v_user_id  uuid := p_user_id;
    v_tx       tc.collection_file_checkin_attempts%ROWTYPE;
    v_version  bigint;
    v_missing  text[];
    v_final    jsonb;
    v_new_ver  bigint;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;

    -- FOR UPDATE so a concurrent retry waits and then takes the 'finished' branch.
    SELECT * INTO v_tx FROM tc.collection_file_checkin_attempts WHERE id = p_transaction_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION '%', '{"error":"transaction_not_found"}' USING ERRCODE = 'PT404';
    END IF;
    IF v_tx.started_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION '%', '{"error":"forbidden"}' USING ERRCODE = 'PT403';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM tc.members m
        WHERE m.collection_id = v_tx.collection_id AND m.user_id = v_user_id
    ) THEN
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;

    IF v_tx.status = 'finished' THEN
        RETURN jsonb_build_object('version', v_tx.resulting_version);
    END IF;

    -- The caller may have been demoted since start.
    IF NOT EXISTS (
        SELECT 1 FROM tc.members m
        WHERE m.collection_id = v_tx.collection_id AND m.user_id = v_user_id AND m.role = 'admin'
    ) THEN
        RAISE EXCEPTION '%', '{"error":"admin_required"}' USING ERRCODE = 'PT403';
    END IF;

    IF v_tx.status = 'aborted' THEN
        RAISE EXCEPTION '%', '{"error":"transaction_aborted"}' USING ERRCODE = 'PT409';
    END IF;
    -- (No status update here: raising would roll it back. The expiry time alone refuses
    -- the call, and the reaper marks the row later.)
    IF v_tx.status = 'expired' OR v_tx.expires_at < now() THEN
        RAISE EXCEPTION '%', '{"error":"TransactionExpired"}' USING ERRCODE = 'PT410';
    END IF;

    SELECT c.collection_files_version INTO v_version
    FROM tc.collections c WHERE c.id = v_tx.collection_id
    FOR UPDATE;

    IF v_version <> v_tx.expected_version THEN
        -- The attempt stays open (an update here would be rolled back by the raise); the
        -- caller receives first, and its next collection-files-start replaces it.
        RAISE EXCEPTION '%', json_build_object(
            'error', 'VersionConflict', 'currentVersion', v_version
        )::text USING ERRCODE = 'PT409';
    END IF;

    SELECT COALESCE(array_agg(cp), '{}') INTO v_missing
    FROM unnest(v_tx.changed_paths) cp
    WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset(p_captured) AS c(path text, "s3VersionId" text)
        WHERE c.path = cp AND c."s3VersionId" IS NOT NULL
    );

    IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION '%', json_build_object(
            'error', 'MissingOrBadUploads', 'paths', to_jsonb(v_missing)
        )::text USING ERRCODE = 'PT409';
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
               'path', f.path,
               'sha256', f.sha256,
               'size', f.size,
               's3VersionId', COALESCE(
                   (SELECT c."s3VersionId" FROM jsonb_to_recordset(p_captured) AS c(path text, "s3VersionId" text)
                    WHERE c.path = f.path),
                   (SELECT cf.s3_version_id FROM tc.collection_files cf
                    WHERE cf.collection_id = v_tx.collection_id AND cf.path = f.path)
               )
           ))
    INTO v_final
    FROM jsonb_to_recordset(v_tx.proposed_files) AS f(path text, sha256 text, size bigint);

    v_new_ver := v_tx.expected_version + 1;

    UPDATE tc.collections
    SET collection_files_version    = v_new_ver,
        collection_files_updated_at = now(),
        collection_files_updated_by = v_user_id
    WHERE id = v_tx.collection_id;

    DELETE FROM tc.collection_files WHERE collection_id = v_tx.collection_id;

    INSERT INTO tc.collection_files (collection_id, path, sha256, size_bytes, s3_version_id)
    SELECT v_tx.collection_id, e->>'path', e->>'sha256', (e->>'size')::bigint, e->>'s3VersionId'
    FROM jsonb_array_elements(COALESCE(v_final, '[]'::jsonb)) e;

    -- CollectionFilesCheckIn (type = 102): it has no book.
    INSERT INTO tc.history_events (collection_id, type, by_user_id)
    VALUES (v_tx.collection_id, 102, v_user_id);

    UPDATE tc.collection_file_checkin_attempts
    SET status = 'finished', resulting_version = v_new_ver
    WHERE id = p_transaction_id;

    -- 'manifest' is extra data for the edge function only (not part of the
    -- CONTRACTS.md {version} response) — used to write the manifest backups.
    RETURN jsonb_build_object('version', v_new_ver, 'manifest', v_final);
END;
$$;

COMMENT ON FUNCTION tc.collection_files_finish_tx(p_transaction_id uuid, p_user_id uuid, p_captured jsonb) IS 'Internal to the collection-files-finish edge function; service-role only (trusts p_captured), with the caller passed as p_user_id as for checkin_finish_tx. Locks the attempt and collection rows, so concurrent retries are idempotent. The caller must still be an admin (PT403 admin_required). A replaced attempt is PT409 transaction_aborted. Re-checks the optimistic version at finish time too (repo-wins rule): PT409 VersionConflict leaves the attempt open. Commits: collections.collection_files_version + 1, the collection_files set replaced, a CollectionFilesCheckIn event (type=102). Returns {version, manifest}.';

CREATE OR REPLACE FUNCTION tc.collection_files_start_tx(p_collection_id uuid, p_expected_version bigint, p_files jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id  uuid := tc.current_user_id();
    v_version  bigint;
    v_files    jsonb;
    v_changed  text[];
    v_tx_id    uuid;
    v_existing tc.collection_file_checkin_attempts%ROWTYPE;
BEGIN
    IF tc.current_authentication_id() IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;
    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;
    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION '%', '{"error":"admin_required"}' USING ERRCODE = 'PT403';
    END IF;

    -- Same NFC normalization/validation as checkin_start_tx, for the same reason.
    v_files := tc._normalize_proposed_files(p_files);

    PERFORM tc.reap_expired_checkin_attempts();

    -- Lock order: the caller's open attempt, then the collection row (as in the finish).
    SELECT * INTO v_existing FROM tc.collection_file_checkin_attempts
    WHERE collection_id = p_collection_id AND started_by = v_user_id AND status = 'open'
    FOR UPDATE;

    SELECT c.collection_files_version INTO v_version
    FROM tc.collections c WHERE c.id = p_collection_id;

    IF v_version <> p_expected_version THEN
        RAISE EXCEPTION '%', json_build_object(
            'error', 'VersionConflict', 'currentVersion', v_version
        )::text USING ERRCODE = 'PT409';
    END IF;

    SELECT COALESCE(array_agg(f.path ORDER BY f.path COLLATE "C"), '{}') INTO v_changed
    FROM jsonb_to_recordset(v_files) AS f(path text, sha256 text, size bigint)
    WHERE NOT EXISTS (
        SELECT 1 FROM tc.collection_files cf
        WHERE cf.collection_id = p_collection_id
          AND cf.path = f.path
          AND cf.sha256 = f.sha256
          AND cf.size_bytes = f.size
    );

    -- As in checkin_start_tx: resume only an identical proposal, otherwise replace it.
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.proposed_files = v_files
           AND v_existing.changed_paths = v_changed
           AND v_existing.expected_version = p_expected_version THEN
            UPDATE tc.collection_file_checkin_attempts
            SET expires_at = now() + INTERVAL '48 hours'
            WHERE id = v_existing.id;
            v_tx_id := v_existing.id;
        ELSE
            UPDATE tc.collection_file_checkin_attempts SET status = 'aborted'
            WHERE id = v_existing.id;
        END IF;
    END IF;

    IF v_tx_id IS NULL THEN
        INSERT INTO tc.collection_file_checkin_attempts (
            collection_id, started_by, expected_version, proposed_files, changed_paths
        )
        VALUES (
            p_collection_id, v_user_id, p_expected_version, v_files, v_changed
        )
        RETURNING id INTO v_tx_id;
    END IF;

    RETURN jsonb_build_object('transactionId', v_tx_id, 'changedPaths', to_jsonb(v_changed));
END;
$$;

COMMENT ON FUNCTION tc.collection_files_start_tx(p_collection_id uuid, p_expected_version bigint, p_files jsonb) IS 'Internal to the collection-files-start edge function. Admin only (PT403 admin_required). NFC-normalizes/validates the proposed manifest (PT400 InvalidManifest), then the optimistic-version gate on collections.collection_files_version (PT409 VersionConflict), the diff against tc.collection_files, and resume-or-replace of the caller''s open attempt (resumed only if identical: files, changed paths, expected version). Returns {transactionId, changedPaths}.';

CREATE OR REPLACE FUNCTION tc.create_collection(p_id uuid, p_name text, p_initial_upload boolean DEFAULT false) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
BEGIN
    IF tc.current_authentication_id() IS NULL THEN
        RAISE EXCEPTION 'unauthenticated' USING ERRCODE = '28000';
    END IF;

    v_user_id := tc._claim_current_user(NULL, true);

    -- Insert collection. The initial-upload flag can only be set here, at creation, and
    -- finish_initial_upload clears it for good, so it can never come back on.
    INSERT INTO tc.collections (id, name, created_by, initial_upload_in_progress)
    VALUES (p_id, normalize(p_name, NFC), v_user_id, COALESCE(p_initial_upload, false));

    -- Insert caller as sole claimed admin
    INSERT INTO tc.members (collection_id, email, role, user_id, added_by, claimed_at)
    SELECT p_id, u.email, 'admin', v_user_id, v_user_id, now()
    FROM core.users u WHERE u.id = v_user_id;
END;
$$;

COMMENT ON FUNCTION tc.create_collection(p_id uuid, p_name text, p_initial_upload boolean) IS 'CONTRACTS.md: create_collection — creates the collection with the caller as its sole claimed admin, creating (or claiming) the caller''s core.users row if needed, which needs a verified email (28000 email_not_verified). p_initial_upload (default false) = true creates it with tc.collections.initial_upload_in_progress set, for an admin who is about to upload an existing collection (sharing it, or migrating a folder Team Collection): my_collections hides it and lock_book_for_legacy_checkout is allowed until finish_initial_upload clears the flag. Creation is the only time the flag can be set.';

CREATE OR REPLACE FUNCTION tc.current_authentication_id() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT auth.jwt() ->> 'sub'
$$;

COMMENT ON FUNCTION tc.current_authentication_id() IS 'The caller''s sign-in identity, the JWT sub claim (a Firebase uid, or a local GoTrue user id); NULL when unauthenticated. Only for telling "not signed in" from "signed in but no user row": everything else uses tc.current_user_id().';

CREATE OR REPLACE FUNCTION tc.current_user_email() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT tc._normalize_email(auth.jwt() ->> 'email')
$$;

COMMENT ON FUNCTION tc.current_user_email() IS 'Returns the caller''s email from the JWT, normalized as stored (tc._normalize_email).';

CREATE OR REPLACE FUNCTION tc.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT u.id FROM core.users u WHERE u.authentication_id = (auth.jwt() ->> 'sub')
$$;

COMMENT ON FUNCTION tc.current_user_id() IS 'Returns the caller''s core.users.id: the row whose authentication_id is the JWT sub. NULL for someone with no user row (or unauthenticated), who is then a member of nothing.';

CREATE OR REPLACE FUNCTION tc.current_caller() RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
BEGIN
    IF tc.current_authentication_id() IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;
    v_user_id := tc.current_user_id();
    IF v_user_id IS NULL THEN
        -- No user row: a member of nothing.
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;
    RETURN jsonb_build_object('userId', v_user_id);
END;
$$;

COMMENT ON FUNCTION tc.current_caller() IS 'Returns {userId} (core.users.id) for the caller''s own (PostgREST-validated) JWT. The finish edge functions call it with the caller''s token to establish who is calling, then pass that id to the service-role-only finish RPCs. Works the same for a Firebase ID token (third-party auth) and a local GoTrue token. PT401 without a token; PT403 not_a_member for a caller with no user row.';

CREATE OR REPLACE FUNCTION tc.delete_book(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
    v_row     tc.books%ROWTYPE;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    -- FOR UPDATE: the holder and GUID checks below must still be true when the row is
    -- tombstoned; otherwise a checkout that changed hands meanwhile (force_unlock, then
    -- someone else's checkout_book) would be deleted and its new lock cleared.
    SELECT * INTO v_row FROM tc.books
    WHERE collection_id = p_collection_id AND instance_id = p_instance_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF v_row.locked_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'lock_required: caller must hold the lock to delete a book'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_row.checkout_guid_hash IS NULL
       OR tc._checkout_guid_hash(p_checkout_guid) IS DISTINCT FROM v_row.checkout_guid_hash THEN
        RAISE EXCEPTION 'CheckoutElsewhere: this book is checked out to you in another copy'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_row.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'already_deleted' USING ERRCODE = 'P0001';
    END IF;

    UPDATE tc.books
    SET    deleted_at        = now(),
           locked_by         = NULL,
           locked_by_machine = NULL,
           locked_at         = NULL
    WHERE  id = v_row.id;

    INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
    VALUES (v_row.collection_id, v_row.id, 8, v_user_id, v_row.name); -- Deleted
END;
$$;

COMMENT ON FUNCTION tc.delete_book(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text) IS 'CONTRACTS.md: delete_book — requires the caller to hold the lock and present its checkout GUID (else CheckoutElsewhere); sets the deleted_at tombstone; emits Deleted (type=8). The lock is released on deletion.';

CREATE OR REPLACE FUNCTION tc.download_start_check(p_collection_id uuid) RETURNS void
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
    IF tc.current_authentication_id() IS NULL THEN
        RAISE EXCEPTION '%', '{"error":"unauthenticated"}' USING ERRCODE = 'PT401';
    END IF;
    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION '%', '{"error":"not_a_member"}' USING ERRCODE = 'PT403';
    END IF;
END;
$$;

COMMENT ON FUNCTION tc.download_start_check(p_collection_id uuid) IS 'Internal to the download-start edge function: membership gate only. PT403 not_a_member if the caller is not a member of the collection.';

CREATE OR REPLACE FUNCTION tc.finish_initial_upload(p_collection_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM tc.collections WHERE id = p_collection_id) THEN
        RAISE EXCEPTION 'collection_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    -- One way only: nothing sets the flag again after this (create_collection is the only
    -- place it is ever set). Clearing an already-clear flag is a no-op, so a retry after a
    -- lost response succeeds.
    UPDATE tc.collections
    SET    initial_upload_in_progress = false
    WHERE  id = p_collection_id
      AND  initial_upload_in_progress;
END;
$$;

COMMENT ON FUNCTION tc.finish_initial_upload(p_collection_id uuid) IS 'CONTRACTS.md: finish_initial_upload — admin-only (else 42501 admin_required; unknown collection P0002 collection_not_found). Clears tc.collections.initial_upload_in_progress once the admin''s Bloom has uploaded every book, the collection files and the carried-over checkouts, so my_collections lists the collection and lock_book_for_legacy_checkout is refused from then on. One way: nothing can set the flag again. Idempotent (already clear = no-op success). Emits no event; get_collection_state and get_changes report the flag.';

CREATE OR REPLACE FUNCTION tc.force_unlock(p_collection_id uuid, p_instance_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id    uuid;
    v_row        tc.books%ROWTYPE;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    -- FOR UPDATE, so the audit event names the lock that is actually cleared.
    SELECT * INTO v_row FROM tc.books
    WHERE collection_id = p_collection_id AND instance_id = p_instance_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Snapshot the lock state for the audit event before clearing it
    INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, lock_info, book_name)
    VALUES (
        v_row.collection_id, v_row.id, 5, -- ForcedUnlock
        v_user_id,
        jsonb_build_object(
            'locked_by',  v_row.locked_by,
            'machine',    v_row.locked_by_machine,
            'locked_at',  v_row.locked_at
        ),
        v_row.name
    );

    UPDATE tc.books
    SET    locked_by         = NULL,
           locked_by_machine = NULL,
           locked_at         = NULL
    WHERE  id = v_row.id;
END;
$$;

COMMENT ON FUNCTION tc.force_unlock(p_collection_id uuid, p_instance_id uuid) IS 'CONTRACTS.md: force_unlock — admin-only; releases any lock (and with it the checkout GUID); emits ForcedUnlock (type=5) with the old lock in lock_info.';

CREATE OR REPLACE FUNCTION tc.forget_swept_attempts(p_cutoff timestamp with time zone) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_count   integer;
    v_deleted integer;
BEGIN
    IF p_cutoff IS NULL THEN
        RAISE EXCEPTION 'forget_swept_attempts: cutoff required' USING ERRCODE = '22023';
    END IF;

    -- Every upload of an attempt is made with credentials from its latest start (which set
    -- expires_at = that start + 48 h), and those last 1 h; so no upload of it is newer than
    -- expires_at - 47 h. A sweep run that deleted versions older than p_cutoff has therefore
    -- deleted all of a dead attempt's garbage once expires_at - 47 h < p_cutoff; one more hour
    -- covers clock differences between S3, the edge runtime and the database.
    DELETE FROM tc.checkin_attempts
    WHERE status IN ('aborted', 'expired')
      AND expires_at - interval '46 hours' < p_cutoff;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    DELETE FROM tc.collection_file_checkin_attempts
    WHERE status IN ('aborted', 'expired')
      AND expires_at - interval '46 hours' < p_cutoff;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    RETURN v_count + v_deleted;
END;
$$;

COMMENT ON FUNCTION tc.forget_swept_attempts(p_cutoff timestamp with time zone) IS 'For the sweep-stale-uploads edge function, after a complete run that deleted garbage versions older than p_cutoff: deletes the aborted and expired attempts (both tables) all of whose uploads were old enough for that run to have deleted them (expires_at - 46 h < p_cutoff), since they are the sweep''s worklist and have nothing left to say. Returns the number deleted. service-role only.';

CREATE OR REPLACE FUNCTION tc.get_book_manifest(p_collection_id uuid, p_instance_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
DECLARE
    v_row   tc.books%ROWTYPE;
    v_files jsonb;
    v_email text;
    v_name  text;
BEGIN
    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM tc.books
    WHERE collection_id = p_collection_id AND instance_id = p_instance_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Never-committed books are invisible to everyone except their mid-Send owner
    -- (same rule as get_collection_state's full snapshot).
    IF v_row.current_version IS NULL
       AND v_row.locked_by IS DISTINCT FROM tc.current_user_id() THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'path',        bf.path,
                'sha256',      bf.sha256,
                'size',        bf.size_bytes,
                's3VersionId', bf.s3_version_id
            )
            ORDER BY bf.path
        ),
        '[]'::jsonb
    )
    INTO v_files
    FROM tc.book_files bf
    WHERE bf.book_id = v_row.id;

    SELECT u.email, u.name INTO v_email, v_name
    FROM core.users u WHERE u.id = v_row.locked_by;

    RETURN jsonb_build_object(
        'instanceId',    v_row.instance_id,
        'version',       v_row.current_version,
        'checksum',      v_row.current_checksum,
        'files',         v_files,
        'lockedBy',      v_row.locked_by,
        'lockedByEmail', v_email,
        'lockedByName',  v_name
    );
END;
$$;

COMMENT ON FUNCTION tc.get_book_manifest(p_collection_id uuid, p_instance_id uuid) IS 'CONTRACTS.md: get_book_manifest — the book''s current files (path, sha256, size, s3VersionId; the main .htm is index.htm), used by Receive to download pinned versions, with its version and checksum, and the lock holder (lockedBy, lockedByEmail, lockedByName) so Receive can show "still checked out to X" without a second round trip. Enforces the never-committed-book invisibility rule.';

CREATE OR REPLACE FUNCTION tc.get_changes(p_collection_id uuid, p_since_event_id bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_events jsonb;
    v_books  jsonb;
BEGIN
    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    -- Wait for every transaction still writing events in this collection, and hold off new
    -- ones until this call ends, so the cursor returned never passes an id that commits
    -- later (see tc._history_events_assign_id). Taken before _touch_member's row lock: a
    -- writer waiting on this lock never holds a member row.
    PERFORM pg_advisory_xact_lock(tc._event_order_lock_key(p_collection_id));

    -- The caller is polling this collection, so they have it open.
    PERFORM tc._touch_member(p_collection_id);

    -- Events since cursor
    SELECT jsonb_agg(row_to_json(e)::jsonb ORDER BY e.id)
    INTO v_events
    FROM (
        SELECT
            e.id,
            b.instance_id,
            e.type,
            e.by_user_id,
            u.name  AS by_name,
            u.email AS by_email,
            e.book_version,
            e.lock_info,
            e.book_name,
            e.message,
            e.bloom_version,
            e.occurred_at
        FROM tc.history_events e
        LEFT JOIN tc.books b ON b.id = e.book_id
        LEFT JOIN core.users u ON u.id = e.by_user_id
        WHERE e.collection_id = p_collection_id
          AND e.id            > p_since_event_id
        ORDER BY e.id
    ) e;

    -- Touched book rows (distinct books referenced in those events)
    SELECT jsonb_agg(row_to_json(b)::jsonb)
    INTO v_books
    FROM (
        SELECT DISTINCT ON (b.id)
            b.instance_id,
            b.name,
            b.current_version,
            b.current_checksum,
            b.locked_by,
            u.name  AS locked_by_name,
            u.email AS locked_by_email,
            b.locked_by_machine,
            b.checkout_guid_hash AS "checkoutGuidHash",
            b.locked_at,
            b.deleted_at,
            b.created_at
        FROM tc.books b
        JOIN tc.history_events e ON e.book_id = b.id
        LEFT JOIN core.users u ON u.id = b.locked_by
        WHERE e.collection_id = p_collection_id
          AND e.id            > p_since_event_id
        ORDER BY b.id
    ) b;

    RETURN jsonb_build_object(
        'events',        COALESCE(v_events, '[]'::jsonb),
        'books',         COALESCE(v_books,  '[]'::jsonb),
        'max_event_id',  (
            SELECT max(id) FROM tc.history_events
            WHERE collection_id = p_collection_id
              AND id > p_since_event_id
        ),
        -- Clearing the flag emits no event, so a poll reports it every time.
        'initial_upload_in_progress',
            (SELECT c.initial_upload_in_progress FROM tc.collections c WHERE c.id = p_collection_id)
    );
END;
$$;

COMMENT ON FUNCTION tc.get_changes(p_collection_id uuid, p_since_event_id bigint) IS 'CONTRACTS.md: get_changes — history events since the cursor (each with the book''s instance_id, and the author''s current name and email from core.users), the book rows they touched (with the lock holder''s name and email, and checkoutGuidHash), max_event_id, and initial_upload_in_progress on every call (clearing it emits no event). Used for polling (60s) and realtime reconnect catch-up. Waits for transactions still writing events in the collection (tc._event_order_lock_key), so no event with an id at or below the returned max_event_id can commit later; a cursor advanced to it never skips one. VOLATILE, because it records that the caller has the collection open (tc._touch_member).';

CREATE OR REPLACE FUNCTION tc.get_collection_file_manifest(p_collection_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
DECLARE
    v_version  bigint;
    v_files    jsonb;
BEGIN
    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    SELECT c.collection_files_version INTO v_version
    FROM tc.collections c WHERE c.id = p_collection_id;

    SELECT COALESCE(
        jsonb_agg(
            jsonb_build_object(
                'path',        cf.path,
                'sha256',      cf.sha256,
                'size',        cf.size_bytes,
                's3VersionId', cf.s3_version_id
            )
            ORDER BY cf.path
        ),
        '[]'::jsonb
    )
    INTO v_files
    FROM tc.collection_files cf
    WHERE cf.collection_id = p_collection_id;

    RETURN jsonb_build_object(
        'version', v_version,
        'files',   v_files
    );
END;
$$;

COMMENT ON FUNCTION tc.get_collection_file_manifest(p_collection_id uuid) IS 'CONTRACTS.md: get_collection_file_manifest — the collection''s current collection files (path relative to the collection folder, sha256, size, s3VersionId) and their version, used by the download path to fetch only changed files pinned to their committed s3_version_id. Mirrors get_book_manifest; a collection whose files were never sent returns version 0 and no files.';

CREATE OR REPLACE FUNCTION tc.get_collection_state(p_collection_id uuid, p_since_event_id bigint DEFAULT NULL::bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_max_event_id bigint;
    v_books        jsonb;
BEGIN
    -- Verify membership
    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    -- As in get_changes: max_event_id must not pass an event whose transaction commits later.
    PERFORM pg_advisory_xact_lock(tc._event_order_lock_key(p_collection_id));

    -- The caller is opening (or re-syncing) this collection.
    PERFORM tc._touch_member(p_collection_id);

    -- Max event id for the cursor
    SELECT max(id) INTO v_max_event_id
    FROM tc.history_events
    WHERE collection_id = p_collection_id;

    -- Books: full or delta
    IF p_since_event_id IS NULL THEN
        -- Full snapshot: all books, minus never-committed books invisible to everyone but
        -- their own mid-Send lock holder.
        SELECT jsonb_agg(row_to_json(b)::jsonb)
        INTO v_books
        FROM (
            SELECT
                b.instance_id,
                b.name,
                b.current_version,
                b.current_checksum,
                b.locked_by,
                u.name  AS locked_by_name,
                u.email AS locked_by_email,
                b.locked_by_machine,
                b.checkout_guid_hash AS "checkoutGuidHash",
                b.locked_at,
                b.deleted_at,
                b.created_at
            FROM tc.books b
            LEFT JOIN core.users u ON u.id = b.locked_by
            WHERE b.collection_id = p_collection_id
              AND (b.current_version IS NOT NULL OR b.locked_by = tc.current_user_id())
            ORDER BY lower(b.name), b.instance_id
        ) b;
    ELSE
        -- Delta: only books that have an event since since_event_id
        SELECT jsonb_agg(row_to_json(b)::jsonb)
        INTO v_books
        FROM (
            SELECT DISTINCT ON (b.id)
                b.instance_id,
                b.name,
                b.current_version,
                b.current_checksum,
                b.locked_by,
                u.name  AS locked_by_name,
                u.email AS locked_by_email,
                b.locked_by_machine,
                b.checkout_guid_hash AS "checkoutGuidHash",
                b.locked_at,
                b.deleted_at,
                b.created_at
            FROM tc.books b
            JOIN tc.history_events e ON e.book_id = b.id
            LEFT JOIN core.users u ON u.id = b.locked_by
            WHERE b.collection_id = p_collection_id
              AND e.id            > p_since_event_id
            ORDER BY b.id
        ) b;
    END IF;

    RETURN jsonb_build_object(
        'books',        COALESCE(v_books,  '[]'::jsonb),
        'collection_files_version',
            (SELECT c.collection_files_version FROM tc.collections c WHERE c.id = p_collection_id),
        'max_event_id', v_max_event_id,
        'initial_upload_in_progress',
            (SELECT c.initial_upload_in_progress FROM tc.collections c WHERE c.id = p_collection_id)
    );
END;
$$;

COMMENT ON FUNCTION tc.get_collection_state(p_collection_id uuid, p_since_event_id bigint) IS 'CONTRACTS.md: get_collection_state — full (p_since_event_id NULL) or delta snapshot of the book rows (instance_id, name, current version and checksum, the lock holder''s user id, name and email, machine and time, checkoutGuidHash, tombstone), the collection files'' version, max_event_id and initial_upload_in_progress. Like get_changes, waits for transactions still writing events in the collection, so max_event_id is a cursor that never skips an event committed later. VOLATILE, because it records that the caller opened the collection (tc._touch_member).';

CREATE OR REPLACE FUNCTION tc.history_events_realtime_broadcast() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Supabase Realtime's broadcast-from-database: realtime.send stores the message in
    -- realtime.messages, and the Realtime server delivers it to subscribers of the private
    -- channel collection:{collection_id} whom the realtime.messages RLS policy lets read it
    -- (04_security.sql). realtime.send only warns if it cannot deliver, so a Realtime problem
    -- never blocks the check-in that logged the event. Where the Realtime schema is absent
    -- (a database started without the Realtime service, as the pgTAP job does) there is
    -- nothing to send to; clients catch up with get_changes either way.
    IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL THEN
        PERFORM realtime.send(
            jsonb_build_object(
                'eventId',     NEW.id,
                'type',        NEW.type,
                'instanceId',  (SELECT b.instance_id FROM tc.books b WHERE b.id = NEW.book_id),
                'bookVersion', NEW.book_version,
                'byUserId',    NEW.by_user_id,
                'byName',      (SELECT u.name FROM core.users u WHERE u.id = NEW.by_user_id),
                'lock',        NEW.lock_info,
                'bookName',    NEW.book_name
            ),
            'tc_event',
            'collection:' || NEW.collection_id::text,
            true
        );
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tc.history_events_realtime_broadcast() IS 'Broadcasts every new history event with realtime.send (Supabase Realtime broadcast from the database) as event "tc_event" on the PRIVATE channel collection:{collection_id}, in the message shape of CONTRACTS.md §Realtime (realtime.send adds its own "id" key). SECURITY DEFINER, to read core.users. A no-op where the realtime schema is not installed; delivery failures are only warnings.';

CREATE OR REPLACE FUNCTION tc.is_admin(p_collection_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tc.members m
        WHERE m.collection_id = p_collection_id
          AND m.user_id        = tc.current_user_id()
          AND m.role           = 'admin'
    )
$$;

COMMENT ON FUNCTION tc.is_admin(p_collection_id uuid) IS 'Returns TRUE when the caller (tc.current_user_id) is a claimed admin of the given collection.';

CREATE OR REPLACE FUNCTION tc.is_client_version_supported(p_client_version text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $_$
DECLARE
    v_min   int[];
    v_cur   int[];
    v_floor text := tc.min_supported_client_version();
BEGIN
    IF v_floor IS NULL OR v_floor = '0.0.0' THEN
        RETURN true; -- floor disabled
    END IF;
    IF p_client_version IS NULL OR p_client_version !~ '^[0-9]+(\.[0-9]+)*$' THEN
        RETURN false; -- unparsable version, floor is enabled ⇒ reject
    END IF;

    SELECT array_agg(x::int) INTO v_min FROM unnest(string_to_array(v_floor, '.')) x;
    SELECT array_agg(x::int) INTO v_cur FROM unnest(string_to_array(p_client_version, '.')) x;

    FOR i IN 1 .. greatest(array_length(v_min, 1), array_length(v_cur, 1)) LOOP
        IF COALESCE(v_cur[i], 0) > COALESCE(v_min[i], 0) THEN
            RETURN true;
        ELSIF COALESCE(v_cur[i], 0) < COALESCE(v_min[i], 0) THEN
            RETURN false;
        END IF;
    END LOOP;
    RETURN true; -- equal
END;
$_$;

COMMENT ON FUNCTION tc.is_client_version_supported(p_client_version text) IS 'Dotted-integer version compare against tc.min_supported_client_version(). Used to raise ClientOutOfDate (426) in checkin_start_tx.';

CREATE OR REPLACE FUNCTION tc.is_member(p_collection_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT EXISTS (
        SELECT 1
        FROM tc.members m
        WHERE m.collection_id = p_collection_id
          AND m.user_id        = tc.current_user_id()
    )
$$;

COMMENT ON FUNCTION tc.is_member(p_collection_id uuid) IS 'Returns TRUE when the caller (tc.current_user_id) is a claimed member of the given collection.';

CREATE OR REPLACE FUNCTION tc.jwt_email_verified() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT
    CASE
      -- Firebase-style: explicit boolean claim (may arrive as 'true'::text or true::bool)
      WHEN (auth.jwt() ->> 'email_verified') IS NOT NULL THEN
        (auth.jwt() ->> 'email_verified')::boolean
      -- Local GoTrue (dev): no email_verified claim; role = 'authenticated' implies confirmed
      WHEN (auth.jwt() ->> 'role') = 'authenticated' THEN
        TRUE
      ELSE
        FALSE
    END
$$;

COMMENT ON FUNCTION tc.jwt_email_verified() IS 'The ONLY place that decides whether the caller''s email is verified. Handles both a Firebase-style email_verified JWT claim and local-GoTrue auto-confirmed users (dev stack). All callers must use this function, never the claim directly.';

CREATE OR REPLACE FUNCTION tc.list_stale_upload_garbage() RETURNS TABLE(transaction_kind text, transaction_id uuid, s3_key text, referenced_version_id text)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    -- Book check-in uploads: tc/{collectionId}/books/{instanceId}/{path}
    SELECT
        'book'::text,
        t.id,
        'tc/' || t.collection_id::text || '/books/' || b.instance_id::text || '/' || p.path,
        (SELECT bf.s3_version_id
           FROM tc.book_files bf
          WHERE bf.book_id = t.book_id AND bf.path = p.path)
    FROM tc.checkin_attempts t
    JOIN tc.books b ON b.id = t.book_id
    CROSS JOIN LATERAL unnest(t.changed_paths) AS p(path)
    WHERE (t.status = 'aborted' OR (t.status <> 'finished' AND t.expires_at < now()))
      AND NOT EXISTS (
          SELECT 1 FROM tc.checkin_attempts live
          WHERE live.book_id = t.book_id
            AND live.status = 'open'
            AND live.expires_at >= now()
            AND p.path = ANY(live.changed_paths)
      )

    UNION ALL

    -- Collection-file uploads: tc/{collectionId}/collectionFiles/{path}
    SELECT
        'collection_file'::text,
        t.id,
        'tc/' || t.collection_id::text || '/collectionFiles/' || p.path,
        (SELECT cf.s3_version_id
           FROM tc.collection_files cf
          WHERE cf.collection_id = t.collection_id
            AND cf.path = p.path)
    FROM tc.collection_file_checkin_attempts t
    CROSS JOIN LATERAL unnest(t.changed_paths) AS p(path)
    WHERE (t.status = 'aborted' OR (t.status <> 'finished' AND t.expires_at < now()))
      AND NOT EXISTS (
          SELECT 1 FROM tc.collection_file_checkin_attempts live
          WHERE live.collection_id = t.collection_id
            AND live.status = 'open'
            AND live.expires_at >= now()
            AND p.path = ANY(live.changed_paths)
      );
$$;

CREATE OR REPLACE FUNCTION tc.list_stale_upload_keys(p_after_key text, p_limit integer) RETURNS TABLE(transaction_kind text, s3_key text, referenced_version_id text)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
    -- Every page must fit in one PostgREST response (max_rows 1000), or it would be
    -- truncated silently and the cursor would skip the missing rows.
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION 'invalid_limit: p_limit must be between 1 and 1000' USING ERRCODE = '22023';
    END IF;
    -- One row per key (a key appears once per dead attempt that touched it), keyset-paged
    -- in byte order ("C" collation, so the order and the > comparison agree on every server).
    RETURN QUERY
    SELECT g.kind, g.k::text, min(g.ref)
    FROM (
        SELECT l.transaction_kind AS kind, l.s3_key COLLATE "C" AS k,
               l.referenced_version_id AS ref
        FROM tc.list_stale_upload_garbage() l
    ) g
    WHERE p_after_key IS NULL OR g.k > (p_after_key COLLATE "C")
    GROUP BY g.kind, g.k
    ORDER BY g.k
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION tc.list_stale_upload_keys(p_after_key text, p_limit integer) IS 'Paged worklist for the sweep-stale-uploads edge function: the distinct S3 keys of tc.list_stale_upload_garbage (with their kind and currently-referenced version), in "C"-collation key order, after p_after_key (NULL = from the start), at most p_limit (1..1000, else 22023 invalid_limit). The sweep passes the last key of each page as the next cursor and reads every page per run, so keys whose dead attempt rows remain after their garbage is deleted never stop it reaching later ones. service-role only.';

CREATE OR REPLACE FUNCTION tc.stale_upload_key_state(p_s3_key text) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    -- Re-evaluates list_stale_upload_garbage for ONE key, as of now: still listed means no
    -- live attempt touches it; referencedVersionId is what the current files reference now.
    SELECT jsonb_build_object(
        'stillStale', count(*) > 0,
        'referencedVersionId', min(g.referenced_version_id)
    )
    FROM tc.list_stale_upload_garbage() g
    WHERE g.s3_key = p_s3_key
$$;

COMMENT ON FUNCTION tc.stale_upload_key_state(p_s3_key text) IS 'For the sweep-stale-uploads edge function, immediately before it deletes versions of one key: {stillStale, referencedVersionId} re-read now. The sweep skips the key unless it is still stale (no live attempt touches it) and still references the same version it planned against, so a check-in that committed or started after the worklist snapshot never loses its upload. service-role only.';

COMMENT ON FUNCTION tc.list_stale_upload_garbage() IS 'The whole, unpaged worklist behind the sweep-stale-uploads edge function (which reads it a page at a time through tc.list_stale_upload_keys, and one key at a time through tc.stale_upload_key_state): per-file S3 keys touched by DEAD (aborted/expired) check-in attempts and collection-file sends, with the currently-referenced s3_version_id as the delete-newer-than watermark (NULL = nothing references the key). Excludes paths a live attempt is still uploading. service-role only. See GOING-LIVE.md "Orphaned-upload sweep".';

CREATE OR REPLACE FUNCTION tc.lock_book_for_legacy_checkout(p_collection_id uuid, p_instance_id uuid, p_legacy_email text, p_checkout_guid text, p_machine text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id    uuid;
    v_email      text;
    v_holder     uuid;
    v_guid_hash  text;
    v_uploading  boolean;
    v_row        tc.books%ROWTYPE;
BEGIN
    v_user_id := tc.current_user_id();

    -- As in checkout_book, the admin's client writes the GUID (here into the old shared
    -- folder's Migration Keys file) before asking, so a lost response can be retried.
    IF p_checkout_guid IS NULL OR btrim(p_checkout_guid) = '' THEN
        RAISE EXCEPTION 'invalid_checkout_guid: a checkout GUID is required' USING ERRCODE = '22023';
    END IF;
    IF p_legacy_email IS NULL OR btrim(p_legacy_email) = '' THEN
        RAISE EXCEPTION 'invalid_legacy_email: the old checkout''s email is required' USING ERRCODE = '22023';
    END IF;
    v_guid_hash := tc._checkout_guid_hash(p_checkout_guid);
    v_email := tc._normalize_email(p_legacy_email);

    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    SELECT c.initial_upload_in_progress INTO v_uploading
    FROM tc.collections c WHERE c.id = p_collection_id;

    IF NOT v_uploading THEN
        RAISE EXCEPTION 'initial_upload_not_in_progress: carried-over checkouts are only possible during a collection''s initial upload'
            USING ERRCODE = 'P0001';
    END IF;

    -- FOR UPDATE: the book's state decides between locking, a retry and a refusal.
    SELECT * INTO v_row FROM tc.books
    WHERE collection_id = p_collection_id AND instance_id = p_instance_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- The book must already be uploaded: the holder can only take it over, never make its
    -- first check-in.
    IF v_row.current_version IS NULL THEN
        RAISE EXCEPTION 'book_not_committed: upload the book before locking it'
            USING ERRCODE = 'P0001';
    END IF;

    IF v_row.locked_by IS NULL AND v_row.deleted_at IS NULL THEN
        -- The holder is the user with that email: an existing one, or a new unclaimed user
        -- (no authentication_id), whom the first verified sign-in with the email claims.
        INSERT INTO core.users (email) VALUES (v_email) ON CONFLICT (email) DO NOTHING;
        SELECT u.id INTO v_holder FROM core.users u WHERE u.email = v_email;

        UPDATE tc.books
        SET    locked_by          = v_holder,
               locked_by_machine  = p_machine,
               locked_at          = now(),
               checkout_guid_hash = v_guid_hash
        WHERE  id = v_row.id
        RETURNING * INTO v_row;

        -- CheckOut (type = 0), as checkout_book emits. The actor is the admin who placed the
        -- lock (events record who did something); lock_info names the holder.
        INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, lock_info, book_name, message)
        VALUES (
            v_row.collection_id, v_row.id, 0, v_user_id,
            jsonb_build_object(
                'locked_by', v_holder,
                'machine',   p_machine,
                'locked_at', v_row.locked_at
            ),
            v_row.name,
            'checked out in the old Team Collection'
        );

        RETURN jsonb_build_object(
            'success',           true,
            'locked_by',         v_row.locked_by,
            'locked_by_machine', v_row.locked_by_machine,
            'locked_at',         v_row.locked_at
        );
    END IF;

    SELECT u.id INTO v_holder FROM core.users u WHERE u.email = v_email;

    IF v_holder IS NOT NULL
       AND v_row.locked_by = v_holder
       AND v_row.deleted_at IS NULL
       AND v_row.checkout_guid_hash = v_guid_hash THEN
        -- A retry (e.g. resuming after a crash, or a lost response): the same success, with
        -- nothing changed and no second event.
        RETURN jsonb_build_object(
            'success',           true,
            'locked_by',         v_row.locked_by,
            'locked_by_machine', v_row.locked_by_machine,
            'locked_at',         v_row.locked_at
        );
    END IF;

    -- Locked by anyone else, to this holder under another GUID, or deleted: nothing changes.
    -- Same shape as checkout_book's refusal.
    RETURN jsonb_build_object(
        'success',           false,
        'locked_by',         v_row.locked_by,
        'locked_by_machine', v_row.locked_by_machine,
        'locked_at',         v_row.locked_at
    );
END;
$$;

COMMENT ON FUNCTION tc.lock_book_for_legacy_checkout(p_collection_id uuid, p_instance_id uuid, p_legacy_email text, p_checkout_guid text, p_machine text) IS 'CONTRACTS.md: lock_book_for_legacy_checkout — during a collection''s initial upload (migrating a folder Team Collection), locks a book that is checked out to someone in the old system to the user with that checkout''s email (tc._normalize_email(p_legacy_email)): the existing core.users row with that email, or a new unclaimed user (no authentication_id), with checkout_guid_hash = tc._checkout_guid_hash(p_checkout_guid) (the GUID the admin''s client first wrote into the old shared folder''s Migration Keys file) and locked_by_machine = p_machine (the old machine). Admin-only (42501 admin_required); only while tc.collections.initial_upload_in_progress is set (else P0001 initial_upload_not_in_progress); only for a committed book (else P0001 book_not_committed); unknown book P0002; NULL/blank GUID or email 22023. A free live book is locked and a CheckOut event (type=0) is emitted with the ADMIN as its actor and the holder in lock_info.locked_by. The same holder with the same GUID again succeeds with no change and no event (resume/retry). Anything else locked, or a deleted book, returns {success: false, locked_by, locked_by_machine, locked_at} and changes nothing, as checkout_book does. Nobody can sign in as an unclaimed user, so the lock ends when that email''s owner signs in (claim_memberships claims the user), by checkout_book_takeover with the GUID, or by force_unlock.';

CREATE OR REPLACE FUNCTION tc.log_event(p_collection_id uuid, p_instance_id uuid DEFAULT NULL::uuid, p_type integer DEFAULT NULL::integer, p_message text DEFAULT NULL::text, p_book_name text DEFAULT NULL::text, p_bloom_version text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id  uuid;
    v_book_id  uuid;
    v_event_id bigint;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    -- type must be a valid event type value (the check constraint on tc.history_events will
    -- catch invalid values, but we give a friendlier error here).
    IF p_type IS NULL THEN
        RAISE EXCEPTION 'event_type_required' USING ERRCODE = '22023';
    END IF;

    -- Every type but CollectionFilesCheckIn (102) concerns a book.
    IF p_type <> 102 AND p_instance_id IS NULL THEN
        RAISE EXCEPTION 'instance_id_required: this event type concerns a book' USING ERRCODE = '22023';
    END IF;

    IF p_instance_id IS NOT NULL THEN
        SELECT b.id INTO v_book_id FROM tc.books b
        WHERE b.collection_id = p_collection_id AND b.instance_id = p_instance_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    INSERT INTO tc.history_events (
        collection_id, book_id, type, by_user_id,
        book_name, message, bloom_version
    )
    VALUES (
        p_collection_id, v_book_id, p_type, v_user_id,
        p_book_name, p_message, p_bloom_version
    )
    RETURNING id INTO v_event_id;

    RETURN v_event_id;
END;
$$;

COMMENT ON FUNCTION tc.log_event(p_collection_id uuid, p_instance_id uuid, p_type integer, p_message text, p_book_name text, p_bloom_version text) IS 'CONTRACTS.md: log_event — client-originated history entries (e.g. WorkPreservedLocally incident events). p_instance_id is required for every type that concerns a book (all but 102; else 22023 instance_id_required), and must name a book of the collection (else P0002). Returns the new event id.';

CREATE OR REPLACE FUNCTION tc.members_add(p_collection_id uuid, p_email text, p_role tc.member_role DEFAULT 'member'::tc.member_role) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
    v_email   text := tc._normalize_email(p_email);
    v_new_id  bigint;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    IF v_email IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'invalid_email: an email is required' USING ERRCODE = '22023';
    END IF;

    -- An email that a row was invited by, or that a joined member now signs in with,
    -- already has access.
    IF EXISTS (
        SELECT 1 FROM tc.members m
        LEFT JOIN core.users u ON u.id = m.user_id
        WHERE m.collection_id = p_collection_id
          AND (m.email = v_email OR u.email = v_email)
    ) THEN
        RETURN NULL;
    END IF;

    INSERT INTO tc.members (collection_id, email, role, added_by)
    VALUES (p_collection_id, v_email, p_role, v_user_id)
    ON CONFLICT (collection_id, email) DO NOTHING
    RETURNING id INTO v_new_id;

    RETURN v_new_id;
END;
$$;

COMMENT ON FUNCTION tc.members_add(p_collection_id uuid, p_email text, p_role tc.member_role) IS 'CONTRACTS.md: members_add — admin-only; invites an email (stored normalized) with a role. Returns the new member id, or NULL when that email already has access: a row was invited by it, or a joined member''s current email (core.users.email) is it.';

CREATE OR REPLACE FUNCTION tc.members_last_admin_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    admin_count     integer;
    v_collection_id uuid    := COALESCE(OLD.collection_id, NEW.collection_id);
    -- Only removing or demoting an admin can reduce the admin count. Non-admin
    -- deletes, promotions, and unrelated column updates cannot orphan a collection.
    v_drops_admin   boolean :=
        (TG_OP = 'DELETE' AND OLD.role = 'admin')
        OR (TG_OP = 'UPDATE' AND OLD.role = 'admin' AND NEW.role = 'member');
BEGIN
    IF NOT v_drops_admin THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Serialize concurrent admin drops on this collection: lock the parent collection row
    -- so two transactions cannot each see the other's soon-to-be-gone admin and both slip
    -- through to zero admins.
    PERFORM 1 FROM tc.collections WHERE id = v_collection_id FOR UPDATE;

    -- The collection itself is being deleted (its members go with it by cascade, as in
    -- support_delete_collection): there is nothing left to orphan.
    IF NOT FOUND THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    SELECT count(*) INTO admin_count
    FROM tc.members
    WHERE collection_id = v_collection_id
      AND role = 'admin'
      AND id <> OLD.id;

    IF admin_count = 0 THEN
        RAISE EXCEPTION 'last_admin_guard: cannot % the last admin of collection %',
            CASE WHEN TG_OP = 'DELETE' THEN 'remove' ELSE 'demote' END, v_collection_id
            USING ERRCODE = 'P0001';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION tc.members_last_admin_guard() IS 'Trigger function: prevents deleting or demoting the last admin of a collection. Locks the parent collection row (FOR UPDATE) before counting so concurrent admin removals/demotions serialize instead of racing to zero admins. Allows the delete when the collection row is already gone, i.e. the members are being removed by the cascade from deleting the collection (support_delete_collection).';

CREATE OR REPLACE FUNCTION tc.members_list(p_collection_id uuid) RETURNS TABLE(id bigint, email text, role tc.member_role, user_id uuid, name text, current_email text, added_by uuid, added_at timestamp with time zone, claimed_at timestamp with time zone, last_seen_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT m.id, m.email, m.role, m.user_id, u.name, u.email, m.added_by, m.added_at,
           m.claimed_at, m.last_seen_at
    FROM tc.members m
    LEFT JOIN core.users u ON u.id = m.user_id
    WHERE m.collection_id = p_collection_id
      AND tc.is_member(p_collection_id)   -- membership gate
    ORDER BY m.email
$$;

COMMENT ON FUNCTION tc.members_list(p_collection_id uuid) IS 'CONTRACTS.md: members_list — the approved accounts of the collection; any member may call it. Rows: member id, the invited email, role, user_id (NULL until claimed), and once claimed the person''s name and current email (core.users), added_by, added_at, claimed_at, last_seen_at (NULL = never seen).';

CREATE OR REPLACE FUNCTION tc.members_remove(p_collection_id uuid, p_member_id bigint) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_caller_id      uuid;
    v_target_user_id uuid;
    v_book           record;
BEGIN
    v_caller_id := tc.current_user_id();

    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    SELECT user_id INTO v_target_user_id
    FROM tc.members
    WHERE id = p_member_id AND collection_id = p_collection_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Force-unlock all books held by this user and emit ForcedUnlock events. FOR UPDATE (in
    -- id order, so two removals take the rows in the same order): a book whose lock changes
    -- hands meanwhile is re-checked once its row lock is ours and skipped if no longer this
    -- user's, so its new holder's checkout is never cleared or reported as the removed
    -- member's.
    FOR v_book IN
        SELECT b.id, b.name, b.locked_by_machine, b.locked_at
        FROM tc.books b
        WHERE b.collection_id = p_collection_id
          AND b.locked_by     = v_target_user_id
        ORDER BY b.id
        FOR UPDATE OF b
    LOOP
        INSERT INTO tc.history_events (
            collection_id, book_id, type, by_user_id,
            lock_info, book_name, message
        )
        VALUES (
            p_collection_id, v_book.id, 5, -- ForcedUnlock
            v_caller_id,
            jsonb_build_object(
                'locked_by', v_target_user_id,
                'machine',   v_book.locked_by_machine,
                'locked_at', v_book.locked_at
            ),
            v_book.name,
            'lock released due to member removal'
        );

        UPDATE tc.books
        SET    locked_by         = NULL,
               locked_by_machine = NULL,
               locked_at         = NULL
        WHERE  id = v_book.id
          AND  locked_by = v_target_user_id;
    END LOOP;

    -- Delete the member row (last-admin guard trigger will fire here if applicable)
    DELETE FROM tc.members WHERE id = p_member_id;
END;
$$;

COMMENT ON FUNCTION tc.members_remove(p_collection_id uuid, p_member_id bigint) IS 'CONTRACTS.md: members_remove — admin-only; force-unlocks any books held by the removed member (emits ForcedUnlock events). Last-admin guard trigger fires on DELETE.';

CREATE OR REPLACE FUNCTION tc.members_set_role(p_collection_id uuid, p_member_id bigint, p_new_role tc.member_role) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    -- The last-admin guard trigger will raise if this demotes the last admin.
    UPDATE tc.members
    SET    role = p_new_role
    WHERE  id              = p_member_id
      AND  collection_id   = p_collection_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'member_not_found' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

COMMENT ON FUNCTION tc.members_set_role(p_collection_id uuid, p_member_id bigint, p_new_role tc.member_role) IS 'CONTRACTS.md: members_set_role — admin-only; last-admin guard trigger fires on demotion.';

CREATE OR REPLACE FUNCTION tc.min_supported_client_version() RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
    SELECT '0.0.0'::text
$$;

COMMENT ON FUNCTION tc.min_supported_client_version() IS 'Floor Bloom client version for cloud check-in operations. Bump via CREATE OR REPLACE FUNCTION when a breaking client-side protocol change ships. ClientOutOfDate (426) is raised when the caller''s clientVersion sorts below this.';

CREATE OR REPLACE FUNCTION tc.my_collections() RETURNS TABLE(id uuid, name text, created_at timestamp with time zone, created_by uuid, my_role tc.member_role, is_claimed boolean)
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT r.id, r.name, r.created_at, r.created_by, r.my_role, r.is_claimed
    FROM (
        -- One row per collection: the caller's joined membership if there is one, else the
        -- invitation to their current email.
        SELECT DISTINCT ON (c.id)
            c.id,
            c.name,
            c.created_at,
            c.created_by,
            m.role      AS my_role,
            (m.user_id IS NOT NULL) AS is_claimed
        FROM tc.collections c
        JOIN tc.members m
            ON m.collection_id = c.id
           AND (m.user_id = tc.current_user_id()
                OR (m.user_id IS NULL AND m.email = tc.current_user_email()))
        -- A collection still being uploaded is not joinable yet, even by its admin.
        WHERE NOT c.initial_upload_in_progress
        ORDER BY c.id, (m.user_id IS NOT NULL) DESC
    ) r
    ORDER BY r.name
$$;

COMMENT ON FUNCTION tc.my_collections() IS 'CONTRACTS.md: my_collections — the collections the caller has joined, or has an invitation to their current (token) email for, one row each. Leaves out collections whose initial upload is still in progress (tc.collections.initial_upload_in_progress), for everyone, the uploading admin included, so nobody joins a half-uploaded collection; they appear once finish_initial_upload clears the flag.';

CREATE OR REPLACE FUNCTION tc.nfc_normalize_book_name() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.name := normalize(NEW.name, NFC);
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tc.nfc_normalize_book_name() IS 'Trigger: NFC-normalize the book name before every insert or update.';

CREATE OR REPLACE FUNCTION tc.nfc_normalize_path() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.path := normalize(NEW.path, NFC);
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION tc.nfc_normalize_path() IS 'Trigger: NFC-normalize the file path before every insert or update.';

CREATE OR REPLACE FUNCTION tc.reap_expired_checkin_attempts() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_book_id uuid;
    v_count   integer := 0;
    v_updated integer;
BEGIN
    -- In book id order, like members_remove, so two sweeps (or a sweep and a member
    -- removal) take the book rows in the same order.
    FOR v_book_id IN
        SELECT DISTINCT book_id FROM tc.checkin_attempts
        WHERE status = 'open' AND expires_at < now()
        ORDER BY book_id
    LOOP
        PERFORM tc._checkin_reap_book(v_book_id);
        v_count := v_count + 1;
    END LOOP;

    UPDATE tc.collection_file_checkin_attempts
    SET status = 'expired'
    WHERE status = 'open' AND expires_at < now();
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    v_count := v_count + v_updated;

    -- A finished attempt is kept only for repeated finishes, which come from the same Bloom
    -- session (it keeps the attempt id in memory), so not past its expiry. Aborted and
    -- expired attempts are the orphaned-upload sweep's worklist; it deletes them
    -- (tc.forget_swept_attempts).
    DELETE FROM tc.checkin_attempts WHERE status = 'finished' AND expires_at < now();
    DELETE FROM tc.collection_file_checkin_attempts WHERE status = 'finished' AND expires_at < now();

    RETURN v_count;
END;
$$;

COMMENT ON FUNCTION tc.reap_expired_checkin_attempts() IS 'Expiry sweep for both attempts tables: reaps expired open check-in attempts (via _checkin_reap_book) and marks expired open collection-file sends, returning how many were reaped; also deletes finished attempts past their expiry. Called at the top of checkin_start_tx and collection_files_start_tx; also safe to run from a scheduled job if one is ever wired up (no pg_cron dependency here).';

CREATE OR REPLACE FUNCTION tc.support_delete_collection(p_collection_id uuid, p_dry_run boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_name   text;
    v_counts jsonb;
BEGIN
    IF p_collection_id IS NULL THEN
        RAISE EXCEPTION 'support_delete_collection: collection id required' USING ERRCODE = '22023';
    END IF;

    SELECT c.name INTO v_name FROM tc.collections c WHERE c.id = p_collection_id FOR UPDATE;

    IF NOT FOUND THEN
        -- Already gone (e.g. a re-run to finish the S3 part): nothing to do.
        RETURN jsonb_build_object('collectionId', p_collection_id, 'found', false,
                                  'deleted', false);
    END IF;

    SELECT jsonb_build_object(
        'members',                          (SELECT count(*) FROM tc.members WHERE collection_id = p_collection_id),
        'books',                            (SELECT count(*) FROM tc.books WHERE collection_id = p_collection_id),
        'book_files',                       (SELECT count(*) FROM tc.book_files f JOIN tc.books b ON b.id = f.book_id WHERE b.collection_id = p_collection_id),
        'checkin_attempts',                 (SELECT count(*) FROM tc.checkin_attempts WHERE collection_id = p_collection_id),
        'collection_files',                 (SELECT count(*) FROM tc.collection_files WHERE collection_id = p_collection_id),
        'collection_file_checkin_attempts', (SELECT count(*) FROM tc.collection_file_checkin_attempts WHERE collection_id = p_collection_id),
        'color_palette_entries',            (SELECT count(*) FROM tc.color_palette_entries WHERE collection_id = p_collection_id),
        'history_events',                   (SELECT count(*) FROM tc.history_events WHERE collection_id = p_collection_id)
    ) INTO v_counts;

    IF NOT p_dry_run THEN
        -- Everything goes with the collection row by ON DELETE CASCADE (the last-admin
        -- guard lets the members go once the collection row is gone). core.users rows stay:
        -- they are people, not part of the collection.
        DELETE FROM tc.collections WHERE id = p_collection_id;
    END IF;

    RETURN jsonb_build_object(
        'collectionId', p_collection_id,
        'name',         v_name,
        'found',        true,
        'deleted',      NOT p_dry_run,
        'rows',         v_counts
    );
END;
$$;

COMMENT ON FUNCTION tc.support_delete_collection(p_collection_id uuid, p_dry_run boolean) IS 'Support tool, SERVICE-ROLE only: permanently deletes a collection and every tc row that belongs to it (members, books, book_files, both attempts tables, collection files, palette entries, history events), e.g. a cloud collection whose initial upload failed. core.users rows are kept. Returns {collectionId, name, found, deleted, rows: {<table>: count}}; p_dry_run = true only counts. An unknown id returns found = false, so a re-run is harmless. Does NOT touch S3: team-collections/support/delete-collection.ps1 calls this and then deletes the tc/{collectionId}/ prefix. See GOING-LIVE.md "Deleting a failed migration".';

CREATE OR REPLACE FUNCTION tc.support_move_user_to_login(p_current_email text, p_authentication_id text, p_email text, p_dry_run boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_email text := tc._normalize_email(p_email);
    v_user  core.users%ROWTYPE;
    v_other uuid;
BEGIN
    IF tc._normalize_email(p_current_email) IS NULL OR tc._normalize_email(p_current_email) = ''
       OR p_authentication_id IS NULL OR btrim(p_authentication_id) = ''
       OR v_email IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'support_move_user_to_login: current email, authentication id and email are required'
            USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_user FROM core.users WHERE email = tc._normalize_email(p_current_email) FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'user_not_found: no user has the email %', tc._normalize_email(p_current_email)
            USING ERRCODE = 'P0002';
    END IF;

    -- Moving onto a login or an email that another row already has would be a merge of two
    -- users, which is a different job.
    SELECT u.id INTO v_other FROM core.users u
    WHERE u.authentication_id = p_authentication_id AND u.id <> v_user.id;
    IF FOUND THEN
        RAISE EXCEPTION 'login_has_user: that login already has user %; moving would be a merge', v_other
            USING ERRCODE = 'P0001';
    END IF;
    SELECT u.id INTO v_other FROM core.users u
    WHERE u.email = v_email AND u.id <> v_user.id;
    IF FOUND THEN
        RAISE EXCEPTION 'email_has_user: % already belongs to user %; moving would be a merge', v_email, v_other
            USING ERRCODE = 'P0001';
    END IF;

    IF NOT p_dry_run THEN
        UPDATE core.users
        SET    authentication_id = p_authentication_id,
               email             = v_email
        WHERE  id = v_user.id;
    END IF;

    RETURN jsonb_build_object(
        'userId',                 v_user.id,
        'moved',                  NOT p_dry_run,
        'oldAuthenticationId',    v_user.authentication_id,
        'oldEmail',               v_user.email,
        'authenticationId',       p_authentication_id,
        'email',                  v_email
    );
END;
$$;

COMMENT ON FUNCTION tc.support_move_user_to_login(p_current_email text, p_authentication_id text, p_email text, p_dry_run boolean) IS 'Support tool, SERVICE-ROLE only: moves the person whose core.users.email is p_current_email to a new login (a new Firebase account after an email change) by setting core.users.authentication_id and email, so their memberships, checkouts and history follow them. Refuses (P0001 login_has_user / email_has_user) if another row already has that login or email, which would make it a merge; no user with p_current_email P0002; missing arguments 22023. p_dry_run = true only checks. Returns {userId, moved, oldAuthenticationId, oldEmail, authenticationId, email}. Run by team-collections/support/move-user-to-login.ps1.';

CREATE OR REPLACE FUNCTION tc.support_set_admin(p_collection_id uuid, p_email text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_email text := tc._normalize_email(p_email);   -- match members_add's normalization
BEGIN
    IF v_email IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'support_set_admin: email required' USING ERRCODE = '22023';
    END IF;

    UPDATE tc.members
    SET    role = 'admin'
    WHERE  collection_id = p_collection_id
      AND  email = v_email;

    IF NOT FOUND THEN
        -- added_by NULL: added by the Bloom team, not by an admin of the collection.
        INSERT INTO tc.members (collection_id, email, role, added_by)
        VALUES (p_collection_id, v_email, 'admin', NULL);
    END IF;
END;
$$;

COMMENT ON FUNCTION tc.support_set_admin(p_collection_id uuid, p_email text) IS 'Admin-recovery tool: grants admin on a collection to an email, for the Bloom team to run with the SERVICE-ROLE key when a collection has lost its only reachable admin. NOT granted to authenticated; bypasses is_admin by design. Idempotent (promote existing member / insert new admin invitation, with added_by NULL). See GOING-LIVE.md "Admin recovery" runbook.';

CREATE OR REPLACE FUNCTION tc.undelete_book(p_collection_id uuid, p_instance_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id uuid;
    v_row     tc.books%ROWTYPE;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_admin(p_collection_id) THEN
        RAISE EXCEPTION 'admin_required' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM tc.books
    WHERE collection_id = p_collection_id AND instance_id = p_instance_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF v_row.deleted_at IS NULL THEN
        RAISE EXCEPTION 'not_deleted: book is not tombstoned' USING ERRCODE = 'P0001';
    END IF;

    UPDATE tc.books
    SET deleted_at = NULL
    WHERE id = v_row.id;

    -- Log the undelete as a Created event to make it visible in history
    INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name, message)
    VALUES (
        v_row.collection_id, v_row.id, 2, -- Created (reuse; undelete restores the book)
        v_user_id, v_row.name, 'undeleted'
    );
END;
$$;

COMMENT ON FUNCTION tc.undelete_book(p_collection_id uuid, p_instance_id uuid) IS 'CONTRACTS.md: undelete_book — admin-only; clears the tombstone; emits Created (type=2) with message ''undeleted''.';

CREATE OR REPLACE FUNCTION tc.unlock_book(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id    uuid;
    v_row        tc.books%ROWTYPE;
BEGIN
    v_user_id := tc.current_user_id();

    IF NOT tc.is_member(p_collection_id) THEN
        RAISE EXCEPTION 'not_a_member' USING ERRCODE = '42501';
    END IF;

    -- FOR UPDATE, as in delete_book: the checks below must still hold when the lock is
    -- cleared, or a new holder's checkout could be released.
    SELECT * INTO v_row FROM tc.books
    WHERE collection_id = p_collection_id AND instance_id = p_instance_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'book_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF v_row.locked_by IS DISTINCT FROM v_user_id THEN
        RAISE EXCEPTION 'lock_not_held: book is not locked by you' USING ERRCODE = 'P0001';
    END IF;

    -- Only the copy holding the checkout GUID may undo the checkout; another copy of the
    -- same user's would otherwise discard that copy's checkout behind its back.
    IF v_row.checkout_guid_hash IS NULL
       OR tc._checkout_guid_hash(p_checkout_guid) IS DISTINCT FROM v_row.checkout_guid_hash THEN
        RAISE EXCEPTION 'CheckoutElsewhere: this book is checked out to you in another copy'
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE tc.books
    SET    locked_by         = NULL,
           locked_by_machine = NULL,
           locked_at         = NULL
    WHERE  id = v_row.id;

    -- CheckOutReleased (type = 101): get_changes only returns books named by newer events,
    -- so without one, polling teammates would go on seeing the book checked out.
    INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
    VALUES (v_row.collection_id, v_row.id, 101, v_user_id, v_row.name);
END;
$$;

COMMENT ON FUNCTION tc.unlock_book(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text) IS 'CONTRACTS.md: unlock_book — release one''s own lock (undo checkout, no content change). Only the lock holder may call this, and only with the current checkout GUID (else CheckoutElsewhere); use force_unlock for admin override. Releasing the lock clears the GUID. Emits CheckOutReleased (type=101) so polling clients see the book unlocked.';


-- ==== 03_tables.sql ====

-- Team Collections cloud: tables, constraints, indexes, and triggers.
CREATE TABLE IF NOT EXISTS core.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    authentication_id text,
    email text NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_email_normalized CHECK ((email = tc._normalize_email(email)))
);

COMMENT ON TABLE core.users IS 'One row per person, with an id of Bloom''s own that never changes; every identity column in tc refers to users.id. Rows are created only when needed: claim_memberships (a verified sign-in with an invitation), create_collection (a collection''s first admin), and lock_book_for_legacy_checkout (an unclaimed user holding a checkout carried over from a folder Team Collection). Not exposed through PostgREST.';

COMMENT ON COLUMN core.users.authentication_id IS 'The sign-in identity: the JWT sub (a Firebase uid, or a local GoTrue user id). tc.current_user_id() looks the caller up here. NULL = an unclaimed user, whom nobody can sign in as; the first verified sign-in with its email claims it (claim_memberships). Changed only by the support function tc.support_move_user_to_login.';

COMMENT ON COLUMN core.users.email IS 'The person''s current sign-in email, lowercase and NFC (tc._normalize_email); unique. Refreshed from the token by claim_memberships.';

COMMENT ON COLUMN core.users.name IS 'The first and last name from the person''s Bloom Registration dialog, sent with claim_memberships at every sign-in. NULL = none known (an unclaimed user, or a person who has not signed in since being created); display falls back to email.';

CREATE TABLE IF NOT EXISTS tc.books (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    collection_id uuid NOT NULL,
    instance_id uuid NOT NULL,
    name text NOT NULL,
    current_version bigint,
    current_checksum text,
    locked_by uuid,
    locked_by_machine text,
    locked_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    checkout_guid_hash text
);

COMMENT ON TABLE tc.books IS 'Authoritative book state per collection: current version, lock and tombstone. The API names a book by (collection_id, instance_id); id is used only inside the database. All state transitions go through RPCs/edge functions; no direct writes via PostgREST.';

COMMENT ON COLUMN tc.books.instance_id IS 'The book''s Bloom instance id (from meta.json). Unique per collection, deleted books included (books_collection_instance_uq). Also the S3 prefix key (tc/{cid}/books/{instance_id}/).';

COMMENT ON COLUMN tc.books.name IS 'The name the book should have (from its title, or chosen with Rename), for display only: status, the join list, history. Not unique: each copy of the collection chooses its own folder names. NFC-normalized on write by the nfc_normalize_book_name trigger.';

COMMENT ON COLUMN tc.books.current_version IS 'The committed version number, increased by one at each commit (checkin_finish_tx). NULL = a first check-in is still in progress; such a book is invisible to everyone but its sender.';

COMMENT ON COLUMN tc.books.deleted_at IS 'Soft tombstone: non-NULL = deleted. A deleted book keeps its instance id.';

COMMENT ON COLUMN tc.books.locked_by IS 'core.users.id of the lock holder; NULL = not checked out. May be an unclaimed user (a checkout carried over from a folder Team Collection by lock_book_for_legacy_checkout), whom nobody can sign in as, so only claiming that user, checkout_book_takeover (with the GUID) or force_unlock ends such a lock.';

COMMENT ON COLUMN tc.books.locked_by_machine IS 'Name of the machine the lock was taken from. Display only: it grants nothing (the checkout GUID decides which local copy may check in).';

COMMENT ON COLUMN tc.books.checkout_guid_hash IS 'Lowercase hex SHA-256 of the UTF-8 bytes of the current checkout GUID (canonical lowercase form), i.e. tc._checkout_guid_hash(guid). The GUID itself is never stored: the client that checks the book out makes it, keeps it in the book folder''s .checkout file and sends it to checkout_book. NULL while locked = a send-only lock that checkin-start took for a first check-in or a check-in of a free book (released when that check-in finishes, aborts or expires). Check-in, unlock and delete by the holder, and takeover by another account, all require the GUID. Readable by members (a hash of 122 random bits cannot be reversed) and returned as checkoutGuidHash by get_collection_state/get_changes so a client can tell whether its local .checkout is still current. NULL = unlocked. Cleared by the books_clear_checkout_on_unlock trigger whenever the lock is released or changes hands without a new GUID.';

CREATE TABLE IF NOT EXISTS tc.book_files (
    book_id uuid NOT NULL,
    path text NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    s3_version_id text NOT NULL
);

COMMENT ON TABLE tc.book_files IS 'The files that make up each book now: path -> sha256, size, s3_version_id. Replaced as a whole by each commit (checkin_finish_tx). Reads always use (path, s3_version_id). The main .htm is stored as index.htm.';

CREATE TABLE IF NOT EXISTS tc.checkin_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    collection_id uuid NOT NULL,
    book_id uuid NOT NULL,
    started_by uuid NOT NULL,
    proposed_name text NOT NULL,
    base_book_version bigint,
    changed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    client_version text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '48:00:00'::interval) NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    proposed_files jsonb DEFAULT '[]'::jsonb NOT NULL,
    checksum text,
    resulting_book_version bigint,
    checkout_guid_hash text,
    CONSTRAINT checkin_attempts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'finished'::text, 'aborted'::text, 'expired'::text])))
);

COMMENT ON TABLE tc.checkin_attempts IS 'Check-in attempts in progress or recently ended (checkin-start -> checkin-finish); the id travels as transactionId. A start resumes the caller''s open attempt for the book only if its proposal is identical, and otherwise aborts it and opens a new one, so a finish commits only the proposal of the start that returned its id. expires_at = 48 h after the latest start. The reaper (tc.reap_expired_checkin_attempts) marks open attempts past expiry expired and deletes finished ones past expiry; the orphaned-upload sweep deletes aborted and expired ones once it has deleted their uploads (tc.forget_swept_attempts). An open attempt for a new book means the book row has no current_version and is invisible to teammates until checkin-finish commits it.';

COMMENT ON COLUMN tc.checkin_attempts.base_book_version IS 'The book''s current_version when the attempt started (NULL for a first check-in). checkin_finish_tx refuses (BaseVersionSuperseded) unless the book is still at it.';

COMMENT ON COLUMN tc.checkin_attempts.proposed_files IS 'Full proposed manifest [{path,sha256,size}] captured at checkin-start, paths NFC and sorted; checkin-finish builds the committed manifest from this + changed_paths + the S3 version-ids captured after upload verification.';

COMMENT ON COLUMN tc.checkin_attempts.checksum IS 'Checksum of the full proposed manifest, supplied at checkin-start and stored as tc.books.current_checksum on finish.';

COMMENT ON COLUMN tc.checkin_attempts.resulting_book_version IS 'Set on a successful finish; makes a repeated checkin-finish for an already-finished attempt idempotent (it returns the same version).';

COMMENT ON COLUMN tc.checkin_attempts.checkout_guid_hash IS 'The book''s checkout_guid_hash as checkin-start saw it (NULL for a send-only lock). checkin-finish refuses (CheckoutElsewhere) unless the book still has this hash, so a checkout that moved to another copy (takeover, force-unlock and re-checkout) in between cannot be committed over.';

CREATE TABLE IF NOT EXISTS tc.collection_file_checkin_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    collection_id uuid NOT NULL,
    started_by uuid NOT NULL,
    expected_version bigint NOT NULL,
    proposed_files jsonb DEFAULT '[]'::jsonb NOT NULL,
    changed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '48:00:00'::interval) NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    resulting_version bigint,
    CONSTRAINT collection_file_checkin_attempts_status_check CHECK ((status = ANY (ARRAY['open'::text, 'finished'::text, 'aborted'::text, 'expired'::text])))
);

COMMENT ON TABLE tc.collection_file_checkin_attempts IS 'Collection-file sends in progress or recently ended (collection-files-start -> collection-files-finish). Mirrors tc.checkin_attempts, for the collection''s one set of collection files: the same resume-only-if-identical rule, expiry and clean-up.';

CREATE TABLE IF NOT EXISTS tc.collection_files (
    collection_id uuid NOT NULL,
    path text NOT NULL,
    sha256 text NOT NULL,
    size_bytes bigint NOT NULL,
    s3_version_id text NOT NULL
);

COMMENT ON TABLE tc.collection_files IS 'The collection''s current collection files (the non-book shared files: .bloomCollection, custom styles, configuration.txt, reader-tools settings, Allowed Words, Sample Texts), paths relative to the collection folder, NFC. Replaced as a whole by collection-files-finish; the version is tc.collections.collection_files_version.';

CREATE TABLE IF NOT EXISTS tc.collections (
    id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid NOT NULL,
    initial_upload_in_progress boolean DEFAULT false NOT NULL,
    collection_files_version bigint DEFAULT 0 NOT NULL,
    collection_files_updated_at timestamp with time zone,
    collection_files_updated_by uuid
);

COMMENT ON TABLE tc.collections IS 'One row per cloud Team Collection. id = Bloom CollectionId GUID.';

COMMENT ON COLUMN tc.collections.id IS 'The collection UUID — same value as in TeamCollectionLink.txt (cloud://sil.bloom/collection/<id>).';

COMMENT ON COLUMN tc.collections.initial_upload_in_progress IS 'TRUE while the admin who started the collection (sharing an ordinary collection or migrating a folder Team Collection) is still uploading its books and collection files. Set only at creation (create_collection with p_initial_upload = true) and cleared, once and for good, by finish_initial_upload. While it is set my_collections leaves the collection out (so invitees cannot join a half-uploaded collection) and lock_book_for_legacy_checkout may lock books to unclaimed users. Returned by get_collection_state and get_changes as initial_upload_in_progress.';

COMMENT ON COLUMN tc.collections.collection_files_version IS 'Version of the collection files, 0 = never sent. collection-files-finish increases it by one; a start or finish whose expectedVersion differs is refused with VersionConflict (the repository wins).';

CREATE TABLE IF NOT EXISTS tc.color_palette_entries (
    id bigint NOT NULL,
    collection_id uuid NOT NULL,
    palette text NOT NULL,
    color text NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by uuid NOT NULL
);

COMMENT ON TABLE tc.color_palette_entries IS 'Color palette entries per collection. Merge is union-only: insert ... on conflict do nothing. No rows are ever deleted.';

ALTER TABLE tc.color_palette_entries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME tc.color_palette_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE IF NOT EXISTS tc.history_events (
    id bigint NOT NULL,
    collection_id uuid NOT NULL,
    book_id uuid,
    type integer NOT NULL,
    by_user_id uuid NOT NULL,
    book_version bigint,
    lock_info jsonb,
    book_name text,
    message text,
    bloom_version text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT history_events_type_check CHECK ((type = ANY (ARRAY[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100, 101, 102]))),
    CONSTRAINT history_events_collection_files_no_book CHECK (((type <> 102) OR (book_id IS NULL)))
);

COMMENT ON TABLE tc.history_events IS 'Each collection''s history log, realtime broadcast source, and polling change feed. type values mirror C# BookHistoryEventType (HistoryEvent.cs): 0=CheckOut, 1=CheckIn, 2=Created, 3=Renamed, 4=Uploaded(legacy), 5=ForcedUnlock, 6=ImportSpreadsheet, 7=SyncProblem(legacy), 8=Deleted, 9=Moved. Cloud-TC extensions start at 100 to avoid colliding with future C# additions: 100=WorkPreservedLocally, 101=CheckOutReleased (a lock released without a check-in by its holder: unlock_book, or an aborted or expired check-in''s send-only lock), 102=CollectionFilesCheckIn (a collection-files send committed; it has no book). Authors are shown by their current core.users.name.';

COMMENT ON COLUMN tc.history_events.book_name IS 'The book''s name at the time of the event, so history reads sensibly after a rename or a delete.';

-- Not an identity column: a default is evaluated before BEFORE triggers run, and the id must
-- be drawn only once the event-order lock is held (history_events_assign_id_tg).
CREATE SEQUENCE IF NOT EXISTS tc.history_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE tc.history_events_id_seq OWNED BY tc.history_events.id;

COMMENT ON COLUMN tc.history_events.id IS 'The polling cursor. Assigned from tc.history_events_id_seq by the history_events_assign_id_tg trigger (tc._history_events_assign_id) while the collection''s event-order lock is held, so get_changes/get_collection_state never return a max_event_id past an event that commits later; an explicit id is refused.';

CREATE TABLE IF NOT EXISTS tc.members (
    id bigint NOT NULL,
    collection_id uuid NOT NULL,
    email text NOT NULL,
    role tc.member_role DEFAULT 'member'::tc.member_role NOT NULL,
    user_id uuid,
    added_by uuid,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    last_seen_at timestamp with time zone,
    CONSTRAINT members_email_normalized CHECK ((email = tc._normalize_email(email)))
);

COMMENT ON TABLE tc.members IS 'Approved-accounts table. Unclaimed rows (user_id IS NULL) are invitations pending until the person signs in with a verified email and calls claim_memberships().';

COMMENT ON COLUMN tc.members.email IS 'The address the person was invited by, lowercase and NFC (tc._normalize_email). Once the row is claimed, the person''s current email is core.users.email.';

COMMENT ON COLUMN tc.members.user_id IS 'core.users.id of the person who claimed the invitation; NULL until claimed.';

COMMENT ON COLUMN tc.members.added_by IS 'core.users.id of the admin who added the row; NULL for a row the Bloom team added (support_set_admin).';

COMMENT ON COLUMN tc.members.last_seen_at IS 'The last time this member had THIS collection open in Bloom (per membership, so work in another collection does not count), to 10-minute granularity. Set by tc._touch_member, which get_collection_state (opening or re-syncing the collection) and get_changes (the 60-second poll and reconnect catch-up) call; written at most once per 10 minutes per member. NULL = never seen (invited only). Returned by members_list for the Share dialog''s "Last seen".';

ALTER TABLE tc.members ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME tc.members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_authentication_id_uq UNIQUE (authentication_id);

COMMENT ON CONSTRAINT users_authentication_id_uq ON core.users IS 'One row per sign-in identity. Unclaimed users (NULL) do not collide (default NULLS DISTINCT).';

ALTER TABLE ONLY core.users
    ADD CONSTRAINT users_email_uq UNIQUE (email);

ALTER TABLE ONLY tc.books
    ADD CONSTRAINT books_collection_instance_uq UNIQUE (collection_id, instance_id);

ALTER TABLE ONLY tc.books
    ADD CONSTRAINT books_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tc.book_files
    ADD CONSTRAINT book_files_pkey PRIMARY KEY (book_id, path);

ALTER TABLE ONLY tc.checkin_attempts
    ADD CONSTRAINT checkin_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tc.collection_file_checkin_attempts
    ADD CONSTRAINT collection_file_checkin_attempts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tc.collection_files
    ADD CONSTRAINT collection_files_pkey PRIMARY KEY (collection_id, path);

ALTER TABLE ONLY tc.collections
    ADD CONSTRAINT collections_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tc.color_palette_entries
    ADD CONSTRAINT color_palette_entries_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tc.color_palette_entries
    ADD CONSTRAINT color_palette_entries_uq UNIQUE (collection_id, palette, color);

ALTER TABLE ONLY tc.history_events
    ADD CONSTRAINT history_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tc.members
    ADD CONSTRAINT members_claimed_user_uq UNIQUE (collection_id, user_id);

COMMENT ON CONSTRAINT members_claimed_user_uq ON tc.members IS 'A claimed user appears at most once per collection. NULL user_id rows (pending invitations) do not collide (default NULLS DISTINCT).';

ALTER TABLE ONLY tc.members
    ADD CONSTRAINT members_collection_email_uq UNIQUE (collection_id, email);

ALTER TABLE ONLY tc.members
    ADD CONSTRAINT members_pkey PRIMARY KEY (id);

CREATE INDEX books_locked_by_idx ON tc.books USING btree (locked_by) WHERE (locked_by IS NOT NULL);

CREATE INDEX checkin_attempts_book_id_idx ON tc.checkin_attempts USING btree (book_id);

CREATE INDEX checkin_attempts_expires_at_idx ON tc.checkin_attempts USING btree (expires_at) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX checkin_attempts_one_open_uq ON tc.checkin_attempts USING btree (book_id, started_by) WHERE (status = 'open'::text);

COMMENT ON INDEX tc.checkin_attempts_one_open_uq IS 'A person has at most one open check-in attempt per book: checkin_start_tx resumes it or aborts it before opening another.';

CREATE INDEX collection_file_checkin_attempts_collection_id_idx ON tc.collection_file_checkin_attempts USING btree (collection_id);

CREATE INDEX collection_file_checkin_attempts_expires_at_idx ON tc.collection_file_checkin_attempts USING btree (expires_at) WHERE (status = 'open'::text);

CREATE UNIQUE INDEX collection_file_checkin_attempts_one_open_uq ON tc.collection_file_checkin_attempts USING btree (collection_id, started_by) WHERE (status = 'open'::text);

COMMENT ON INDEX tc.collection_file_checkin_attempts_one_open_uq IS 'A person has at most one open collection-files send per collection: collection_files_start_tx resumes it or aborts it before opening another.';

CREATE INDEX history_events_book_id_idx ON tc.history_events USING btree (book_id) WHERE (book_id IS NOT NULL);

CREATE INDEX history_events_collection_cursor_idx ON tc.history_events USING btree (collection_id, id);

CREATE INDEX members_email_idx ON tc.members USING btree (email);

CREATE INDEX members_user_id_idx ON tc.members USING btree (user_id) WHERE (user_id IS NOT NULL);

CREATE OR REPLACE TRIGGER books_clear_checkout_on_unlock BEFORE UPDATE ON tc.books FOR EACH ROW EXECUTE FUNCTION tc._clear_checkout_on_unlock();

CREATE OR REPLACE TRIGGER books_nfc_normalize_name_tg BEFORE INSERT OR UPDATE OF name ON tc.books FOR EACH ROW EXECUTE FUNCTION tc.nfc_normalize_book_name();

CREATE OR REPLACE TRIGGER book_files_nfc_normalize_path_tg BEFORE INSERT OR UPDATE OF path ON tc.book_files FOR EACH ROW EXECUTE FUNCTION tc.nfc_normalize_path();

CREATE OR REPLACE TRIGGER collection_files_nfc_normalize_path_tg BEFORE INSERT OR UPDATE OF path ON tc.collection_files FOR EACH ROW EXECUTE FUNCTION tc.nfc_normalize_path();

CREATE OR REPLACE TRIGGER history_events_assign_id_tg BEFORE INSERT ON tc.history_events FOR EACH ROW EXECUTE FUNCTION tc._history_events_assign_id();

CREATE OR REPLACE TRIGGER history_events_realtime_broadcast_tg AFTER INSERT ON tc.history_events FOR EACH ROW EXECUTE FUNCTION tc.history_events_realtime_broadcast();

CREATE OR REPLACE TRIGGER members_last_admin_guard_tg BEFORE DELETE OR UPDATE ON tc.members FOR EACH ROW EXECUTE FUNCTION tc.members_last_admin_guard();

ALTER TABLE ONLY tc.books
    ADD CONSTRAINT books_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.books
    ADD CONSTRAINT books_locked_by_fkey FOREIGN KEY (locked_by) REFERENCES core.users(id);

ALTER TABLE ONLY tc.book_files
    ADD CONSTRAINT book_files_book_id_fkey FOREIGN KEY (book_id) REFERENCES tc.books(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.checkin_attempts
    ADD CONSTRAINT checkin_attempts_book_id_fkey FOREIGN KEY (book_id) REFERENCES tc.books(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.checkin_attempts
    ADD CONSTRAINT checkin_attempts_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.checkin_attempts
    ADD CONSTRAINT checkin_attempts_started_by_fkey FOREIGN KEY (started_by) REFERENCES core.users(id);

ALTER TABLE ONLY tc.collection_file_checkin_attempts
    ADD CONSTRAINT collection_file_checkin_attempts_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.collection_file_checkin_attempts
    ADD CONSTRAINT collection_file_checkin_attempts_started_by_fkey FOREIGN KEY (started_by) REFERENCES core.users(id);

ALTER TABLE ONLY tc.collection_files
    ADD CONSTRAINT collection_files_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.collections
    ADD CONSTRAINT collections_created_by_fkey FOREIGN KEY (created_by) REFERENCES core.users(id);

ALTER TABLE ONLY tc.collections
    ADD CONSTRAINT collections_collection_files_updated_by_fkey FOREIGN KEY (collection_files_updated_by) REFERENCES core.users(id);

ALTER TABLE ONLY tc.color_palette_entries
    ADD CONSTRAINT color_palette_entries_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.color_palette_entries
    ADD CONSTRAINT color_palette_entries_added_by_fkey FOREIGN KEY (added_by) REFERENCES core.users(id);

ALTER TABLE ONLY tc.history_events
    ADD CONSTRAINT history_events_book_id_fkey FOREIGN KEY (book_id) REFERENCES tc.books(id) ON DELETE SET NULL;

ALTER TABLE ONLY tc.history_events
    ADD CONSTRAINT history_events_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.history_events
    ADD CONSTRAINT history_events_by_user_id_fkey FOREIGN KEY (by_user_id) REFERENCES core.users(id);

ALTER TABLE ONLY tc.members
    ADD CONSTRAINT members_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES tc.collections(id) ON DELETE CASCADE;

ALTER TABLE ONLY tc.members
    ADD CONSTRAINT members_user_id_fkey FOREIGN KEY (user_id) REFERENCES core.users(id);

ALTER TABLE ONLY tc.members
    ADD CONSTRAINT members_added_by_fkey FOREIGN KEY (added_by) REFERENCES core.users(id);


-- ==== 04_security.sql ====

-- Team Collections cloud: row-level security (enable + policies) and grants.
-- Writes go through SECURITY DEFINER RPCs, so most tables expose only SELECT to
-- `authenticated`; anon gets nothing.
--
-- Who may call which RPC: everything a member could safely do by calling it directly is
-- granted to `authenticated` and reads the caller from their own JWT (auth.jwt()),
-- including the edge functions' start/abort RPCs, which the edge functions call with the
-- caller's forwarded token. The finish RPCs are different: they commit S3 version-ids
-- that only the edge function has verified, so they are granted to `service_role` alone,
-- the edge functions call them with the service-role key, and the caller's identity is a
-- parameter the edge function first established from the caller's JWT (tc.current_caller).
-- Operational tools (sweep, admin recovery, support scripts) are service_role-only too.
--
-- core.users is reached only through SECURITY DEFINER functions: no role but its owner has
-- any privilege on the core schema, and it is not exposed through PostgREST.
ALTER TABLE core.users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA core FROM PUBLIC, anon, authenticated;

REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC, anon, authenticated;

ALTER TABLE tc.books ENABLE ROW LEVEL SECURITY;

CREATE POLICY books_select ON tc.books FOR SELECT USING (tc.is_member(collection_id));

ALTER TABLE tc.book_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY book_files_select ON tc.book_files FOR SELECT USING ((EXISTS ( SELECT 1
   FROM tc.books b
  WHERE ((b.id = book_files.book_id) AND tc.is_member(b.collection_id)))));

ALTER TABLE tc.checkin_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY checkin_attempts_select ON tc.checkin_attempts FOR SELECT USING ((started_by = tc.current_user_id()));

ALTER TABLE tc.collection_file_checkin_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY collection_file_checkin_attempts_select ON tc.collection_file_checkin_attempts FOR SELECT USING ((started_by = tc.current_user_id()));

ALTER TABLE tc.collection_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY collection_files_select ON tc.collection_files FOR SELECT USING (tc.is_member(collection_id));

ALTER TABLE tc.collections ENABLE ROW LEVEL SECURITY;

CREATE POLICY collections_select ON tc.collections FOR SELECT USING (tc.is_member(id));

ALTER TABLE tc.color_palette_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY color_palette_entries_insert ON tc.color_palette_entries FOR INSERT WITH CHECK (tc.is_member(collection_id));

CREATE POLICY color_palette_entries_select ON tc.color_palette_entries FOR SELECT USING (tc.is_member(collection_id));

ALTER TABLE tc.history_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY history_events_insert ON tc.history_events FOR INSERT WITH CHECK ((tc.is_member(collection_id) AND (by_user_id = tc.current_user_id())));

CREATE POLICY history_events_select ON tc.history_events FOR SELECT USING (tc.is_member(collection_id));

ALTER TABLE tc.members ENABLE ROW LEVEL SECURITY;

CREATE POLICY members_delete ON tc.members FOR DELETE USING (tc.is_admin(collection_id));

CREATE POLICY members_insert ON tc.members FOR INSERT WITH CHECK (tc.is_admin(collection_id));

CREATE POLICY members_select ON tc.members FOR SELECT USING (tc.is_member(collection_id));

CREATE POLICY members_update ON tc.members FOR UPDATE USING (tc.is_admin(collection_id)) WITH CHECK (tc.is_admin(collection_id));

GRANT USAGE ON SCHEMA tc TO authenticated;

-- The service role calls only the service-role-only SECURITY DEFINER functions below
-- (finish RPCs, sweep worklist/re-check/clean-up, support functions); it needs the schema.
GRANT USAGE ON SCHEMA tc TO service_role;

-- Internal: only SECURITY DEFINER functions call these.
REVOKE ALL ON FUNCTION tc._touch_member(p_collection_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tc._claim_current_user(p_name text, p_create boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tc._checkin_reap_book(p_book_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tc._lock_holder_json(p_user_id uuid, p_machine text, p_locked_at timestamp with time zone) FROM PUBLIC, anon, authenticated;

GRANT ALL ON FUNCTION tc.add_palette_colors(p_collection_id uuid, p_palette text, p_colors text[]) TO authenticated;

GRANT ALL ON FUNCTION tc.checkin_abort_tx(p_transaction_id uuid) TO authenticated;

-- The finish RPCs record S3 version-ids as verified, trusting their p_captured argument,
-- and take the caller's identity as a parameter; only the finish edge functions, which
-- verify those uploads against S3 first and establish the caller from their own JWT, may
-- call them (with the service-role key). Granted to authenticated they would let a member
-- commit arbitrary, unverified version-ids straight to the shared manifest.
REVOKE ALL ON FUNCTION tc.checkin_finish_tx(p_transaction_id uuid, p_user_id uuid, p_comment text, p_keep_checked_out boolean, p_captured jsonb) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION tc.checkin_finish_tx(p_transaction_id uuid, p_user_id uuid, p_comment text, p_keep_checked_out boolean, p_captured jsonb) TO service_role;

GRANT ALL ON FUNCTION tc.checkin_start_tx(p_collection_id uuid, p_instance_id uuid, p_proposed_name text, p_base_version bigint, p_checksum text, p_client_version text, p_files jsonb, p_checkout_guid text) TO authenticated;

GRANT ALL ON FUNCTION tc.checkout_book(p_collection_id uuid, p_instance_id uuid, p_machine text, p_checkout_guid text) TO authenticated;

GRANT ALL ON FUNCTION tc.checkout_book_takeover(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text, p_machine text) TO authenticated;

GRANT ALL ON FUNCTION tc.claim_memberships(p_name text) TO authenticated;

-- Service-role only, for the same reason as checkin_finish_tx above.
REVOKE ALL ON FUNCTION tc.collection_files_finish_tx(p_transaction_id uuid, p_user_id uuid, p_captured jsonb) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION tc.collection_files_finish_tx(p_transaction_id uuid, p_user_id uuid, p_captured jsonb) TO service_role;

GRANT ALL ON FUNCTION tc.collection_files_start_tx(p_collection_id uuid, p_expected_version bigint, p_files jsonb) TO authenticated;

GRANT ALL ON FUNCTION tc.create_collection(p_id uuid, p_name text, p_initial_upload boolean) TO authenticated;

GRANT ALL ON FUNCTION tc.current_caller() TO authenticated;

GRANT ALL ON FUNCTION tc.delete_book(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text) TO authenticated;

GRANT ALL ON FUNCTION tc.download_start_check(p_collection_id uuid) TO authenticated;

GRANT ALL ON FUNCTION tc.finish_initial_upload(p_collection_id uuid) TO authenticated;
GRANT ALL ON FUNCTION tc.force_unlock(p_collection_id uuid, p_instance_id uuid) TO authenticated;

REVOKE ALL ON FUNCTION tc.forget_swept_attempts(p_cutoff timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION tc.forget_swept_attempts(p_cutoff timestamp with time zone) TO service_role;

GRANT ALL ON FUNCTION tc.get_book_manifest(p_collection_id uuid, p_instance_id uuid) TO authenticated;

GRANT ALL ON FUNCTION tc.get_changes(p_collection_id uuid, p_since_event_id bigint) TO authenticated;

GRANT ALL ON FUNCTION tc.get_collection_file_manifest(p_collection_id uuid) TO authenticated;

GRANT ALL ON FUNCTION tc.get_collection_state(p_collection_id uuid, p_since_event_id bigint) TO authenticated;

REVOKE ALL ON FUNCTION tc.list_stale_upload_garbage() FROM PUBLIC;
GRANT ALL ON FUNCTION tc.list_stale_upload_garbage() TO service_role;

REVOKE ALL ON FUNCTION tc.list_stale_upload_keys(p_after_key text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION tc.list_stale_upload_keys(p_after_key text, p_limit integer) TO service_role;

REVOKE ALL ON FUNCTION tc.stale_upload_key_state(p_s3_key text) FROM PUBLIC;
GRANT ALL ON FUNCTION tc.stale_upload_key_state(p_s3_key text) TO service_role;

GRANT ALL ON FUNCTION tc.lock_book_for_legacy_checkout(p_collection_id uuid, p_instance_id uuid, p_legacy_email text, p_checkout_guid text, p_machine text) TO authenticated;
GRANT ALL ON FUNCTION tc.log_event(p_collection_id uuid, p_instance_id uuid, p_type integer, p_message text, p_book_name text, p_bloom_version text) TO authenticated;

GRANT ALL ON FUNCTION tc.members_add(p_collection_id uuid, p_email text, p_role tc.member_role) TO authenticated;

GRANT ALL ON FUNCTION tc.members_list(p_collection_id uuid) TO authenticated;

GRANT ALL ON FUNCTION tc.members_remove(p_collection_id uuid, p_member_id bigint) TO authenticated;

GRANT ALL ON FUNCTION tc.members_set_role(p_collection_id uuid, p_member_id bigint, p_new_role tc.member_role) TO authenticated;

GRANT ALL ON FUNCTION tc.my_collections() TO authenticated;

GRANT ALL ON FUNCTION tc.reap_expired_checkin_attempts() TO authenticated;

-- Deletes a whole collection's rows: the Bloom team's support tool, never a client's.
REVOKE ALL ON FUNCTION tc.support_delete_collection(p_collection_id uuid, p_dry_run boolean) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION tc.support_delete_collection(p_collection_id uuid, p_dry_run boolean) TO service_role;
REVOKE ALL ON FUNCTION tc.support_move_user_to_login(p_current_email text, p_authentication_id text, p_email text, p_dry_run boolean) FROM PUBLIC, anon, authenticated;
GRANT ALL ON FUNCTION tc.support_move_user_to_login(p_current_email text, p_authentication_id text, p_email text, p_dry_run boolean) TO service_role;
REVOKE ALL ON FUNCTION tc.support_set_admin(p_collection_id uuid, p_email text) FROM PUBLIC;
GRANT ALL ON FUNCTION tc.support_set_admin(p_collection_id uuid, p_email text) TO service_role;

GRANT ALL ON FUNCTION tc.undelete_book(p_collection_id uuid, p_instance_id uuid) TO authenticated;

GRANT ALL ON FUNCTION tc.unlock_book(p_collection_id uuid, p_instance_id uuid, p_checkout_guid text) TO authenticated;

-- Listed column by column so that a column added later is not member-readable until it is
-- added here. checkout_guid_hash is readable on purpose: it is a hash of 122 random bits,
-- and clients compare it with their local .checkout file (CONTRACTS.md, "Checkout GUID").
GRANT SELECT (id, collection_id, instance_id, name, current_version, current_checksum,
              locked_by, locked_by_machine, locked_at, deleted_at, created_at,
              checkout_guid_hash) ON TABLE tc.books TO authenticated;

GRANT SELECT ON TABLE tc.book_files TO authenticated;

GRANT SELECT ON TABLE tc.checkin_attempts TO authenticated;

GRANT SELECT ON TABLE tc.collection_file_checkin_attempts TO authenticated;

GRANT SELECT ON TABLE tc.collection_files TO authenticated;

GRANT SELECT ON TABLE tc.collections TO authenticated;

GRANT SELECT,INSERT ON TABLE tc.color_palette_entries TO authenticated;

GRANT USAGE ON SEQUENCE tc.color_palette_entries_id_seq TO authenticated;

GRANT SELECT,INSERT ON TABLE tc.history_events TO authenticated;

GRANT USAGE ON SEQUENCE tc.history_events_id_seq TO authenticated;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tc.members TO authenticated;

GRANT USAGE ON SEQUENCE tc.members_id_seq TO authenticated;

-- Defense in depth: anon holds no privileges anywhere in tc.
REVOKE ALL ON ALL TABLES IN SCHEMA tc FROM anon;

-- Realtime (CONTRACTS.md §Realtime): tc.history_events_realtime_broadcast sends each event on
-- the PRIVATE broadcast channel collection:{collection_id}; the Realtime server lets a
-- signed-in user join a private channel only if this policy lets them read its messages,
-- i.e. only a member of that collection. realtime.messages belongs to the Realtime service,
-- so where it is not installed (a database started without Realtime) there is nothing to
-- protect. The CASE keeps the uuid cast away from any other topic.
DO $$
BEGIN
    IF to_regclass('realtime.messages') IS NOT NULL THEN
        DROP POLICY IF EXISTS tc_members_receive_collection_broadcasts ON realtime.messages;
        CREATE POLICY tc_members_receive_collection_broadcasts ON realtime.messages
            FOR SELECT TO authenticated
            USING (
                realtime.messages.extension = 'broadcast'
                AND CASE
                    WHEN realtime.topic() ~ '^collection:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                        THEN tc.is_member(substr(realtime.topic(), 12)::uuid)
                    ELSE false
                END
            );
    END IF;
END;
$$;
