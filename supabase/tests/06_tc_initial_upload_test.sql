-- =============================================================================
-- pgTAP tests: starting a cloud collection. An admin creates the collection with its
-- initial-upload flag set, uploads it, locks books that are checked out to people in the old
-- folder Team Collection to the user with that checkout's email, an unclaimed user if nobody
-- has it yet (lock_book_for_legacy_checkout), then clears the flag (finish_initial_upload).
-- While the flag is set my_collections hides the collection. Nobody can sign in as an
-- unclaimed user, so such a lock ends by claiming (03_tc_users_test.sql), by
-- checkout_book_takeover with its GUID, or by force_unlock. support_delete_collection removes
-- a failed attempt's rows.
-- =============================================================================
-- Run against a local Supabase stack:
--   supabase start
--   supabase test db
-- =============================================================================

BEGIN;

SELECT plan(99);

-- Helper: set a fake JWT (same helper as the other test files; each runs standalone).
CREATE SCHEMA IF NOT EXISTS tests;

CREATE OR REPLACE FUNCTION tests.set_jwt(
    p_sub   text,
    p_email text,
    p_email_verified boolean DEFAULT true
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
            'email_verified', p_email_verified,
            'role',           'authenticated',
            'aud',            'authenticated'
        )::text,
        true
    );
END;
$$;

-- The hash as the contract defines it, computed independently of tc._checkout_guid_hash.
CREATE OR REPLACE FUNCTION tests.guid_hash(p_guid text)
RETURNS text
LANGUAGE sql
AS $$
    SELECT encode(sha256(convert_to(lower(p_guid), 'UTF8')), 'hex')
$$;

