-- =============================================================================
-- pgTAP tests: the two-phase check-in / collection-files RPCs.
--   1-2. the finish RPCs are service-role only; tc.current_caller reports the caller's user id
--   3-4. paths are NFC-normalized at start and committed under that spelling; versions are
--        numbers per book
--   5.   finish re-checks the lock, the checkout GUID and the base version (no stale overwrite)
--   6.   book names are not unique: a rename to another book's name is accepted
--   7.   malformed / colliding manifests are refused at start
--   8.   collection files: admin only, NFC at start, service-role finish, idempotent retry,
--        a CollectionFilesCheckIn event with no book
--   9.   the row locks that make start/finish race-safe are present
--   10.  the sweep's paged worklist and per-key re-check
--   11.  aborting an expired new-book check-in, and retrying that abort
--   12-13. the checkout GUID at start: required for one's own checkout, never issued; a free
--        or new book is locked for the send only (no hash)
--   14.  an admin force-unlocks without the GUID; the old holder's check-in is refused
--   15-16. a start resumes an open attempt only if identical; otherwise it aborts it, and
--        the old attempt's finish answers transaction_aborted
--   17.  start taking a free lock emits a CheckOut event; abort and expiry release it
--   18.  a deleted book can't be checked in to
--   19.  realtime broadcast on collection:{uuid} (skipped without the Realtime service)
--   20.  undoing a checkout records CheckOutReleased, so polling sees the book unlocked
--   21.  the reaper deletes finished attempts past their expiry
-- (The edge functions call the finish RPCs with the service-role key; here the suite's
-- postgres role stands in for it and passes the caller's user id explicitly.)
-- =============================================================================
-- Run against a local Supabase stack:
--   supabase start
--   supabase test db
-- =============================================================================

BEGIN;

SELECT plan(109);

CREATE SCHEMA IF NOT EXISTS tests;

CREATE OR REPLACE FUNCTION tests.set_jwt(
    p_sub   text,
    p_email text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM set_config(
        'request.jwt.claims',
        json_build_object(
            'sub',            p_sub,
            'email',          p_email,
            'email_verified', true,
            'role',           'authenticated',
            'aud',            'authenticated'
        )::text,
        true
    );
END;
$$;

-- The stored form of a checkout GUID as the contract defines it (lowercase hex SHA-256 of
-- the lowercase GUID), computed independently of tc._checkout_guid_hash.
CREATE OR REPLACE FUNCTION tests.guid_hash(p_guid text)
RETURNS text
LANGUAGE sql
AS $$
    SELECT encode(sha256(convert_to(lower(p_guid), 'UTF8')), 'hex')
$$;

-- What a client does to check a book out: make a GUID, then send it. Returns the GUID when the
-- checkout succeeded, else NULL.
CREATE OR REPLACE FUNCTION tests.checkout(p_instance_id uuid, p_machine text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
    v_guid text := gen_random_uuid()::text;
BEGIN
    IF (tc.checkout_book((SELECT collection_id FROM tc.books WHERE instance_id = p_instance_id),
                         p_instance_id, p_machine, v_guid) ->> 'success') = 'true' THEN
        RETURN v_guid;
    END IF;
    RETURN NULL;
END;
$$;

-- The core.users id of the person signed in as p_sub.
CREATE OR REPLACE FUNCTION tests.uid(p_sub text)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT id FROM core.users WHERE authentication_id = p_sub
$$;

-- Composed vs decomposed spellings of "café.htm" (é = U+00E9, or e + U+0301).
SELECT set_config('tests.nfc', U&'caf\00E9.htm', true);
SELECT set_config('tests.nfd', U&'cafe\0301.htm', true);

-- =============================================================================
-- 1. Privileges: the finish RPCs trust the S3 version-ids they are given, so only the
--    service role (the finish edge functions) may execute them.
-- =============================================================================

SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.checkin_finish_tx(uuid, uuid, text, boolean, jsonb)', 'EXECUTE'),
    '1a: authenticated cannot execute checkin_finish_tx'
);
SELECT ok(
    NOT has_function_privilege('anon', 'tc.checkin_finish_tx(uuid, uuid, text, boolean, jsonb)', 'EXECUTE'),
    '1b: anon cannot execute checkin_finish_tx'
);
SELECT ok(
    has_function_privilege('service_role', 'tc.checkin_finish_tx(uuid, uuid, text, boolean, jsonb)', 'EXECUTE'),
    '1c: service_role can execute checkin_finish_tx'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.collection_files_finish_tx(uuid, uuid, jsonb)', 'EXECUTE'),
    '1d: authenticated cannot execute collection_files_finish_tx'
);
SELECT ok(
    has_function_privilege('service_role', 'tc.collection_files_finish_tx(uuid, uuid, jsonb)', 'EXECUTE'),
    '1e: service_role can execute collection_files_finish_tx'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.stale_upload_key_state(text)', 'EXECUTE'),
    '1f: authenticated cannot execute stale_upload_key_state (sweep, service-role only)'
);

-- And a direct call as a signed-in member really is refused.
SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SET LOCAL ROLE authenticated;
SELECT throws_ok(
    $$SELECT tc.checkin_finish_tx('00000000-0000-0000-0000-000000000000', gen_random_uuid(), NULL, false, '[]')$$,
    '42501',
    NULL,
    '1g: a member calling checkin_finish_tx directly gets permission denied'
);
SELECT throws_ok(
    $$SELECT tc.collection_files_finish_tx('00000000-0000-0000-0000-000000000000', gen_random_uuid(), '[]')$$,
    '42501',
    NULL,
    '1h: a member calling collection_files_finish_tx directly gets permission denied'
);
RESET ROLE;

-- =============================================================================
-- 2. tc.current_caller: how the finish edge functions learn who is calling
-- =============================================================================

SELECT throws_ok($$SELECT tc.current_caller()$$, 'PT403', NULL,
    '2a: current_caller refuses a signed-in caller with no user row (a member of nothing)');

-- =============================================================================
-- Fixture: Alice (admin) and Bob (member) in one collection.
-- =============================================================================

SELECT tc.create_collection('c0000000-0000-0000-0000-00000000c401', 'Checkin Flow Collection');
SELECT tc.members_add('c0000000-0000-0000-0000-00000000c401', 'bob-cif@example.com', 'member');
SELECT tests.set_jwt('user-bob-cif', 'bob-cif@example.com');
SELECT tc.claim_memberships('Bob');

SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');

SELECT is((tc.current_caller() ->> 'userId')::uuid, tests.uid('user-alice-cif'),
    '2b: current_caller reports the caller''s core.users id');
SELECT ok(has_function_privilege('authenticated', 'tc.current_caller()', 'EXECUTE'),
    '2c: authenticated can execute current_caller');

SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT throws_ok($$SELECT tc.current_caller()$$, 'PT401', NULL,
    '2d: current_caller refuses a token with no user');

-- =============================================================================
-- 3. A new book whose manifest spells a path in decomposed form: start normalizes it.
-- =============================================================================

SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');

SELECT set_config('tests.start1', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One', NULL, 'cs-1', '6.5.0',
    jsonb_build_array(
        jsonb_build_object('path', current_setting('tests.nfd'), 'sha256', 'sha-cafe-1', 'size', 10),
        jsonb_build_object('path', 'images/a.png', 'sha256', 'sha-a', 'size', 20)
    ))::text, true);
SELECT set_config('tests.tx1', current_setting('tests.start1')::jsonb ->> 'transactionId', true);
SELECT set_config('tests.book1',
    (SELECT id::text FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c401'), true);

SELECT ok(
    current_setting('tests.nfd') <> current_setting('tests.nfc'),
    '3a: sanity: the two spellings differ before normalization'
);
SELECT ok(
    (current_setting('tests.start1')::jsonb -> 'changedPaths') ? current_setting('tests.nfc')
    AND NOT ((current_setting('tests.start1')::jsonb -> 'changedPaths') ? current_setting('tests.nfd')),
    '3b: changedPaths (the keys the client uploads to) use the NFC spelling'
);
SELECT is(
    (SELECT proposed_files -> 0 ->> 'path' FROM tc.checkin_attempts WHERE id = current_setting('tests.tx1')::uuid),
    current_setting('tests.nfc'),
    '3c: the stored proposed manifest uses the NFC spelling'
);
SELECT ok(
    (SELECT current_setting('tests.nfc') = ANY(changed_paths) FROM tc.checkin_attempts WHERE id = current_setting('tests.tx1')::uuid),
    '3d: the stored changed_paths use the NFC spelling'
);
SELECT ok(
    (SELECT base_book_version IS NULL FROM tc.checkin_attempts WHERE id = current_setting('tests.tx1')::uuid),
    '3e: a new book''s attempt has no base version'
);
SELECT ok(
    NOT (current_setting('tests.start1')::jsonb ? 'checkoutGuid')
    AND NOT (current_setting('tests.start1')::jsonb ? 'bookId')
    AND (SELECT locked_by = tests.uid('user-alice-cif') AND checkout_guid_hash IS NULL AND current_version IS NULL
           FROM tc.books WHERE id = current_setting('tests.book1')::uuid)
    AND (SELECT checkout_guid_hash IS NULL FROM tc.checkin_attempts WHERE id = current_setting('tests.tx1')::uuid),
    '3f: a new book''s start returns no GUID and no book id; the book is locked for the send with no hash and no version'
);

-- =============================================================================
-- 4. Finish (as the edge function would, with the caller passed explicitly)
-- =============================================================================

SELECT set_config('tests.fin1', tc.checkin_finish_tx(
    current_setting('tests.tx1')::uuid, tests.uid('user-alice-cif'), 'first', false,
    jsonb_build_array(
        jsonb_build_object('path', current_setting('tests.nfc'), 's3VersionId', 'sv-cafe-1'),
        jsonb_build_object('path', 'images/a.png', 's3VersionId', 'sv-a-1')
    ))::text, true);

SELECT is(
    (SELECT s3_version_id FROM tc.book_files
      WHERE book_id = current_setting('tests.book1')::uuid AND path = current_setting('tests.nfc')),
    'sv-cafe-1',
    '4a: the file is committed under the same NFC key it was uploaded to'
);
SELECT ok(
    (current_setting('tests.fin1')::jsonb ->> 'version') = '1'
    AND (SELECT current_version = 1 AND locked_by IS NULL AND checkout_guid_hash IS NULL
           FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    '4b: the first commit is version 1 and releases the lock (and its checkout GUID)'
);
SELECT ok(
    (SELECT count(*) = 2 AND bool_and(book_version = 1) FROM tc.history_events
      WHERE book_id = current_setting('tests.book1')::uuid AND type IN (1, 2)
        AND by_user_id = tests.uid('user-alice-cif'))
    AND (SELECT message = 'first' AND bloom_version = '6.5.0' FROM tc.history_events
          WHERE book_id = current_setting('tests.book1')::uuid AND type = 1),
    '4c: Created + CheckIn events carry the user passed in, the version, the comment and the Bloom version'
);
SELECT is(
    tc.checkin_finish_tx(current_setting('tests.tx1')::uuid, tests.uid('user-alice-cif'), 'first', false, '[]') ->> 'version',
    '1',
    '4d: re-calling finish on a finished attempt returns the same version (idempotent)'
);
SELECT throws_ok(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-bob-cif'), NULL, false, '[]')$$, current_setting('tests.tx1')),
    'PT403',
    NULL,
    '4e: finish refuses a user who did not start the attempt'
);

-- =============================================================================
-- 5. Stale check-in: Alice starts from v1, loses the lock (admin force-unlock), Bob
--    commits v2 -- Alice's finish must not overwrite v2 or disturb Bob's lock.
-- =============================================================================

SELECT set_config('tests.a5',
    tests.checkout('d0000000-0000-0000-0000-00000000c401', 'AliceMachine'), true);
SELECT set_config('tests.tx2', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One', NULL, 'cs-2a', '6.5.0',
    jsonb_build_array(
        jsonb_build_object('path', current_setting('tests.nfc'), 'sha256', 'sha-cafe-alice', 'size', 11),
        jsonb_build_object('path', 'images/a.png', 'sha256', 'sha-a', 'size', 20)
    ), current_setting('tests.a5')) ->> 'transactionId', true);

SELECT is(
    (SELECT base_book_version FROM tc.checkin_attempts WHERE id = current_setting('tests.tx2')::uuid),
    1::bigint,
    '5a: with no baseVersion sent, start records the book''s current version as the base'
);

SELECT tc.force_unlock('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401');

SELECT tests.set_jwt('user-bob-cif', 'bob-cif@example.com');
SELECT set_config('tests.b5',
    tests.checkout('d0000000-0000-0000-0000-00000000c401', 'BobMachine'), true);
SELECT set_config('tests.tx3', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One', 1, 'cs-2b', '6.5.0',
    jsonb_build_array(
        jsonb_build_object('path', current_setting('tests.nfc'), 'sha256', 'sha-cafe-bob', 'size', 12),
        jsonb_build_object('path', 'images/a.png', 'sha256', 'sha-a', 'size', 20)
    ), current_setting('tests.b5')) ->> 'transactionId', true);
SELECT tc.checkin_finish_tx(current_setting('tests.tx3')::uuid, tests.uid('user-bob-cif'), 'bob', true,
    jsonb_build_array(jsonb_build_object('path', current_setting('tests.nfc'), 's3VersionId', 'sv-cafe-bob')));

SELECT ok(
    (SELECT current_version = 2 AND locked_by = tests.uid('user-bob-cif') FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    '5b: sanity: Bob committed v2 and kept the book checked out'
);
SELECT is(
    (SELECT checkout_guid_hash FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    tests.guid_hash(current_setting('tests.b5')),
    '5b2: keepCheckedOut keeps the checkout GUID (not rotated, not cleared)'
);

SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-alice-cif'), 'stale', false, %L)$$,
        current_setting('tests.tx2'),
        jsonb_build_array(jsonb_build_object('path', current_setting('tests.nfc'), 's3VersionId', 'sv-cafe-alice'))::text),
    '%LockHeldByOther%',
    '5c: Alice''s finish is refused while Bob holds the lock'
);
SELECT ok(
    (SELECT current_version = 2 AND locked_by = tests.uid('user-bob-cif') FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    '5d: v2 and Bob''s lock are untouched'
);

SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book One', NULL, 'cs-x', '6.5.0', '[]', NULL)$$,
    '%LockHeldByOther%"name" : "Bob"%',
    '5d2: a LockHeldByOther refusal at start names the holder'
);
SELECT tests.set_jwt('user-bob-cif', 'bob-cif@example.com');

-- Even once Alice holds the lock again, it is a new checkout (a new GUID), not the one her
-- attempt started under.
SELECT tc.unlock_book('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401', current_setting('tests.b5'));
SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SELECT set_config('tests.a5b',
    tests.checkout('d0000000-0000-0000-0000-00000000c401', 'AliceMachine'), true);

SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-alice-cif'), 'stale', false, %L)$$,
        current_setting('tests.tx2'),
        jsonb_build_array(jsonb_build_object('path', current_setting('tests.nfc'), 's3VersionId', 'sv-cafe-alice'))::text),
    '%CheckoutElsewhere%',
    '5e: Alice''s finish is refused because the checkout GUID changed since her start'
);

