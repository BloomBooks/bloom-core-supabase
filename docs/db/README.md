# The database: Parse → Supabase migration notes

Status (2026-07-17): the **"Local Supabase + Blorg" milestone** is implemented — the
read-scope schema exists as a migration, `packages/sync-tool` imports a ~100-book sample
from production Parse, and blorg (branch `SupabaseMigration`) can browse it anonymously
against a local stack. Parse remains the production system of record; nothing here is
serving production traffic yet.

See `MIGRATION-PLAN.md` at the repo root for the *functions* migration (Azure → Edge
Functions, phases F0–F8). This doc covers the *database* side.

## Schema conventions

- **IDs**: `id TEXT PRIMARY KEY` preserving legacy Parse objectIds. New rows get a
  DB-generated legacy-style 10-char alphanumeric id (`generate_legacy_style_id()`).
- **Names**: Parse camelCase → snake_case (`bookInstanceId` → `book_instance_id`).
  One irregular mapping: `bloomPUBVersion` → `bloom_pub_version`.
- **Types**: Parse String → `text`, Number → `integer`/`numeric`/`bigint` (timestamps),
  Boolean → `boolean`, Date → `timestamptz`, Array-of-strings → `text[]`,
  Object / Array-of-objects → `jsonb` (`show`, `internet_limits`, `tools`).
- **Field authority**: the private repo `BloomBooks/bloom-parser-server-schema`
  (`schema/production.json`), NOT `setupTables` in bloom-parse-server's cloud code (its
  header admits it's out of date). `publisher_book_id` postdates the dump (bloom-parse-server
  PR #76).
- **Relations**: `books.lang_pointers text[]` keeps the raw language ids for sync fidelity,
  AND `book_languages` (junction, FKs) exists so PostgREST/supabase-js can embed language
  records with books (`select("*, languages:languages(*)")`) — the equivalent of Parse's
  `include=langPointers`. `books.uploader_id` → `users(id)`.
- **RLS**: enabled everywhere; anonymous public read via `Public read` policies + table
  grants; no client write policies (the sync tool writes with the service role, which
  bypasses RLS).
- **Deliberately absent (post-milestone work)**: derivation triggers replacing Parse's
  `beforeSave` (search string, tag normalization, moderator-field preservation — these must
  be gated off for sync connections when they arrive), write policies, Firebase third-party
  auth wiring, and the classes `apiAccount` (needed for the opds function),
  `appSpecification`/`appDetailsInLanguage`/`booksInApp` (verify they're used at all before
  porting), `downloadHistory`, `version`, `bookDeletion` tombstones.

## Corrections to the earlier draft plans

The `supabase/*.md` docs in bloom-parse-server were a useful starting point; things fixed
or superseded here:

1. `uploader_id REFERENCES auth.users(id)` was wrong — under Firebase third-party auth,
   `auth.users` stays empty. It references `public.users` (TEXT legacy ids).
2. The draft DDL was missing `edition`, `upload_pending_timestamp`, `banner_image_url`
   (languages), and the whole `apiAccount` class; and misnamed `analytics_started_count`.
3. `language.isoCode` is NOT unique in production (multiple rows per code) — the draft's
   UNIQUE constraint would have broken the import.
4. `tools` can hold objects — `jsonb`, not `text[]`.
5. The draft's legacy-id generator could produce <10 chars (base64 of 8 bytes minus
   stripped symbols); ours draws 24 bytes.
6. The auth plan (custom login endpoint + bespoke session tokens) is superseded by
   Supabase's native **third-party Firebase auth** (`[auth.third_party.firebase]`,
   supabase-js `accessToken`, `auth.jwt()` in RLS; requires a `role: 'authenticated'`
   custom claim on Firebase users — a backfill task when we get there).
7. The sync plan's derivation-trigger idea conflicts with sync writes: triggers re-deriving
   `search`/tags would fight the Parse-computed values the sync delivers. When triggers
   arrive they must be gated (e.g. a `bloom.sync` session flag) so sync writes pass through
   verbatim — which also gives us a parity test (replay a synced row through the triggers,
   diff against Parse's output).

## Roadmap after this milestone (summary)

1. **Full sync tool**: watermark-based incremental sync (order: users → languages → tags →
   books), tombstones for book deletions (the ONE change bloom-parse-server needs: an
   `afterDelete("books")` trigger), scheduled runs + validation harness (sampled deep-diffs,
   count checks, lag alerts).
2. **Auth**: enable Firebase third-party auth; `role` claim backfill; RLS policies for
   uploader/moderator writes (email-verified, username==email semantics from
   `bloomFirebaseAuthAdapter`).
3. **Read-path flips**: edge functions (opds, stats, books-GET) switch from
   `BloomParseServer.ts` to Postgres, one at a time behind env switches, staging first;
   byte-diff outputs against the Parse-sourced versions.
4. **blorg**: contract tests green on both backends, production flip of reads+writes
   together at cutover.
5. **Write cutover** (joint with F8 books/upload): freeze Parse writes → final sync →
   flip → 1–2 week read-only rollback window → decommission Parse + MongoDB Atlas.

Key risks: search-semantics parity (Mongo `$text` vs Postgres), the untested `beforeSave`
behaviors, Parse Pointer-shaped JSON in frozen API contracts, and Firebase claim coverage.