-- Setup helper: a book, committed (version 1, one file) unless p_committed is false. Its
-- instance id is its id with the first character replaced by 'a'.
CREATE OR REPLACE FUNCTION tests.add_book(p_id uuid, p_collection uuid, p_name text,
                                          p_committed boolean DEFAULT true,
                                          p_deleted boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO tc.books (id, collection_id, instance_id, name, deleted_at)
    VALUES (p_id, p_collection, ('a' || substr(p_id::text, 2))::uuid, p_name,
            CASE WHEN p_deleted THEN now() END);
    IF p_committed THEN
        INSERT INTO tc.book_files (book_id, path, sha256, size_bytes, s3_version_id)
        VALUES (p_id, 'index.htm', 'sha-' || p_name, 10, 'v1');
        UPDATE tc.books
        SET current_version = 1, current_checksum = 'cs-' || p_name
        WHERE id = p_id;
    END IF;
END;
$$;

-- The collection and the instance id of a book (the API names a book by the pair).
CREATE OR REPLACE FUNCTION tests.coll(p_book uuid)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT collection_id FROM tc.books WHERE id = p_book
$$;
CREATE OR REPLACE FUNCTION tests.inst(p_book uuid)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT instance_id FROM tc.books WHERE id = p_book
$$;

-- The core.users id of the person signed in as p_sub, and of the user with an email.
CREATE OR REPLACE FUNCTION tests.uid(p_sub text)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT id FROM core.users WHERE authentication_id = p_sub
$$;
CREATE OR REPLACE FUNCTION tests.user_with_email(p_email text)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT id FROM core.users WHERE email = p_email
$$;

-- Setup helper: one row in every other per-collection table (a check-in attempt, a
-- collection file, a collection-file attempt, a palette entry, an event), so
-- support_delete_collection has something everywhere.
CREATE OR REPLACE FUNCTION tests.populate(p_collection uuid, p_book uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO tc.checkin_attempts (collection_id, book_id, started_by, proposed_name,
                                     base_book_version, status)
    SELECT p_collection, p_book, tests.uid('user-alice-iu'), b.name, b.current_version, 'aborted'
    FROM tc.books b WHERE b.id = p_book;
    INSERT INTO tc.collection_files (collection_id, path, sha256, size_bytes, s3_version_id)
    VALUES (p_collection, 'x.bloomCollection', 'sha-x', 5, 'v1');
    INSERT INTO tc.collection_file_checkin_attempts (collection_id, started_by, expected_version)
    VALUES (p_collection, tests.uid('user-alice-iu'), 1);
    INSERT INTO tc.color_palette_entries (collection_id, palette, color, added_by)
    VALUES (p_collection, 'text', '#123456', tests.uid('user-alice-iu'));
    INSERT INTO tc.history_events (collection_id, book_id, type, by_user_id, book_name)
    VALUES (p_collection, p_book, 2, tests.uid('user-alice-iu'), 'populated');
END;
$$;

-- Rows per tc table that belong to a collection.
CREATE OR REPLACE FUNCTION tests.row_counts(p_collection uuid)
RETURNS jsonb
LANGUAGE sql
AS $$
    SELECT jsonb_build_object(
        'collections',   (SELECT count(*) FROM tc.collections WHERE id = p_collection),
        'members',       (SELECT count(*) FROM tc.members WHERE collection_id = p_collection),
        'books',         (SELECT count(*) FROM tc.books WHERE collection_id = p_collection),
        'book_files',    (SELECT count(*) FROM tc.book_files f
                          JOIN tc.books b ON b.id = f.book_id WHERE b.collection_id = p_collection),
        'checkin_attempts', (SELECT count(*) FROM tc.checkin_attempts WHERE collection_id = p_collection),
        'collection_files', (SELECT count(*) FROM tc.collection_files WHERE collection_id = p_collection),
        'collection_file_checkin_attempts', (SELECT count(*) FROM tc.collection_file_checkin_attempts WHERE collection_id = p_collection),
        'color_palette_entries', (SELECT count(*) FROM tc.color_palette_entries WHERE collection_id = p_collection),
        'history_events', (SELECT count(*) FROM tc.history_events WHERE collection_id = p_collection)
    )
$$;

-- Rows in each of those tables altogether, to check that nothing is left over anywhere.
CREATE OR REPLACE FUNCTION tests.total_counts()
RETURNS jsonb
LANGUAGE sql
AS $$
    SELECT jsonb_build_object(
        'collections',   (SELECT count(*) FROM tc.collections),
        'members',       (SELECT count(*) FROM tc.members),
        'books',         (SELECT count(*) FROM tc.books),
        'book_files',    (SELECT count(*) FROM tc.book_files),
        'checkin_attempts', (SELECT count(*) FROM tc.checkin_attempts),
        'collection_files', (SELECT count(*) FROM tc.collection_files),
        'collection_file_checkin_attempts', (SELECT count(*) FROM tc.collection_file_checkin_attempts),
        'color_palette_entries', (SELECT count(*) FROM tc.color_palette_entries),
        'history_events', (SELECT count(*) FROM tc.history_events)
    )
$$;

-- The book's lock columns, for comparing before and after.
CREATE OR REPLACE FUNCTION tests.lock_of(p_book uuid)
RETURNS jsonb
LANGUAGE sql
AS $$
    SELECT jsonb_build_object('locked_by', locked_by, 'machine', locked_by_machine,
                              'locked_at', locked_at, 'hash', checkout_guid_hash)
    FROM tc.books WHERE id = p_book
$$;

CREATE OR REPLACE FUNCTION tests.checkout_events(p_book uuid)
RETURNS bigint
LANGUAGE sql
AS $$
    SELECT count(*) FROM tc.history_events WHERE book_id = p_book AND type = 0
$$;

-- =============================================================================
-- 0. The column, the constraint, the RPCs
-- =============================================================================

SELECT has_column('tc', 'collections', 'initial_upload_in_progress',
    '0a: tc.collections.initial_upload_in_progress exists');
SELECT col_not_null('tc', 'collections', 'initial_upload_in_progress', '0b: it is NOT NULL');
SELECT col_default_is('tc', 'collections', 'initial_upload_in_progress', 'false', '0c: it defaults to false');
SELECT has_function('tc', 'finish_initial_upload', ARRAY['uuid'], '0d: tc.finish_initial_upload(uuid) exists');
SELECT has_function('tc', 'lock_book_for_legacy_checkout', ARRAY['uuid', 'uuid', 'text', 'text', 'text'],
    '0e: tc.lock_book_for_legacy_checkout(uuid, uuid, text, text, text) exists');
SELECT ok(
    has_function_privilege('authenticated', 'tc.finish_initial_upload(uuid)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'tc.lock_book_for_legacy_checkout(uuid, uuid, text, text, text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'tc.create_collection(uuid, text, boolean)', 'EXECUTE'),
    '0f: members can call finish_initial_upload, lock_book_for_legacy_checkout and create_collection (the RPCs check admin themselves)'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.support_delete_collection(uuid, boolean)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'tc.support_delete_collection(uuid, boolean)', 'EXECUTE')
    AND has_function_privilege('service_role', 'tc.support_delete_collection(uuid, boolean)', 'EXECUTE'),
    '0g: support_delete_collection is service-role only'
);

-- =============================================================================
-- Fixture: Alice (admin) creates U with the flag set and O without it; Bob is a claimed
-- member of U; Carol and Dave are invited to U but have not claimed.
-- =============================================================================

SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');

SELECT lives_ok(
    $$SELECT tc.create_collection('c0000000-0000-0000-0000-0000000e0001', 'Uploading Collection', true)$$,
    '1a: create_collection with p_initial_upload = true succeeds'
);
SELECT lives_ok(
    $$SELECT tc.create_collection('c0000000-0000-0000-0000-0000000e0002', 'Ordinary Collection')$$,
    '1b: create_collection with the two original arguments still works'
);
SELECT is(
    (SELECT initial_upload_in_progress FROM tc.collections WHERE id = 'c0000000-0000-0000-0000-0000000e0001'),
    true, '1c: the flag is set on the collection created for an initial upload');
SELECT is(
    (SELECT initial_upload_in_progress FROM tc.collections WHERE id = 'c0000000-0000-0000-0000-0000000e0002'),
    false, '1d: an ordinary collection is created without it');

SELECT tc.members_add('c0000000-0000-0000-0000-0000000e0001', 'bob-iu@example.com', 'member');
SELECT tc.members_add('c0000000-0000-0000-0000-0000000e0001', 'carol-iu@example.com', 'member');
SELECT tc.members_add('c0000000-0000-0000-0000-0000000e0001', 'dave-iu@example.com', 'member');
SELECT tests.set_jwt('user-bob-iu', 'bob-iu@example.com');
SELECT tc.claim_memberships();
SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');

SELECT tests.add_book('b0000000-0000-0000-0000-00000000e101', 'c0000000-0000-0000-0000-0000000e0001', 'Bob Old Book');
SELECT tests.add_book('b0000000-0000-0000-0000-00000000e102', 'c0000000-0000-0000-0000-0000000e0001', 'Uncommitted Book', false);
SELECT tests.add_book('b0000000-0000-0000-0000-00000000e103', 'c0000000-0000-0000-0000-0000000e0001', 'Bob Current Book');
SELECT tests.add_book('b0000000-0000-0000-0000-00000000e104', 'c0000000-0000-0000-0000-0000000e0001', 'Deleted Book', true, true);
SELECT tests.add_book('b0000000-0000-0000-0000-00000000e105', 'c0000000-0000-0000-0000-0000000e0001', 'Jose Book');
SELECT tests.add_book('b0000000-0000-0000-0000-00000000e106', 'c0000000-0000-0000-0000-0000000e0001', 'Late Book');
SELECT tests.add_book('b0000000-0000-0000-0000-00000000e201', 'c0000000-0000-0000-0000-0000000e0002', 'Other Book');

SELECT ok(
    tests.user_with_email('bob-old@example.com') IS NULL,
    '1e: sanity: there is no user with the old checkout''s email yet'
);

-- =============================================================================
-- 2. What members see while the flag is set
-- =============================================================================

SELECT is(
    (tc.get_collection_state('c0000000-0000-0000-0000-0000000e0001') ->> 'initial_upload_in_progress'),
    'true', '2a: get_collection_state reports initial_upload_in_progress = true');
SELECT is(
    (tc.get_changes('c0000000-0000-0000-0000-0000000e0001', 0) ->> 'initial_upload_in_progress'),
    'true', '2b: get_changes reports it too');
SELECT is(
    (tc.get_collection_state('c0000000-0000-0000-0000-0000000e0002') ->> 'initial_upload_in_progress'),
    'false', '2c: an ordinary collection reports false');
SELECT is(
    (SELECT array_agg(id::text ORDER BY id) FROM tc.my_collections()),
    ARRAY['c0000000-0000-0000-0000-0000000e0002'],
    '2d: my_collections leaves out the collection being uploaded, even for its admin'
);
SELECT tests.set_jwt('user-carol-iu', 'carol-iu@example.com');
SELECT is(
    (SELECT count(*) FROM tc.my_collections()), 0::bigint,
    '2e: an invitee does not see the collection being uploaded');
SELECT tests.set_jwt('user-bob-iu', 'bob-iu@example.com');
SELECT is(
    (SELECT count(*) FROM tc.my_collections()), 0::bigint,
    '2f: nor does a claimed member');

-- Bob checks B3 out normally (he is the current holder of it in the cloud).
SELECT is(
    (tc.checkout_book(tests.coll('b0000000-0000-0000-0000-00000000e103'), tests.inst('b0000000-0000-0000-0000-00000000e103'), 'BOBPC', gen_random_uuid()::text) ->> 'success'),
    'true', '2g: Bob checks out a book normally during the upload (fixture)');

-- =============================================================================
-- 3. lock_book_for_legacy_checkout: who, when, which books
-- =============================================================================

SELECT set_config('tests.g1', gen_random_uuid()::text, true);

SELECT throws_ok(
    format($$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'bob-old@example.com', %L, 'OLDPC')$$,
           current_setting('tests.g1')),
    '42501', 'admin_required',
    '3a: a non-admin member cannot lock a carried-over checkout'
);
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'locked_by', NULL,
    '3b: ... and the book stays free');

SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');

SELECT throws_ok(
    $$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'bob-old@example.com', NULL, 'OLDPC')$$,
    '22023', NULL, '3c: no GUID is refused');
SELECT throws_ok(
    $$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'bob-old@example.com', '  ', 'OLDPC')$$,
    '22023', NULL, '3d: a blank GUID is refused');
SELECT throws_ok(
    format($$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), ' ', %L, 'OLDPC')$$,
           current_setting('tests.g1')),
    '22023', NULL, '3e: a blank email is refused');
SELECT throws_ok(
    format($$SELECT tc.lock_book_for_legacy_checkout('c0000000-0000-0000-0000-0000000e0001', 'a0000000-0000-0000-0000-00000000efff', 'bob-old@example.com', %L, 'OLDPC')$$,
           current_setting('tests.g1')),
    'P0002', NULL, '3f: an unknown book is refused');
SELECT throws_like(
    format($$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e102'), tests.inst('b0000000-0000-0000-0000-00000000e102'), 'bob-old@example.com', %L, 'OLDPC')$$,
           current_setting('tests.g1')),
    'book_not_committed%', '3g: a book with no committed version is refused');

SELECT set_config('tests.b3_before', tests.lock_of('b0000000-0000-0000-0000-00000000e103')::text, true);
SELECT set_config('tests.r_locked',
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e103'), tests.inst('b0000000-0000-0000-0000-00000000e103'), 'bob-old@example.com',
        current_setting('tests.g1'), 'OLDPC')::text, true);
