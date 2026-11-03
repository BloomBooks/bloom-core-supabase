import BookData, { ContentUrlParams, isValidBucket } from "./BookData.ts";
import { getCorsHeaders, secretsMatch } from "../_shared/utils.ts";

// Resolves a request for a file in a book to its S3 URL without the caller
// knowing [it is on s3, who the uploader is, etc], and answers with a 302 to
// that URL. Normally the caller is the routing worker, which follows the
// redirect itself; see the comment at the end of handleFsRequest.
// Example use: https://api.bloomlibrary.org/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png
//
// Exported separately from index.ts (which just wires this to Deno.serve) so
// tests can exercise it with plain Request objects.
export async function handleFsRequest(req: Request): Promise<Response> {
  // CORS: pages on bloomlibrary.org fetch book content cross-origin (this
  // function is served from api.bloomlibrary.org), so every response -
  // including errors - must carry CORS headers, and we must answer preflights
  // ourselves. The Azure Functions host used to do this globally.
  const corsHeaders = {
    ...getCorsHeaders(req),
    // fs serves file content only; the shared default advertises POST/DELETE.
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const respond = (body: string | null, init: ResponseInit): Response =>
    new Response(body, {
      ...init,
      headers: {
        ...corsHeaders,
        ...((init.headers as Record<string, string>) ?? {}),
      },
    });

  // Only the routing worker may use fs: our 302s reveal S3 addresses, which
  // can contain uploader emails, and the worker is what keeps them from
  // clients. It proves itself with the BLOOM_WORKER_SECRET it shares with us
  // (see cloudflare/worker.js). If the secret isn't configured, nobody gets in.
  // OPTIONS is answered above without it: a preflight reveals nothing.
  if (
    !(await secretsMatch(
      req.headers.get("x-bloom-worker-secret"),
      Deno.env.get("BLOOM_WORKER_SECRET")
    ))
  ) {
    return respond("Unauthorized", {
      status: 401,
      statusText: "Unauthorized",
    });
  }

  // We only serve file content; anything else is likely a client mistake and
  // must not silently proxy to S3 as a read.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return respond("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  }

  // Parse the URL to extract path parameters
  // Expected URL format: /fs/{bucket}/{bookid}/{path segments...}
  const url = new URL(req.url);
  const pathSegments = url.pathname
    .split("/")
    .filter((segment) => segment !== "");

  // Find the "fs" segment (could be at index 0 or after "v1")
  const fsIndex = pathSegments.findIndex((segment) => segment === "fs");
  if (fsIndex === -1) {
    return respond("Bad Request: Invalid URL format - missing 'fs' path", {
      status: 400,
      statusText: "Bad Request",
    });
  }

  // Extract parameters from path segments after "fs"
  const segments = pathSegments.slice(fsIndex + 1);

  if (segments.length < 3) {
    return respond(
      "Bad Request: Missing required path parameters (bucket, bookid, and at least one path segment)",
      {
        status: 400,
        statusText: "Bad Request",
      }
    );
  }

  // decodeURIComponent throws URIError on malformed percent-encoding (e.g. a
  // lone "%"); that is a client error, not a server crash. getContentUrl can
  // hit the same thing when it re-encodes path segments.
  let params: ContentUrlParams;
  let urlArtifact: string | null;
  try {
    params = {
      bucket: decodeURIComponent(segments[0]),
      bookid: decodeURIComponent(segments[1]),
      pathSegments: segments.slice(2).map((seg) => decodeURIComponent(seg)),
    };

    if (!isValidBucket(params.bucket)) {
      return respond("Bad Request: unknown bucket", {
        status: 400,
        statusText: "Bad Request",
      });
    }

    urlArtifact = await BookData.getContentUrl(params);
  } catch (error) {
    if (error instanceof URIError) {
      return respond("Bad Request: malformed percent-encoding in URL", {
        status: 400,
        statusText: "Bad Request",
      });
    }
    // e.g. the Parse server is unreachable. Answer through respond() so even
    // this failure carries CORS headers; a bare rethrow would surface to a
    // cross-origin caller as an opaque CORS error instead of a 500.
    console.error("Error in fs function:", error);
    return respond("Internal Server Error", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }

  if (!urlArtifact) {
    // The bucket was valid, so the book id didn't resolve to a book with content.
    return respond("Not Found", {
      status: 404,
      statusText: "Not Found",
    });
  }

  // Redirect to S3 rather than proxying the file. Edge Function response
  // bytes count as uncached Supabase egress, and proxying every thumbnail,
  // .bloompub, PDF and audio file blew through our egress quota. The routing
  // worker (cloudflare/worker.js) follows this redirect server-side, fetches
  // the file from S3 itself and streams it to the client on
  // api.bloomlibrary.org, so Cloudflare (no egress fees) carries the bytes and
  // clients never see S3. The worker also does the response shaping (header
  // whitelist, 304/404 mapping, x-amz-* stripping, thumbnail caching) that
  // used to live here. It copies our CORS headers from this response, so
  // getCorsHeaders stays the single source of truth for them.
  //
  // The start of urlArtifact is the book's raw baseUrl from Parse, which can
  // hold unencoded non-ASCII (e.g. a title). fetch() used to percent-encode
  // that for us; a header value can't carry it, so let the URL parser apply
  // the same encoding fetch did. Existing %xx escapes and "+" are kept.
  let location: string;
  try {
    location = new URL(urlArtifact).href;
  } catch (error) {
    console.error("Error in fs function: bad S3 URL", urlArtifact, error);
    return respond("Internal Server Error", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }
  return respond(null, {
    status: 302,
    headers: { Location: location },
  });
}
