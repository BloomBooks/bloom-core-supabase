import BookData, { ContentUrlParams, isValidBucket } from "./BookData.ts";
import { getCorsHeaders } from "../_shared/utils.ts";

// Handles a request for a file in a book on S3 without the caller knowing
// [it is on s3, who the uploader is, etc].
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

  try {
    // Forward relevant headers from the original request to S3.
    //
    // SECURITY: We use a whitelist approach rather than blindly forwarding all headers because:
    // 1. **Prevent Header Injection**: Malicious clients could send headers that affect S3 behavior
    //    in unintended ways (e.g., x-amz-* headers for S3-specific operations)
    // 2. **Avoid Auth Leakage**: Authorization/authentication headers from the client should NOT
    //    be forwarded to S3 (S3 uses its own auth via signed URLs)
    // 3. **Prevent SSRF Attacks**: Headers like Host, X-Forwarded-For could be exploited
    // 4. **Minimize Attack Surface**: Only forward headers necessary for legitimate functionality
    //
    // COMPLETENESS: This whitelist includes standard HTTP headers for:
    // - Content negotiation: accept-encoding
    // - Conditional requests: if-none-match, if-modified-since, if-match, if-unmodified-since
    // - Range requests: range
    //
    // If you need to add more headers, consider:
    // - Is it a standard HTTP header (RFC 7231-7235)?
    // - Does S3 support it for CloudFront/direct access?
    // - Could it be exploited for security issues?
    // - Common additions might include: accept, accept-language (for content negotiation)
    const forwardHeaders = new Headers();
    const headersToForward = [
      "range",              // For partial content/streaming (RFC 7233)
      "if-none-match",      // For ETag-based conditional requests (RFC 7232)
      "if-modified-since",  // For time-based conditional requests (RFC 7232)
      "if-match",           // For ETag-based preconditions (RFC 7232)
      "if-unmodified-since", // For time-based preconditions (RFC 7232)
      "accept-encoding",    // For content encoding negotiation (RFC 7231)
    ];

    // Note: Headers.get() handles case-insensitivity.
    headersToForward.forEach((headerName) => {
      const value = req.headers.get(headerName);
      if (value) {
        forwardHeaders.set(headerName, value);
      }
    });

    // Proxy the request to S3 with forwarded headers, preserving GET vs HEAD.
    const response = await fetch(urlArtifact, {
      method: req.method,
      headers: forwardHeaders,
    });

    // 304 Not Modified is a *success* for the conditional requests whose
    // headers we forward above; it must reach the client, not become a 404.
    if (!response.ok && response.status !== 304) {
      return respond("File not found", { status: 404 });
    }

    // Return content as a blob with headers from S3
    const headers = new Headers();

    // Copy headers from S3 response, except S3 internals (request ids etc.)
    // that would leak infrastructure details the URL format exists to hide.
    response.headers.forEach((value, key) => {
      if (key.toLowerCase().startsWith("x-amz-")) {
        return;
      }
      headers.set(key, value);
    });

    // Special caching rule for harvest thumbnails
    // see https://docs.google.com/document/d/1Vub0SeQL6BQqyGoQBN6-cfi6AIRbcBHeV87KjnzZXDU/edit
    const bucket = params.bucket.toLowerCase();
    if (
      (bucket === "harvest" || bucket === "dev-harvest") &&
      params.pathSegments.length > 0 &&
      params.pathSegments[0].toLowerCase() === "thumbnails"
    ) {
      headers.delete("cache-control"); //we don't know which casing s3 uses, so remove the other one
      headers.set("Cache-Control", "max-age=31536000");
    }

    // CORS headers go on the success path too. Vary is appended rather than
    // set so an existing Vary from S3 (e.g. Accept-Encoding) is preserved.
    Object.entries(corsHeaders).forEach(([key, value]) => {
      if (key.toLowerCase() === "vary" && headers.has("vary")) {
        headers.append(key, value);
      } else {
        headers.set(key, value);
      }
    });

    return new Response(response.body, {
      status: response.status,
      headers: headers,
    });
  } catch (error) {
    console.error("Error in fs function:", error);
    return respond("Internal Server Error", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }
}