SELECT is(current_setting('tests.r_locked')::jsonb ->> 'success', 'false',
    '3h: a book someone holds is refused');
SELECT is(current_setting('tests.r_locked')::jsonb ->> 'locked_by', tests.uid('user-bob-iu')::text,
    '3i: ... naming the holder, as checkout_book does');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e103'), current_setting('tests.b3_before')::jsonb,
    '3j: ... and Bob''s lock is unchanged');

SELECT is(
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e104'), tests.inst('b0000000-0000-0000-0000-00000000e104'), 'bob-old@example.com',
        current_setting('tests.g1'), 'OLDPC') ->> 'success',
    'false', '3k: a deleted book is refused');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e104') ->> 'locked_by', NULL,
    '3l: ... and stays unlocked');

-- The real thing: B1 is checked out to bob-old@example.com on OLDPC in the old system.
SELECT set_config('tests.r1',
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), '  Bob-Old@Example.COM ',
        current_setting('tests.g1'), 'OLDPC')::text, true);
SELECT is(current_setting('tests.r1')::jsonb ->> 'success', 'true', '3m: the admin locks a free committed book to the old checkout''s email');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'locked_by', tests.user_with_email('bob-old@example.com')::text,
    '3n: locked_by is the user with the trimmed, lowercased email');
