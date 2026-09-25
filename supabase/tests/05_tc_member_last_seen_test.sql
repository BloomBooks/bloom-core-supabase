-- =============================================================================
-- pgTAP tests: tc.members.last_seen_at (CONTRACTS.md v1.11, BL-16673)
-- get_collection_state and get_changes set the caller's own last_seen_at in that
-- collection, at most once per 10 minutes; members_list returns it.
-- =============================================================================
-- Run against a local Supabase stack:
--   supabase start
--   supabase test db
--
-- The whole file runs in one transaction, so now() is the same instant throughout: a
-- touch sets last_seen_at to exactly now(), and "older" values are made by backdating
-- the column directly.
-- =============================================================================

BEGIN;

SELECT plan(34);

SELECT has_column('tc', 'members', 'last_seen_at', 'tc.members.last_seen_at exists');

SELECT is(
    (SELECT p.provolatile::text FROM pg_proc p
     WHERE p.oid = 'tc.get_collection_state(uuid, bigint)'::regprocedure),
    'v',
    '0a: get_collection_state is VOLATILE (it writes last_seen_at)'
);

SELECT is(
    (SELECT p.provolatile::text FROM pg_proc p
     WHERE p.oid = 'tc.get_changes(uuid, bigint)'::regprocedure),
    'v',
    '0b: get_changes is VOLATILE (it writes last_seen_at)'
);

SELECT ok(
    NOT has_function_privilege('authenticated', 'tc._touch_member(uuid)', 'EXECUTE'),
    '0c: clients cannot call tc._touch_member directly'
);

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

-- Helper: one member's last_seen_at in one collection.
CREATE OR REPLACE FUNCTION tests.seen(p_collection_id uuid, p_email text)
RETURNS timestamptz
LANGUAGE sql
AS $$
    SELECT last_seen_at FROM tc.members
    WHERE collection_id = p_collection_id AND email = p_email
$$;

-- Helper: backdate one member's last_seen_at by p_age.
CREATE OR REPLACE FUNCTION tests.backdate(p_collection_id uuid, p_email text, p_age interval)
RETURNS void
LANGUAGE sql
AS $$
    UPDATE tc.members SET last_seen_at = now() - p_age
    WHERE collection_id = p_collection_id AND email = p_email
$$;

-- =============================================================================
-- Fixture: Alice creates collections L1 and L2 and adds Bob (who claims) to both;
-- Carol is approved in L1 but never claims; Dave is in neither.
-- =============================================================================

SELECT tests.set_jwt('user-alice-ls', 'alice-ls@example.com', true);
SELECT tc.create_collection('c0000000-0000-0000-0000-00000000e001'::uuid, 'Last Seen L1');
SELECT tc.create_collection('c0000000-0000-0000-0000-00000000e002'::uuid, 'Last Seen L2');
SELECT tc.members_add('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com', 'member');
SELECT tc.members_add('c0000000-0000-0000-0000-00000000e002', 'bob-ls@example.com', 'member');
SELECT tc.members_add('c0000000-0000-0000-0000-00000000e001', 'carol-ls@example.com', 'member');

SELECT tests.set_jwt('user-bob-ls', 'bob-ls@example.com', true);
SELECT tc.claim_memberships();

SELECT is(
    (SELECT count(*)::int FROM tc.members
     WHERE collection_id IN ('c0000000-0000-0000-0000-00000000e001', 'c0000000-0000-0000-0000-00000000e002')
       AND user_id IS NOT NULL),
    4,
    '0d: fixture sanity: Alice and Bob each have a claimed row in both collections (Carol none)'
);

-- =============================================================================
-- 1. New and just-claimed members have never been seen
-- =============================================================================

SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'alice-ls@example.com'), NULL,
    '1a: the creator''s row starts with last_seen_at NULL');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com'), NULL,
    '1b: claiming a membership does not set last_seen_at');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'carol-ls@example.com'), NULL,
    '1c: an invited, unclaimed member has last_seen_at NULL');

