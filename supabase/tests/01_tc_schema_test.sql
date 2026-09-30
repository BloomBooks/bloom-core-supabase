-- =============================================================================
-- pgTAP tests: Cloud Team Collections â€” tc schema, RLS, RPCs
-- =============================================================================
-- Run with:
--   supabase start
--   supabase test db
--
-- Requires: pgTAP extension (bundled with local Supabase), pgtap schema accessible.
-- =============================================================================

BEGIN;

-- Load pgTAP
SELECT plan(74);   -- update count when tests are added/removed

-- =============================================================================
-- 0. Sanity: schemas and key tables exist, and the tables the plan dropped do not
-- =============================================================================

SELECT has_schema('tc', 'tc schema exists');
SELECT has_schema('core', 'core schema exists');

SELECT has_table('core', 'users',                          'core.users table exists');
SELECT has_table('tc', 'collections',                      'tc.collections table exists');
SELECT has_table('tc', 'members',                          'tc.members table exists');
SELECT has_table('tc', 'books',                            'tc.books table exists');
SELECT has_table('tc', 'book_files',                       'tc.book_files table exists');
SELECT has_table('tc', 'collection_files',                 'tc.collection_files table exists');
SELECT has_table('tc', 'color_palette_entries',            'tc.color_palette_entries table exists');
SELECT has_table('tc', 'history_events',                   'tc.history_events table exists');
SELECT has_table('tc', 'checkin_attempts',                 'tc.checkin_attempts table exists');
SELECT has_table('tc', 'collection_file_checkin_attempts', 'tc.collection_file_checkin_attempts table exists');
SELECT hasnt_table('tc', 'versions',                       'no tc.versions table (a version is a number per book)');

SELECT has_function('tc', 'jwt_email_verified',   'tc.jwt_email_verified() exists');
SELECT has_function('tc', 'create_collection',    'tc.create_collection() exists');
SELECT has_function('tc', 'claim_memberships',    'tc.claim_memberships() exists');
SELECT has_function('tc', 'checkout_book',        'tc.checkout_book() exists');
SELECT hasnt_function('tc', 'rename_check',       'no tc.rename_check() (book names are not unique)');

-- =============================================================================
-- Test fixture helpers
-- =============================================================================
-- We impersonate JWT callers via set_config so SECURITY DEFINER functions
-- can read auth.jwt().  In real Supabase these come from the auth layer.

CREATE SCHEMA IF NOT EXISTS tests;

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

-- Helper: set a fake JWT so auth.jwt() returns a known sub/email
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
        true   -- local to transaction
    );
END;
$$;

-- =============================================================================
-- 1. jwt_email_verified()
-- =============================================================================

-- 1a. Firebase-style: email_verified = true
DO $$
BEGIN
    PERFORM set_config('request.jwt.claims',
        '{"sub":"firebase-uid-abc","email":"alice@example.com","email_verified":true,"role":"authenticated"}',
        true);
END;
$$;
SELECT ok(tc.jwt_email_verified(), '1a: jwt_email_verified() true for Firebase email_verified=true');

-- 1b. Firebase-style: email_verified = false
DO $$
BEGIN
    PERFORM set_config('request.jwt.claims',
        '{"sub":"firebase-uid-abc","email":"alice@example.com","email_verified":false,"role":"authenticated"}',
        true);
END;
$$;
SELECT ok(NOT tc.jwt_email_verified(), '1b: jwt_email_verified() false for Firebase email_verified=false');

-- 1c. Local GoTrue: no email_verified claim, role = 'authenticated'
DO $$
BEGIN
    PERFORM set_config('request.jwt.claims',
        '{"sub":"11111111-1111-1111-1111-111111111111","email":"dev@localhost","role":"authenticated"}',
        true);
END;
$$;
SELECT ok(tc.jwt_email_verified(), '1c: jwt_email_verified() true for local GoTrue (no claim, role=authenticated)');

-- =============================================================================
-- 2. create_collection + RLS: member can read their collection
-- =============================================================================

SELECT tests.set_jwt('user-alice-001', 'alice@example.com');

SELECT is(tests.uid('user-alice-001'), NULL, '2-pre: Alice has no user row before she does anything');

-- Alice creates a collection
SELECT lives_ok(
    $$SELECT tc.create_collection('a0000000-0000-0000-0000-000000000001'::uuid, 'Alice Test Collection')$$,
    '2a: create_collection succeeds for authenticated user'
);

