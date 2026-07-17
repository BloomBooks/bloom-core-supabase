# Azure Functions → Supabase Edge Functions Migration Plan

This document is the plan for migrating the Bloom Library API from
[bloom-azure-functions](https://github.com/BloomBooks/bloom-azure-functions) (Azure Functions,
Node/TypeScript) to this repo (Supabase Edge Functions, Deno/TypeScript).

Status as of July 2026: **`fs` is migrated** (this repo's first function) and serving production
traffic through the proxying Cloudflare Worker (Phase 0.5, deployed 2026-07-10). Everything
else still runs on Azure.

---

## 1. Current state

### Public API

All clients call `https://api.bloomlibrary.org/v1/<function>`. Known consumers:

| Consumer | Endpoints used |
| --- | --- |
| BloomLibrary2 (blorg) | `books` (queries), `stats`, `social` (share links), `fs` (book artifacts/thumbnails) |
| Bloom Desktop (`BloomLibraryBookApiClient.cs`) | `books` (`:upload-start` / `:upload-finish`), `status`, `books/{id}:permissions` |
| External OPDS partners (API accounts) | `opds` (which emits links back into `fs`) |
| Social-media scrapers (Facebook, etc.) | `social` (also via `social.bloomlibrary.org/v1/social`) |

### Azure function inventory

| Function | Trigger | Mutating? | External dependencies | Auth |
| --- | --- | --- | --- | --- |
| `fs` ✅ migrated | HTTP GET | No | ParseServer, S3 (public GET) | none |
| `social` | HTTP GET | No | none (pure HTML) | domain allow-list |
| `subscriptions` | HTTP GET (`/v1/subscriptionInfo/{code}`) | No | Google Sheets (service account) | none |
| `opds` | HTTP GET | No | ParseServer (incl. `catalog-service` login) | API-account `key` param |
| `stats` | HTTP GET/POST | No (temp table only) | Postgres analytics DB (read-only user), ParseServer | none |
| `contentfulToCrowdin` | Timer (22:30 daily) | Yes (writes to Crowdin) | Contentful (read), Crowdin (write) | tokens |
| `dailyTimer` | Timer (10:40 daily) | Yes (refreshes PG materialized views) | Postgres (admin user) | n/a |
| `bookCleanup` | Timer (12:40 daily) | **Yes — deletes** S3 files and Parse records | ParseServer (`book-cleanup` login), S3 | password |
| `status` | HTTP GET | No | Azure Durable Functions state | none |
| `books` | HTTP GET/POST/DELETE | **Yes** (Parse + S3 writes) | ParseServer, S3/STS, Contentful, Durable Functions | Parse session token |
| `longRunningActionOrchestrator` / `longRunningActions` | Durable (internal) | Yes (does the upload work) | ParseServer, S3 | internal |

### This repo (Supabase)

- One deployed edge function: `fs` (`supabase/functions/fs/`), Deno, `verify_jwt = false`.
- Shared code in `supabase/functions/_shared/` — `BloomParseServer.ts` was ported wholesale from
  the Azure repo, so much of the plumbing for future functions (book CRUD, service-user logins,
  S3 link helpers) already exists here, though only a small slice is currently used.
- CI/CD: GitHub Actions. PRs run tests; push to `develop` deploys to the **staging** Supabase
  project; push to `main` deploys to **production** (`.github/workflows/`).
- Secrets so far: `BLOOM_PARSE_APP_ID_{PROD,DEV,UNIT_TEST}` plus deploy credentials.

---

## 2. The Cloudflare situation

> **2026-07-10 update:** the 302 Redirect Rules described below have since been replaced by
> the proxying Worker (Phase 0.5 ✅ — see Appendix A for the current routing). This section is
> kept as background on why the replacement was necessary.

**What we knew (verified by inspecting live traffic, 2026-07-08):**

- All `api.bloomlibrary.org` traffic goes through Cloudflare.
- **The `fs` split is a redirect ("forwarding"), not a proxy.** It is implemented as two
  Cloudflare **Redirect Rules** (confirmed from the dashboard, 2026-07-08):
  - `supabase edge functions`: host `api.bloomlibrary.org` + path starts with `/v1/fs/` →
    302 to `concat("https://sekpsuviwfhzzznzrdgx.supabase.co/functions/v1/fs/", ...)`
  - `supabase edge functions - staging`: host `staging-api.bloomlibrary.org` + path starts with
    `/v1/fs/` → 302 to `concat("https://mwatyhkxsprxgnkcbalq.supabase.co/functions/v1/fs/", ...)`

  So there is a **staging API hostname** (`staging-api.bloomlibrary.org` → the staging Supabase
  project) alongside production. Verified live: `GET https://api.bloomlibrary.org/v1/fs/*`
  returns `302 Found` from Cloudflare with the path rewritten `/v1/` → `/functions/v1/`; the
  client then fetches from Supabase directly.
- **Everything else is reverse-proxied to Azure**: the `api.bloomlibrary.org` DNS record points
  at `bloom-functions.azurewebsites.net` (proxied through Cloudflare). Verified live —
  e.g. `/v1/subscriptionInfo/*` returns the Azure response directly (Azure's `Request-Context`
  App Insights header present, no redirect).
- `social.bloomlibrary.org` also routes to the Azure `social` function.

**Why forwarding works for `fs` but not for most other functions:** `fs` is public, GET-only,
and called with no custom headers — a CORS "simple request" that never triggers a preflight, and
every client (browser, curl, `<img>` tags) follows GET redirects transparently. The other
functions break one or more of those assumptions; see §2a below. **The plan assumes we replace
the redirect with a true proxy before migrating anything beyond `fs`.**

**Still to be looked up and documented here:** how `social.bloomlibrary.org` is routed
(needed for Phase 1); everything else is now documented in Appendix A.

This routing layer is the cutover/rollback lever for the whole migration: each function migrates
by adding one entry to the worker's `SUPABASE_FUNCTIONS` list, and rolls back by removing it.
It is version-controlled in [`cloudflare/worker.js`](cloudflare/worker.js) (deployed by the ops
team); keep Appendix A current as routes change.

### §2a. Why the current redirect approach must change before Phase 1+

Problems with 30x forwarding for the remaining functions:

1. **CORS preflights cannot follow redirects.** Any browser request with a JSON body or a custom
   header (`Authentication-Token`, `Content-Type: application/json`) triggers an `OPTIONS`
   preflight, and the fetch spec treats a redirect response to a preflight as a network error.
   This breaks blorg's calls to `stats` (POST + JSON) and `books` (auth header) outright.
2. **302 converts POST to GET.** Browsers and most clients re-issue a 302'd POST as a bodyless
   GET, breaking `books:upload-start/finish` and `DELETE books/{id}`. A 307/308 preserves the
   method, but only for clients that can replay the body, and it doesn't fix problem 1 or 3.
3. **Auth headers are dropped on cross-origin redirects.** The fetch spec strips `Authorization`
   when following a redirect to a different origin, and .NET's `HttpClient` (Bloom Desktop) does
   the same — risky for any authenticated endpoint even where the redirect is otherwise followed.
4. **Unknown clients may not follow redirects at all** — OPDS partner harvesters, social-media
   scrapers hitting `social`, older Desktop code paths.
5. **It leaks the Supabase project URL** into clients, caches, and logs, and adds a full extra
   round-trip (new TLS connection to `*.supabase.co`) per request.

**Recommendation:** replace the redirect with a **Cloudflare Worker** on
`api.bloomlibrary.org/v1/*` that proxies (`fetch()`) matching paths to
`<project-ref>.supabase.co/functions/v1/...` and passes everything else through to Azure. Workers
are available on any Cloudflare plan (the alternative — Origin Rules with host-header override to
an external origin — is Enterprise-only), keep `api.bloomlibrary.org` as the only origin clients
ever see, preserve method/headers/CORS semantics, and give us a per-path routing table we can
version-control with Wrangler. Migrating `fs` from the 302 rule into that Worker is the proof
step, and becomes **Phase 0.5** — a prerequisite for every later phase.

**The worker is deployed (2026-07-10)**: `bloom-api-router-staging` and `bloom-api-router`
are live on `staging-api.bloomlibrary.org/v1/*` and `api.bloomlibrary.org/v1/*`, currently
routing only `fs` to Supabase. Code, Wrangler config, current state, and
verification/rollback instructions are in [`cloudflare/`](cloudflare/README.md). (The dev
team has only domain-level Cloudflare permissions, so the ops team deploys changes; each
later phase is a one-line change to the worker's routing list, staging worker first.)

---

## 3. Migration order (lowest risk → highest risk)

Risk here combines: implementation complexity, blast radius if it breaks, whether it mutates
data, and how easily it rolls back (all HTTP functions roll back instantly via the Cloudflare
rule; timers roll back by re-enabling the Azure timer).

**The API contract.** [`api-spec.yml`](api-spec.yml) — the OpenAPI spec for the public API at
`https://api.bloomlibrary.org/v1`, ported from the Azure repo — is landed **first**, ahead of
every phase below, as the reference each migration must preserve. The phases move each endpoint's
*implementation* from Azure to Supabase; the contract they honor does not change. Everything in
`api-spec.yml` is live; planned-but-unimplemented endpoints (currently only `/languages/{tag}`,
never implemented in either repo) live in [`api-spec-next.yml`](api-spec-next.yml) and graduate
to `api-spec.yml` when built.

### Phase 0 — `fs` ✅ done
Serving production. Remaining follow-ups: document the Cloudflare rule (Appendix A), and confirm
Azure `fs` traffic has actually dropped to zero before deleting the Azure function.

### Phase 0.5 — Replace the 302 redirects with a proxying Worker ✅ done
Stand up the Cloudflare Worker described in §2a in two stages: first replace the **staging**
redirect rule (`staging-api.bloomlibrary.org` → staging Supabase project) and verify proxying
behavior there (headers, range requests, caching, Azure fall-through); then replace the
production rule on `api.bloomlibrary.org`. Every subsequent phase is then "add a path to the
Worker's routing table," rolled out staging-first the same way.

Status: **✅ deployed by ops 2026-07-10** — both workers live, routing only `fs` for now; both
redirect rules disabled (kept for rollback). Verified staging and production: 200 PNG through
the proxy with no 302, 206 on Range requests, and Azure fall-through intact
(`Request-Context` header present). See [`cloudflare/`](cloudflare/README.md) for current
state, verification curls, and the per-function extension process.

### Phase 1 — `social` (trivial, no dependencies)
- Pure HTML generation with a `bloomlibrary.org` domain allow-list; no external services, no
  secrets, read-only.
- Watch-outs: preserve exact OpenGraph output (test with Facebook's sharing debugger);
  `social.bloomlibrary.org` needs its own Cloudflare rule in addition to
  `api.bloomlibrary.org/v1/social`.
- Status: **implemented** (`supabase/functions/social/`) and merged to `develop`. Two changes
  from the Azure version: parameters are HTML-escaped (the Azure version interpolated them raw —
  an injection vector), and the public `og:url` is reconstructed from a custom header the worker
  sends (see the `og:url` finding below). No special cutover ordering is needed.

#### The `og:url` / host-rewrite problem (verified on staging 2026-07-17)
When the worker proxies a migrated function it must rewrite the request host to
`<ref>.supabase.co` — you cannot reach Supabase under the `bloomlibrary.org` host. So the
function sees its own URL as the Supabase one and can't build a public `og:url` from `req.url`.
The code tries to carry the original host across in an `X-Forwarded-Host` header the worker
sets — **but that header does not survive.** `X-Forwarded-*` are proxy-managed headers, and the
Cloudflare/gateway layer in front of the Supabase runtime strips or overwrites them before the
Deno function sees them. Verified on staging: a `curl` that set `X-Forwarded-Host` **by hand,
directly at `*.supabase.co` (bypassing the worker entirely), still didn't reach the function** —
so the loss is at the Supabase edge, not in our worker. Result: `og:url` silently falls back to
the `*.supabase.co` URL — exactly the leak §2a-5 warns about.

**Current production behavior (verified 2026-07-17).** Production is unaffected today because it
is still on Azure. Both public entry points — `api.bloomlibrary.org/v1/social` and
`social.bloomlibrary.org/v1/social` — hit the *same* Azure function (identical `Request-Context`
appId) and differ in exactly one way: each **mirrors its own host into `og:url`** (`api.…` →
`https://api.bloomlibrary.org/v1/social?...`, `social.…` →
`https://social.bloomlibrary.org/v1/social?...`). Azure gets this for free because the request
reaches it already bearing the public host. Preserving that per-host mirror is the target
behavior for the migrated version.

Second, latent bug found the same way: `getPublicUrl` strips a `/functions/v1/` path prefix, but
the function's actual `req.url` path is `/social` (no such prefix), so even a surviving header
would rebuild `/social`, not the `/v1/social` Azure emits.

**Resolution (implemented): carry the public URL in a custom header.** `X-Forwarded-*` is
stripped, but a *non-proxy-managed* header rides through the Supabase edge untouched. Verified on
staging 2026-07-17: with `X-Bloom-Public-Url` set to a `social.bloomlibrary.org` URL, `og:url`
came back as that public URL with **no `*.supabase.co`** — both when routed through the existing
worker (which copies client headers) and when sent directly to the Supabase function. So:
- **Function side:** `getPublicUrl` reads a full public URL from `X-Bloom-Public-Url`, validated
  against the `bloomlibrary.org` allowlist, and otherwise falls back to `req.url`. Carrying the
  *full* URL also disposes of the `/functions/v1/` vs `/v1/social` path bug above, since the worker
  sends the already-correct public path. (The dead `X-Forwarded-Host` path has been removed.)
- **Worker side (deployed to staging 2026-07-17; production deploy pending):** the routing worker
  sets `X-Bloom-Public-Url` to the original public request URL (host + `/v1/…` + query) in place of
  `X-Forwarded-Host`.

This supersedes the earlier idea of a DNS/custom-domain switch: **no Supabase custom domain is
needed, and `social` need not be cut over last** — it works correctly through the worker like any
other migrated function, on both `api.bloomlibrary.org` and `social.bloomlibrary.org` (each
mirrors its own host, since the worker forwards whichever public URL the request arrived on).

**End-to-end verified on staging (2026-07-17).** With the worker change deployed, a plain request
through `staging-api.bloomlibrary.org/v1/social` (no client-set header) returned
`og:url = https://staging-api.bloomlibrary.org/v1/social?...` with no `*.supabase.co` and the
redirect intact — the worker injects the header on its own and the function honors it, matching
Azure's current per-host behavior.

Remaining step: deploy the same `cloudflare/worker.js` to **production** at cutover time. Until
then, production stays on Azure; and on staging, any not-yet-wired host simply falls back to
`req.url` (no regression).

### Phase 2 — `subscriptions` (read-only, one simple dependency)
- Route `/v1/subscriptionInfo/{code}`; reads one named range from a Google Sheet.
- Needs the Google service-account secrets moved to Supabase
  (`BLOOM_GOOGLE_SERVICE_ACCOUNT_EMAIL`, `BLOOM_GOOGLE_SERVICE_PRIVATE_KEY`,
  `BLOOM_SUBSCRIPTION_SPREADSHEET_ID`). The `googleapis` npm client works under Deno via `npm:`
  specifiers, or swap for a plain JWT + fetch call to the Sheets REST API.
- Consumed by Bloom Desktop for subscription/branding codes, so verify against a released
  Desktop build before cutover.
- Status: **implemented** (`supabase/functions/subscriptionInfo/` — named for its URL segment,
  not the Azure folder name `subscriptions`). Uses a hand-rolled service-account JWT +
  Sheets REST call instead of the googleapis npm package.

### Phase 3 — `contentfulToCrowdin` (first timer; not user-facing)
- Daily one-way sync: Contentful → three l10n JSON files → Crowdin. No Bloom data touched;
  a failure is visible only to translators and is easy to re-run.
- Supabase Edge Functions have no timer trigger. Options:
  a. **pg_cron + pg_net** in the Supabase Postgres calling the edge function on schedule
     (the standard Supabase pattern), or
  b. a GitHub Actions `schedule:` workflow in this repo that invokes the function (simpler,
     visible in git, one less moving part in the database).
  Pick one and reuse it for the other timers.
- Run both Azure and Supabase versions in parallel for a few days (Crowdin uploads are
  idempotent) before disabling the Azure timer.

### Phase 4 — `opds` (read-only, but external contract)
- ParseServer-only dependency, and `_shared/BloomParseServer.ts` already has the
  `catalog-service` login helper ported. Main work is porting the XML catalog generation and its
  tests.
- Risk is the **external contract**: OPDS partners consume this XML with their own parsers.
  Mitigate with byte-level diffing of old vs. new output across a matrix of
  `lang`/`tag`/`epub`/`src` parameters before cutover.
- Needs `BLOOM_PARSE_CATALOG_SERVICE_PASSWORD` (+ unit-test API-account id for tests).

### Phase 5 — `stats` (read-only, adds the Postgres dependency)
- Calls stored procedures in the analytics Postgres DB (read-only user), sometimes seeding a
  temp table with book IDs resolved from Parse.
- New for this repo: direct Postgres connections from an edge function to the *analytics* DB
  (not the Supabase DB). Use a Deno Postgres driver; check that the analytics DB accepts
  connections from Supabase egress IPs, and prefer a pooled connection (the Azure version manages
  a `pg` pool; edge functions are short-lived, so verify connection-per-request performance or put
  pgbouncer in front).
- Note: `stats/events.ts` builds some SQL by string interpolation with only a crude injection
  guard — fix that (parameterized queries) during the port rather than copying it.
- Consumed by blorg's book-stats UI; low write risk, moderate visibility.

### Phase 6 — `dailyTimer` (small, but first *writing* function)
- One job: call `common.refresh_materialized_views()` in the analytics Postgres as the admin
  user. **Chosen approach: schedule it inside the analytics Postgres itself with pg_cron** and
  skip porting the function entirely — it's a DB-to-itself operation; the Azure function is just
  a cron wrapper. The analytics DB is Azure Database for PostgreSQL
  (`bloom-analytics.postgres.database.azure.com`); pg_cron is on its supported-extensions list
  (requires adding `pg_cron` to the `azure.extensions` and `shared_preload_libraries` server
  parameters — needs a server restart — and setting `cron.database_name`).
- **Failure reporting** (pg_cron only *records* outcomes, it never pushes alerts):
  1. pg_cron logs every run in `cron.job_run_details` (status, error message, timings) — the
     audit trail, queryable but passive. Schedule a second pg_cron job to prune it
     (e.g. delete rows older than 30 days).
  2. Azure's Postgres flavor does not support `pg_net`/`http` extensions, so the DB cannot call
     a webhook itself. Active alerting therefore comes from a small external **watchdog**: a
     scheduled GitHub Actions workflow in this repo (daily, an hour or two after the refresh)
     that connects with the read-only user and asserts **freshness** — every materialized view
     refreshed within the last ~25 h — rather than looking for failure rows (a freshness check
     also catches "pg_cron never ran at all", which leaves no failure row). A failing workflow
     notifies via GitHub's built-in failure emails (optionally Slack).
  3. To make freshness checkable, extend `common.refresh_mv_in_transaction()` (in
     `analytics-postgreSQL`) to write each view's refresh time + success/error to a small
     `common.refresh_log` table. Worth adding per-view exception handling at the same time so
     one failing view doesn't abort the remaining six (today an error mid-procedure stops the
     rest).
  4. Alternative/adjunct if ops prefers: Azure Monitor log alerts on the Postgres server logs.
- Note this is a *better* story than the status quo: the Azure `dailyTimer` only logs failures
  to App Insights, which nobody is alerted on either.
- Risk: needs the server-parameter change (restart) on the analytics DB. Failure mode is stale
  stats (detectable, recoverable), not data loss.

### Phase 7 — `bookCleanup` (destructive timer)
- Deletes abandoned-upload S3 files and Parse book records older than 24h. First function that
  can *destroy* data if buggy.
- Mitigations: it already has a `runInSafeMode` flag — run the Supabase port in safe/log-only
  mode for a week alongside the Azure version, diff what each *would* delete, then flip.
  Never run both live simultaneously (double-delete races on the same books).
- Needs `BLOOM_PARSE_BOOK_CLEANUP_PASSWORD_{PROD,DEV,UNIT_TEST}` and the
  `BLOOM_UPLOAD_PERMISSION_MANAGER_S3_*` secrets.

### Phase 8 — `books` + `status` + the durable-function machinery (highest risk, do last)
- The core book upload/query/delete API: Parse session-token auth, uploader/collection-editor/
  moderator permission logic (Contentful), S3 copy/delete, STS temporary credentials, and —
  hardest — the **Azure Durable Functions** pattern (`books:upload-start/finish` → orchestrator →
  activity, polled via `status`, 10-minute timeout).
- Supabase edge functions can't replicate durable orchestration directly (CPU/wall-clock limits,
  no built-in orchestration). The 202-Accepted + poll-`status` contract must be re-implemented;
  realistic options, to be decided in a short design doc when we get here:
  - a jobs table in Supabase Postgres + **Supabase Queues (pgmq)**, with a worker triggered by
    cron or `EdgeRuntime.waitUntil` background tasks;
  - restructure upload-finish so the slow parts (S3 copy, hash diffing) shrink or move
    client-side, possibly eliminating the need for orchestration;
  - keep the orchestration piece on Azure last, migrating the simple `books` GET/permissions
    endpoints first (the `books` routes can be split at Cloudflare by method/action if needed).
- `status` migrates *with* this phase — it's meaningless apart from the orchestration store.
- Both current Bloom Desktop releases and blorg depend on this; Desktop versions in the field
  can't be patched, so the API contract (including error shapes and `Operation-Location`
  headers) must be preserved exactly.
