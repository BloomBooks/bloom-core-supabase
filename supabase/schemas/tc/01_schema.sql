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