SELECT ok(
    (SELECT created_by = tests.uid('user-alice-001') AND tests.uid('user-alice-001') IS NOT NULL
       FROM tc.collections WHERE id = 'a0000000-0000-0000-0000-000000000001'),
    '2a1: create_collection made Alice''s user row and records it as the creator'
);

-- Alice can see her collection via RLS. Must run as the authenticated role â€” the suite's
-- postgres superuser bypasses RLS, which would make this assertion pass vacuously.
SET LOCAL ROLE authenticated;

SELECT ok(
    (SELECT count(*) = 1 FROM tc.collections WHERE id = 'a0000000-0000-0000-0000-000000000001'),
    '2b: Alice can SELECT her collection (RLS: is_member)'
);

-- Alice is an admin member
SELECT ok(
    (SELECT role = 'admin' FROM tc.members
     WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'
       AND user_id = tc.current_user_id()),
    '2c: Alice is recorded as admin of her collection'
);

RESET ROLE;

-- =============================================================================
-- 3. RLS matrix: non-member cannot read
-- =============================================================================

SELECT tests.set_jwt('user-bob-002', 'bob@example.com');

-- RLS only applies to non-superuser roles: the suite runs as postgres, which BYPASSES
-- row security, so these direct-table assertions must run as the authenticated role
-- (the role PostgREST uses for JWT-carrying requests). RESET ROLE afterwards so later
-- fixture writes run as postgres again.
SET LOCAL ROLE authenticated;

SELECT ok(
    (SELECT count(*) = 0 FROM tc.collections WHERE id = 'a0000000-0000-0000-0000-000000000001'),
    '3a: Non-member Bob cannot SELECT Alice''s collection (RLS)'
);

