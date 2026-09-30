-- =============================================================================
-- pgTAP tests: people (core.users). A person is a row with an id of Bloom's own; the JWT sub
-- is looked up in users.authentication_id. Rows are created only when needed (a claimed
-- invitation, a collection's first admin, a carried-over checkout's unclaimed holder); the name
-- comes from Bloom's Registration dialog at every sign-in; an email change of the same login is
-- picked up at sign-in, and a move to a new login is a support task.
-- =============================================================================

BEGIN;

SELECT plan(32);

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

CREATE OR REPLACE FUNCTION tests.uid(p_sub text)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT id FROM core.users WHERE authentication_id = p_sub
$$;

-- =============================================================================
-- 1. No row without a reason; claiming an invitation creates one and records the name
-- =============================================================================

SELECT tests.set_jwt('user-nobody', 'nobody@example.com');

SELECT is(
    tc.claim_memberships('No Body') ->> 'userId',
    NULL,
    '1a: someone with nothing to join gets no user row (userId NULL)'
);
SELECT ok(
    NOT EXISTS (SELECT 1 FROM core.users WHERE email = 'nobody@example.com'),
    '1b: and none is created'
);
SELECT ok(tc.current_user_id() IS NULL, '1c: current_user_id() is NULL for them');

SELECT tests.set_jwt('user-ann', 'ann@example.com');
SELECT tc.create_collection('d0000000-0000-0000-0000-000000000001'::uuid, 'Users Test');
SELECT tc.claim_memberships('Ann Admin');
SELECT tc.members_add('d0000000-0000-0000-0000-000000000001', '  Ben@Example.COM ', 'member');

SELECT ok(
    EXISTS (SELECT 1 FROM tc.members WHERE collection_id = 'd0000000-0000-0000-0000-000000000001'
                                       AND email = 'ben@example.com' AND user_id IS NULL),
    '1d: members_add stores the invited email trimmed, lowercased and NFC'
);

SELECT tests.set_jwt('user-ben', 'ben@example.com');
SELECT set_config('tests.ben_claim', tc.claim_memberships('  Ben Member  ')::text, true);

SELECT ok(
    (current_setting('tests.ben_claim')::jsonb ->> 'userId')::uuid = tests.uid('user-ben')
    AND (SELECT name = 'Ben Member' AND email = 'ben@example.com'
           FROM core.users WHERE authentication_id = 'user-ben'),
    '1e: claiming an invitation creates the row with the trimmed Registration name, returning its id'
);
SELECT is(
    (SELECT user_id FROM tc.members WHERE collection_id = 'd0000000-0000-0000-0000-000000000001'
                                      AND email = 'ben@example.com'),
    tests.uid('user-ben'),
    '1f: and fills user_id on the invitation'
);

SELECT tc.claim_memberships(NULL);
SELECT is(
    (SELECT name FROM core.users WHERE authentication_id = 'user-ben'),
    'Ben Member',
    '1g: a sign-in without a name keeps the name'
);
SELECT tc.claim_memberships('Benjamin Member');
SELECT is(
    (SELECT name FROM core.users WHERE authentication_id = 'user-ben'),
    'Benjamin Member',
    '1h: a sign-in with a corrected Registration name updates it'
);

-- =============================================================================
-- 2. Names and emails are shown from core.users wherever a person appears
-- =============================================================================

SELECT tests.set_jwt('user-ann', 'ann@example.com');

SELECT ok(
    (SELECT name = 'Benjamin Member' AND current_email = 'ben@example.com' AND email = 'ben@example.com'
       FROM tc.members_list('d0000000-0000-0000-0000-000000000001') WHERE user_id = tests.uid('user-ben')),
    '2a: members_list shows a joined member''s name and current email'
);

INSERT INTO tc.books (id, collection_id, instance_id, name, current_version)
VALUES ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
        'd1000000-0000-0000-0000-000000000002', 'Users Book', 1);

SELECT tests.set_jwt('user-ben', 'ben@example.com');
SELECT tc.checkout_book('d0000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000002',
                        'BensMachine', gen_random_uuid()::text);