-- Pretend the attempt had started under this checkout: it is still based on v1, which is gone.
UPDATE tc.checkin_attempts
SET checkout_guid_hash = tests.guid_hash(current_setting('tests.a5b'))
WHERE id = current_setting('tests.tx2')::uuid;

SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-alice-cif'), 'stale', false, %L)$$,
        current_setting('tests.tx2'),
        jsonb_build_array(jsonb_build_object('path', current_setting('tests.nfc'), 's3VersionId', 'sv-cafe-alice'))::text),
    '%BaseVersionSuperseded%',
    '5e2: with the same checkout, Alice''s finish is refused because the book moved on from her base version'
);
SELECT is(
    (SELECT s3_version_id FROM tc.book_files
      WHERE book_id = current_setting('tests.book1')::uuid AND path = current_setting('tests.nfc')),
    'sv-cafe-bob',
    '5f: Bob''s committed file is still the current one'
);

SELECT tc.unlock_book('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401', current_setting('tests.a5b'));
SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-alice-cif'), 'stale', false, '[]')$$,
        current_setting('tests.tx2')),
    '%LockHeldByOther%',
    '5g: a finish by someone who no longer holds the lock is refused even when the lock is free'
);
SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book One', 1, 'cs-x', '6.5.0', '[]')$$,
    '%BaseVersionSuperseded%',
    '5h: a start whose baseVersion the book has moved on from is refused'
);