- Migrate `books` GET (blorg queries) first behind its own Cloudflare rule, then uploads.

### Decommission
When Azure traffic is zero (verify via Azure metrics/logs over ≥30 days, remembering monthly
timers and long-tail OPDS clients): disable the functions app, retire the Kudu deployment, rotate
any credentials that lived in Azure app settings, archive the repo with a pointer to this one.

**What remains relevant in the Azure repo** (everything else — functions, shared code, tests,
api-spec, host/deploy config, READMEs — has been ported here or superseded):
1. The **secret values** in the Function App's settings (portal → Configuration → Application
   settings; also on dev machines in `local.settings.json`) — the source when provisioning the
   checklist in §4. Never in git.
2. The **running app itself** until cutover completes.
3. The unit-test Parse server (`bloom-parse-server-unittest.azurewebsites.net`) is a separate
   Azure App Service from the `bloom-parse-server` repo — out of scope; it stays.

---

## 4. Cross-cutting concerns

- **Runtime port (Node → Deno):** axios → `fetch`; `@azure/functions` request/response → the
  `Deno.serve` handler pattern already established in `fs`; npm deps via `npm:` specifiers where
  needed. The `?env=dev` environment-selection convention is already ported (`_shared/utils.ts`).
- **Routing convention:** Azure uses `host.json` `routePrefix: "v1"`; Supabase functions live at
  `/functions/v1/<name>`. Follow the `fs` pattern (scan path segments for the function-name
  marker) so functions work both at their native Supabase URL and behind
  `api.bloomlibrary.org/v1/...`.