SELECT is(current_setting('tests.r1')::jsonb ->> 'locked_by', tests.user_with_email('bob-old@example.com')::text,
    '3o: ... which the result reports');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'hash', tests.guid_hash(current_setting('tests.g1')),
    '3p: the stored hash is the contract hash of the GUID');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'machine', 'OLDPC',
    '3q: locked_by_machine is the old machine');
SELECT ok(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'locked_at' IS NOT NULL, '3r: locked_at is set');
SELECT is(tests.checkout_events('b0000000-0000-0000-0000-00000000e101'), 1::bigint, '3s: one CheckOut event');
SELECT is(
    (SELECT jsonb_build_object('by', by_user_id, 'holder', lock_info ->> 'locked_by',
                               'machine', lock_info ->> 'machine')
     FROM tc.history_events WHERE book_id = 'b0000000-0000-0000-0000-00000000e101' AND type = 0),
    jsonb_build_object('by', tests.uid('user-alice-iu'),
                       'holder', tests.user_with_email('bob-old@example.com'), 'machine', 'OLDPC'),
    '3t: the event''s actor is the admin, and lock_info names the holder'
);

-- Idempotent: resuming after a crash repeats the call with the same GUID.
SELECT set_config('tests.b1_locked', tests.lock_of('b0000000-0000-0000-0000-00000000e101')::text, true);
SELECT is(
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'bob-old@example.com',
        upper(current_setting('tests.g1')), 'OTHERPC') ->> 'success',
    'true', '3u: the same holder with the same GUID succeeds again');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101'), current_setting('tests.b1_locked')::jsonb,
    '3v: ... changing nothing (not even the machine)');
SELECT is(tests.checkout_events('b0000000-0000-0000-0000-00000000e101'), 1::bigint, '3w: ... and emitting no second event');

SELECT is(
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'bob-old@example.com',
        gen_random_uuid()::text, 'OLDPC') ->> 'success',
    'false', '3x: the same holder with a different GUID is refused');
SELECT is(
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'someone-else@example.com',
        current_setting('tests.g1'), 'OLDPC') ->> 'success',
    'false', '3y: another holder with the same GUID is refused');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101'), current_setting('tests.b1_locked')::jsonb,
    '3z: ... and neither changed the lock');

-- NFC, like member emails: a decomposed accent is stored composed.
SELECT set_config('tests.g5', gen_random_uuid()::text, true);
SELECT is(
    tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e105'), tests.inst('b0000000-0000-0000-0000-00000000e105'), U&'Jose\0301@example.com',
        current_setting('tests.g5'), 'OLDPC2') ->> 'success',
    'true', '3aa: a second carried-over checkout (fixture for NFC and force unlock)');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e105') ->> 'locked_by',
    tests.user_with_email(normalize(U&'jose\0301@example.com', NFC))::text,
    '3ab: the holder''s email is NFC-normalized');

-- =============================================================================
-- 4. How a carried-over checkout displays
-- =============================================================================

SELECT ok(
    (SELECT authentication_id IS NULL AND name IS NULL FROM core.users
      WHERE id = tests.user_with_email('bob-old@example.com')),
    '4a: the holder is an unclaimed user: no login and no name'
);
SELECT is(
    (SELECT b ->> 'locked_by_email'
     FROM jsonb_array_elements(tc.get_collection_state('c0000000-0000-0000-0000-0000000e0001') -> 'books') b
     WHERE b ->> 'instance_id' = tests.inst('b0000000-0000-0000-0000-00000000e103')::text),
    'bob-iu@example.com',
    '4b: a book an ordinary member holds shows that member''s email'
);
SELECT is(
    (SELECT b ->> 'locked_by_email'
     FROM jsonb_array_elements(tc.get_collection_state('c0000000-0000-0000-0000-0000000e0001') -> 'books') b
     WHERE b ->> 'instance_id' = tests.inst('b0000000-0000-0000-0000-00000000e101')::text),
    'bob-old@example.com', '4c: get_collection_state shows the book as checked out to the old email');
SELECT is(
    (SELECT b ->> 'locked_by_email'
     FROM jsonb_array_elements(tc.get_changes('c0000000-0000-0000-0000-0000000e0001', 0) -> 'books') b
     WHERE b ->> 'instance_id' = tests.inst('b0000000-0000-0000-0000-00000000e101')::text),
    'bob-old@example.com', '4d: so does get_changes');
