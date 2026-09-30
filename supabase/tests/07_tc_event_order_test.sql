-- =============================================================================
-- pgTAP tests: event ids and the polling cursor. An event's id is drawn from
-- tc.history_events_id_seq by the history_events_assign_id_tg trigger while the event's transaction holds
-- its collection's event-order advisory lock SHARED (until commit); get_changes and
-- get_collection_state take that lock EXCLUSIVE before reading. So a cursor they return
-- (max_event_id) never passes an event whose transaction commits later. The concurrency
-- itself cannot be exercised in one pgTAP transaction; these tests check its parts: ids
-- come only from the trigger, and each side holds the lock it must.
-- =============================================================================
-- Run against a local Supabase stack:
--   supabase start
--   supabase test db
-- =============================================================================

BEGIN;

SELECT plan(14);

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

-- Whether this session holds the collection's event-order lock in the given mode
-- ('ShareLock' or 'ExclusiveLock'). A bigint advisory key shows in pg_locks as its high
-- 32 bits in classid and its low 32 bits in objid, with objsubid = 1.
CREATE OR REPLACE FUNCTION tests.holds_event_lock(p_collection uuid, p_mode text)
RETURNS boolean
LANGUAGE sql
AS $$
    SELECT EXISTS (
        SELECT 1 FROM pg_locks l
        WHERE l.locktype = 'advisory'
          AND l.pid = pg_backend_pid()
          AND l.granted
          AND l.mode = p_mode
          AND l.objsubid = 1
          AND l.classid = ((tc._event_order_lock_key(p_collection) >> 32) & 4294967295)::oid
          AND l.objid   = (tc._event_order_lock_key(p_collection) & 4294967295)::oid
    )
$$;

INSERT INTO core.users (authentication_id, email) VALUES ('user-alice-eo', 'alice-eo@example.com');

-- Alice's core.users id.
CREATE OR REPLACE FUNCTION tests.alice()
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT id FROM core.users WHERE authentication_id = 'user-alice-eo'
$$;

INSERT INTO tc.collections (id, name, created_by) VALUES
    ('c0000000-0000-0000-0000-0000000f0001', 'Event Order One', tests.alice()),
    ('c0000000-0000-0000-0000-0000000f0002', 'Event Order Two', tests.alice());
INSERT INTO tc.members (collection_id, email, role, user_id, added_by, claimed_at) VALUES
    ('c0000000-0000-0000-0000-0000000f0001', 'alice-eo@example.com', 'admin', tests.alice(), tests.alice(), now()),
    ('c0000000-0000-0000-0000-0000000f0002', 'alice-eo@example.com', 'admin', tests.alice(), tests.alice(), now());

-- -----------------------------------------------------------------------------
-- 1. The id column: no identity/default (it would be drawn before the lock), a trigger.
-- -----------------------------------------------------------------------------

SELECT is(
    (SELECT attidentity::text FROM pg_attribute
     WHERE attrelid = 'tc.history_events'::regclass AND attname = 'id'),
    '',
    '1a: tc.history_events.id is not an identity column');

SELECT col_hasnt_default('tc', 'history_events', 'id', '1b: tc.history_events.id has no default');

SELECT has_trigger('tc', 'history_events', 'history_events_assign_id_tg', '1c: history_events_assign_id_tg exists');

-- -----------------------------------------------------------------------------
-- 2. Inserting events
-- -----------------------------------------------------------------------------

-- Sanity: the two collections' keys differ, and nothing holds either lock yet.
SELECT isnt(
    tc._event_order_lock_key('c0000000-0000-0000-0000-0000000f0001'),
    tc._event_order_lock_key('c0000000-0000-0000-0000-0000000f0002'),
    '2a: each collection has its own event-order lock key');

SELECT ok(
    NOT tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0001', 'ShareLock')
    AND NOT tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0002', 'ShareLock'),
    '2b: before any event insert, neither collection''s lock is held');

SELECT throws_ok(
    $$INSERT INTO tc.history_events (id, collection_id, type, by_user_id)
      VALUES (999999999, 'c0000000-0000-0000-0000-0000000f0001', 100, tests.alice())$$,
    '428C9',
    NULL,
    '2c: an explicitly supplied event id is refused');

SELECT is(
    (SELECT count(*)::int FROM tc.history_events WHERE id = 999999999),
    0,
    '2d: and no event with that id exists');

WITH e1 AS (
    INSERT INTO tc.history_events (collection_id, type, by_user_id, message)
    VALUES ('c0000000-0000-0000-0000-0000000f0001', 100, tests.alice(), 'eo-1')
    RETURNING id
)
SELECT set_config('tests.eo1', (SELECT id FROM e1)::text, true);

SELECT ok(
    tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0001', 'ShareLock')
    AND NOT tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0002', 'ShareLock'),
    '2e: an event insert holds its own collection''s lock SHARED (and no other''s)');

WITH e2 AS (
    INSERT INTO tc.history_events (collection_id, type, by_user_id, message)
    VALUES ('c0000000-0000-0000-0000-0000000f0002', 100, tests.alice(), 'eo-2')
    RETURNING id
)
SELECT set_config('tests.eo2', (SELECT id FROM e2)::text, true);

WITH e3 AS (
    INSERT INTO tc.history_events (collection_id, type, by_user_id, message)
    VALUES ('c0000000-0000-0000-0000-0000000f0001', 100, tests.alice(), 'eo-3')
    RETURNING id
)
SELECT set_config('tests.eo3', (SELECT id FROM e3)::text, true);

SELECT ok(
    current_setting('tests.eo1')::bigint < current_setting('tests.eo2')::bigint
    AND current_setting('tests.eo2')::bigint < current_setting('tests.eo3')::bigint,
    '2f: the trigger assigns increasing ids, across collections');

SELECT is(
    (SELECT last_value FROM tc.history_events_id_seq),
    current_setting('tests.eo3')::bigint,
    '2g: the ids come from tc.history_events_id_seq, one per event');

-- -----------------------------------------------------------------------------
-- 3. Cursor readers take the lock exclusive
-- -----------------------------------------------------------------------------

SELECT tests.set_jwt('user-alice-eo', 'alice-eo@example.com');

-- Sanity: not held exclusive yet.
SELECT ok(
    NOT tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0001', 'ExclusiveLock'),
    '3a: before a cursor read, the lock is not held exclusive');

SELECT is(
    (tc.get_changes('c0000000-0000-0000-0000-0000000f0001', 0) ->> 'max_event_id')::bigint,
    current_setting('tests.eo3')::bigint,
    '3b: get_changes returns the collection''s newest event as max_event_id');

SELECT ok(
    tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0001', 'ExclusiveLock')
    AND NOT tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0002', 'ExclusiveLock'),
    '3c: get_changes holds its collection''s lock exclusive (and no other''s)');

SELECT ok(
    (tc.get_collection_state('c0000000-0000-0000-0000-0000000f0002') ->> 'max_event_id')::bigint
        = current_setting('tests.eo2')::bigint
    AND tests.holds_event_lock('c0000000-0000-0000-0000-0000000f0002', 'ExclusiveLock'),
    '3d: get_collection_state returns max_event_id holding its collection''s lock exclusive');

SELECT * FROM finish();
ROLLBACK;