SELECT ok(
    (SELECT count(*) = 0 FROM tc.books
     WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'),
    '3b: Non-member Bob cannot SELECT books in Alice''s collection (RLS)'
);

SELECT ok(
    (SELECT count(*) = 0 FROM tc.history_events
     WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'),
    '3c: Non-member Bob cannot SELECT history events in Alice''s collection (RLS)'
);

SELECT throws_ok(
    $$SELECT count(*) FROM core.users$$,
    '42501',
    NULL,
    '3d: a signed-in user cannot read core.users directly'
);

RESET ROLE;

-- =============================================================================
-- 4. claim_memberships requires verified email
-- =============================================================================

-- Add Bob as an approved member (Alice adds him)
SELECT tests.set_jwt('user-alice-001', 'alice@example.com');

SELECT lives_ok(
    $$SELECT tc.members_add('a0000000-0000-0000-0000-000000000001', 'bob@example.com', 'member')$$,
    '4a: Admin Alice can add Bob as approved member'
);

-- Bob with unverified email cannot claim
SELECT tests.set_jwt('user-bob-002', 'bob@example.com', false);

SELECT throws_ok(
    $$SELECT tc.claim_memberships()$$,
    '28000',    -- invalid_authorization_specification, raised by claim_memberships
    NULL,
    '4b: claim_memberships raises when email_verified=false'
);

-- Bob with verified email can claim
SELECT tests.set_jwt('user-bob-002', 'bob@example.com');

SELECT is(
    (tc.claim_memberships() ->> 'userId')::uuid,
    tests.uid('user-bob-002'),
    '4c: claim_memberships succeeds for verified Bob, returning his new user id'
);

SELECT ok(
    tests.uid('user-bob-002') IS NOT NULL
    AND (SELECT user_id = tests.uid('user-bob-002') FROM tc.members
          WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'
            AND email = 'bob@example.com'),
    '4d: Bob''s user_id is filled after claiming'
);

-- =============================================================================
-- 5. checkout_book concurrency: exactly one winner
-- =============================================================================
-- Insert a test book directly (SECURITY DEFINER helper â€” RLS bypassed for setup).
INSERT INTO tc.books (id, collection_id, instance_id, name, current_version)
VALUES (
    'b0000000-0000-0000-0000-000000000001'::uuid,
    'a0000000-0000-0000-0000-000000000001'::uuid,
    'b0000000-0000-0000-0000-000000000002'::uuid,
    'Test Book',
    1
);

-- Alice checks out
SELECT tests.set_jwt('user-alice-001', 'alice@example.com');

-- Keep the checkout GUID Alice's client makes and saves in the book's .checkout file; the
-- delete below needs it.
SELECT set_config('tests.alice_guid',
    tests.checkout('b0000000-0000-0000-0000-000000000002', 'AliceMachine'),
    true);

SELECT ok(
    current_setting('tests.alice_guid', true) IS NOT NULL
    AND (SELECT locked_by FROM tc.books WHERE id = 'b0000000-0000-0000-0000-000000000001') = tests.uid('user-alice-001'),
    '5a: Alice wins the checkout race (first call) and gets a checkout GUID'
);

-- Bob tries to check out the same book â€” should fail
SELECT tests.set_jwt('user-bob-002', 'bob@example.com');

SELECT ok(
    (SELECT (tc.checkout_book('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002',
                              'BobMachine', gen_random_uuid()::text)) ->> 'success' = 'false'),
    '5b: Bob loses the checkout race (lock already held)'
);

-- Exactly one CheckOut event (type=0) emitted
SELECT ok(
    (SELECT count(*) = 1 FROM tc.history_events
     WHERE book_id = 'b0000000-0000-0000-0000-000000000001'
       AND type = 0),
    '5c: exactly one CheckOut event (type=0) emitted'
);

SELECT throws_ok(
    $$SELECT tc.checkout_book('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000099',
                              'BobMachine', gen_random_uuid()::text)$$,
    'P0002',
    NULL,
    '5d: checkout_book of an instance id the collection has no book for is book_not_found'
);

-- =============================================================================
-- 6. last-admin guard
-- =============================================================================

-- Attempt to remove Alice (the only admin) should fail
SELECT tests.set_jwt('user-alice-001', 'alice@example.com');

SELECT throws_ok(
    $$SELECT tc.members_remove(
        'a0000000-0000-0000-0000-000000000001',
        (SELECT id FROM tc.members WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'
          AND user_id = tests.uid('user-alice-001'))
    )$$,
    'P0001',
    NULL,
    '6a: Removing the last admin raises last_admin_guard'
);

-- Demoting Alice to member should also fail
SELECT throws_ok(
    $$UPDATE tc.members
      SET role = 'member'
      WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'
        AND user_id = tests.uid('user-alice-001')$$,
    'P0001',
    NULL,
    '6b: Demoting the last admin raises last_admin_guard'
);

-- =============================================================================
-- 7. get_changes cursor, and log_event
-- =============================================================================

SELECT tests.set_jwt('user-alice-001', 'alice@example.com');

SELECT lives_ok(
    $$SELECT tc.log_event(
        'a0000000-0000-0000-0000-000000000001',
        'b0000000-0000-0000-0000-000000000002',
        100,  -- WorkPreservedLocally
        'test incident',
        'Test Book',
        '6.5.0'
    )$$,
    '7a: log_event succeeds for a member'
);

SELECT throws_ok(
    $$SELECT tc.log_event('a0000000-0000-0000-0000-000000000001', NULL, 100, 'no book')$$,
    '22023',
    NULL,
    '7a1: log_event refuses a book event type with no instance id'
);

SELECT throws_ok(
    $$SELECT tc.log_event('a0000000-0000-0000-0000-000000000001',
                          'b0000000-0000-0000-0000-000000000099', 100, 'no such book')$$,
    'P0002',
    NULL,
    '7a2: log_event refuses an instance id the collection has no book for'
);

-- get_changes with cursor = 0 returns events
SELECT ok(
    (SELECT jsonb_array_length(
        (tc.get_changes('a0000000-0000-0000-0000-000000000001', 0)) -> 'events'
    ) > 0),
    '7b: get_changes(since=0) returns at least one event'
);

SELECT ok(
    (SELECT e ->> 'instance_id' = 'b0000000-0000-0000-0000-000000000002'
            AND (e ->> 'by_user_id')::uuid = tests.uid('user-alice-001')
            AND NOT (e ? 'book_id')
       FROM jsonb_array_elements(tc.get_changes('a0000000-0000-0000-0000-000000000001', 0) -> 'events') e
      WHERE (e ->> 'type')::int = 100),
    '7b1: an event names its book by instance_id (not the internal id) and its author by user id'
);

-- get_changes with cursor = max returns empty
SELECT ok(
    (SELECT jsonb_array_length(
        (tc.get_changes(
            'a0000000-0000-0000-0000-000000000001',
            (SELECT max(id) FROM tc.history_events WHERE collection_id = 'a0000000-0000-0000-0000-000000000001')
        )) -> 'events'
    ) = 0),
    '7c: get_changes(since=max_id) returns empty events'
);

-- =============================================================================
-- 8. Tombstone / undelete
-- =============================================================================

-- Alice must hold the lock to delete (she already holds it from checkout in test 5a)
SELECT lives_ok(
    format($$SELECT tc.delete_book('a0000000-0000-0000-0000-000000000001',
                                   'b0000000-0000-0000-0000-000000000002', %L)$$,
        current_setting('tests.alice_guid')),
    '8a: delete_book succeeds when caller holds the lock (with its checkout GUID)'
);

SELECT ok(
    (SELECT deleted_at IS NOT NULL FROM tc.books
     WHERE id = 'b0000000-0000-0000-0000-000000000001'),
    '8b: deleted_at is set after delete_book'
);

-- Admin (Alice) can undelete
SELECT lives_ok(
    $$SELECT tc.undelete_book('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002')$$,
    '8c: admin can undelete a tombstoned book'
);

SELECT ok(
    (SELECT deleted_at IS NULL FROM tc.books
     WHERE id = 'b0000000-0000-0000-0000-000000000001'),
    '8d: deleted_at is NULL after undelete_book'
);

-- =============================================================================
-- 9. Book names are for display only: not unique. Instance ids are unique per collection,
--    deleted books included.
-- =============================================================================

-- Delete the existing book again, to tombstone it.
SELECT tc.delete_book('a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002',
    tests.checkout('b0000000-0000-0000-0000-000000000002', 'AliceMachine'));

SELECT lives_ok(
    $$INSERT INTO tc.books (id, collection_id, instance_id, name)
      VALUES (
          'b0000000-0000-0000-0000-000000000099'::uuid,
          'a0000000-0000-0000-0000-000000000001'::uuid,
          'b0000000-0000-0000-0000-000000000098'::uuid,
          'Test Book'
      )$$,
    '9a: a live book may have a deleted book''s name'
);

SELECT lives_ok(
    $$INSERT INTO tc.books (id, collection_id, instance_id, name)
      VALUES (
          'b0000000-0000-0000-0000-000000000097'::uuid,
          'a0000000-0000-0000-0000-000000000001'::uuid,
          'b0000000-0000-0000-0000-000000000096'::uuid,
          'Test Book'
      )$$,
    '9b: two live books may have the same name'
);

SELECT throws_ok(
    $$INSERT INTO tc.books (collection_id, instance_id, name)
      VALUES (
          'a0000000-0000-0000-0000-000000000001'::uuid,
          'b0000000-0000-0000-0000-000000000002'::uuid,
          'Another Name'
      )$$,
    '23505',   -- unique_violation
    NULL,
    '9c: a second book with a deleted book''s instance id raises unique_violation'
);

-- =============================================================================
-- 10. get_collection_file_manifest: one set of collection files per collection
-- =============================================================================
-- Seed the committed files directly (pgTAP can't drive the two-phase S3 upload). Alice is an
-- admin/member of the collection above.
DO $$
BEGIN
    UPDATE tc.collections SET collection_files_version = 3
    WHERE id = 'a0000000-0000-0000-0000-000000000001';
    INSERT INTO tc.collection_files (collection_id, path, sha256, size_bytes, s3_version_id)
    VALUES
        ('a0000000-0000-0000-0000-000000000001', 'Allowed Words/list.txt', 'sha-a', 10, 'sv-1'),
        ('a0000000-0000-0000-0000-000000000001', 'customCollectionStyles.css', 'sha-b', 20, 'sv-2');
END
$$;

SELECT is(
    (tc.get_collection_file_manifest('a0000000-0000-0000-0000-000000000001') ->> 'version'),
    '3',
    '10a: get_collection_file_manifest returns the collection files'' version'
);
SELECT is(
    jsonb_array_length(tc.get_collection_file_manifest(
        'a0000000-0000-0000-0000-000000000001') -> 'files'),
    2,
    '10b: manifest returns every committed collection file'
);
SELECT is(
    (tc.get_collection_file_manifest('a0000000-0000-0000-0000-000000000001')
        -> 'files' -> 0 ->> 's3VersionId'),
    'sv-1',
    '10c: manifest files carry the pinned s3VersionId (ordered by path)'
);

SELECT tc.create_collection('a0000000-0000-0000-0000-000000000002'::uuid, 'Never Sent');

SELECT is(
    (tc.get_collection_file_manifest('a0000000-0000-0000-0000-000000000002') ->> 'version'),
    '0',
    '10d: a collection whose files were never sent returns version 0 (not an error)'
);
SELECT is(
    jsonb_array_length(tc.get_collection_file_manifest(
        'a0000000-0000-0000-0000-000000000002') -> 'files'),
    0,
    '10e: a collection whose files were never sent returns empty files'
);

SELECT is(
    (tc.get_collection_state('a0000000-0000-0000-0000-000000000001') ->> 'collection_files_version'),
    '3',
    '10e1: get_collection_state reports the collection files'' version'
);

-- A non-member (one with no user row at all) is refused.
SELECT tests.set_jwt('user-carol-999', 'carol@example.com');
SELECT throws_ok(
    $$SELECT tc.get_collection_file_manifest('a0000000-0000-0000-0000-000000000001')$$,
    '42501',
    NULL,
    '10f: get_collection_file_manifest refuses a non-member'
);

-- =============================================================================
-- 11. concurrency lock + admin recovery
-- =============================================================================

-- 11a: the last-admin guard must take a FOR UPDATE lock on the parent collection so concurrent
-- admin removals serialize instead of racing to zero admins. A true two-session race can't be
-- reproduced in single-session pgTAP, so assert the lock is present in the function body -- a
-- regression guard against a future CREATE OR REPLACE silently dropping it. (6a/6b cover the
-- actual rejection behavior.)
SELECT ok(
    pg_get_functiondef('tc.members_last_admin_guard()'::regprocedure)
        LIKE '%tc.collections%FOR UPDATE%',
    '11a: last_admin_guard locks the collection row (serializes concurrent admin removals)'
);

-- 11b: support_set_admin promotes an EXISTING member to admin (the common recovery). The
-- mixed-case input also exercises the normalization.
DO $$
BEGIN
    INSERT INTO tc.members (collection_id, email, role, added_by)
    VALUES ('a0000000-0000-0000-0000-000000000001', 'recover-promote@example.com', 'member', NULL);
    PERFORM tc.support_set_admin('a0000000-0000-0000-0000-000000000001', 'Recover-Promote@Example.com');
END;
$$;
SELECT is(
    (SELECT role::text FROM tc.members
      WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'
        AND email = 'recover-promote@example.com'),
    'admin',
    '11b: support_set_admin promotes an existing member to admin (case-insensitive)'
);

-- 11c: support_set_admin grants admin to an email that is NOT yet a member (inserts a row).
DO $$
BEGIN
    PERFORM tc.support_set_admin('a0000000-0000-0000-0000-000000000001', 'recover-new@example.com');
END;
$$;
SELECT ok(
    (SELECT role::text = 'admin' AND added_by IS NULL FROM tc.members
      WHERE collection_id = 'a0000000-0000-0000-0000-000000000001'
        AND email = 'recover-new@example.com'),
    '11c: support_set_admin grants admin to a not-yet-member email (added_by NULL: the Bloom team)'
);

-- 11d: support_set_admin is a service-role-only recovery tool -- a normal signed-in caller
-- (`authenticated`) must not be able to execute it.
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.support_set_admin(uuid, text)', 'EXECUTE'),
    '11d: authenticated cannot execute support_set_admin (service-role only)'
);

SELECT throws_ok(
    $$INSERT INTO tc.members (collection_id, email, role) VALUES
        ('a0000000-0000-0000-0000-000000000001', 'Not-Normalized@Example.com', 'member')$$,
    '23514',
    NULL,
    '11e: a member email that is not stored normalized is refused'
);

-- =============================================================================
-- 12. orphaned-upload sweep worklist, and forgetting swept attempts
-- =============================================================================

-- Fixture: a committed book (index.htm @ s3 version 'v-committed') plus a DEAD check-in
-- attempt (open but past its expiry) that had changed index.htm -- i.e. it uploaded a newer
-- garbage version to S3 and never committed.
DO $$
BEGIN
    INSERT INTO tc.books (id, collection_id, instance_id, name, current_version, current_checksum)
    VALUES ('eb000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
            'cccccccc-cccc-cccc-cccc-cccccccccccc', 'Sweep Fixture Book', 1, 'cs-sweep');
    INSERT INTO tc.book_files (book_id, path, sha256, size_bytes, s3_version_id)
    VALUES ('eb000000-0000-0000-0000-000000000001', 'index.htm', 'sha-x', 10, 'v-committed');
    INSERT INTO tc.checkin_attempts (id, collection_id, book_id, started_by, proposed_name,
                                     changed_paths, status, started_at, expires_at)
    VALUES ('e2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
            'eb000000-0000-0000-0000-000000000001', tests.uid('user-alice-001'), 'Sweep Fixture Book',
            ARRAY['index.htm'], 'open', now() - interval '3 days', now() - interval '1 day');
END;
$$;

-- 12a: the dead attempt surfaces index.htm with the committed version as the delete watermark.
SELECT is(
    (SELECT referenced_version_id FROM tc.list_stale_upload_garbage()
      WHERE s3_key = 'tc/a0000000-0000-0000-0000-000000000001/books/cccccccc-cccc-cccc-cccc-cccccccccccc/index.htm'),
    'v-committed',
    '12a: a dead check-in attempt surfaces its changed file, watermarked to the committed version'
);

-- 12b: once a LIVE (open, unexpired) attempt is uploading that same path, it is excluded
-- from the worklist -- the sweep must never race a legitimate in-flight check-in.
DO $$
BEGIN
    INSERT INTO tc.checkin_attempts (id, collection_id, book_id, started_by, proposed_name,
                                     changed_paths, status, started_at, expires_at)
    VALUES ('e3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
            'eb000000-0000-0000-0000-000000000001', tests.uid('user-bob-002'), 'Sweep Fixture Book',
            ARRAY['index.htm'], 'open', now(), now() + interval '1 day');
END;
$$;
SELECT is(
    (SELECT count(*)::int FROM tc.list_stale_upload_garbage()
      WHERE s3_key = 'tc/a0000000-0000-0000-0000-000000000001/books/cccccccc-cccc-cccc-cccc-cccccccccccc/index.htm'),
    0,
    '12b: a path a live (unexpired open) attempt is still uploading is excluded from the sweep'
);

-- 12c: the worklist is an operational, cross-collection function -- not callable by a user.
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.list_stale_upload_garbage()', 'EXECUTE'),
    '12c: authenticated cannot execute list_stale_upload_garbage (service-role only)'
);

-- 12d-f: forget_swept_attempts deletes a dead attempt only once a sweep run's cutoff is past
-- the time of its latest possible upload (46 h before its expiry, with an hour's margin).
DO $$
BEGIN
    UPDATE tc.checkin_attempts SET status = 'expired'
    WHERE id = 'e2000000-0000-0000-0000-000000000001';
END;
$$;
SELECT is(
    tc.forget_swept_attempts(now() - interval '1 day' - interval '47 hours'),
    0,
    '12d: a sweep whose cutoff is before the dead attempt''s last possible upload forgets nothing'
);
SELECT is(
    tc.forget_swept_attempts(now() - interval '1 day' - interval '45 hours'),
    1,
    '12e: a sweep whose cutoff is past it deletes the dead attempt'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM tc.checkin_attempts WHERE id = 'e2000000-0000-0000-0000-000000000001')
    AND EXISTS (SELECT 1 FROM tc.checkin_attempts WHERE id = 'e3000000-0000-0000-0000-000000000001'),
    '12f: only the dead attempt is gone; the live one is kept'
);
SELECT ok(
    NOT has_function_privilege('authenticated', 'tc.forget_swept_attempts(timestamp with time zone, text[])', 'EXECUTE'),
    '12g: authenticated cannot execute forget_swept_attempts (service-role only)'
);

-- 12h-i: a dead attempt that touched a key the sweep could not clean (its referenced version
-- is missing) is kept, so the key stays on the worklist.
DO $$
BEGIN
    INSERT INTO tc.checkin_attempts (id, collection_id, book_id, started_by, proposed_name,
                                     changed_paths, status, started_at, expires_at)
    VALUES ('e4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
            'eb000000-0000-0000-0000-000000000001', tests.uid('user-alice-001'), 'Sweep Fixture Book',
            ARRAY['keep.htm'], 'expired', now() - interval '3 days', now() - interval '1 day');
END;
$$;
SELECT is(
    tc.forget_swept_attempts(now() - interval '1 day' - interval '45 hours',
        ARRAY['tc/a0000000-0000-0000-0000-000000000001/books/cccccccc-cccc-cccc-cccc-cccccccccccc/keep.htm']),
    0,
    '12h: an attempt that touched a key the sweep could not clean is kept'
);
SELECT is(
    tc.forget_swept_attempts(now() - interval '1 day' - interval '45 hours'),
    1,
    '12i: once no key needs keeping, it is forgotten'
);

-- =============================================================================
-- Finish
-- =============================================================================

SELECT * FROM finish();
ROLLBACK;
