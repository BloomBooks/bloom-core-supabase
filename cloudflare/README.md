# Cloudflare Worker: `bloom-api-router`

**Audience: the ops team (whoever has Workers permission on the `bloomlibrary.org` Cloudflare
zone).** The Bloom dev team maintains this code but has only domain-level permissions, so we
need you to deploy it. Contact: andrew_polk@sil.org.

## What this is and why

Bloom Library is migrating its API (`api.bloomlibrary.org/v1/*`) from Azure Functions to
Supabase Edge Functions, one function at a time (full plan: [`../MIGRATION-PLAN.md`](../MIGRATION-PLAN.md)).

This worker is the routing layer for that migration: requests for migrated functions are
**proxied** server-side to Supabase and the response is returned on the bloomlibrary.org
hostname; everything else passes through to the Azure origin exactly as before.

For `fs` the worker does more: it also **carries the file bytes** — see
[fs: the worker carries the file bodies](#fs-the-worker-carries-the-file-bodies).

## fs: the worker carries the file bodies

**Why:** Edge Function response bytes count as uncached Supabase egress. When the `fs` function
fetched each file from S3 and streamed it back, every thumbnail, `.bloompub`, PDF and audio file
served through `api.bloomlibrary.org/v1/fs` counted, and we exceeded the Supabase egress quota.
Cloudflare has no egress fees, so the bytes now go S3 → Cloudflare → client instead.

**How:** the `fs` function still looks the book up in Parse, but now answers with a tiny **302
to the file's S3 URL**. For `/v1/fs/*` only, the worker calls the function with
`redirect: "manual"`, then follows the 302 **itself**: it fetches the file from S3 and streams
it to the client. The client never sees the redirect or S3 — it gets the file from
`api.bloomlibrary.org` exactly as before. On the way the worker:

- refuses (502) any redirect that isn't `https://s3.amazonaws.com/<one of our four buckets>/...`,
  so it can't be turned into an open proxy;
- forwards only `range`, `if-none-match`, `if-modified-since`, `if-match`,
  `if-unmodified-since` and `accept-encoding` to S3, with the client's method (GET or HEAD);
- passes 304 (and 206) through, and turns any other S3 failure into a 404;
- strips `x-amz-*` response headers;
- sets `Cache-Control: max-age=31536000` on `harvest`/`dev-harvest` thumbnails;
- copies the CORS headers from the function's 302 onto the file response (appending to S3's
  `Vary`), so the function remains the one place CORS is decided.

Anything other than a redirect from the function (OPTIONS preflights, 400/401/404/405/500) is
passed through unchanged.

### The worker secret: only the worker may use fs

The function's 302 reveals the S3 address, and older books' S3 paths contain the uploader's
email. The worker never passes that 302 on, but the function's own Supabase URL is public and
needs no login. So fs answers only requests carrying a shared secret:

- The worker adds an `X-Bloom-Worker-Secret` header, from its **`BLOOM_WORKER_SECRET` secret**,
  to every request it proxies to Supabase. It replaces any value a client sent, and removes it if
  the secret isn't configured. It never sends it to S3.
- `fs` compares it in constant time against its own `BLOOM_WORKER_SECRET` Supabase secret and
  answers **401** to anything else, including when the secret isn't configured. OPTIONS
  preflights don't need it.

Use one strong random value (`openssl rand -base64 32`) for **both staging and production**, and
store it as an encrypted secret on all four (both workers, both Supabase projects), never as a
plaintext variable or in `wrangler.toml`. Share it out-of-band. To rotate it, set the new value
on each worker and its Supabase project one right after the other; fs refuses requests in
between.

### Deploy order: secrets and worker first, then the function

**The worker, its secret and the function must be deployed together, worker first.** The new
worker is backward compatible: if the function still streams the file (a 200), the worker passes
it through untouched, and the old function ignores the secret header. The reverse is not true:
the old worker hands the function's 302 straight to the client (exposing S3 URLs and breaking
cross-origin `fetch()` of fs files from bloomlibrary.org), and a new function without a matching
secret answers every fs request with 401.

The function deploys automatically from GitHub Actions — to the **staging** Supabase project on
every push to `develop`, to **production** on every push to `main`. So:

1. **Dev team:** generate the secret and set it on both Supabase projects (the old function
   ignores it): `supabase secrets set BLOOM_WORKER_SECRET=<value> --project-ref
   mwatyhkxsprxgnkcbalq`, then the same with `--project-ref sekpsuviwfhzzznzrdgx`. Send the value
   to ops out-of-band.
2. **Ops:** on `bloom-api-router-staging`, add `BLOOM_WORKER_SECRET` as an **encrypted secret**
   (Settings → Variables and Secrets → type *Secret*, or `npx wrangler secret put
   BLOOM_WORKER_SECRET --env staging`) and redeploy with the new `worker.js`. Verify (below) that
   fs still works; nothing should change yet, since staging still runs the old function.