- **Secrets:** each phase moves its secrets into Supabase project secrets (staging + prod) and
  GitHub Actions secrets for CI. Full inventory is in the Azure repo (`local.settings.json`
  keys); map naming to the `BLOOM_*` convention started here.
- **JWT:** each new public function needs `verify_jwt = false` in `supabase/config.toml`
  (or an explicit auth design if we ever want Supabase-native auth).
- **Testing:** keep the ported Jest tests as Deno tests (pattern established in
  `supabase/functions/tests/`). The unit-test Parse Server still runs on Azure App Service
  (`bloom-parse-server-unittest.azurewebsites.net`) — out of scope here, but note it's a residual
  Azure dependency even after this migration completes.
- **Staging:** every phase deploys to the staging Supabase project first (auto on `develop`)
  and is exercised there before the Cloudflare rule flips production traffic.
- **Rollback:** for HTTP functions, rollback = revert the Cloudflare rule (leave the Azure
  function running until decommission). For timers, rollback = re-enable the Azure timer. Keep
  the Azure app deployed and warm until the very end.
- **Monitoring:** decide per-phase how we'll know it broke — Supabase function logs/metrics at
  minimum; consider forwarding errors to whatever alerting the team already watches.

---

## 5. Cutover runbook (the order of operations from here)

