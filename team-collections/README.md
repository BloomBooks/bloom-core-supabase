# Team Collections backend

The server side of Bloom's **Cloud Team Collections**: a Postgres schema (`tc`) with RLS and
RPCs, a set of edge functions that broker scoped S3 credentials for check-in/download, and the
local stack (Supabase + MinIO) for developing against it. The Bloom desktop client that uses
this backend lives in the BloomDesktop repo (`src/BloomExe/TeamCollection/Cloud/`), along with
the project's design notes (`Design/CloudTeamCollections/`); comments here that mention
"task NN", `src/...`, or `IMPLEMENTATION.md` refer to that repo.

## Where each part lives

| What | Where |
|------|-------|
| Declarative `tc` schema (source of truth) | `supabase/schemas/tc/01_schema.sql` … `04_security.sql` |
| Generated migration (do not hand-edit) | `supabase/migrations/20260720000001_init_tc_schema.sql` |
| Script that regenerates it | `team-collections/regen-init-migration.sh` (`pnpm tc:regen-migration`) |
| pgTAP database tests | `supabase/tests/*_tc_*_test.sql` |
| Edge functions | `supabase/functions/{checkin-start,checkin-finish,checkin-abort,collection-files-start,collection-files-finish,download-start,sweep-stale-uploads}/` |
| Code shared by those functions | `supabase/functions/_shared/tc/` |
| Deno unit tests | `supabase/functions/tests/tc-*-test.ts` |
| Local dev users | `supabase/seeds/tc_dev.sql` (run by `supabase db reset`) |
| Local stack: MinIO compose, function secrets, smoke test, S3 parity check | `team-collections/dev/` (start with its README) |
| AWS bucket/IAM provisioning for hosted environments | `team-collections/aws/provision-aws.ps1` |
| Firebase custom-claim reference code (deployed from BloomLibrary infra) | `team-collections/firebase/` |
| API contracts, schema overview, go-live runbook | `team-collections/docs/` (`CONTRACTS.md`, `SCHEMA.md`, `GOING-LIVE.md`) |

The edge-function names are part of the contract with the Bloom client (see
`docs/CONTRACTS.md`), so do not rename them.

Each TC function has its own `deno.json` whose import map pins the AWS SDK, because
`supabase functions deploy` bundles a function with the `deno.json` in its folder. Those pins
must match the root `deno.json`, which the tests and `deno check` use;
`tc-deno-config-test.ts` fails if they drift.

## Changing the schema

Edit the relevant file under `supabase/schemas/tc/`, then run `pnpm tc:regen-migration` (needs
bash; Git Bash is fine on Windows), then `supabase db reset` and `pnpm test:db`. This
regenerate-the-init approach is only valid before go-live; afterwards, schema changes are
forward-only delta migrations. See `docs/CONTRACTS.md` ("Database: declarative schema") and
`docs/GOING-LIVE.md`.

## Running the tests

- **Edge-function unit tests** (no stack needed; they fake PostgREST and S3):
  `pnpm test:ci` runs them with the rest of the repo's Deno tests, and
  `deno test --allow-all supabase/functions/tests/tc-*-test.ts` runs just these.
- **Database tests** (pgTAP; needs a running local Supabase): `supabase start` (or just
  `supabase db start`, which is all they need), then `supabase db reset` and `pnpm test:db`.
  CI's `db-tests` job runs exactly that on every pull request.
- **Whole local stack** (Supabase + MinIO + served functions): follow `dev/README.md`, then
  run `dev/smoke.ps1`.

The local stack needs the TC function secrets from `dev/functions.env`, so serve functions with
`pnpm dev:functions:tc` rather than plain `pnpm dev:functions`. Hosted projects get those
values from `supabase secrets set` (see `docs/GOING-LIVE.md`).