-- =============================================================================
-- 6. Book names are for display only: renaming a book to another book's name is accepted
-- =============================================================================

INSERT INTO tc.books (id, collection_id, instance_id, name, current_version)
VALUES ('b0000000-0000-0000-0000-00000000c402', 'c0000000-0000-0000-0000-00000000c401',
        'd0000000-0000-0000-0000-00000000c402', 'Book Two', 1);

SELECT set_config('tests.a6',
    tests.checkout('d0000000-0000-0000-0000-00000000c401', 'AliceMachine'), true);
SELECT lives_ok(
    format($$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book Two', NULL, 'cs-x', '6.5.0', '[]', %L)$$, current_setting('tests.a6')),
    '6a: a check-in may give a book another book''s name'
);

-- =============================================================================
-- 7. Malformed manifests are refused at start (PT400 InvalidManifest)
-- =============================================================================

SELECT throws_ok(
    format($$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c409',
        'Book Nine', NULL, 'cs-9', '6.5.0', %L)$$,
        jsonb_build_array(
            jsonb_build_object('path', current_setting('tests.nfc'), 'sha256', 's1', 'size', 1),
            jsonb_build_object('path', current_setting('tests.nfd'), 'sha256', 's2', 'size', 2))::text),
    'PT400',
    NULL,
    '7a: two spellings of one path (which would share one S3 key) are refused'
);
SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c409',
        'Book Nine', NULL, 'cs-9', '6.5.0', '[{"path":"../escape.htm","sha256":"s","size":1}]')$$,
    '%InvalidManifest%',
    '7b: a ".." path segment is refused'
);
SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c409',
        'Book Nine', NULL, 'cs-9', '6.5.0', '[{"path":"a.htm","size":1}]')$$,
    '%InvalidManifest%',
    '7c: an entry with no sha256 is refused'
);
SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c409',
        'Book Nine', NULL, 'cs-9', '6.5.0', '[{"path":"a.htm","sha256":"s","size":100000000000000000000}]')$$,
    '%InvalidManifest%',
    '7d: a size too big for the bigint size columns is refused (not a 500)'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c409'),
    '7e: a refused start creates no book row'
);

-- =============================================================================
-- 8. Collection files: admin only, NFC at start, service-role finish, idempotent retry
-- =============================================================================

SELECT tests.set_jwt('user-bob-cif', 'bob-cif@example.com');
SELECT throws_like(
    $$SELECT tc.collection_files_start_tx('c0000000-0000-0000-0000-00000000c401', 0, '[]')$$,
    '%admin_required%',
    '8-pre: a member who is not an admin cannot send collection files'
);
SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');

SELECT set_config('tests.cfstart', tc.collection_files_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 0,
    jsonb_build_array(jsonb_build_object('path', 'Sample Texts/' || current_setting('tests.nfd'), 'sha256', 'sha-cf', 'size', 5))
    )::text, true);
SELECT set_config('tests.cftx', current_setting('tests.cfstart')::jsonb ->> 'transactionId', true);