All code is implemented (phases 1–5, 7, 8, the worker, and the spec). What remains is
operational, in this order:

1. **Merge the branch stack** bottom-up into `develop` (`api-spec` → `phase2-subscriptions` →
   `phase3-contentful-to-crowdin` → `phase4-opds` → `phase5-stats` → `phase7-book-cleanup` →
   `phase8-books`; `phase1-social` is already on `develop`). Each merge auto-deploys functions
   **and migrations** to the staging project. Before the first merge, provision the secrets
   checklist (§4) on the staging Supabase project and the GitHub repo secrets (`BLOOM_CRON_SECRET`,
   `BLOOM_SUPABASE_{STAGING,PRODUCTION}_DB_PASSWORD`) — the contentfulToCrowdin cron activates on
   merge and will report failures until its secrets exist.
2. **Ops deploys the staging worker** (Stage 1 of [`cloudflare/README.md`](cloudflare/README.md)).
3. **Verify on `staging-api.bloomlibrary.org`**: every function's smoke tests; the OPDS
   byte-diff against Azure output (`lang`/`tag`/`epub`/`src` matrix); a real Bloom Desktop
   upload (upload-start → S3 sync → upload-finish → status polling); `stats` against the
   analytics DB (confirms the firewall accepts Supabase egress); safe-mode `bookCleanup` runs
   compared against what the Azure timer deletes.
