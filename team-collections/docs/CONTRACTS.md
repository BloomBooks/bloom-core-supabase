# Cloud Team Collections — API contracts

> **Status:** **contract version 2.0, planned.** It describes the API of the design in `DESIGN.md`.
> The SQL and edge functions on this branch still implement version 1.12; the work to bring them to
> 2.0 is listed in `DESIGN.md`, section 9. Paths under `src/` refer to the BloomDesktop repo, where
> the desktop client lives. Change this file only together with the version number above.

## Link file

`TeamCollectionLink.txt` content is either a folder path (folder Team Collection) or
`cloud://sil.bloom/collection/<collectionId>` where `<collectionId>` = the Bloom CollectionId GUID
(also the server's `collections.id`).

## Auth

Bearer JWT on every request: Supabase third-party Firebase auth, where the JWT is the Firebase ID
token itself, unmodified (`CloudAuth` isolates the client side of this). Claims used server-side:
`sub`, `email`, `email_verified`. The server finds the caller with `tc.current_user_id()`, which
looks `sub` up in `core.users.authentication_id` and returns the person's `users.id`, or NULL for
someone with no user row (who is then a member of nothing). Claiming an invitation requires
`email_verified = true`. Everywhere below, a "user id" is a `core.users.id` (uuid), never a
Firebase uid.

## Auth: token-receipt endpoint

The Bloom-side half of BloomLibrary2's forwarding change (`src/editor.ts`, GOING-LIVE.md Phase
3.2). Reuses the conventions of the `external/login` endpoint (ExternalApi.cs) that the same
BloomLibrary-hosted login page already posts back to for the Parse session: same host/port
(`http://127.0.0.1:{port}/bloom/api/...`, `port` is the query param the login page was opened
with; see `BloomLibraryAuthentication.LogIn`'s `login-for-editor?port=` URL), same CORS/OPTIONS
handling, same "POST it and move on" shape. It is a **separate** endpoint, not new fields on
`external/login`, because the two payloads are independent (a Parse sign-in does not imply a Cloud
Team Collection one, and vice versa) and the login page may call either or both.

**Route**: `POST /bloom/api/external/cloudLogin`

**Request body** (JSON):
```json
{ "idToken": "<firebase-id-token-jwt>", "refreshToken": "<firebase-refresh-token>" }
```
Both fields are required, non-empty strings. `idToken` is the raw Firebase ID token JWT (the login
page's own Firebase SDK session already holds this after sign-in); `refreshToken` is its paired
Firebase refresh token. Bloom derives identity (email, uid, email_verified, expiry) **only** from
decoding `idToken`'s own claims; it never trusts a separately supplied email or verified flag (see
`FirebaseCloudAuthProvider.AcceptExternalSession` / `SessionFromIdToken`).

**Reply**: `200` with an empty body on success (`request.PostSucceeded()`, matching
`external/login`); a non-2xx status with a plain-text error message on failure (e.g. a malformed
token). An `OPTIONS` preflight always succeeds with an empty 200, as for every other `external/*`
endpoint.

**Side effects on success**: the same as the local-mode `sharing/login` endpoint: `CloudAuth`'s
in-memory session is replaced (persisted via `DpapiCloudTokenStore` once the production wiring in
GOING-LIVE.md Phase 3.5 selects it), the `sharing`/`loginState` websocket event fires so any open
`useSharingLoginState()` subscriber re-queries and updates or closes itself, and the Bloom window is
brought to the front (matching `external/login`'s `Shell.ComeToFront()`). Bloom then calls
`claim_memberships` (below).

## Cloud functions

Two categories of server-side function back the cloud client. Both are gated by the caller's
Supabase login (a JWT), but they run in different places and have different powers. Since most of
this project's programmers work in the C#/TypeScript client rather than the database backend, the
distinction in one paragraph:

- **Postgres RPCs** run *inside the database*: SQL / PL/pgSQL functions that Supabase's PostgREST
  layer exposes over HTTP at `/rest/v1/rpc/...`, which the Bloom client calls directly. Use them
  for pure database reads and writes; **row-level security (RLS)** enforces per-user,
  per-collection access on every call. An RPC cannot reach outside the database; in particular it
  cannot talk to Amazon S3.
- **Edge functions** are small TypeScript programs running on a *separate* server (Supabase's edge
  runtime, **not** the database), reached at `/functions/v1/<name>`; the Bloom client calls them
  over HTTP. Use one when an operation needs something the database can't do, above all talking to
  **AWS S3**: only edge functions hold the AWS secret key, so anything that vends S3 credentials or
  verifies S3 objects *must* be an edge function. An edge function may itself call database
  functions; `checkin-finish`, for example, does its S3 work and then calls `checkin_finish_tx` to
  record the result in one atomic transaction.

Both require the user's login; only edge functions additionally hold the AWS secret. Rule of thumb:
**credential-free, single-step database work → RPC; anything touching S3 or orchestrating several
steps → edge function.** (Edge functions live under `supabase/functions/`; the RPCs and everything
else in the database live in the declarative schema described next.)

### Database: declarative schema

The whole database (the `tc` schema, and the `core` schema that holds `users`): tables, the RPCs
above, transaction (`_tx`) helpers, trigger functions, row-level-security policies and grants, is
defined **declaratively** as the source of truth in files applied in this order (wired via
`[db.migrations].schema_paths` in `supabase/config.toml`):

| file | contents |
|------|----------|
| `supabase/schemas/tc/01_schema.sql`   | the `tc` and `core` schemas + enum types |
| `supabase/schemas/tc/02_functions.sql`| every function (RPCs, `_tx`, triggers, helpers) |
| `supabase/schemas/tc/03_tables.sql`   | tables (including `core.users`), constraints, indexes, triggers |
| `supabase/schemas/tc/04_security.sql` | RLS enable + policies + grants |

These files are what you **edit and review**. What actually runs (`supabase db reset` locally,
`supabase db push` to a project) is a migration under `supabase/migrations/`, which is a
*generated artifact*: the concatenation of the schema files in order, produced by
`team-collections/regen-init-migration.sh`.

> **Why concatenation, not `supabase db diff`?** The declarative workflow normally has you run
> `supabase db diff` to *generate* a migration from the schema files. Both diff engines
> (pg-schema-diff and migra) **silently drop every `COMMENT ON` and every
> `GRANT EXECUTE ON FUNCTION`**, which would leave the RPCs uncallable by `authenticated` and the
> schema undocumented. Concatenation is lossless, so that is how the migration is built.

**Making a schema change before go-live:** there is a single initial migration and the only
database is local, so history is disposable. Edit the relevant `schemas/tc/*.sql` file, run
`team-collections/regen-init-migration.sh`, then `supabase db reset` to rebuild and
`supabase test db` to check. Keep `SCHEMA.md`'s diagram in sync for table changes.

**After go-live:** once a real project database exists, its history must be preserved, so you can
no longer regenerate the initial migration. Switch to **forward-only delta migrations**: edit the
`schemas/tc/*.sql` file (still the source of truth), then hand-write a small migration for the delta
(or generate one with `supabase db diff` and **re-add the `COMMENT ON` / `GRANT` lines it drops**;
see the caveat above). Never edit the already-applied initial migration.

### Postgres RPCs (PostgREST `/rest/v1/rpc/...`)

Wire format: (1) every SQL parameter is prefixed `p_`, and PostgREST matches JSON keys to parameter
names, so clients send `{"p_collection_id": ...}` etc.; the table below uses the logical
(unprefixed) names. (2) The `tc` schema is exposed as a separate PostgREST schema: RPC calls carry
the `Content-Profile: tc` header (reads: `Accept-Profile: tc`). (3) Call every RPC by POST: some that
look like reads also write (`get_collection_state` and `get_changes` record the caller's visit).
(4) **A book is named by `collection_id` and `instance_id`** (its Bloom instance id, from
`meta.json`) everywhere; the table's own key is internal. (5) A book's **version** is a number per
book, increased by one at each commit; NULL means a first check-in is still in progress.

| RPC | Args → Result |
|-----|----------------|
| `claim_memberships(name text)` | Bloom calls it at every sign-in. Creates the caller's `core.users` row if there is none and the token's verified email has an invitation, or claims the **unclaimed user** with that email (see "Carried-over checkouts" below); refreshes `users.email` from the token and sets `users.name` to `name` (the first and last name from Bloom's Registration dialog); fills `user_id` on every member row inviting that email. Returns `{ userId }` (NULL if the caller has no user row) |
| `create_collection(id uuid, name text, initial_upload boolean = false)` | creates the collection with the caller as its sole claimed admin, creating the caller's user row if needed. `initial_upload: true` creates it with its initial upload in progress (see "Starting a cloud collection" below); this is the only way the flag is ever set |
| `my_collections()` | collections where the caller's email is approved (claimed or not), leaving out those whose initial upload is in progress (for everyone, the uploading admin too) |
| `finish_initial_upload(collection_id)` | admin (else SQLSTATE 42501 `admin_required`; unknown id P0002 `collection_not_found`). Clears the initial-upload flag for good; already clear = no-op success, so retry freely. Emits no event |
| `get_collection_state(collection_id, since_event_id?)` | full or delta snapshot: book rows (`instanceId`, name, current version and checksum, the lock holder's user id, name and email, machine and time, `checkoutGuidHash`, tombstone), the collection files' version, `max_event_id` (safe as a cursor, as for `get_changes`) and `initial_upload_in_progress`. Also sets the caller's `last_seen_at` in this collection (at most once per 10 minutes) |
| `get_changes(collection_id, since_event_id)` | history events since the cursor, and the book rows they touched (polling and catch-up); also `initial_upload_in_progress`, on every call, since clearing it emits no event. The call first waits for transactions still writing events in the collection, so no event at or below the returned `max_event_id` can commit later; advancing the cursor to it never skips one. Also sets the caller's `last_seen_at` |
| `get_book_manifest(collection_id, instance_id)` | `{ instanceId, version, checksum, files: [{path, sha256, size, s3VersionId}] }` for pinned-version Receive; the main `.htm` is `index.htm`; a never-committed book is invisible except to the holder of its send-only lock |
| `get_collection_file_manifest(collection_id)` | `{ version, files: [{path, sha256, size, s3VersionId}] }`, paths relative to the collection folder; a collection whose files were never sent returns `version 0` and no files |
| `checkout_book(collection_id, instance_id, machine text, checkout_guid text)` | conditional lock of a FREE book. `checkout_guid` is made by the client and saved in `.checkout` before the call (see "Checkout GUID" below); NULL or blank raises SQLSTATE 22023 `invalid_checkout_guid`. On success returns `{success: true, locked_by, locked_by_machine, locked_at}`. A retry by the caller with the SAME GUID after it succeeded returns the same success, changing nothing and emitting no second event. A book the caller holds under a different GUID (another copy), or under a send-only check-in lock, returns `{success: false, locked_by_me: true, locked_by, locked_by_machine, locked_at}` and changes nothing. Locked by someone else, or deleted: `{success: false, locked_by, locked_by_machine, locked_at}`. `locked_by` is a user id; `machine` is for display only |
| `checkout_book_takeover(collection_id, instance_id, checkout_guid text, machine text)` | atomically reassigns a DIFFERENT user's lock to the caller ONLY when `checkout_guid` is the lock's current checkout GUID (a person opening the local copy another account checked the book out in, whose `.checkout` holds the GUID; or a carried-over checkout). Presenting the member-readable hash does not work. The GUID is kept, so the same copy goes on working under the new account. `machine` is recorded with the new lock. Returns `{success, locked_by, locked_by_machine, locked_at}`; emits a CheckOut event only on a genuine handover; safe to call speculatively (success false when unlocked, already the caller's, or the GUID is missing or wrong) |
| `unlock_book(collection_id, instance_id, checkout_guid text)` | release one's own lock (undo checkout, no content change). Needs the current checkout GUID, else `CheckoutElsewhere: ...` (SQLSTATE P0001; HTTP 400); not the holder: `lock_not_held: ...`. Emits CheckOutReleased (101) |
| `force_unlock(collection_id, instance_id)` | admin; emits ForcedUnlock with the old lock in `lock_info`. Never needs the checkout GUID; clears it with the lock |
| `delete_book(collection_id, instance_id, checkout_guid text)` | requires the caller to hold the lock and present its checkout GUID (else `CheckoutElsewhere: ...`, SQLSTATE P0001); sets `deleted_at`; emits Deleted |
| `undelete_book(collection_id, instance_id)` | admin; clears the tombstone |
| `members_list(collection_id)` | any member. Rows: member id, invited `email`, role, `userId` (NULL until claimed), and once claimed the person's `name` and current email from `core.users`, `claimed_at`, `last_seen_at` (ISO timestamp, or NULL if they have never had the collection open; 10-minute granularity) |
| `members_add` / `members_remove` / `members_set_role` | admin-only management of the approved accounts. `members_add` treats an email matching a row's invited address, or a joined member's current email, as already having access. Removing a member force-unlocks that person's checkouts (evented). The last-admin guard refuses to remove or demote the last admin |
| `lock_book_for_legacy_checkout(collection_id, instance_id, legacy_email text, checkout_guid text, machine text)` | admin; only while the collection's initial upload is in progress. Locks a FREE, committed, live book to the user with `legacy_email` (an unclaimed user if nobody has that email yet) with the GUID's hash, `machine` as `locked_by_machine`, and emits a CheckOut (0) event. Result and refusals as for `checkout_book`; see "Carried-over checkouts" below |
| `add_palette_colors(collection_id, palette, colors[])` | union merge |
| `log_event(collection_id, instance_id?, type, message?, book_name?, bloom_version?)` | client-originated history entries (e.g. WorkPreservedLocally). `instance_id` is required for the types that concern a book |

All timestamps are server-side. All RPCs are RLS-gated; tables accept no direct writes.

#### Checkout GUID

The client that checks a book out makes a random GUID (`Guid.NewGuid()`, lowercase "D" form),
writes it to `<bookFolder>/.checkout` (never uploaded) and only then sends it to `checkout_book`;
the server never makes or returns one. A lost response is recovered by retrying with the same GUID
(idempotent) or by comparing the book row's `checkoutGuidHash` with the hash of the GUID on disk.
Only `checkout_book` creates a checkout: the lock `checkin-start` takes on a new or free book is a
send-only lock with no hash, which ends with that check-in. The server stores only the hash in
`tc.books.checkout_guid_hash`:

    checkoutGuidHash = lowercase hex( SHA-256( UTF-8 bytes of lower(guid) ) )

(SQL: `encode(sha256(convert_to(lower(guid), 'UTF8')), 'hex')`). The hash is member-readable (a
hash of 122 random bits cannot be reversed) and comes back on every book row as
`checkoutGuidHash`; the GUID itself is stored nowhere. A copy's `.checkout` is current only when the
row is locked by the caller and `checkoutGuidHash` equals the hash of its GUID. Check-in,
`unlock_book` and `delete_book` by the holder need the GUID, and so does `checkout_book_takeover`
by another account; `force_unlock` and member removal (admin) never do, and clear it with the lock.
The hash is also cleared whenever the lock is released or passes to another user without a new
GUID (only `checkout_book_takeover` hands the same GUID on).

#### Starting a cloud collection

The admin's Bloom calls `create_collection(id, name, initial_upload: true)`, uploads the collection
files and every book (ordinary first check-ins), locks the carried-over checkouts below, and finally
calls `finish_initial_upload(id)`. Until then `my_collections()` does not list the collection to
anyone, so invitees cannot join a half-uploaded collection; this also hides it from the uploading
admin's other machines (they can join once it is finished). Members who already have it open see
`initial_upload_in_progress: true` from `get_collection_state` / `get_changes`. The flag does not
restrict anything else: check-in, checkout and membership work as usual meanwhile.

#### Carried-over checkouts

A book checked out to someone in the old folder Team Collection is locked, after it is uploaded, to
the **user with that checkout's email** (`lower(NFC(trim(email)))`): the existing `core.users` row
with that email, or a new **unclaimed user**, a row with that email and no `authentication_id`.
Nobody can sign in as an unclaimed user, so nobody can check such a book in, unlock it or delete it.

- **Placing one:** `lock_book_for_legacy_checkout(collection_id, instance_id, legacy_email,
  checkout_guid, machine)`. The admin's client makes the GUID and writes it to the old shared
  folder's `Migration Keys/<instanceId>.json` first. Admin-only (42501 `admin_required`); only while
  the flag is set (else P0001 `initial_upload_not_in_progress: ...`); only for a book with a
  committed version (else P0001 `book_not_committed: ...`); NULL or blank GUID or email ⇒ 22023;
  unknown book P0002. A free live book is locked (`checkout_guid_hash` = hash of the GUID,
  `locked_by_machine` = `machine`, the old machine) and gets a CheckOut (0) event whose actor is the
  **admin**, with `lock_info: {locked_by: <that user's id>, machine, locked_at}` and `message`
  "checked out in the old Team Collection". Returns `{success: true, locked_by, locked_by_machine,
  locked_at}`. The same holder with the same GUID again returns the same success with nothing
  changed and no event (resuming after a crash). Anything else (locked by anyone, including the
  same holder under another GUID, or deleted) returns `{success: false, locked_by,
  locked_by_machine, locked_at}` and changes nothing.
- **Display:** the holder is shown by its email, having no name until claimed.
- **Ending one:** if the person signs in with that email, `claim_memberships` claims the unclaimed
  user, so the lock is already theirs. Otherwise `checkout_book_takeover(collection_id, instance_id,
  checkout_guid, machine)` by any member presenting the GUID (from the key file) moves the lock to
  the caller, keeps the GUID and emits CheckOut; from then on it is an ordinary checkout.
  `force_unlock` (admin) clears it with a ForcedUnlock event. Member removal never touches it (an
  unclaimed user is no member). These locks survive `finish_initial_upload`.

### Edge functions (`/functions/v1/<name>`, JWT-verified; only these hold AWS credentials)

A check-in is one **check-in attempt** (a row in `tc.checkin_attempts`), whose id travels as
`transactionId`.

#### `checkin-start` POST
Req: `{ collectionId, instanceId, proposedName, baseVersion?, checksum, clientVersion,
files: [{path, sha256, size}], checkoutGuid? }`
- `files` is the book's whole manifest, with the book's main `.htm` as `index.htm`, whatever the
  local folder is called. `proposedName` is the name the book should have (from its title, or the
  name chosen with Rename), never a folder name with a local suffix; it is for display and is not
  required to be unique.
- **No book with that instance id** in the collection ⇒ first Send of a new book: creates the row
  locked to the caller with NO current version (invisible to teammates until the first commit). The
  lock is for the send only, with no checkout GUID, so a first check-in never leaves the book
  checked out; re-calling for the same never-committed book needs only the same user and
  `instanceId` (any `checkoutGuid` sent is ignored). A deleted book with that instance id ⇒ 404
  `book_not_found`.
- **Existing book:** if the caller has it checked out, `checkoutGuid` must be its current checkout
  GUID, else 409 `CheckoutElsewhere` (the caller holds it in another copy); under the caller's own
  send-only lock (an unfinished check-in that took it while free) `checkoutGuid` must be absent. If
  the book is free, start takes a send-only lock (no GUID; finish, abort and expiry release it) and
  emits a CheckOut event (type 0, as `checkout_book` does); if someone else holds it, 409
  `LockHeldByOther` (+`holder`). If `baseVersion` is sent and the book has moved on, 409
  `BaseVersionSuperseded`.
- The S3 credentials are obtained before the lock is taken; a refused start returns none.
- Every `files[].path` is NFC-normalized before anything else, and validated: it must be a
  non-empty relative path (no leading `/`, no empty, `.` or `..` segment), with a `sha256` string
  and a non-negative integer `size`; two entries whose paths are equal after normalization are
  refused. Failure ⇒ 400 `InvalidManifest` (+`detail`, and `entries` or `paths`). `changedPaths`
  are returned NFC: **the client must upload each changed file to `prefix + changedPath` exactly as
  returned**, not under its local spelling (and the main `.htm` to `index.htm`).
- **An open attempt for this book and caller** is resumed only if the new proposal is identical to
  it (the same files, changed paths, checksum, base version, GUID snapshot and proposed name): the
  same `transactionId` comes back, with fresh credentials and a new expiry. Otherwise that attempt
  is aborted and a new one opened, with a new `transactionId`; for a never-committed new book the
  uncommitted book row is kept and only the attempt is replaced. The start locks the open attempt
  before comparing, so a finish of the old attempt either commits first or finds it aborted.
- The attempt records the book's current version as its base, and its `checkout_guid_hash` as a
  snapshot; `checkin-finish` refuses to commit if either has changed.

200: `{ transactionId, changedPaths[], s3: { bucket, region, prefix, credentials: { accessKeyId,
secretAccessKey, sessionToken, expiration } } }` (credentials scoped
`tc/{collectionId}/books/{instanceId}/*`, 1 h). A check-in never returns a checkout GUID.
Errors: 400 `InvalidManifest` · 401/403 · 404 `book_not_found` · 409 `LockHeldByOther` (+holder) /
`CheckoutElsewhere` / `BaseVersionSuperseded` · 426 `ClientOutOfDate`.

#### `checkin-finish` POST
Req: `{ transactionId, comment?, keepCheckedOut? }`

Verifies each changed object's sha256 attribute in S3, captures the S3 version ids, then in one
database transaction: sets the book's current version to the next number, replaces the book's
current files, updates the book row (checksum, name), releases the lock (unless `keepCheckedOut`),
records the new version on the attempt, and writes history events (Created and CheckIn for a new
book). Then writes the manifest backups. 200: `{ version }`.

Before committing it re-checks, under row locks, that the attempt is still open, that the caller
still holds the book's lock, that the book still has the checkout GUID the attempt started under,
and that the book is still at the attempt's base version. Otherwise nothing is written:
- 409 `transaction_aborted`: a newer `checkin-start` replaced this attempt. The client treats it as
  superseded (the newer Send carries on), not as an error.
- 409 `LockHeldByOther` (`holder`, or `null` if the lock was released, e.g. force-unlocked).
- 409 `CheckoutElsewhere` (checked after `LockHeldByOther`, before `BaseVersionSuperseded`).
- 409 `BaseVersionSuperseded` (`currentVersion`): the client must Receive and re-send rather than
  retry.
- 409 `MissingOrBadUploads { paths[] }`: re-upload and retry. An upload whose S3 `LastModified` is
  older than the commit window (`UPLOAD_COMMIT_WINDOW_MS`, 24 h) is never committed, even though its
  checksum matches; it is left out, and `stalePaths[]` (present only then) names those paths as well
  as `paths[]`. The client handles it like any other `MissingOrBadUploads`: start again and upload
  the returned `changedPaths`, then finish. This keeps the orphaned-upload sweep from ever deleting
  a version that is being committed.
- 410 `TransactionExpired`.

A retry of a finish that already committed (even one racing it) returns the same `{ version }`,
however old the uploads. `keepCheckedOut: true` keeps the lock AND the GUID; otherwise both are
released. Under a send-only lock (start created the book or took it while free; no GUID) the book
must still have no GUID, and the lock is always released, `keepCheckedOut` or not.

*Internal (not called by the client):* the finish edge functions establish the caller from their
own JWT via the `tc.current_caller()` RPC (validated by PostgREST), then call
`tc.checkin_finish_tx` / `tc.collection_files_finish_tx` with the **service-role key**, passing that
user id. Those two RPCs are EXECUTE-able by `service_role` only, because they trust the S3 version
ids they are given; a member calling them directly gets `permission denied`.

#### `checkin-abort` POST — `{ transactionId }` → 200
Idempotent: an attempt that does not exist (any longer) is also 200, a no-op, so a retry after a
lost response still succeeds. Someone else's attempt is 403. Removes a never-committed new book;
releases an existing book's send-only lock (no GUID) that the aborted check-in took; a checkout
(with a GUID) is kept. An expired attempt's send-only lock is released the same way when it is
reaped.

#### Keeping the attempts tables small
The reaper runs at every `checkin-start` and `collection-files-start`. It marks an open attempt
`expired` once its 48 hours are up, deletes a finished attempt once its expiry has passed (a
repeated finish only ever comes from the same Bloom session, which keeps the attempt id in memory),
and deletes an aborted or expired attempt once the orphaned-upload sweep has deleted its uploads.

#### Orphaned uploads (`sweep-stale-uploads`, ops only)
Not called by the client: a service-role job (see GOING-LIVE.md "Orphaned-upload sweep") that
deletes S3 versions uploaded by check-in attempts and collection-file sends that never committed.
Its worklist is the aborted and expired attempts; it reads it a page at a time
(`tc.list_stale_upload_keys(after_key, limit)`, keyset-paged by S3 key, every page per run), deletes
only versions older than `UPLOAD_SWEEP_GRACE_MS` (48 h), and re-checks each key just before
deleting. Because the finish functions never commit an upload older than `UPLOAD_COMMIT_WINDOW_MS`
(24 h; see `checkin-finish`), no version the sweep may delete can be committed while it runs; both
constants are in `supabase/functions/_shared/tc/uploadWindows.ts`, and a test keeps the commit
window plus a safety margin below the grace.

**Known limitation:** the uploads of a first check-in (new book) that never commits are not swept:
when that attempt expires, the reaper deletes the uncommitted book row with it, so the sweep's
worklist never sees them. They are harmless orphans (unreferenced current versions the lifecycle
rule never removes). Closing this needs an inventory-based cleanup (e.g. S3 Inventory or a periodic
listing, deleting keys no book row or manifest references and older than the sweep grace); not
built.

#### `download-start` POST — `{ collectionId }` →
200 `{ s3: {...} }` read-only credentials (`GetObject` + `GetObjectVersion`) scoped
`tc/{collectionId}/*`, 1 h.

#### `collection-files-start` / `collection-files-finish` POST
Admin only (403 `admin_required`). Start: `{ collectionId, expectedVersion, files[] }`, where `files`
is the collection's whole set of collection files, paths relative to the collection folder
(`Allowed Words/...`, `Sample Texts/...` and top-level files). Two-phase like check-in, with the same
path normalization and validation (400 `InvalidManifest`; upload to the returned `changedPaths`),
the same resume-only-if-identical rule, and credentials obtained before the attempt is opened.
Finish bumps `collections.collection_files_version` atomically and writes a CollectionFilesCheckIn
(102) event; 200 `{ version }`, idempotent on retry. 409 `VersionConflict` ⇒ the client receives
first (the repository wins). As in `checkin-finish`, an upload older than the 24 h commit window is
not committed (409 `MissingOrBadUploads` with `stalePaths[]`), and a replaced attempt answers 409
`transaction_aborted`.

## Realtime

Private broadcast channel `collection:{uuid}` (a trigger on `tc.history_events`), broadcast event
`tc_event`, sent with Supabase Realtime's `realtime.send` (the payload also carries the `id` that
`realtime.send` adds). Message: `{ eventId, type, instanceId?, bookVersion?, byUserId, byName, lock?,
bookName? }`. Only members of the collection may join the channel (RLS policy
`tc_members_receive_collection_broadcasts` on `realtime.messages`). Subscribe with `private: true`
and the user's JWT. (The Bloom client polls `get_changes` for now; realtime is later work.) Clients
persist `last_seen_event_id`; on (re)connect always run one `get_changes` delta first.

Event `type` values are the `BookHistoryEventType` numbers, plus cloud types from 100:

- `100` WorkPreservedLocally (a client-logged incident);
- `101` CheckOutReleased: a lock released without a check-in by (or on behalf of) its holder:
  `unlock_book`, or the send-only lock of an attempt that was aborted or expired (only for a
  committed book; a new book is invisible);
- `102` CollectionFilesCheckIn: a collection-files send committed; it has no book.

ForcedUnlock (5) is the admin's `force_unlock` and member removal. Every lock change of a visible
book has an event, so a `get_changes` poll always returns the book's new lock state. Authors are
shown by their current `users.name`. **Client:** `BookHistoryEventType` (and
CollectionHistoryTable.tsx's names / EventTypeEnumerationIsStable) must include 101 and 102.

## S3 layout (bucket versioning ON; lifecycle: abort-multipart 7 d, noncurrent expiry ~7 d)

```
tc/{collectionId}/books/{instanceId}/{relativePath}           (NFC; main .htm = index.htm)
tc/{collectionId}/books/{instanceId}/.manifest.json           (latest manifest backup)
tc/{collectionId}/books/{instanceId}/.manifests/{version}.json (backup of each version)
tc/{collectionId}/collectionFiles/{relativePath}
tc/{collectionId}/collectionFiles/.manifest.json, .manifests/{version}.json
```

Manifest backups are best-effort copies written after each commit (the database is the source of
truth; nothing reads them yet). Each committed version gets its own immutable
`.manifests/{version}.json`, and `.manifest.json` carries its version in the
`x-amz-meta-manifest-version` metadata and is replaced only by a newer one (conditional PUT), so
overlapping finishes that complete out of commit order never leave an older manifest as the latest.
Reads are ALWAYS by `(path, s3VersionId)` from the committed manifest, never "latest". Invariant:
check-in attempt lifetime < noncurrent-expiry floor.

## Book-status JSON (client ↔ TeamCollectionApi, additive)

Existing `IBookTeamCollectionStatus` fields unchanged; adds `localVersion?`, `repoVersion?`,
`signedIn`, backend capability flags.
