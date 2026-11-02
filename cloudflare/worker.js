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
 *   - bloom-api-router-staging on staging-api.bloomlibrary.org/v1/* → staging Supabase
 *   - bloom-api-router         on api.bloomlibrary.org/v1/*     → production Supabase
 *
 * Proxying (rather than the 302 "forwarding" page rule it replaces) is required
 * because redirects break CORS preflights, convert POSTs to GETs, and drop auth
 * headers on cross-origin hops — see MIGRATION-PLAN.md §2a.
 *
 * To migrate a function: add its name to SUPABASE_FUNCTIONS and redeploy.
 * To roll back a function: remove its name and redeploy.
 *
 * fs is special: the function only looks up the book and answers with a 302 to
 * the file on S3; this worker follows that redirect itself and streams the file
 * to the client (see handleFs). Edge Function response bytes count as Supabase
 * egress, which proxying files through the function exhausted; Cloudflare
 * carries them without egress fees. fs only answers requests carrying the
 * BLOOM_WORKER_SECRET this worker adds (see supabaseHeaders). The function
 * and this worker must therefore be deployed together (worker first; see
 * README.md).
 */

// Function names that have been migrated to Supabase.
// NOTE: this is the URL path segment, which is not always the repo folder name
// (e.g. the "subscriptions" function is reached at /v1/subscriptionInfo).
const SUPABASE_FUNCTIONS = new Set([
  "fs",
  "social",
  "subscriptionInfo",
  "opds",
]);

// Fetch `url`, carrying over the incoming request's method, headers, and
// (streaming) body; `init` can override parts of the request. `headers` sets
// extra request headers; a null value removes that header instead.
async function proxy(url, request, headers, init) {
  try {
    const proxied = new Request(url, init ? new Request(request, init) : request);
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (value === null) {
        proxied.headers.delete(name);
      } else {
        proxied.headers.set(name, value);
      }
    }
    return await fetch(proxied);
  } catch (err) {
    return new Response(`Error proxying to ${url.hostname}: ${err.message}`, {
      status: 502,
      headers: { "content-type": "text/plain" },
    });
  }
}

// The only place fs may send us: path-style URLs into the four S3 buckets the
// fs function maps its bucket names to (see BookData.ts kBuckets and
// BloomParseServer.getS3LinkBase). Anything else is refused, so a bad
// redirect can't turn this worker into an open proxy.
const S3_HOST = "s3.amazonaws.com";
const S3_BUCKETS = new Set([
  "BloomLibraryBooks",
  "BloomLibraryBooks-Sandbox",
  "bloomharvest",
  "bloomharvest-sandbox",
]);

function isAllowedS3Url(location) {
  let url;
  try {
    url = new URL(location);
  } catch {
    return false;
  }
  const [, bucket, ...key] = url.pathname.split("/");
  return (
    url.protocol === "https:" &&
    url.hostname === S3_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    S3_BUCKETS.has(bucket) &&
    // An object, never the bucket itself, and no query string (S3 uses
    // those for bucket-level operations).
    key.join("/") !== "" &&
    url.search === ""
  );
}

// Request headers we pass on to S3.
//
// SECURITY: We use a whitelist approach rather than blindly forwarding all headers because:
// 1. **Prevent Header Injection**: Malicious clients could send headers that affect S3 behavior
//    in unintended ways (e.g., x-amz-* headers for S3-specific operations)
// 2. **Avoid Auth Leakage**: Authorization/authentication headers from the client should NOT
//    be forwarded to S3 (S3 uses its own auth via signed URLs)
// 3. **Prevent SSRF Attacks**: Headers like Host, X-Forwarded-For could be exploited
// 4. **Minimize Attack Surface**: Only forward headers necessary for legitimate functionality
//
// If you need to add more headers, consider:
// - Is it a standard HTTP header (RFC 7231-7235)?
// - Does S3 support it for CloudFront/direct access?
// - Could it be exploited for security issues?
// - Common additions might include: accept, accept-language (for content negotiation)
const S3_FORWARD_HEADERS = [
  "range", // For partial content/streaming (RFC 7233)
  "if-none-match", // For ETag-based conditional requests (RFC 7232)
  "if-modified-since", // For time-based conditional requests (RFC 7232)
  "if-match", // For ETag-based preconditions (RFC 7232)
  "if-unmodified-since", // For time-based preconditions (RFC 7232)
  "accept-encoding", // For content encoding negotiation (RFC 7231)
];

// The CORS headers the fs function put on its redirect. The function (via
// getCorsHeaders in supabase/functions/_shared/utils.ts) stays the one place
// that decides which origins are allowed; we just carry its answer over.
function corsHeadersFrom(response) {
  const cors = {};
  response.headers.forEach((value, key) => {
    if (key.startsWith("access-control-") || key === "vary") {
      cors[key] = value;
    }
  });
  return cors;
}

function textResponse(body, status, cors) {
  return new Response(body, {
    status,
    headers: { ...cors, "content-type": "text/plain" },
  });
}