SELECT ok(
    (current_setting('tests.cfstart')::jsonb -> 'changedPaths') ? ('Sample Texts/' || current_setting('tests.nfc')),
    '8a: collection-file changedPaths use the NFC spelling'
);
SELECT is(
    tc.collection_files_finish_tx(current_setting('tests.cftx')::uuid, tests.uid('user-alice-cif'),
        jsonb_build_array(jsonb_build_object('path', 'Sample Texts/' || current_setting('tests.nfc'), 's3VersionId', 'sv-cf-1'))
    ) ->> 'version',
    '1',
    '8b: finish bumps the collection files to version 1'
);
SELECT ok(
    (SELECT s3_version_id = 'sv-cf-1' FROM tc.collection_files
      WHERE collection_id = 'c0000000-0000-0000-0000-00000000c401'
        AND path = 'Sample Texts/' || current_setting('tests.nfc'))
    AND (SELECT collection_files_version = 1 AND collection_files_updated_by = tests.uid('user-alice-cif')
           FROM tc.collections WHERE id = 'c0000000-0000-0000-0000-00000000c401'),
    '8c: the collection file is committed under the NFC key, and the collection records the version and who sent it'
);
SELECT ok(
    (SELECT count(*) = 1 FROM tc.history_events
      WHERE collection_id = 'c0000000-0000-0000-0000-00000000c401' AND type = 102
        AND book_id IS NULL AND by_user_id = tests.uid('user-alice-cif')),
    '8c2: the send is recorded as one CollectionFilesCheckIn (102) event with no book'
);
SELECT is(
    tc.collection_files_finish_tx(current_setting('tests.cftx')::uuid, tests.uid('user-alice-cif'), '[]') ->> 'version',
    '1',
    '8d: re-calling finish returns the same version (idempotent)'
);
SELECT throws_ok(
    format($$SELECT tc.collection_files_finish_tx(%L, tests.uid('user-bob-cif'), '[]')$$, current_setting('tests.cftx')),
    'PT403',
    NULL,
    '8e: collection-files finish refuses a user who did not start the attempt'
);
SELECT throws_like(
    $$SELECT tc.collection_files_start_tx('c0000000-0000-0000-0000-00000000c401', 0, '[]')$$,
    '%VersionConflict%',
    '8f: a start from an old version is refused (VersionConflict: receive first)'
);

-- =============================================================================
-- 9. Row locks that make concurrent start/finish calls safe. A real two-session race
--    cannot run in single-session pgTAP, so guard against the locks being dropped.
-- =============================================================================

SELECT ok(
    pg_get_functiondef('tc.checkin_start_tx(uuid, uuid, text, bigint, text, text, jsonb, text)'::regprocedure)
        ~ 'FROM tc.checkin_attempts\s+WHERE book_id = v_book_id AND started_by = v_user_id AND status = ''open''\s+FOR UPDATE;\s+SELECT \* INTO v_book FROM tc.books WHERE id = v_book_id FOR UPDATE',
    '9a: checkin_start_tx locks the caller''s open attempt, then the book row, before checking anything'
);
SELECT ok(
    pg_get_functiondef('tc.checkin_start_tx(uuid, uuid, text, bigint, text, text, jsonb, text)'::regprocedure)
        ~ 'pg_advisory_xact_lock\(hashtextextended\(\s+''tc\.checkin_start:''.*PERFORM tc\.reap_expired_checkin_attempts\(\).*FOR UPDATE',
    '9a2: checkin_start_tx serializes one person''s starts per book before taking any row lock (a re-sent start resumes)'
);
SELECT ok(
    pg_get_functiondef('tc.collection_files_start_tx(uuid, bigint, jsonb)'::regprocedure)
        ~ 'pg_advisory_xact_lock\(hashtextextended\(\s+''tc\.collection_files_start:''.*PERFORM tc\.reap_expired_checkin_attempts\(\).*FOR UPDATE',
    '9a3: collection_files_start_tx does the same per person and collection'
);
SELECT ok(
    pg_get_functiondef('tc.checkin_finish_tx(uuid, uuid, text, boolean, jsonb)'::regprocedure)
        LIKE '%FROM tc.checkin_attempts WHERE id = p_transaction_id FOR UPDATE%',
    '9b: checkin_finish_tx locks its attempt row (concurrent retries are idempotent)'
);
SELECT ok(
    pg_get_functiondef('tc.checkin_finish_tx(uuid, uuid, text, boolean, jsonb)'::regprocedure)
        LIKE '%FROM tc.books WHERE id = v_tx.book_id FOR UPDATE%',
    '9c: checkin_finish_tx locks the book row while re-checking lock and base version'
);
SELECT ok(
    pg_get_functiondef('tc.collection_files_finish_tx(uuid, uuid, jsonb)'::regprocedure)
        LIKE '%FROM tc.collection_file_checkin_attempts WHERE id = p_transaction_id FOR UPDATE%',
    '9d: collection_files_finish_tx locks its attempt row'
);

-- =============================================================================
-- 10. stale_upload_key_state: the sweep's just-before-delete re-check
-- =============================================================================

INSERT INTO tc.checkin_attempts (collection_id, book_id, started_by, proposed_name,
                                 changed_paths, status)
VALUES ('c0000000-0000-0000-0000-00000000c401', current_setting('tests.book1')::uuid,
        tests.uid('user-alice-cif'), 'Book One', ARRAY['images/a.png'], 'aborted');

SELECT set_config('tests.akey',
    'tc/c0000000-0000-0000-0000-00000000c401/books/d0000000-0000-0000-0000-00000000c401/images/a.png', true);

SELECT is(
    tc.stale_upload_key_state(current_setting('tests.akey')),
    '{"stillStale": true, "referencedVersionId": "sv-a-1"}'::jsonb,
    '10a: a key only a dead attempt touched is still stale, with its current referenced version'
);

-- The sweep's paged worklist. Another dead attempt: one touching a.png again (so that key has
-- two rows) and two more keys, so paging by 2 needs several pages.
INSERT INTO tc.checkin_attempts (collection_id, book_id, started_by, proposed_name,
                                 changed_paths, status)
VALUES ('c0000000-0000-0000-0000-00000000c401', current_setting('tests.book1')::uuid,
        tests.uid('user-alice-cif'), 'Book One', ARRAY['images/a.png', 'images/b.png', 'z.htm'], 'aborted');

-- Every key, reading page after page of p_limit keys with the last key as the cursor.
CREATE OR REPLACE FUNCTION tests.all_stale_key_pages(p_limit integer)
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
    v_all  text[] := '{}';
    v_page text[];
    v_after text := NULL;
BEGIN
    LOOP
        SELECT COALESCE(array_agg(s3_key ORDER BY s3_key COLLATE "C"), '{}') INTO v_page
        FROM tc.list_stale_upload_keys(v_after, p_limit);
        IF cardinality(v_page) > p_limit THEN
            RAISE EXCEPTION 'a page of % keys exceeded p_limit %', cardinality(v_page), p_limit;
        END IF;
        v_all := v_all || v_page;
        EXIT WHEN cardinality(v_page) < p_limit;
        v_after := v_page[cardinality(v_page)];
    END LOOP;
    RETURN v_all;
END;
$$;