4. **Ops deploys the production worker** (Stage 2). ⚠️ The checked-in `cloudflare/worker.js`
   lists **all** migrated functions, so deploying it verbatim cuts everything over at once.
   For production, start `SUPABASE_FUNCTIONS` with just `"fs"` and extend it one function at a
   time as each passes staging verification; each extension is an instant-rollback one-line
   change. Extend `social` **last of all** — its production cutover is deferred to the end-state
   DNS switch described in §3 (Phase 1), when the `bloomlibrary.org` hosts point directly at
   Supabase and the worker is retired.
5. **Timers**: uncomment the bookCleanup workflow schedule only after step 3's safe-mode
   comparison and after disabling the Azure timer (never both live). Disable the Azure
   contentfulToCrowdin timer once the GitHub cron has succeeded a few days in a row.
6. **Phase 6** (materialized views): set up pg_cron + the `refresh_log` change + the freshness
   watchdog in the analytics DB (see Phase 6 above) and disable the Azure `dailyTimer`.
7. **Provision production secrets** and repeat the per-function worker extension on
   `api.bloomlibrary.org` (step 4's list and ordering — `social` last).
8. **Decommission** Azure per the checklist above.

Note on tests: the suite includes live tests ported from Azure (Google Sheet lookups, prod-Parse
OPDS queries, S3 bucket round-trips, the end-to-end bookCleanup scenario). They skip themselves
unless their credentials are present in the environment — same env-var names as the functions
(see `.env.example`) — so a bare `pnpm test:ci` run only exercises what its secrets allow.

---

## Appendix A — Cloudflare routing rules

Confirmed from the Cloudflare dashboard + live traffic. Updated 2026-07-10, when the Workers
replaced the 302 Redirect Rules (Phase 0.5).

| Hostname / path | Mechanism | Destination | Notes |
| --- | --- | --- | --- |
| `api.bloomlibrary.org/v1/*` | Worker `bloom-api-router` — server-side **proxy** | `fs` → `sekpsuviwfhzzznzrdgx.supabase.co` (prod Supabase); everything else falls through to the zone origin (Azure) | path rewritten `/v1/<fn>` → `/functions/v1/<fn>` in [`cloudflare/worker.js`](cloudflare/worker.js) |
| `staging-api.bloomlibrary.org/v1/*` | Worker `bloom-api-router-staging` — **proxy** | `fs` → `mwatyhkxsprxgnkcbalq.supabase.co` (staging Supabase); everything else → Azure via `ORIGIN_HOST` | same script as production |
| *(disabled)* Redirect Rules `supabase edge functions` / `... - staging` | **302** on `/v1/fs/*` | prod / staging Supabase | disabled 2026-07-10; kept in the dashboard for instant rollback |
| `api.bloomlibrary.org/*` (rest) | proxied DNS record | `bloom-functions.azurewebsites.net` (Azure Functions app) | Azure `Request-Context` header visible in responses; the Worker's fall-through relies on this record |
| `social.bloomlibrary.org/*` | not yet inspected | Azure `social` function | needs updating in Phase 1 |
