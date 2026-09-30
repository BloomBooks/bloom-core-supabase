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