-- Events before any touch, to check the touches emit none.
SELECT set_config('tests.events_before',
    (SELECT count(*)::text FROM tc.events
     WHERE collection_id IN ('c0000000-0000-0000-0000-00000000e001', 'c0000000-0000-0000-0000-00000000e002')),
    true);

-- =============================================================================
-- 2. get_collection_state sets only the caller's row in that collection
-- =============================================================================

SELECT tests.set_jwt('user-bob-ls', 'bob-ls@example.com', true);

SELECT lives_ok(
    $$SELECT tc.get_collection_state('c0000000-0000-0000-0000-00000000e001'::uuid)$$,
    '2a: Bob calls get_collection_state(L1)'
);
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com'), now(),
    '2b: get_collection_state sets the caller''s last_seen_at to now()');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e002', 'bob-ls@example.com'), NULL,
    '2c: the caller''s membership in another collection is untouched');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'alice-ls@example.com'), NULL,
    '2d: other members of the collection are untouched');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'carol-ls@example.com'), NULL,
    '2e: pending members of the collection are untouched');

-- Throttle: a value younger than 10 minutes is kept; an older one is refreshed.
SELECT tests.backdate('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com', interval '5 minutes');
SELECT tc.get_collection_state('c0000000-0000-0000-0000-00000000e001'::uuid, 0);
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com'), now() - interval '5 minutes',
    '2f: get_collection_state (delta) within 10 minutes of the last touch leaves it alone');

SELECT tests.backdate('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com', interval '11 minutes');
SELECT tc.get_collection_state('c0000000-0000-0000-0000-00000000e001'::uuid);
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com'), now(),
    '2g: get_collection_state more than 10 minutes after the last touch refreshes it');

-- =============================================================================
-- 3. get_changes sets it too, with the same throttle
-- =============================================================================

SELECT lives_ok(
    $$SELECT tc.get_changes('c0000000-0000-0000-0000-00000000e002'::uuid, 0)$$,
    '3a: Bob calls get_changes(L2)'
);
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e002', 'bob-ls@example.com'), now(),
    '3b: get_changes sets the caller''s last_seen_at to now()');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e002', 'alice-ls@example.com'), NULL,
    '3c: get_changes leaves other members of the collection alone');

SELECT tests.backdate('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com', interval '9 minutes');
SELECT tc.get_changes('c0000000-0000-0000-0000-00000000e001'::uuid, 0);
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com'), now() - interval '9 minutes',
    '3d: get_changes within 10 minutes of the last touch leaves it alone');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e002', 'bob-ls@example.com'), now(),
    '3e: polling L1 does not change Bob''s L2 value');

SELECT tests.backdate('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com', interval '10 minutes 1 second');
SELECT tc.get_changes('c0000000-0000-0000-0000-00000000e001'::uuid, 0);
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'bob-ls@example.com'), now(),
    '3f: get_changes more than 10 minutes after the last touch refreshes it');

-- =============================================================================
-- 4. Non-members still fail and write nothing
-- =============================================================================

-- Snapshot of every last_seen_at in both collections.
SELECT set_config('tests.snapshot',
    (SELECT string_agg(id::text || '=' || coalesce(last_seen_at::text, 'null'), ',' ORDER BY id)
     FROM tc.members
     WHERE collection_id IN ('c0000000-0000-0000-0000-00000000e001', 'c0000000-0000-0000-0000-00000000e002')),
    true);

SELECT tests.set_jwt('user-dave-ls', 'dave-ls@example.com', true);

SELECT throws_ok(
    $$SELECT tc.get_collection_state('c0000000-0000-0000-0000-00000000e001'::uuid)$$,
    '42501', 'not_a_member',
    '4a: a non-member''s get_collection_state still fails with not_a_member'
);
SELECT throws_ok(
    $$SELECT tc.get_changes('c0000000-0000-0000-0000-00000000e001'::uuid, 0)$$,
    '42501', 'not_a_member',
    '4b: a non-member''s get_changes still fails with not_a_member'
);

