-- =============================================================================
-- pgTAP tests: tc.checkout_book_takeover (dogfood batch 1, item 9 -- account-switch
-- checkout takeover). Takeover is granted by presenting the secret checkout token that
-- checkout_book returned to the lock holder (kept in the local copy's checkout record);
-- the machine name and seat, which every member can read, grant nothing.
-- =============================================================================
-- Run against a local Supabase stack:
--   supabase start
--   supabase test db
-- =============================================================================

BEGIN;

SELECT plan(32);

SELECT has_function('tc', 'checkout_book_takeover', 'tc.checkout_book_takeover() exists');

-- Helper: set a fake JWT so auth.jwt() returns a known sub/email (same helper as
-- 01_tc_schema_test.sql; re-declared here since each test file runs standalone).
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

-- =============================================================================
-- Fixture: a collection with Alice (admin) and Bob (member, claimed), a book Alice has
-- checked out on "SharedMachine" in her own local copy ("seat-alice-copy"). Uses the
-- public RPCs (create_collection/members_add/claim_memberships), matching
-- 01_tc_schema_test.sql's own fixture convention.
-- =============================================================================

SELECT tests.set_jwt('user-alice-tko', 'alice-tko@example.com', true);

SELECT lives_ok(
    $$SELECT tc.create_collection('c0000000-0000-0000-0000-00000000a001'::uuid, 'Takeover Test Collection')$$,
    '0a: create_collection succeeds for Alice'
);

SELECT lives_ok(
    $$SELECT tc.members_add('c0000000-0000-0000-0000-00000000a001', 'bob-tko@example.com', 'member')$$,
    '0b: Alice adds Bob as an approved member'
);

SELECT tests.set_jwt('user-bob-tko', 'bob-tko@example.com', true);

SELECT lives_ok(
    $$SELECT tc.claim_memberships()$$,
    '0c: Bob claims his membership'
);

SELECT tests.set_jwt('user-alice-tko', 'alice-tko@example.com', true);

-- Insert a test book directly (SECURITY DEFINER helper — RLS bypassed for setup), matching
-- 01_tc_schema_test.sql section 5's own convention.
INSERT INTO tc.books (id, collection_id, instance_id, name, created_by)
VALUES (
    'b0000000-0000-0000-0000-00000000a001'::uuid,
    'c0000000-0000-0000-0000-00000000a001'::uuid,
    'b0000000-0000-0000-0000-00000000a002'::uuid,
    'Takeover Test Book',
    'user-alice-tko'
);

-- Alice checks the book out on SharedMachine, seat "seat-alice-copy"; keep the token her
-- client would save in the book folder's checkout record.
SELECT set_config('tests.alice_token',
    tc.checkout_book('b0000000-0000-0000-0000-00000000a001', 'SharedMachine', 'seat-alice-copy') ->> 'checkout_token',
    true);

SELECT ok(
    (SELECT locked_seat FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001') = 'seat-alice-copy',
    '0d: checkout_book records the caller''s seat with the lock'
);

SELECT ok(
    current_setting('tests.alice_token') ~ '^[0-9a-f]{64}$',
    '0e: a successful checkout returns a 64-hex-char checkout token'
);

SELECT ok(
    (SELECT checkout_token_hash = sha256(convert_to(current_setting('tests.alice_token'), 'UTF8'))
       FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
    '0f: only the token''s SHA-256 is stored on the book row'
);

-- The hash column is not readable by members (column-level grants), nor is the token
-- reachable through the member-facing state RPCs.
SELECT ok(
    NOT has_column_privilege('authenticated', 'tc.books', 'checkout_token_hash', 'SELECT'),
    '0g: authenticated cannot SELECT tc.books.checkout_token_hash'
);

SELECT ok(
    has_column_privilege('authenticated', 'tc.books', 'locked_by', 'SELECT'),
    '0h: sanity: authenticated can still SELECT the ordinary lock columns'
);

SELECT ok(
    position(current_setting('tests.alice_token') IN tc.get_collection_state('c0000000-0000-0000-0000-00000000a001')::text) = 0
    AND position('checkout_token' IN tc.get_collection_state('c0000000-0000-0000-0000-00000000a001')::text) = 0,
    '0i: get_collection_state exposes neither the token nor its hash'
);

SELECT ok(
    position(current_setting('tests.alice_token') IN tc.get_changes('c0000000-0000-0000-0000-00000000a001', 0)::text) = 0
    AND position('checkout_token' IN tc.get_changes('c0000000-0000-0000-0000-00000000a001', 0)::text) = 0,
    '0j: get_changes exposes neither the token nor its hash'
);

-- =============================================================================
-- 1. Bob (different account) CANNOT take over without Alice's token -- even replaying
--    the machine and seat every member can read.
-- =============================================================================

SELECT tests.set_jwt('user-bob-tko', 'bob-tko@example.com', true);

SELECT ok(
    NOT (tc.checkout_book('b0000000-0000-0000-0000-00000000a001', 'BobsMachine') ? 'checkout_token'),
    '1a: a failed checkout_book does not hand Bob a token'
);

SELECT ok(
    (SELECT (tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001', NULL, 'SharedMachine', 'seat-alice-copy')) ->> 'success' = 'false'),
    '1b: Bob cannot take over by replaying Alice''s machine and seat with no token'
);

SELECT ok(
    (SELECT (tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001', repeat('0', 64), 'SharedMachine', 'seat-alice-copy')) ->> 'success' = 'false'),
    '1c: Bob cannot take over with a wrong token'
);

SELECT ok(
    (SELECT (tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001',
        (SELECT encode(checkout_token_hash, 'hex') FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
        'SharedMachine', 'seat-alice-copy')) ->> 'success' = 'false'),
    '1d: presenting the stored hash instead of the token does not work'
);

SELECT ok(
    (SELECT locked_by FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001') = 'user-alice-tko',
    '1e: the lock still belongs to Alice after the failed attempts'
);

-- =============================================================================
-- 2. Bob CAN take over when he presents Alice's token (the true shared-computer
--    scenario: account B opens the exact local folder account A checked the book out in;
--    the folder may have been moved or renamed, so machine/seat need not match)
-- =============================================================================

SELECT set_config('tests.bob_token',
    tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001',
        current_setting('tests.alice_token'), 'SharedMachine', 'seat-renamed-copy') ->> 'checkout_token',
    true);

SELECT ok(
    current_setting('tests.bob_token') ~ '^[0-9a-f]{64}$',
    '2a: Bob takes over with Alice''s token and gets a token of his own'
);

SELECT ok(
    (SELECT locked_by FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001') = 'user-bob-tko',
    '2b: the lock now belongs to Bob'
);

SELECT ok(
    (SELECT locked_seat FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001') = 'seat-renamed-copy',
    '2c: the seat Bob reported is recorded with his lock'
);

SELECT ok(
    current_setting('tests.bob_token') <> current_setting('tests.alice_token')
    AND (SELECT checkout_token_hash = sha256(convert_to(current_setting('tests.bob_token'), 'UTF8'))
           FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
    '2d: the token was rotated: the row now holds the hash of Bob''s new token'
);

SELECT ok(
    (SELECT count(*) = 1 FROM tc.events
     WHERE book_id = 'b0000000-0000-0000-0000-00000000a001'
       AND type = 0
       AND by_user_id = 'user-bob-tko'),
    '2e: exactly one CheckOut event (type=0) recorded for Bob''s takeover'
);

-- Alice's old token is dead: she cannot use it to take the lock back.
SELECT tests.set_jwt('user-alice-tko', 'alice-tko@example.com', true);

SELECT ok(
    (SELECT (tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001', current_setting('tests.alice_token'), 'SharedMachine', 'seat-alice-copy')) ->> 'success' = 'false'),
    '2f: the token Bob presented no longer grants takeover'
);

-- =============================================================================
-- 3. Calling it again for the CURRENT holder is a harmless no-op (not a new "takeover")
-- =============================================================================

SELECT tests.set_jwt('user-bob-tko', 'bob-tko@example.com', true);

SELECT ok(
    (SELECT (tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001', current_setting('tests.bob_token'), 'SharedMachine', 'seat-renamed-copy')) ->> 'success' = 'false'),
    '3a: re-calling takeover when the caller already holds the lock reports no change'
);

SELECT ok(
    (SELECT count(*) = 1 FROM tc.events
     WHERE book_id = 'b0000000-0000-0000-0000-00000000a001'
       AND type = 0
       AND by_user_id = 'user-bob-tko'),
    '3b: no duplicate CheckOut event was emitted for the no-op re-call'
);

SELECT ok(
    (SELECT checkout_token_hash = sha256(convert_to(current_setting('tests.bob_token'), 'UTF8'))
       FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
    '3c: the no-op re-call leaves Bob''s token valid'
);

-- =============================================================================
-- 4. A non-member cannot take over any lock, even with the token
-- =============================================================================

SELECT tests.set_jwt('user-carol-tko', 'carol-tko@example.com', true);

-- PT403 (not 42501): checkout_book_takeover raises the schema-wide PT### passthrough codes.
SELECT throws_ok(
    format($$SELECT tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001', %L, 'SharedMachine', 'seat-alice-copy')$$,
        current_setting('tests.bob_token')),
    'PT403',
    NULL,
    '4a: a non-member cannot take over a lock (not_a_member)'
);

-- =============================================================================
-- 5. Unlock clears the seat and the token (books_clear_seat_on_unlock trigger)
-- =============================================================================

SELECT tests.set_jwt('user-bob-tko', 'bob-tko@example.com', true);

SELECT lives_ok(
    $$SELECT tc.unlock_book('b0000000-0000-0000-0000-00000000a001')$$,
    '5a: the current holder can unlock'
);

SELECT ok(
    (SELECT locked_seat IS NULL FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
    '5b: locked_seat is cleared with the lock (trigger)'
);

SELECT ok(
    (SELECT checkout_token_hash IS NULL FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
    '5c: checkout_token_hash is cleared with the lock (trigger)'
);

-- =============================================================================
-- 6. A lock that changed hands without a token being issued (as checkin_start_tx's
--    take-if-free path does) can never be taken over, and no earlier token survives it.
-- =============================================================================

SELECT tests.set_jwt('user-alice-tko', 'alice-tko@example.com', true);

SELECT set_config('tests.alice_token2',
    tc.checkout_book('b0000000-0000-0000-0000-00000000a001', 'SharedMachine', 'seat-alice-copy') ->> 'checkout_token',
    true);

-- Simulate a token-less lock change (a different holder written without a new hash).
UPDATE tc.books SET locked_by = 'user-dave-tko' WHERE id = 'b0000000-0000-0000-0000-00000000a001';

SELECT ok(
    (SELECT checkout_token_hash IS NULL FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001'),
    '6a: a change of holder that sets no new token clears the old token hash (trigger)'
);

SELECT tests.set_jwt('user-bob-tko', 'bob-tko@example.com', true);

SELECT ok(
    (SELECT (tc.checkout_book_takeover('b0000000-0000-0000-0000-00000000a001', current_setting('tests.alice_token2'), 'SharedMachine', 'seat-alice-copy')) ->> 'success' = 'false'),
    '6b: a lock with no token cannot be taken over, even with the previous holder''s token'
);

SELECT ok(
    (SELECT locked_by FROM tc.books WHERE id = 'b0000000-0000-0000-0000-00000000a001') = 'user-dave-tko',
    '6c: the token-less lock is unchanged'
);

SELECT * FROM finish();
ROLLBACK;