SELECT is(
    tc.get_book_manifest(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101')) ->> 'lockedByEmail',
    'bob-old@example.com', '4e: so does get_book_manifest');

-- =============================================================================
-- 5. Nobody can use a carried-over checkout without taking it over
-- =============================================================================

SELECT tests.set_jwt('user-bob-iu', 'bob-iu@example.com');
SELECT throws_like(
    format($$SELECT tc.unlock_book(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), %L)$$, current_setting('tests.g1')),
    'lock_not_held%', '5a: a member with the GUID still cannot unlock it');
SELECT throws_like(
    format($$SELECT tc.delete_book(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), %L)$$, current_setting('tests.g1')),
    'lock_required%', '5b: nor delete it');
SELECT throws_ok(
    format($$SELECT tc.checkin_start_tx('c0000000-0000-0000-0000-0000000e0001',
             tests.inst('b0000000-0000-0000-0000-00000000e101'),
             'Bob Old Book', NULL, 'cs-new', '6.6.0',
             jsonb_build_array(jsonb_build_object('path', 'index.htm', 'sha256', 'sha-new', 'size', 11)),
             %L)$$, current_setting('tests.g1')),
    'PT409', NULL, '5c: nor check it in (LockHeldByOther)');
SELECT is(
    tc.checkout_book(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), 'BOBPC', current_setting('tests.g1')) ->> 'success',
    'false', '5d: nor check it out');
SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');
SELECT throws_like(
    format($$SELECT tc.unlock_book(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), %L)$$, current_setting('tests.g1')),
    'lock_not_held%', '5e: the admin who placed it cannot unlock it either (force_unlock is the way)');
SELECT throws_like(
    format($$SELECT tc.delete_book(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), %L)$$, current_setting('tests.g1')),
    'lock_required%', '5f: nor delete it');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101'), current_setting('tests.b1_locked')::jsonb,
    '5g: none of that changed the lock');

-- Removing a member who never claimed (user_id NULL) touches no carried-over checkout.
SELECT lives_ok(
    $$SELECT tc.members_remove('c0000000-0000-0000-0000-0000000e0001',
        (SELECT id FROM tc.members WHERE email = 'carol-iu@example.com'))$$,
    '5h: members_remove of an unclaimed member works with carried-over checkouts present');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101'), current_setting('tests.b1_locked')::jsonb,
    '5i: ... and leaves the carried-over checkout alone');

-- =============================================================================
-- 6. finish_initial_upload
-- =============================================================================

SELECT tests.set_jwt('user-bob-iu', 'bob-iu@example.com');
SELECT throws_ok(
    $$SELECT tc.finish_initial_upload('c0000000-0000-0000-0000-0000000e0001')$$,
    '42501', 'admin_required', '6a: a non-admin cannot clear the flag');
SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');
SELECT throws_ok(
    $$SELECT tc.finish_initial_upload('c0000000-0000-0000-0000-0000000effff')$$,
    'P0002', 'collection_not_found', '6b: an unknown collection is refused');
SELECT is(
    (SELECT initial_upload_in_progress FROM tc.collections WHERE id = 'c0000000-0000-0000-0000-0000000e0001'),
    true, '6c: the flag is still set (sanity check before clearing it)');
SELECT lives_ok(
    $$SELECT tc.finish_initial_upload('c0000000-0000-0000-0000-0000000e0001')$$,
    '6d: the admin clears the flag');
SELECT is(
    (SELECT initial_upload_in_progress FROM tc.collections WHERE id = 'c0000000-0000-0000-0000-0000000e0001'),
    false, '6e: the flag is clear');
SELECT lives_ok(
    $$SELECT tc.finish_initial_upload('c0000000-0000-0000-0000-0000000e0001')$$,
    '6f: clearing it again is a no-op success (retry after a lost response)');
SELECT throws_ok(
    $$SELECT tc.create_collection('c0000000-0000-0000-0000-0000000e0001', 'Uploading Collection', true)$$,
    '23505', NULL, '6g: the flag cannot be set again (create_collection, its only setter, cannot recreate the collection)');