// Headers for every request we proxy to Supabase.
// - X-Bloom-Public-Url: the public URL the client used, so a function can
//   reconstruct it in links it generates (e.g. og:url). A custom header is
//   used rather than X-Forwarded-Host because Supabase's edge strips
//   proxy-managed forwarding headers before the function sees them.
// - X-Bloom-Worker-Secret: proves the request came through this worker. fs
//   refuses requests without it, so calling the Supabase URL directly can't
//   reveal S3 addresses (which can contain uploader emails). It comes from the
//   BLOOM_WORKER_SECRET worker secret; any value the client sent is replaced,
//   or removed if the secret isn't configured. Never forwarded to S3.
function supabaseHeaders(publicUrl, env) {
  return {
    "X-Bloom-Public-Url": publicUrl,
    "X-Bloom-Worker-Secret": env.BLOOM_WORKER_SECRET || null,
  };
}

// fs: ask the function where the file is, then fetch it from S3 ourselves.
// `fsPath` is the part of the public path after /v1/fs.
async function handleFs(url, request, supabaseRequestHeaders, fsPath) {
  // redirect: "manual" so we get the function's 302 rather than fetch
  // following it with all the client's headers.
  const fnResponse = await proxy(url, request, supabaseRequestHeaders, {
    redirect: "manual",
  });
  if (![301, 302, 303, 307, 308].includes(fnResponse.status)) {
    // OPTIONS preflights, 400/401/404/405/500 and our own 502: already final.
    return fnResponse;
  }

  const cors = corsHeadersFrom(fnResponse);
  const location = fnResponse.headers.get("location");
  if (!location || !isAllowedS3Url(location)) {
    console.error(`fs redirected somewhere unexpected: ${location}`);
    return textResponse("Bad Gateway", 502, cors);
  }

  const forwardHeaders = new Headers();
  for (const name of S3_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      forwardHeaders.set(name, value);
    }
  }

  let s3Response;
  try {
    // Preserve GET vs HEAD (the function only redirects those two).
    s3Response = await fetch(location, {
      method: request.method,
      headers: forwardHeaders,
      redirect: "manual",
    });
  } catch (err) {
    console.error(`Error fetching from S3: ${err.message}`);
    return textResponse("Bad Gateway", 502, cors);
  }

  // 304 Not Modified is a *success* for the conditional requests whose
  // headers we forward above; it must reach the client, not become a 404.
  if (!s3Response.ok && s3Response.status !== 304) {
    return textResponse("File not found", 404, cors);
  }

  // Copy headers from S3 response, except S3 internals (request ids etc.)
  // that would leak infrastructure details the URL format exists to hide.
  const headers = new Headers();
  s3Response.headers.forEach((value, key) => {
    if (!key.startsWith("x-amz-")) {
      headers.set(key, value);
    }
  });

  // Special caching rule for harvest thumbnails
  // see https://docs.google.com/document/d/1Vub0SeQL6BQqyGoQBN6-cfi6AIRbcBHeV87KjnzZXDU/edit
  // fsPath is /{bucket}/{bookid}/{path...}; the function has already
  // rejected malformed percent-encoding, so decoding here can't throw.
  const [bucket, , firstPathSegment] = fsPath
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent);
  if (
    ["harvest", "dev-harvest"].includes(bucket?.toLowerCase()) &&
    firstPathSegment?.toLowerCase() === "thumbnails"
  ) {
    headers.set("Cache-Control", "max-age=31536000");
  }

  // Vary is appended rather than set so an existing Vary from S3 (e.g.
  // Accept-Encoding) is preserved.
  for (const [key, value] of Object.entries(cors)) {
    if (key === "vary") {
      headers.append(key, value);
    } else {
      headers.set(key, value);
    }
  }

  return new Response(s3Response.body, {
    status: s3Response.status,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    url.protocol = "https:";
    url.port = "";
    // The public URL the client used (normalized to https), captured before we
    // rewrite the host/path to the Supabase target below.
    const publicUrl = url.toString();

    const match = url.pathname.match(/^\/v1\/([^/]+)(\/.*)?$/);

    if (match && SUPABASE_FUNCTIONS.has(match[1])) {
      // Migrated: rewrite https://<host>/v1/<fn>/<rest>?<query>
      //     to https://<project>.supabase.co/functions/v1/<fn>/<rest>?<query>
      url.hostname = env.SUPABASE_FUNCTIONS_HOST;
      url.pathname = `/functions/v1/${match[1]}${match[2] ?? ""}`;
      const headers = supabaseHeaders(publicUrl, env);
      if (match[1] === "fs") {
        return handleFs(url, request, headers, match[2] ?? "");
      }
      return proxy(url, request, headers);
    }

    // Not migrated: send to the Azure Functions app.
    if (env.ORIGIN_HOST) {
      url.hostname = env.ORIGIN_HOST;
      return proxy(url, request);
    }
    // No ORIGIN_HOST configured (production): fall through to the zone's
    // existing origin for this hostname, exactly as if the worker weren't here.
    try {
      return await fetch(request);
    } catch (err) {
      return new Response(`Error fetching from origin: ${err.message}`, {
        status: 502,
        headers: { "content-type": "text/plain" },
      });
    }
  },
};