SELECT ok(
    (SELECT b ->> 'locked_by_name' = 'Benjamin Member' AND b ->> 'locked_by_email' = 'ben@example.com'
       FROM jsonb_array_elements(tc.get_collection_state('d0000000-0000-0000-0000-000000000001') -> 'books') b
      WHERE b ->> 'instance_id' = 'd1000000-0000-0000-0000-000000000002'),
    '2b: get_collection_state shows the lock holder''s name and email'
);

SELECT tc.claim_memberships('Ben M.');
SELECT ok(
    (SELECT e ->> 'by_name' = 'Ben M.'
       FROM jsonb_array_elements(tc.get_changes('d0000000-0000-0000-0000-000000000001', 0) -> 'events') e
      WHERE (e ->> 'type')::int = 0),
    '2c: history shows the author''s CURRENT name, after a later correction'
);

-- =============================================================================
-- 3. An email change of the same login is picked up at sign-in
-- =============================================================================

SELECT tests.set_jwt('user-ben', 'Ben.New@Example.com');
SELECT tc.claim_memberships(NULL);

SELECT is(
    (SELECT email FROM core.users WHERE authentication_id = 'user-ben'),
    'ben.new@example.com',
    '3a: the next sign-in refreshes users.email from the verified token'
);
SELECT ok(
    tc.is_member('d0000000-0000-0000-0000-000000000001')
    AND (SELECT email FROM tc.members WHERE user_id = tests.uid('user-ben')) = 'ben@example.com',
    '3b: the membership follows the person; members.email stays the invited address'
);

SELECT tests.set_jwt('user-ben', 'ben.unverified@example.com', false);
SELECT tc.create_collection('d0000000-0000-0000-0000-000000000009'::uuid, 'Ben Unverified');
SELECT is(
    (SELECT email FROM core.users WHERE authentication_id = 'user-ben'),
    'ben.new@example.com',
    '3c: an unverified token''s email is not taken over'
);

SELECT tests.set_jwt('user-ann', 'ann@example.com');
SELECT is(
    tc.members_add('d0000000-0000-0000-0000-000000000001', 'ben.new@example.com'),
    NULL,
    '3d: members_add treats a joined member''s current email as already having access'
);
SELECT is(
    tc.members_add('d0000000-0000-0000-0000-000000000001', 'BEN@example.com'),
    NULL,
    '3e: and an invited address likewise'
);

-- =============================================================================
-- 4. Unverified tokens create nothing; an email another login has is refused
-- =============================================================================

SELECT tests.set_jwt('user-mallory', 'ann@example.com', false);
SELECT throws_ok(
    $$SELECT tc.create_collection('d0000000-0000-0000-0000-000000000002'::uuid, 'Mallory')$$,
    '28000',
    NULL,
    '4a: an unverified token cannot create a user row (and so cannot take someone''s email)'
);

SELECT tests.set_jwt('user-ann-second-login', 'ann@example.com');
SELECT throws_like(
    $$SELECT tc.create_collection('d0000000-0000-0000-0000-000000000003'::uuid, 'Second Login')$$,
    'email_in_use%',
    '4b: a second login with an email another login''s row has is refused (a support task)'
);

-- =============================================================================
-- 5. Unclaimed users: a carried-over checkout's holder is claimed by the first sign-in
-- =============================================================================

SELECT tests.set_jwt('user-ann', 'ann@example.com');
SELECT tc.create_collection('d0000000-0000-0000-0000-000000000004'::uuid, 'Migrating', true);
INSERT INTO tc.books (id, collection_id, instance_id, name, current_version)
VALUES ('d2000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000004',
        'd2000000-0000-0000-0000-000000000002', 'Carried Book', 1);
SELECT tc.members_add('d0000000-0000-0000-0000-000000000004', 'cara@example.com');

SELECT ok(
    (tc.lock_book_for_legacy_checkout('d0000000-0000-0000-0000-000000000004',
        'd2000000-0000-0000-0000-000000000002', ' Cara@Example.com ', gen_random_uuid()::text,
        'OldMachine') ->> 'success') = 'true',
    '5a: an admin locks a carried-over checkout to cara@example.com during the initial upload'
);
SELECT ok(
    (SELECT authentication_id IS NULL AND name IS NULL FROM core.users WHERE email = 'cara@example.com'),
    '5b: its holder is an unclaimed user (no login, no name)'
);
SELECT ok(
    (SELECT b ->> 'locked_by_email' = 'cara@example.com' AND b ->> 'locked_by_name' IS NULL
       FROM jsonb_array_elements(tc.get_collection_state('d0000000-0000-0000-0000-000000000004') -> 'books') b),
    '5c: the holder is shown by email'
);

