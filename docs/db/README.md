# The database: Parse → Supabase migration notes

Status (2026-07-17): the **"Local Supabase + Blorg" milestone** is implemented — the
read-scope schema exists as a migration, `packages/sync-tool` imports a ~100-book sample
from production Parse, and blorg (branch `SupabaseMigration`) can browse it anonymously
against a local stack. Parse remains the production system of record; nothing here is
serving production traffic yet.

See `FUNCTIONS-MIGRATION-PLAN.md` at the repo root for the *functions* migration (Azure → Edge
Functions, phases F0–F8). This doc covers the *database* side.

## Schema conventions

- **IDs**: `id TEXT PRIMARY KEY` preserving legacy Parse objectIds. New rows get a
  DB-generated legacy-style 10-char alphanumeric id (`generate_legacy_style_id()`).
- **Names**: Parse camelCase → snake_case (`bookInstanceId` → `book_instance_id`).
  The conversion is capital-run-aware, so `bloomPUBVersion` → `bloom_pub_version` with no
  special-casing. (The `analytics_*` fields already carry underscores in Parse.)
- **Types**: Parse String → `text`, Number → `integer`/`numeric`/`bigint` (timestamps),
  Boolean → `boolean`, Date → `timestamptz`, Array-of-strings → `text[]`,
  Object / Array-of-objects → `jsonb` (`show`, `internet_limits`, `tools`).
- **Field authority**: the private repo `BloomBooks/bloom-parser-server-schema`
  (`schema/production.json`), NOT `setupTables` in bloom-parse-server's cloud code (its
  header admits it's out of date). `publisher_book_id` postdates the dump (bloom-parse-server
  PR #76).
- **Relations**: `books.lang_pointers text[]` keeps the raw language ids for sync fidelity,
  AND `book_languages` (junction, FKs) exists so PostgREST/supabase-js can embed language
  records with books — the equivalent of Parse's `include=langPointers`:
  `select("*, languages(*)")` (PostgREST resolves the many-to-many through the junction
  automatically). This works because Parse's legacy `languages` array field is deliberately
  not ported (see correction 8) — the name is reserved for the embed.
  `books.uploader_id` → `users(id)`.
- **RLS**: enabled everywhere; anonymous public read via `Public read` policies + table
  grants; no client write policies (the sync tool writes with the service role, which
  bypasses RLS). Two policies are row-gated: soft-deleted books (`is_deleted`, the future
  sync's tombstones) are never served, and a `users` row is only readable while the user
  has at least one visible book — uploader emails stay embeddable for book display without
  the table being a listable email directory.
- **Deliberately absent (post-milestone work)**: derivation triggers replacing Parse's
  `beforeSave` (search string, tag normalization, moderator-field preservation — these must
  be gated off for sync connections when they arrive), `updated_at` triggers (same gating
  problem — see correction 7), write policies, Firebase third-party
  auth wiring, and the classes `apiAccount` (needed for the opds function),
  `appSpecification`/`appDetailsInLanguage`/`booksInApp` (verify they're used at all before
  porting), `downloadHistory`, `version`, `bookDeletion` tombstones.

## Design goal: perform at 200k books

Production is ~25k books today; **every read-path design decision should assume 200k**
(decided 2026-07-22). "Small table, seq scan is fine" reasoning is not acceptable for
`books` — features must be designed against the 200k target, not current row counts.

What this implies for the query patterns blorg actually issues (see
`SupabaseBookQueryBuilder.ts` in blorg):

- **Exact tag filters** use `tags @> ARRAY[...]` against the existing GIN index on
  `tags` — already fine at 200k.
- **Fuzzy/wildcard matching on vocabularies (tags, topics, bookshelves, branding, …)**:
  the guiding pattern is **resolve against the small vocabulary table first, then apply
  exact matches to books**. These matches are rare, and the vocabularies are tiny (the
  `tags` table is a few thousand rows — a seq scan there is microseconds), so pattern
  matching belongs on the vocabulary, never on 200k book rows. `match_topic_tags` already
  works this way (LIKE over `tags`, then array containment on books via the GIN index).
  The wildcard-tag path in blorg (`LIKE` on the generated `tags_text` column) should
  eventually migrate to the same resolve-then-contain shape, at which point `tags_text`
  can be retired; until then it's an accepted (rare) seq scan, not something to index.
- **Free-text search** is the exception — it's per-word `ILIKE '%word%'` against the
  per-book `search` column, which is book content, not a vocabulary, and it's the *common*
  query (the search box). This is the one place a books-side index earns its keep:
  a **`pg_trgm` GIN index on `books.search`**. Trigram GIN serves `ILIKE` directly, so no
  query changes are needed. (Caveats: words shorter than 3 chars fall back to seq scan;
  write amplification lands only on the batch importer.)
- **Rare facets** (`title:`, `branding:`, `phash:` ILIKE on books) stay accepted seq
  scans — infrequent enough that ~200k-row scans are tolerable, revisit only if slow-query
  logs disagree.
- **Operational**: on a populated hosted database new indexes must be added with
  `CREATE INDEX CONCURRENTLY` (outside a transaction); and bulk imports should end with
  `ANALYZE` so the planner has fresh statistics before the first real queries arrive.

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
   diff against Parse's output). This bit immediately: the v0 schema shipped `updated_at`
   triggers stamping `now()` on update, which meant every importer re-run (an upsert's
   update path) silently replaced Parse's real timestamps with the import time. They're
   removed until the gating mechanism exists.
8. Parse's legacy `books.languages` array is not ported. Production evidence (2026-07-18):
   only 146 books have the field, none created after Jan 2015, and every value is `[]` —
   it carries zero information. Keeping it would also have collided with the natural
   PostgREST embed name: a `languages` *column* on `books` and an embedded `languages`
   *relation* can't both appear in one response, forcing every consumer to alias the embed
   forever. `lang_pointers` + `book_languages` carry the real language data.

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
