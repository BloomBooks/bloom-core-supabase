import BookData, { ContentUrlParams } from "./BookData.ts";

// This function allows us to request a file in a book on S3 without knowing [it is on s3, who the uploader is, etc].
// Example use: https://api.bloomlibrary.org/v1/fs/dev-harvest/U4KS7uOBBC/thumbnails/thumbnail-256.png
Deno.serve(async (req: Request) => {
  // Parse the URL to extract path parameters
  // Expected URL format: /fs/{bucket}/{bookid}/{path segments...}
  const url = new URL(req.url);
  const pathSegments = url.pathname
    .split("/")
    .filter((segment) => segment !== "");

  // Find the "fs" segment (could be at index 0 or after "v1")
  const fsIndex = pathSegments.findIndex((segment) => segment === "fs");
  if (fsIndex === -1) {
    return new Response("Bad Request: Invalid URL format - missing 'fs' path", {
      status: 400,
      statusText: "Bad Request",
    });
  }

  // Extract parameters from path segments after "fs"
  const segments = pathSegments.slice(fsIndex + 1);

  if (segments.length < 3) {
    return new Response(
      "Bad Request: Missing required path parameters (bucket, bookid, and at least one path segment)",
      {
        status: 400,
        statusText: "Bad Request",
      }
    );
  }

  const params: ContentUrlParams = {
    bucket: decodeURIComponent(segments[0]),
    bookid: decodeURIComponent(segments[1]),
    pathSegments: segments.slice(2).map((seg) => decodeURIComponent(seg)),
  };

  const urlArtifact = await BookData.getContentUrl(params);
  if (!urlArtifact) {
    return new Response("Bad Request", {
      status: 400,
      statusText: "Bad Request",
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

    // Proxy the request to S3 with forwarded headers
    const response = await fetch(urlArtifact, {
      headers: forwardHeaders,
    });

    if (!response.ok) {
      return new Response("File not found", { status: 404 });
    }

    // Return content as a blob with headers from S3
    const headers = new Headers();

    // Copy headers from S3 response
    response.headers.forEach((value, key) => {
      headers.set(key, value);
    });

    // Special caching rule for harvest thumbnails
    // see https://docs.google.com/document/d/1Vub0SeQL6BQqyGoQBN6-cfi6AIRbcBHeV87KjnzZXDU/edit
    if (
      params.bucket.toLowerCase() === "harvest" &&
      params.pathSegments.length > 0 &&
      params.pathSegments[0].toLowerCase() === "thumbnails"
    ) {
      headers.delete("cache-control"); //we don't know which casing s3 uses, so remove the other one
      headers.set("Cache-Control", "max-age:31536000");
    }

    return new Response(response.body, {
      status: response.status,
      headers: headers,
    });
  } catch (error) {
    console.error("Error in fs function:", error);
    return new Response("Internal Server Error", {
      status: 500,
      statusText: "Internal Server Error",
    });
  }
});