SELECT tests.set_jwt('user-cara', 'cara@example.com');
SELECT tc.claim_memberships('Cara Carried');

SELECT ok(
    (SELECT count(*) = 1 FROM core.users WHERE email = 'cara@example.com')
    AND (SELECT authentication_id = 'user-cara' AND name = 'Cara Carried'
           FROM core.users WHERE email = 'cara@example.com'),
    '5d: Cara''s first sign-in claims the unclaimed user instead of making a new row'
);
SELECT ok(
    (SELECT locked_by = tests.uid('user-cara') FROM tc.books WHERE id = 'd2000000-0000-0000-0000-000000000001')
    AND (SELECT user_id = tests.uid('user-cara') FROM tc.members
          WHERE collection_id = 'd0000000-0000-0000-0000-000000000004' AND email = 'cara@example.com'),
    '5e: so the carried-over checkout is already hers, and so is the invitation'
);

-- =============================================================================
-- 6. my_collections: one row per collection, joined or invited
-- =============================================================================

SELECT tests.set_jwt('user-ann', 'ann@example.com');
SELECT tc.members_add('d0000000-0000-0000-0000-000000000001', 'ben.newest@example.com');

SELECT tests.set_jwt('user-ben', 'ben.newest@example.com');
SELECT ok(
    (SELECT count(*) = 1 AND bool_and(is_claimed) FROM tc.my_collections()
      WHERE id = 'd0000000-0000-0000-0000-000000000001'),
    '6a: a collection Ben has joined, and also has an invitation to his new email for, is listed once, as joined'
);
SELECT tc.claim_memberships(NULL);
SELECT ok(
    (SELECT user_id IS NULL FROM tc.members WHERE email = 'ben.newest@example.com'),
    '6b: claiming leaves the second invitation alone (a person appears once per collection)'
);

-- =============================================================================
-- 7. Moving a user to a new login (support, service role)
-- =============================================================================

SELECT ok(
    NOT has_function_privilege('authenticated',
        'tc.support_move_user_to_login(uuid, text, text, boolean)', 'EXECUTE'),
    '7a: authenticated cannot execute support_move_user_to_login'
);

SELECT set_config('tests.ben_id', tests.uid('user-ben')::text, true);

SELECT ok(
    (tc.support_move_user_to_login(current_setting('tests.ben_id')::uuid, 'user-ben-2', 'Ben@New-Login.org', true)
        ->> 'moved') = 'false'
    AND tests.uid('user-ben-2') IS NULL,
    '7b: a dry run changes nothing'
);

SELECT throws_like(
    format($$SELECT tc.support_move_user_to_login(%L, 'user-ann', 'ben2@example.com')$$,
        current_setting('tests.ben_id')),
    'login_has_user%',
    '7c: moving onto a login that already has a row is refused (a merge)'
);
SELECT throws_like(
    format($$SELECT tc.support_move_user_to_login(%L, 'user-ben-2', 'ann@example.com')$$,
        current_setting('tests.ben_id')),
    'email_has_user%',
    '7d: moving onto an email another row has is refused (a merge)'
);

SELECT lives_ok(
    format($$SELECT tc.support_move_user_to_login(%L, 'user-ben-2', 'Ben@New-Login.org')$$,
        current_setting('tests.ben_id')),
    '7e: the move succeeds'
);

SELECT tests.set_jwt('user-ben-2', 'ben@new-login.org');
SELECT ok(
    tc.current_user_id() = current_setting('tests.ben_id')::uuid
    AND tc.is_member('d0000000-0000-0000-0000-000000000001')
    AND (SELECT locked_by = current_setting('tests.ben_id')::uuid FROM tc.books
          WHERE id = 'd1000000-0000-0000-0000-000000000001'),
    '7f: the new login is the same person: same id, memberships and checkouts'
);

SELECT tests.set_jwt('user-ben', 'ben.new@example.com');
SELECT ok(
    tc.current_user_id() IS NULL,
    '7g: the old login no longer finds the row'
);

SELECT * FROM finish();
ROLLBACK;