SELECT is(
    (SELECT initial_upload_in_progress FROM tc.collections WHERE id = 'c0000000-0000-0000-0000-0000000e0001'),
    false, '6h: ... and it stays clear');
SELECT is(
    (tc.get_collection_state('c0000000-0000-0000-0000-0000000e0001') ->> 'initial_upload_in_progress'),
    'false', '6i: get_collection_state reports it cleared');
SELECT is(
    (tc.get_changes('c0000000-0000-0000-0000-0000000e0001', 0) ->> 'initial_upload_in_progress'),
    'false', '6j: get_changes reports it cleared');
SELECT is(
    (SELECT array_agg(id::text ORDER BY id) FROM tc.my_collections()),
    ARRAY['c0000000-0000-0000-0000-0000000e0001', 'c0000000-0000-0000-0000-0000000e0002'],
    '6k: my_collections now lists it for the admin'
);
SELECT tests.set_jwt('user-dave-iu', 'dave-iu@example.com');
SELECT is(
    (SELECT array_agg(id::text) FROM tc.my_collections()),
    ARRAY['c0000000-0000-0000-0000-0000000e0001'],
    '6l: and for an invitee'
);
SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');
SELECT throws_like(
    format($$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e106'), tests.inst('b0000000-0000-0000-0000-00000000e106'), 'bob-old@example.com', %L, 'OLDPC')$$,
           gen_random_uuid()::text),
    'initial_upload_not_in_progress%', '6m: no carried-over checkout once the flag is clear');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e106') ->> 'locked_by', NULL, '6n: ... and the book stays free');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101'), current_setting('tests.b1_locked')::jsonb,
    '6o: carried-over checkouts placed during the upload survive clearing the flag');
SELECT throws_like(
    format($$SELECT tc.lock_book_for_legacy_checkout(tests.coll('b0000000-0000-0000-0000-00000000e201'), tests.inst('b0000000-0000-0000-0000-00000000e201'), 'bob-old@example.com', %L, 'OLDPC')$$,
           gen_random_uuid()::text),
    'initial_upload_not_in_progress%', '6p: an ordinary collection (never flagged) refuses carried-over checkouts too');

-- =============================================================================
-- 7. Takeover moves a carried-over checkout to whoever presents the GUID
-- =============================================================================

SELECT tests.set_jwt('user-bob-iu', 'bob-iu@example.com');
SELECT is(
    tc.checkout_book_takeover(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), gen_random_uuid()::text, 'BOBNEWPC') ->> 'success',
    'false', '7a: takeover with the wrong GUID is refused');
SELECT is(
    tc.checkout_book_takeover(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), tests.guid_hash(current_setting('tests.g1')), 'BOBNEWPC') ->> 'success',
    'false', '7b: takeover presenting the (member-readable) hash is refused');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101'), current_setting('tests.b1_locked')::jsonb,
    '7c: ... and the unclaimed user still holds it');
SELECT is(tests.checkout_events('b0000000-0000-0000-0000-00000000e101'), 1::bigint, '7d: ... with no new event');

SELECT is(
    tc.checkout_book_takeover(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), upper(current_setting('tests.g1')), 'BOBNEWPC') ->> 'success',
    'true', '7e: a member presenting the GUID from the Migration Keys file takes it over');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'locked_by', tests.uid('user-bob-iu')::text,
    '7f: the lock is now the caller''s (whatever the old email was)');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'hash', tests.guid_hash(current_setting('tests.g1')),
    '7g: the GUID is kept');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e101') ->> 'machine', 'BOBNEWPC',
    '7h: the new machine is recorded');
SELECT is(
    (SELECT by_user_id FROM tc.history_events
     WHERE book_id = 'b0000000-0000-0000-0000-00000000e101' AND type = 0 ORDER BY id DESC LIMIT 1),
    tests.uid('user-bob-iu'), '7i: a CheckOut event by the new holder');
SELECT is(tests.checkout_events('b0000000-0000-0000-0000-00000000e101'), 2::bigint, '7j: (two CheckOut events in all)');
SELECT lives_ok(
    format($$SELECT tc.unlock_book(tests.coll('b0000000-0000-0000-0000-00000000e101'), tests.inst('b0000000-0000-0000-0000-00000000e101'), %L)$$, current_setting('tests.g1')),
    '7k: from then on it is an ordinary checkout (the holder can unlock it with the GUID)');