SELECT set_config('tests.distinct_keys',
    (SELECT array_agg(k ORDER BY k)::text FROM (
        SELECT DISTINCT s3_key COLLATE "C" AS k FROM tc.list_stale_upload_garbage()) d), true);

SELECT ok(
    cardinality(current_setting('tests.distinct_keys')::text[]) >= 3
    AND (SELECT count(*) FROM tc.list_stale_upload_garbage() WHERE s3_key = current_setting('tests.akey')) = 2,
    '10a1: sanity: at least three stale keys, and a.png is listed once per dead attempt'
);
SELECT is(
    tests.all_stale_key_pages(2),
    current_setting('tests.distinct_keys')::text[],
    '10a2: paging 2 at a time returns every stale key exactly once, in key order'
);
SELECT is(
    (SELECT referenced_version_id FROM tc.list_stale_upload_keys(NULL, 1000) WHERE s3_key = current_setting('tests.akey')),
    'sv-a-1',
    '10a3: a page row carries the key''s currently-referenced version'
);
SELECT throws_ok(
    $$SELECT * FROM tc.list_stale_upload_keys(NULL, 1001)$$,
    '22023', NULL,
    '10a4: a page larger than PostgREST''s max_rows (1000) is refused'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.list_stale_upload_keys(text, integer)', 'EXECUTE')
    AND has_function_privilege('service_role', 'tc.list_stale_upload_keys(text, integer)', 'EXECUTE'),
    '10a5: list_stale_upload_keys is service-role only'
);

INSERT INTO tc.checkin_attempts (collection_id, book_id, started_by, proposed_name,
                                 changed_paths, status)
VALUES ('c0000000-0000-0000-0000-00000000c401', current_setting('tests.book1')::uuid,
        tests.uid('user-bob-cif'), 'Book One', ARRAY['images/a.png'], 'open');

SELECT is(
    tc.stale_upload_key_state(current_setting('tests.akey')) ->> 'stillStale',
    'false',
    '10b: once a live attempt touches the key it is no longer stale'
);
SELECT is(
    tc.stale_upload_key_state('tc/nowhere/books/none/x') ->> 'stillStale',
    'false',
    '10c: an unknown key is not stale'
);
SELECT is(
    (SELECT count(*)::int FROM tc.list_stale_upload_garbage()
      WHERE s3_key = 'tc/c0000000-0000-0000-0000-00000000c401/collectionFiles/Sample Texts/' || current_setting('tests.nfc')),
    0,
    '10d: sanity: a committed collection-files send leaves nothing for the sweep'
);

-- =============================================================================
-- 11. Aborting an expired check-in of a never-finished new book still succeeds
--     (abort must not reap its own target away first and then report 404)
-- =============================================================================

SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SELECT set_config('tests.tx11', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c411',
    'Book Eleven', NULL, 'cs-11', '6.5.0', '[]') ->> 'transactionId', true);
UPDATE tc.checkin_attempts SET expires_at = now() - INTERVAL '1 hour'
WHERE id = current_setting('tests.tx11')::uuid;

SELECT lives_ok(
    format($$SELECT tc.checkin_abort_tx(%L)$$, current_setting('tests.tx11')),
    '11a: aborting an expired new-book check-in succeeds'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c411'),
    '11b: and removes the never-finished book'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM tc.checkin_attempts WHERE id = current_setting('tests.tx11')::uuid),
    '11c: sanity: removing the book removed its attempt too'
);
SELECT lives_ok(
    format($$SELECT tc.checkin_abort_tx(%L)$$, current_setting('tests.tx11')),
    '11d: a retried abort of that (now gone) attempt still succeeds, as a no-op'
);

-- =============================================================================
-- 12. Existing book: starting a check-in of one's own lock needs its checkout GUID (the
--     copy that has it); taking a free lock issues none.
-- =============================================================================