-- Carol's email is approved in L1 but she has not claimed it, so she is not yet a member.
SELECT tests.set_jwt('user-carol-ls', 'carol-ls@example.com', true);

SELECT throws_ok(
    $$SELECT tc.get_collection_state('c0000000-0000-0000-0000-00000000e001'::uuid)$$,
    '42501', 'not_a_member',
    '4c: an invited but unclaimed account''s get_collection_state fails with not_a_member'
);
SELECT throws_ok(
    $$SELECT tc.get_changes('c0000000-0000-0000-0000-00000000e001'::uuid, 0)$$,
    '42501', 'not_a_member',
    '4d: an invited but unclaimed account''s get_changes fails with not_a_member'
);

SELECT is(
    (SELECT string_agg(id::text || '=' || coalesce(last_seen_at::text, 'null'), ',' ORDER BY id)
     FROM tc.members
     WHERE collection_id IN ('c0000000-0000-0000-0000-00000000e001', 'c0000000-0000-0000-0000-00000000e002')),
    current_setting('tests.snapshot'),
    '4e: the failed calls changed no last_seen_at'
);

SELECT is(
    (SELECT count(*)::text FROM tc.events
     WHERE collection_id IN ('c0000000-0000-0000-0000-00000000e001', 'c0000000-0000-0000-0000-00000000e002')),
    current_setting('tests.events_before'),
    '4f: touching last_seen_at emitted no tc.events'
);

-- =============================================================================
-- 5. members_list returns last_seen_at
-- =============================================================================

SELECT tests.set_jwt('user-alice-ls', 'alice-ls@example.com', true);

SELECT is(
    (SELECT ml.last_seen_at FROM tc.members_list('c0000000-0000-0000-0000-00000000e001') ml
     WHERE ml.email = 'bob-ls@example.com'),
    now(),
    '5a: members_list returns a seen member''s last_seen_at'
);
SELECT is(
    (SELECT ml.last_seen_at FROM tc.members_list('c0000000-0000-0000-0000-00000000e001') ml
     WHERE ml.email = 'carol-ls@example.com'),
    NULL,
    '5b: members_list returns NULL last_seen_at for an invited-only member'
);
SELECT is(
    (SELECT to_jsonb(ml) ->> 'last_seen_at' FROM tc.members_list('c0000000-0000-0000-0000-00000000e001') ml
     WHERE ml.email = 'bob-ls@example.com')::timestamptz,
    now(),
    '5c: the members_list row serializes it as last_seen_at'
);

-- members_list is a read: Alice's own call did not touch her row.
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'alice-ls@example.com'), NULL,
    '5d: members_list does not touch last_seen_at');

-- A plain member (not only admins) sees the value.
SELECT tests.set_jwt('user-bob-ls', 'bob-ls@example.com', true);

SELECT is(
    (SELECT ml.last_seen_at FROM tc.members_list('c0000000-0000-0000-0000-00000000e002') ml
     WHERE ml.email = 'bob-ls@example.com'),
    now(),
    '5e: a non-admin member can read last_seen_at through members_list'
);

-- Alice opens L2: her L2 row is set, her L1 row is not.
SELECT tests.set_jwt('user-alice-ls', 'alice-ls@example.com', true);
SELECT tc.get_collection_state('c0000000-0000-0000-0000-00000000e002'::uuid);

SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e002', 'alice-ls@example.com'), now(),
    '5f: an admin''s get_collection_state sets their own row');
SELECT is(tests.seen('c0000000-0000-0000-0000-00000000e001', 'alice-ls@example.com'), NULL,
    '5g: ...and not their row in the other collection');

SELECT * FROM finish();

ROLLBACK;