-- =============================================================================
-- 8. force_unlock clears a carried-over checkout
-- =============================================================================

SELECT tests.set_jwt('user-alice-iu', 'alice-iu@example.com');
SELECT set_config('tests.b5_locked', tests.lock_of('b0000000-0000-0000-0000-00000000e105')::text, true);
SELECT lives_ok(
    $$SELECT tc.force_unlock(tests.coll('b0000000-0000-0000-0000-00000000e105'), tests.inst('b0000000-0000-0000-0000-00000000e105'))$$,
    '8a: an admin force-unlocks a carried-over checkout (its owner never switched)');
SELECT is(tests.lock_of('b0000000-0000-0000-0000-00000000e105'),
    jsonb_build_object('locked_by', NULL, 'machine', NULL, 'locked_at', NULL, 'hash', NULL),
    '8b: lock and GUID hash are cleared');
SELECT is(
    (SELECT lock_info ->> 'locked_by' FROM tc.history_events
     WHERE book_id = 'b0000000-0000-0000-0000-00000000e105' AND type = 5),
    current_setting('tests.b5_locked')::jsonb ->> 'locked_by',
    '8c: the ForcedUnlock event records the unclaimed holder in lock_info');

-- =============================================================================
-- 9. support_delete_collection
-- =============================================================================

SELECT tests.populate('c0000000-0000-0000-0000-0000000e0001', 'b0000000-0000-0000-0000-00000000e103');
SELECT tests.populate('c0000000-0000-0000-0000-0000000e0002', 'b0000000-0000-0000-0000-00000000e201');
SELECT set_config('tests.u_before', tests.row_counts('c0000000-0000-0000-0000-0000000e0001')::text, true);
SELECT set_config('tests.o_before', tests.row_counts('c0000000-0000-0000-0000-0000000e0002')::text, true);
SELECT set_config('tests.all_before', tests.total_counts()::text, true);

SELECT ok(
    NOT EXISTS (SELECT 1 FROM jsonb_each_text(current_setting('tests.u_before')::jsonb) WHERE value::int = 0)
    AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(current_setting('tests.o_before')::jsonb) WHERE value::int = 0),
    '9a: both collections have rows in every tc table (sanity check of the fixture)'
);

SELECT set_config('tests.dry',
    tc.support_delete_collection('c0000000-0000-0000-0000-0000000e0001', true)::text, true);
SELECT is(tests.row_counts('c0000000-0000-0000-0000-0000000e0001'), current_setting('tests.u_before')::jsonb,
    '9b: a dry run deletes nothing');
SELECT is(current_setting('tests.dry')::jsonb -> 'rows' -> 'books',
    current_setting('tests.u_before')::jsonb -> 'books', '9c: ... and reports the rows it would delete');

SELECT set_config('tests.del',
    tc.support_delete_collection('c0000000-0000-0000-0000-0000000e0001')::text, true);
SELECT is(current_setting('tests.del')::jsonb ->> 'deleted', 'true', '9d: the real run reports deleted');
SELECT ok(
    NOT EXISTS (SELECT 1 FROM jsonb_each_text(tests.row_counts('c0000000-0000-0000-0000-0000000e0001')) WHERE value::int <> 0),
    '9e: every row of the deleted collection is gone (despite its last admin)'
);
SELECT is(tests.row_counts('c0000000-0000-0000-0000-0000000e0002'), current_setting('tests.o_before')::jsonb,
    '9f: another collection''s rows are untouched');
SELECT is(
    (SELECT jsonb_object_agg(a.key, a.value::bigint - u.value::bigint)
     FROM jsonb_each_text(current_setting('tests.all_before')::jsonb) a
     JOIN jsonb_each_text(current_setting('tests.u_before')::jsonb) u USING (key)),
    tests.total_counts(),
    '9f2: exactly the deleted collection''s rows went, table by table, and nothing else'
);
SELECT is(
    tc.support_delete_collection('c0000000-0000-0000-0000-0000000e0001') ->> 'found',
    'false', '9g: running it again finds nothing and succeeds');

SELECT * FROM finish();
ROLLBACK;