SELECT ok(
    (SELECT locked_by = tests.uid('user-alice-cif') AND checkout_guid_hash = tests.guid_hash(current_setting('tests.a6'))
       FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    '12-sanity: Alice still holds book one under the GUID from section 6'
);

SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book One Renamed', NULL, 'cs-12', '6.5.0', '[]')$$,
    '%CheckoutElsewhere%',
    '12a: without the GUID, start refuses the holder (CheckoutElsewhere)'
);
SELECT throws_like(
    format($$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book One Renamed', NULL, 'cs-12', '6.5.0', '[]', %L)$$, gen_random_uuid()::text),
    '%CheckoutElsewhere%',
    '12b: with a wrong GUID, start refuses the holder (CheckoutElsewhere)'
);

SELECT set_config('tests.s12', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One Renamed', NULL, 'cs-12', '6.5.0', '[]', current_setting('tests.a6'))::text, true);
SELECT ok(
    (current_setting('tests.s12')::jsonb ? 'transactionId')
    AND NOT (current_setting('tests.s12')::jsonb ? 'checkoutGuid')
    AND (SELECT checkout_guid_hash FROM tc.books WHERE id = current_setting('tests.book1')::uuid)
        = tests.guid_hash(current_setting('tests.a6')),
    '12c: with the right GUID, start succeeds, issues no new GUID and keeps the hash'
);

-- Take-if-free: release the lock, then start with no GUID.
SELECT tc.unlock_book('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401', current_setting('tests.a6'));
SELECT set_config('tests.s12e', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One Renamed', NULL, 'cs-12', '6.5.0', '[]')::text, true);
SELECT ok(
    (current_setting('tests.s12e')::jsonb ? 'transactionId')
    AND NOT (current_setting('tests.s12e')::jsonb ? 'checkoutGuid')
    AND (SELECT locked_by = tests.uid('user-alice-cif') AND checkout_guid_hash IS NULL
           FROM tc.books WHERE id = current_setting('tests.book1')::uuid)
    AND (SELECT checkout_guid_hash IS NULL FROM tc.checkin_attempts
          WHERE id = (current_setting('tests.s12e')::jsonb ->> 'transactionId')::uuid),
    '12d: start on a free book locks it for the send only: no GUID, no hash on the book or the attempt'
);
SELECT ok(
    (SELECT status = 'aborted' FROM tc.checkin_attempts
      WHERE id = (current_setting('tests.s12')::jsonb ->> 'transactionId')::uuid),
    '12d2: the earlier attempt (started under the checkout, a different GUID snapshot) was aborted, not resumed'
);
SELECT throws_like(
    format($$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book One Renamed', NULL, 'cs-12', '6.5.0', '[]', %L)$$, current_setting('tests.a6')),
    '%CheckoutElsewhere%',
    '12e: presenting a (now obsolete) GUID for a send-only lock is refused (CheckoutElsewhere)'
);
SELECT ok(
    (SELECT r ->> 'success' = 'false' AND r ->> 'locked_by_me' = 'true'
       FROM (SELECT tc.checkout_book('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
                                     'AliceMachine', gen_random_uuid()::text) AS r) s)
    AND (SELECT checkout_guid_hash IS NULL FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    '12f: checkout_book cannot turn a send-only lock into a checkout (locked_by_me, hash still NULL)'
);

-- =============================================================================
-- 13. New book: start issues no GUID, and resuming the never-committed book needs only the
--     same user and instance id.
-- =============================================================================

SELECT set_config('tests.s13', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c413',
    'Book Thirteen', NULL, 'cs-13', '6.5.0', '[]')::text, true);
SELECT ok(
    NOT (current_setting('tests.s13')::jsonb ? 'checkoutGuid')
    AND (SELECT locked_by = tests.uid('user-alice-cif') AND checkout_guid_hash IS NULL
           FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c413'),
    '13a: a new book''s start issues no GUID and locks the row for the send with no hash'
);

SELECT is(
    tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c413',
        'Book Thirteen', NULL, 'cs-13', '6.5.0', '[]') ->> 'transactionId',
    current_setting('tests.s13')::jsonb ->> 'transactionId',
    '13b: resuming one''s own new book with an identical proposal continues the same attempt'
);

SELECT ok(
    (SELECT r ->> 'transactionId' = current_setting('tests.s13')::jsonb ->> 'transactionId'
            AND NOT (r ? 'checkoutGuid')
       FROM (SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c413',
                 'Book Thirteen', NULL, 'cs-13', '6.5.0', '[]', gen_random_uuid()::text) AS r) s),
    '13c: a GUID sent for a new book is ignored: the same attempt continues, with no GUID issued'
);

SELECT ok(
    (SELECT checkout_guid_hash IS NULL FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c413')
    AND (SELECT count(*) = 1 AND bool_and(checkout_guid_hash IS NULL) FROM tc.checkin_attempts
          WHERE book_id = (SELECT id FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c413')),
    '13d: after the resumes the new book and its one attempt still have no hash'
);

SELECT set_config('tests.s13e', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c413',
    'Book Thirteen, Renamed', NULL, 'cs-13', '6.5.0', '[]')::text, true);
SELECT ok(
    (current_setting('tests.s13e')::jsonb ->> 'transactionId') <> (current_setting('tests.s13')::jsonb ->> 'transactionId')
    AND (SELECT status = 'aborted' FROM tc.checkin_attempts
          WHERE id = (current_setting('tests.s13')::jsonb ->> 'transactionId')::uuid)
    AND (SELECT count(*) = 1 FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c413'),
    '13e: a new book''s start with a different proposal replaces the attempt and keeps the uncommitted book row'
);

-- =============================================================================
-- 14. An admin can always cancel someone else's checkout without its GUID; the old
--     holder's in-flight check-in is then refused.
-- =============================================================================

SELECT tests.set_jwt('user-bob-cif', 'bob-cif@example.com');
SELECT set_config('tests.b14',
    tests.checkout('d0000000-0000-0000-0000-00000000c402', 'BobMachine'), true);
SELECT set_config('tests.tx14', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c402',
    'Book Two', NULL, 'cs-14', '6.5.0',
    jsonb_build_array(jsonb_build_object('path', 'two.htm', 'sha256', 'sha-two', 'size', 3)),
    current_setting('tests.b14')) ->> 'transactionId', true);

-- Alice (admin) has never seen Bob's GUID.
SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SELECT lives_ok(
    $$SELECT tc.force_unlock('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c402')$$,
    '14a: an admin with no GUID can force-unlock a book another member has checked out'
);
SELECT ok(
    current_setting('tests.tx14', true) IS NOT NULL
    AND (SELECT locked_by IS NULL AND checkout_guid_hash IS NULL
           FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000c402'),
    '14b: force_unlock clears the lock and the checkout GUID hash'
);
SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-bob-cif'), 'stale', false, %L)$$,
        current_setting('tests.tx14'),
        jsonb_build_array(jsonb_build_object('path', 'two.htm', 's3VersionId', 'sv-two'))::text),
    '%LockHeldByOther%',
    '14c: the old holder''s check-in under the now-stale GUID is refused'
);

-- =============================================================================
-- 15. A start resumes the caller's open attempt only if its proposal is identical;
--     otherwise it aborts it, and a finish of the old attempt answers transaction_aborted.
-- =============================================================================

SELECT set_config('tests.tx15', current_setting('tests.s12e')::jsonb ->> 'transactionId', true);
SELECT set_config('tests.files15',
    jsonb_build_array(
        jsonb_build_object('path', 'fifteen.htm', 'sha256', 'sha-15', 'size', 15),
        jsonb_build_object('path', 'images/a.png', 'sha256', 'sha-a', 'size', 20))::text, true);

-- First make the open attempt propose these files (replacing the empty proposal).
SELECT set_config('tests.tx15', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One Renamed', NULL, 'cs-15', '6.5.0', current_setting('tests.files15')::jsonb) ->> 'transactionId', true);
UPDATE tc.checkin_attempts SET expires_at = now() + interval '1 hour'
WHERE id = current_setting('tests.tx15')::uuid;

SELECT set_config('tests.s15a', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One Renamed', NULL, 'cs-15', '6.5.1',
    jsonb_build_array(
        jsonb_build_object('path', 'images/a.png', 'sha256', 'sha-a', 'size', 20),
        jsonb_build_object('path', 'fifteen.htm', 'sha256', 'sha-15', 'size', 15)))::text, true);
SELECT ok(
    (current_setting('tests.s15a')::jsonb ->> 'transactionId') = current_setting('tests.tx15')
    AND (SELECT expires_at > now() + interval '47 hours' FROM tc.checkin_attempts
          WHERE id = current_setting('tests.tx15')::uuid),
    '15a: an identical proposal (files in another order, another client version) resumes the attempt and extends its expiry'
);

SELECT set_config('tests.tx15b', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
    'Book One Renamed', NULL, 'cs-15b', '6.5.0',
    jsonb_build_array(
        jsonb_build_object('path', 'fifteen.htm', 'sha256', 'sha-15-new', 'size', 16),
        jsonb_build_object('path', 'images/a.png', 'sha256', 'sha-a', 'size', 20))) ->> 'transactionId', true);

SELECT ok(
    current_setting('tests.tx15b') <> current_setting('tests.tx15')
    AND (SELECT status = 'aborted' FROM tc.checkin_attempts WHERE id = current_setting('tests.tx15')::uuid)
    AND (SELECT status = 'open' FROM tc.checkin_attempts WHERE id = current_setting('tests.tx15b')::uuid),
    '15b: a different proposal aborts the open attempt and opens a new one'
);
SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-alice-cif'), 'raced', false, %L)$$,
        current_setting('tests.tx15'),
        jsonb_build_array(jsonb_build_object('path', 'fifteen.htm', 's3VersionId', 'sv-15-old'))::text),
    '%transaction_aborted%',
    '15c: a finish of the replaced attempt answers transaction_aborted'
);
SELECT ok(
    (SELECT current_version = 2 AND locked_by = tests.uid('user-alice-cif')
       FROM tc.books WHERE id = current_setting('tests.book1')::uuid),
    '15d: the refused finish commits nothing'
);
SELECT is(
    tc.checkin_finish_tx(current_setting('tests.tx15b')::uuid, tests.uid('user-alice-cif'), 'retried', true,
        jsonb_build_array(jsonb_build_object('path', 'fifteen.htm', 's3VersionId', 'sv-15-new'))) ->> 'version',
    '3',
    '15e: the new attempt''s finish commits version 3'
);
SELECT ok(
    (SELECT locked_by IS NULL AND checkout_guid_hash IS NULL AND name = 'Book One Renamed'
       FROM tc.books WHERE id = current_setting('tests.book1')::uuid)
    AND (SELECT resulting_book_version = 3 AND status = 'finished' FROM tc.checkin_attempts
          WHERE id = current_setting('tests.tx15b')::uuid),
    '15f: finishing under a send-only lock releases it, even with keepCheckedOut, and records the version on the attempt'
);

-- =============================================================================
-- 16. The same rule for collection files.
-- =============================================================================

SELECT set_config('tests.cf16', tc.collection_files_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 1,
    jsonb_build_array(jsonb_build_object('path', 's.txt', 'sha256', 'sha-s-old', 'size', 1))
    ) ->> 'transactionId', true);
