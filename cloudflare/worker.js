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
 * README.md). Files whose version fs reports are cached here (see handleFs).
 */

// Function names that have been migrated to Supabase.
// NOTE: this is the URL path segment, which is not always the repo folder name
// (e.g. the "subscriptions" function is reached at /v1/subscriptionInfo).
const SUPABASE_FUNCTIONS = new Set([
  "fs",
  "social",
  "subscriptionInfo",
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

// ---------------------------------------------------------------------------
// Caching fs files
//
// fs tells us the version of the file it found (X-Bloom-File-Version): the
// time (epoch ms) the book's files in that bucket last changed, sent only once
// they are final (see fileVersion in supabase/functions/fs/BookData.ts). We
// cache the file from S3 under that version for a year, for every client: a
// new version is a new cache entry, so nobody gets stale bytes. fs itself is
// still asked on every request, so a new upload or harvest, or a deleted book,
// takes effect at once.
//
// Clients may also put the version in the URL, so that browsers can keep the
// file too (Cache-Control: immutable):
//   /v1/fs/{bucket}/{bookId}/{path}?v={epochMs}   single files
//   /v1/fs/{bucket}/{bookId}@{epochMs}/{path}     read-online, so the relative
//                                                 links inside the book keep it
// ("@" never occurs in a Parse id.) We strip it before asking fs. It only
// counts when it matches fs's version; it never decides what is cached.
//
// A download button adds download=1 (also stripped): the response is then
// saved, under the file's real name (see downloadDisposition), rather than
// whatever S3's headers would make the browser do.
// ---------------------------------------------------------------------------

const VERSION_DIGITS = "\\d{1,16}";
const VERSION_PATTERN = new RegExp(`^${VERSION_DIGITS}$`);
// The book id segment of the path form; the "@" may arrive percent-encoded.
const VERSIONED_BOOK_SEGMENT = new RegExp(`^(.+?)(?:@|%40)(${VERSION_DIGITS})$`, "i");
const ONE_YEAR_SECONDS = 31536000;

// Splits our own parameters out of an fs request. `fsPath` is the part of the
// public path after /v1/fs (/{bucket}/{bookId}/{path...}) and `search` the
// request's query string. Returns the version (null when unversioned),
// whether the client asked for a download (download=1), and the path and
// query to send the fs function, without those. A path-form version wins over
// a v= in the query. An "@" or v= that isn't a valid version is left in
// place, so fs answers that request as it always has.
function parseFsRequest(fsPath, search) {
  const segments = fsPath.split("/");
  // segments: ["", bucket, bookId, ...path]
  const pathMatch =
    segments.length > 3 ? VERSIONED_BOOK_SEGMENT.exec(segments[2]) : null;
  const params = new URLSearchParams(search);
  const queryVersion = params.get("v") ?? "";
  const download = params.get("download") === "1";

  let version = null;
  if (pathMatch) {
    version = pathMatch[2];
    segments[2] = pathMatch[1];
  } else if (VERSION_PATTERN.test(queryVersion)) {
    version = queryVersion;
  }
  if (version === null && !download) {
    return { version, download, fnPath: fsPath, fnSearch: search };
  }
  if (version !== null) {
    params.delete("v");
  }
  if (download) {
    params.delete("download");
  }
  const rest = params.toString();
  return {
    version,
    download,
    fnPath: segments.join("/"),
    fnSearch: rest ? `?${rest}` : "",
  };
}

// How Cloudflare caches an S3 file whose version fs reported: everything,
// whatever its type, for a year, but only successes. A 404 (say, a file
// requested before it was uploaded) must not stick.
const VERSIONED_S3_CACHE = {
  cacheEverything: true,
  cacheTtlByStatus: { "200-299": ONE_YEAR_SECONDS, "300-599": -1 },
};

// Content-Disposition naming a download after the file's real name, so titles
// containing "+" or "%" keep them. The name comes from the S3 URL the fs
// function resolved, whose last segment is the URL-encoded name of the S3
// object; the public URL's encoding is fs's business.
function downloadDisposition(location) {
  let name;
  try {
    name = decodeURIComponent(new URL(location).pathname.split("/").pop());
  } catch {
    return null;
  }
  if (!name) {
    return null;
  }
  // filename= for old clients (printable ASCII, no quotes or backslashes);
  // filename* (RFC 5987/6266) carries the exact UTF-8 name.
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Special caching rule for harvest thumbnails
// see https://docs.google.com/document/d/1Vub0SeQL6BQqyGoQBN6-cfi6AIRbcBHeV87KjnzZXDU/edit
// `fnPath` is /{bucket}/{bookid}/{path...}. The function has already rejected
// malformed percent-encoding, so decoding here can't throw.
function isHarvestThumbnail(fnPath) {
  const [bucket, , firstPathSegment] = fnPath
    .split("/")
    .filter((segment) => segment !== "")
    .map(decodeURIComponent);
  return (
    ["harvest", "dev-harvest"].includes(bucket?.toLowerCase()) &&
    firstPathSegment?.toLowerCase() === "thumbnails"
  );
}

// The Cache-Control for a file response, or null to keep S3's.
// - The URL names the version of the file it gets: browsers may keep it.
// - Harvest thumbnails: a year, as always.
// - Otherwise, a file that came through Cloudflare's cache may carry a
//   Cache-Control Cloudflare made up (the zone's browser TTL), not S3's.
//   The URL doesn't name a version, so browsers must check back: a new
//   upload has to show.
function cacheControlFor(fs, fileVersion) {
  if (fileVersion !== null && fs.version === fileVersion) {
    return `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
  }
  if (isHarvestThumbnail(fs.fnPath)) {
    return `max-age=${ONE_YEAR_SECONDS}`;
  }
  return fileVersion !== null ? "no-cache" : null;
}

// fs: ask the function where the file is, then fetch it from S3 ourselves.
// `url` is the Supabase URL for the request, with any version already
// removed; `fs` is what parseFsRequest made of the public URL.
async function handleFs(url, request, supabaseRequestHeaders, fs) {
  // redirect: "manual" so we get the function's 302 rather than fetch
  // following it with all the client's headers.
  const fnResponse = await proxy(url, request, supabaseRequestHeaders, {
    redirect: "manual",
  });
  if (![301, 302, 303, 307, 308].includes(fnResponse.status)) {
    // OPTIONS preflights, 400/401/404/405/500 and our own 502: already final.
    return fnResponse;
  }
  const location = fnResponse.headers.get("location");
  const cors = corsHeadersFrom(fnResponse);
  if (!location || !isAllowedS3Url(location)) {
    console.error(`fs redirected somewhere unexpected: ${location}`);
    return textResponse("Bad Gateway", 502, cors);
  }
  // The version fs reported, or null if it reported none (or nonsense).
  const reported = fnResponse.headers.get("x-bloom-file-version") ?? "";
  const fileVersion = VERSION_PATTERN.test(reported) ? reported : null;
  const cacheable = fileVersion !== null;

  const forwardHeaders = new Headers();
  for (const name of S3_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      forwardHeaders.set(name, value);
    }
  }

  // ?v= goes on the S3 URL: S3 ignores it, but it is part of Cloudflare's
  // cache key, so each version of a file gets its own cache entry. (A custom
  // cf.cacheKey would need an Enterprise plan.)
  const s3Url = new URL(location);
  if (cacheable) {
    s3Url.searchParams.set("v", fileVersion);
  }

  let s3Response;
  try {
    s3Response = await fetch(s3Url.toString(), {
      // Preserve GET vs HEAD (the function only redirects those two).
      method: request.method,
      headers: forwardHeaders,
      redirect: "manual",
      cf: cacheable ? VERSIONED_S3_CACHE : undefined,
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

  const cacheControl = cacheControlFor(fs, fileVersion);
  if (cacheControl) {
    headers.set("Cache-Control", cacheControl);
  }
  if (cacheable) {
    // The age of the cached copy, which can approach a year; it would only
    // shorten how long a browser may keep an immutable file.
    headers.delete("Age");
  }
  const disposition = fs.download && downloadDisposition(location);
  if (disposition) {
    headers.set("Content-Disposition", disposition);
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
      // For fs, <rest> and <query> lose any version first: the function
      // doesn't know about versions and would take "id@version" for the id.
      const rest = match[2] ?? "";
      const fs = match[1] === "fs" ? parseFsRequest(rest, url.search) : null;
      url.hostname = env.SUPABASE_FUNCTIONS_HOST;
      url.pathname = `/functions/v1/${match[1]}${fs ? fs.fnPath : rest}`;
      const headers = supabaseHeaders(publicUrl, env);
      if (fs) {
        url.search = fs.fnSearch;
        return handleFs(url, request, headers, fs);
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
