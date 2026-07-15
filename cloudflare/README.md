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

# Another non-migrated function: expect HTML from Azure, not an error
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