SELECT is(
    tc.collection_files_start_tx(
        'c0000000-0000-0000-0000-00000000c401', 1,
        jsonb_build_array(jsonb_build_object('path', 's.txt', 'sha256', 'sha-s-old', 'size', 1))
    ) ->> 'transactionId',
    current_setting('tests.cf16'),
    '16a: an identical collection-files start resumes the same attempt'
);
SELECT set_config('tests.cf16b', tc.collection_files_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 1,
    jsonb_build_array(jsonb_build_object('path', 's.txt', 'sha256', 'sha-s-new', 'size', 2))
    ) ->> 'transactionId', true);
SELECT ok(
    current_setting('tests.cf16b') <> current_setting('tests.cf16')
    AND (SELECT status = 'aborted' FROM tc.collection_file_checkin_attempts WHERE id = current_setting('tests.cf16')::uuid),
    '16b: a different collection-files proposal aborts the attempt and opens a new one'
);
SELECT throws_like(
    format($$SELECT tc.collection_files_finish_tx(%L, tests.uid('user-alice-cif'), %L)$$,
        current_setting('tests.cf16'),
        jsonb_build_array(jsonb_build_object('path', 's.txt', 's3VersionId', 'sv-s-old'))::text),
    '%transaction_aborted%',
    '16c: a finish of the replaced collection-files attempt answers transaction_aborted'
);
SELECT is(
    tc.collection_files_finish_tx(current_setting('tests.cf16b')::uuid, tests.uid('user-alice-cif'),
        jsonb_build_array(jsonb_build_object('path', 's.txt', 's3VersionId', 'sv-s-new'))) ->> 'version',
    '2',
    '16d: the new attempt commits version 2'
);
SELECT ok(
    (SELECT array_agg(path ORDER BY path) = ARRAY['s.txt'] FROM tc.collection_files
      WHERE collection_id = 'c0000000-0000-0000-0000-00000000c401'),
    '16e: the collection files are the committed set, replacing the previous one'
);

-- =============================================================================
-- 17. checkin-start taking a free lock records a CheckOut event, like checkout_book, so
--     other clients polling get_changes see the new lock.
-- =============================================================================

SELECT ok(
    (SELECT locked_by IS NULL FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000c402'),
    '17-sanity: book two is free (force-unlocked in section 14)'
);
SELECT set_config('tests.ev17', (SELECT COALESCE(max(id), 0) FROM tc.history_events)::text, true);
SELECT set_config('tests.s17', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c402',
    'Book Two', NULL, 'cs-17', '6.5.0', '[]')::text, true);

SELECT ok(
    (SELECT count(*) = 1 FROM tc.history_events
      WHERE id > current_setting('tests.ev17')::bigint
        AND collection_id = 'c0000000-0000-0000-0000-00000000c401'
        AND book_id = 'b0000000-0000-0000-0000-00000000c402'
        AND type = 0 AND by_user_id = tests.uid('user-alice-cif') AND book_name = 'Book Two')
    AND (SELECT count(*) = 1 FROM tc.history_events WHERE id > current_setting('tests.ev17')::bigint),
    '17a: taking the free lock emitted exactly one CheckOut event, by the caller'
);
SELECT ok(
    (SELECT (c -> 'events') @> '[{"type": 0, "instance_id": "d0000000-0000-0000-0000-00000000c402"}]'::jsonb
            AND (c -> 'books') @> jsonb_build_array(jsonb_build_object(
                'instance_id', 'd0000000-0000-0000-0000-00000000c402',
                'locked_by', tests.uid('user-alice-cif'),
                'checkoutGuidHash', NULL))
       FROM (SELECT tc.get_changes('c0000000-0000-0000-0000-00000000c401',
                                   current_setting('tests.ev17')::bigint) AS c) s),
    '17b: get_changes reports the event and the book''s new (send-only, no hash) lock'
);
SELECT tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c402',
    'Book Two', NULL, 'cs-17', '6.5.0', '[]');
SELECT ok(
    (SELECT count(*) = 1 FROM tc.history_events WHERE id > current_setting('tests.ev17')::bigint),
    '17c: starting again under one''s own lock records no further CheckOut event'
);
SELECT tc.checkin_abort_tx((current_setting('tests.s17')::jsonb ->> 'transactionId')::uuid);
SELECT ok(
    (SELECT locked_by IS NULL AND checkout_guid_hash IS NULL
       FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000c402')
    AND (SELECT count(*) = 1 FROM tc.history_events
          WHERE id > current_setting('tests.ev17')::bigint AND type = 101),
    '17d: aborting the check-in releases its send-only lock, with a CheckOutReleased event'
);
-- An expired check-in's send-only lock is released by the reaper.
SELECT set_config('tests.tx17e', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c402',
    'Book Two', NULL, 'cs-17e', '6.5.0', '[]') ->> 'transactionId', true);
