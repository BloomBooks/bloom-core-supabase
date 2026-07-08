/**
 * Cloudflare Worker: routes bloomlibrary.org API traffic between Supabase and Azure.
 *
 * Bloom Library is migrating its API function-by-function from Azure Functions to
 * Supabase Edge Functions (see ../MIGRATION-PLAN.md). This worker is the routing
 * layer for that migration:
 *
 *   - Requests whose function name (the first path segment after /v1/) is listed in
 *     SUPABASE_FUNCTIONS are PROXIED — not redirected — to the Supabase project,
 *     rewriting /v1/<fn>/... to /functions/v1/<fn>/...
 *   - Everything else goes to the Azure Functions app: to the host named by the
 *     ORIGIN_HOST variable if set (staging), otherwise straight through to the
 *     zone's configured origin for the request hostname (production).
 *
 * The same script is deployed twice (see wrangler.toml):
 *   - bloom-api-router-staging on dev-api.bloomlibrary.org/v1/* → staging Supabase
 *   - bloom-api-router         on api.bloomlibrary.org/v1/*     → production Supabase
 *
 * Proxying (rather than the 302 "forwarding" page rule it replaces) is required
 * because redirects break CORS preflights, convert POSTs to GETs, and drop auth
 * headers on cross-origin hops — see MIGRATION-PLAN.md §2a.
 *
 * To migrate a function: add its name to SUPABASE_FUNCTIONS and redeploy.
 * To roll back a function: remove its name and redeploy.
 */

// Function names that have been migrated to Supabase.
// NOTE: this is the URL path segment, which is not always the repo folder name
// (e.g. the "subscriptions" function is reached at /v1/subscriptionInfo).
const SUPABASE_FUNCTIONS = new Set([
  "fs",
]);

// Fetch `url`, carrying over the incoming request's method, headers, and
// (streaming) body.
async function proxy(url, request) {
  try {
    return await fetch(new Request(url, request));
  } catch (err) {
    return new Response(`Error proxying to ${url.hostname}: ${err.message}`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.port = "";

    const match = url.pathname.match(/^\/v1\/([^/]+)(\/.*)?$/);

    if (match && SUPABASE_FUNCTIONS.has(match[1])) {
      // Migrated: rewrite https://<host>/v1/<fn>/<rest>?<query>
      //     to https://<project>.supabase.co/functions/v1/<fn>/<rest>?<query>
      url.hostname = env.SUPABASE_FUNCTIONS_HOST;
      url.pathname = `/functions/v1/${match[1]}${match[2] ?? ""}`;
      return proxy(url, request);
    }

    // Not migrated: send to the Azure Functions app.
    if (env.ORIGIN_HOST) {
      url.hostname = env.ORIGIN_HOST;
      return proxy(url, request);
    }
    // No ORIGIN_HOST configured (production): fall through to the zone's
    // existing origin for this hostname, exactly as if the worker weren't here.
    return fetch(request);
  },
};