3. **Merge the PR to `develop`** (deploys the redirecting function to staging). Run the
   verification below against `staging-api.bloomlibrary.org`, including the direct-call 401.
4. **Ops:** add the same value as an encrypted secret on `bloom-api-router` (production; `npx
   wrangler secret put BLOOM_WORKER_SECRET`) and redeploy with the new `worker.js`, keeping
   production's own `SUPABASE_FUNCTIONS` list. Verify production fs is unchanged.
5. **Merge `develop` to `main`** (deploys the function to production). Verify production again,
   then watch the Supabase egress graph drop.

**Verification** (use `staging-api` for staging):

```bash
# 200 PNG, Cache-Control: max-age=31536000, no Location, no x-amz-* headers, no supabase.co
curl -sD - -o /dev/null -H "Origin: https://bloomlibrary.org" "https://api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/thumbnails/thumbnail-256.png"

# 206 with Content-Range
curl -sD - -o /dev/null -H "Range: bytes=0-1023" "https://api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"

# 304 when revalidating with the ETag from a previous response
curl -sD - -o /dev/null -H 'If-None-Match: "<etag>"' "https://api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"

# 404 for a missing file, still with Access-Control-Allow-Origin
curl -sD - -o /dev/null -H "Origin: https://bloomlibrary.org" "https://api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/no-such-file.pdf"

# Calling the function directly, without the secret: 401 and no Location
# (staging: mwatyhkxsprxgnkcbalq.supabase.co)
curl -sD - -o /dev/null "https://sekpsuviwfhzzznzrdgx.supabase.co/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"
```

If fs answers 401 through `api.bloomlibrary.org`, the worker's and the project's
`BLOOM_WORKER_SECRET` don't match (or one is missing).

**Rollback:** revert the function change (on `develop`/`main`, which redeploys it). The new
worker can stay; it passes the old function's 200s through.

### Testing the worker locally

`supabase/functions/tests/cloudflare-worker-test.ts` unit-tests the worker under Deno (part of
`pnpm test`). To run the real worker in `workerd` against a locally served function, copy
`worker.js` and `wrangler.toml` to a scratch folder; in the copy change `url.protocol = "https:"`
and `url.port = ""` to `"http:"` and the function's port, and set
`SUPABASE_FUNCTIONS_HOST = "localhost"`; run `npx wrangler dev --var
BLOOM_WORKER_SECRET:<the value in your .env.local>` there and curl
`http://127.0.0.1:8787/v1/fs/...`.

## Current state — deployed 2026-07-10 ✅

Both workers are live:

| Worker | Route | `SUPABASE_FUNCTIONS_HOST` | `ORIGIN_HOST` |
| --- | --- | --- | --- |
| `bloom-api-router-staging` | `staging-api.bloomlibrary.org/v1/*` | `mwatyhkxsprxgnkcbalq.supabase.co` (staging project) | `bloom-functions.azurewebsites.net` |
| `bloom-api-router` | `api.bloomlibrary.org/v1/*` | `sekpsuviwfhzzznzrdgx.supabase.co` (production project) | (not set — falls through to the zone's origin) |

Both currently route **only `fs`** to Supabase; all other `/v1/*` traffic still goes to the
Azure Functions app. Each function we migrate is a one-line addition — see
[Ongoing changes](#ongoing-changes-adding-a-function) below.

The workers replaced two 302 **Redirect Rules** (`supabase edge functions` and
`supabase edge functions - staging`, now disabled but kept in the dashboard for rollback).
The 302 approach happened to work for `fs` (public, GET-only) but would have broken the
functions migrating next: CORS preflights can't follow redirects, 302 turns POST into GET, and
auth headers get dropped on cross-origin redirects.

## Files

- [`worker.js`](worker.js) — the worker (ES module, no dependencies, no build step)
- [`wrangler.toml`](wrangler.toml) — config if you deploy with Wrangler; also the reference for
  the routes/variables listed below if you use the dashboard

## How they were deployed (reference)

Completed 2026-07-10; kept for reference (e.g. re-creating a worker from scratch). The same
script is deployed twice. **Stage 1** replaced the staging redirect rule on
`staging-api.bloomlibrary.org` with the worker, pointed at our *staging* Supabase project, where
we verified the proxying behavior without touching live traffic; **Stage 2** then did the same
on `api.bloomlibrary.org`. The verification curls remain useful any time a worker changes.

All values are pre-filled in `wrangler.toml`; the Azure Functions app is
`bloom-functions.azurewebsites.net` (the DNS target of `api.bloomlibrary.org`).

### Stage 1 — staging worker (no live traffic affected)

1. **Create the worker**. Worker scripts live at the *account* level, not the zone — from
   inside the `bloomlibrary.org` zone, click the account name in the breadcrumb (or the
   "Manage Workers" button on the zone's Workers Routes page). Then: **Workers & Pages →
   Create application → Workers tab → Create Worker** → name it `bloom-api-router-staging` →
   **Deploy** the starter (code can't be pasted at this step) → **Edit code** → replace the
   starter with the contents of `worker.js` (it's an ES-module worker) → **Save and deploy**.
2. **Variables** (worker → Settings → Variables and Secrets, plaintext):
   - `SUPABASE_FUNCTIONS_HOST` = `mwatyhkxsprxgnkcbalq.supabase.co` (staging Supabase project)
   - `ORIGIN_HOST` = `bloom-functions.azurewebsites.net`
3. **Route**: add `staging-api.bloomlibrary.org/v1/*` on zone `bloomlibrary.org`
   (zone sidebar → **Workers Routes** → Add route, or the worker's Settings → Domains & Routes).
   (The DNS record for that hostname already exists — the staging redirect rule uses it.)
4. **Disable or delete the Redirect Rule named `supabase edge functions - staging`.** This is
   required: Redirect Rules execute before Workers in Cloudflare's traffic sequence, so while
   the rule is active the worker never sees the `fs` traffic.
5. Tell the Bloom dev team it's live; we will run the verification below and confirm before
   Stage 2. Nothing about `api.bloomlibrary.org` changes in this stage.

**Staging verification** (run by the dev team, listed here for completeness):

```bash
# fs proxied to staging Supabase: expect HTTP 200 PNG, no 302, no supabase.co in headers
# (dev-harvest serves *dev* data; if this returns 400, the example book was deleted from the
# dev site — substitute any book id from dev.bloomlibrary.org)
curl -sD - -o /dev/null "https://staging-api.bloomlibrary.org/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png"

# Range request through the proxy: expect HTTP 206
curl -sD - -o /dev/null -H "Range: bytes=0-1023" "https://staging-api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"

# Azure fall-through via ORIGIN_HOST: expect a 404 that includes a
# "Request-Context: appId=..." header (that header comes from Azure)
curl -sD - -o /dev/null "https://staging-api.bloomlibrary.org/v1/subscriptionInfo/not-a-real-code"
```

### Stage 2 — production worker (after staging is confirmed)

> ⚠️ `worker.js` in this folder lists **every** migrated function in
> `SUPABASE_FUNCTIONS`, which is right for staging but would cut all production
> traffic over at once. For the production worker, edit that list down to just
> `"fs"` before deploying; we will then ask for one-line extensions as each
> function passes staging verification (each is an instant rollback if needed).

1. **Create the worker**: same steps as Stage 1, same script, named `bloom-api-router`.
2. **Variable**: `SUPABASE_FUNCTIONS_HOST` = `sekpsuviwfhzzznzrdgx.supabase.co`
   (the production Supabase project; same host the current production redirect rule points at).
   **Do NOT set `ORIGIN_HOST` on production** — non-migrated paths must fall through to the
   zone's existing origin config for `api.bloomlibrary.org`, unchanged.
3. **Route**: add `api.bloomlibrary.org/v1/*` on zone `bloomlibrary.org`.
4. **Disable or delete the Redirect Rule named `supabase edge functions`** (same reason as
   Stage 1 step 4). **Do not touch** the DNS record pointing `api.bloomlibrary.org` at
   `bloom-functions.azurewebsites.net` — the worker relies on it as the fall-through origin.

**Production verification:**

```bash
# fs now proxies: expect HTTP 200 PNG, and NO 302 / no supabase.co in any header
curl -sD - -o /dev/null "https://api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/thumbnails/thumbnail-256.png"

# Range requests still work: expect HTTP 206
curl -sD - -o /dev/null -H "Range: bytes=0-1023" "https://api.bloomlibrary.org/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"

# Azure passthrough unchanged: expect a 404 with a "Request-Context: appId=..." header
curl -sD - -o /dev/null "https://api.bloomlibrary.org/v1/subscriptionInfo/not-a-real-code"

# social now proxies to Supabase (migrated in this repo): expect HTTP 200 with HTML
curl -sD - -o /dev/null "https://api.bloomlibrary.org/v1/social?link=https://bloomlibrary.org/test&title=t"
```

Also load https://bloomlibrary.org and confirm book thumbnails render (they come through
`/v1/fs/`).

## Rollback

- **Production**: remove the route `api.bloomlibrary.org/v1/*` from `bloom-api-router` (or
  delete the worker) and re-enable the `supabase edge functions` Redirect Rule. All traffic
  then behaves exactly as before this change.
- **Staging**: remove the route and re-enable the `supabase edge functions - staging` rule.
  No live traffic either way.

## Ongoing changes: adding a function

Each migration phase is a one-line change to the `SUPABASE_FUNCTIONS` list in
`worker.js` plus a redeploy — staging worker first, production after we verify. Phase 1 will
also add the route `social.bloomlibrary.org/v1/*` (that hostname currently routes to Azure). If
it's possible to give the dev team deploy rights scoped to just these two workers (or a CI API
token with `Workers Scripts: Edit` on this zone), that would remove the need to involve you for
each phase.