UPDATE tc.checkin_attempts SET expires_at = now() - INTERVAL '1 hour'
WHERE id = current_setting('tests.tx17e')::uuid;
SELECT tc.reap_expired_checkin_attempts();
SELECT ok(
    (SELECT locked_by IS NULL AND checkout_guid_hash IS NULL
       FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000c402')
    AND (SELECT status = 'expired' FROM tc.checkin_attempts WHERE id = current_setting('tests.tx17e')::uuid),
    '17e: reaping an expired check-in releases its send-only lock and marks the attempt expired'
);
-- =============================================================================
-- 18. A deleted book (tombstone) can't be checked in to
-- =============================================================================

UPDATE tc.books SET deleted_at = now(), locked_by = NULL, locked_at = NULL
WHERE id = current_setting('tests.book1')::uuid;
SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SELECT throws_like(
    $$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c401',
        'Book One', NULL, 'cs-x', '6.5.0', '[]')$$,
    '%book_not_found%',
    '18a: check-in start refuses a deleted book instead of taking its lock or making a new one'
);
-- ...and a book deleted after its check-in started can't be finished either.
SELECT set_config('tests.tx18', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c418',
    'Book Eighteen', NULL, 'cs-18', '6.5.0', '[]') ->> 'transactionId', true);
UPDATE tc.books SET deleted_at = now()
WHERE instance_id = 'd0000000-0000-0000-0000-00000000c418';
SELECT throws_like(
    format($$SELECT tc.checkin_finish_tx(%L, tests.uid('user-alice-cif'), 'eighteen', false, '[]')$$,
        current_setting('tests.tx18')),
    '%book_not_found%',
    '18b: finish refuses a book deleted after start (no invisible version)'
);
-- =============================================================================
-- 19. Realtime: each event is broadcast on the private channel collection:{uuid}.
--     realtime.messages and its daily partitions belong to the Realtime service, so these
--     are skipped in a database started without it (as the db-only pgTAP job may be).
-- =============================================================================

-- Dynamic SQL, so this file still parses where realtime.messages does not exist.
CREATE OR REPLACE FUNCTION tests.realtime_sent(p_event_id bigint, p_topic text, p_instance_id text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_found boolean;
BEGIN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM realtime.messages
                             WHERE topic = $1 AND private AND event = ''tc_event''
                               AND extension = ''broadcast'' AND payload ->> ''eventId'' = $2
                               AND payload ->> ''instanceId'' = $3)'
        INTO v_found USING p_topic, p_event_id::text, p_instance_id;
    RETURN v_found;
END;
$$;

SELECT set_config('tests.ev19', tc.log_event('c0000000-0000-0000-0000-00000000c401',
    'd0000000-0000-0000-0000-00000000c402', 3, 'realtime probe')::text, true);
SELECT CASE
    WHEN to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NULL
         OR to_regclass('realtime.messages_' || to_char(now() AT TIME ZONE 'UTC', 'YYYY_MM_DD')) IS NULL
        THEN skip('Realtime (realtime.send and today''s realtime.messages partition) is not installed here', 1)
    ELSE ok(
        tests.realtime_sent(current_setting('tests.ev19')::bigint,
                            'collection:c0000000-0000-0000-0000-00000000c401',
                            'd0000000-0000-0000-0000-00000000c402'),
        '19a: inserting an event puts a private tc_event broadcast (naming the book by instance id) on collection:{uuid}')
END;
SELECT CASE
    WHEN to_regclass('realtime.messages') IS NULL
        THEN skip('realtime.messages is not installed here', 1)
    ELSE ok(
        EXISTS (SELECT 1 FROM pg_policies
                WHERE schemaname = 'realtime' AND tablename = 'messages'
                  AND policyname = 'tc_members_receive_collection_broadcasts'
                  AND cmd = 'SELECT' AND 'authenticated' = ANY(roles)),
        '19b: members-only receive policy on realtime.messages is in place')
END;

-- =============================================================================
-- 20. Undoing a checkout is visible to polling: unlock_book records CheckOutReleased (101),
--     so get_changes after the previous cursor returns the book, unlocked.
-- =============================================================================

SELECT tests.set_jwt('user-alice-cif', 'alice-cif@example.com');
SELECT set_config('tests.tx20', tc.checkin_start_tx(
    'c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c420',
    'Book Twenty', NULL, 'cs-20', '6.5.0', '[]') ->> 'transactionId', true);
SELECT tc.checkin_finish_tx(current_setting('tests.tx20')::uuid, tests.uid('user-alice-cif'), 'twenty', false, '[]');
SELECT set_config('tests.book20',
    (SELECT id::text FROM tc.books WHERE instance_id = 'd0000000-0000-0000-0000-00000000c420'), true);
SELECT set_config('tests.a20', tests.checkout('d0000000-0000-0000-0000-00000000c420', 'AliceMachine'), true);
SELECT set_config('tests.ev20', (SELECT max(id) FROM tc.history_events)::text, true);
SELECT ok(
    (SELECT current_version = 1 AND locked_by = tests.uid('user-alice-cif') FROM tc.books
      WHERE id = current_setting('tests.book20')::uuid),
    '20-sanity: book twenty is committed and checked out to Alice'
);
SELECT tc.unlock_book('c0000000-0000-0000-0000-00000000c401', 'd0000000-0000-0000-0000-00000000c420', current_setting('tests.a20'));
SELECT ok(
    (SELECT count(*) = 1 FROM tc.history_events
      WHERE id > current_setting('tests.ev20')::bigint
        AND book_id = current_setting('tests.book20')::uuid
        AND type = 101 AND by_user_id = tests.uid('user-alice-cif') AND book_name = 'Book Twenty'),
    '20a: unlock_book records one CheckOutReleased (type 101) event'
);
SELECT ok(
    (SELECT (c -> 'books') @> jsonb_build_array(jsonb_build_object(
                'instance_id', 'd0000000-0000-0000-0000-00000000c420', 'locked_by', NULL))
       FROM (SELECT tc.get_changes('c0000000-0000-0000-0000-00000000c401',
                                   current_setting('tests.ev20')::bigint) AS c) s),
    '20b: get_changes after the previous cursor returns the book, unlocked'
);

-- =============================================================================
-- 21. The reaper deletes a finished attempt once its expiry has passed
-- =============================================================================

SELECT ok(
    EXISTS (SELECT 1 FROM tc.checkin_attempts WHERE id = current_setting('tests.tx20')::uuid AND status = 'finished'),
    '21-sanity: book twenty''s finished attempt is still there'
);
UPDATE tc.checkin_attempts SET expires_at = now() - interval '1 minute'
WHERE id = current_setting('tests.tx20')::uuid;
SELECT tc.reap_expired_checkin_attempts();
SELECT ok(
    NOT EXISTS (SELECT 1 FROM tc.checkin_attempts WHERE id = current_setting('tests.tx20')::uuid)
    AND EXISTS (SELECT 1 FROM tc.checkin_attempts WHERE id = current_setting('tests.tx17e')::uuid),
    '21a: the finished attempt past its expiry is deleted; the expired one is kept for the sweep'
);

SELECT * FROM finish();
ROLLBACK;
