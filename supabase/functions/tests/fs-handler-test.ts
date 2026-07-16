import { assert, assertEquals } from "@std/assert";

import { handleFsRequest } from "../fs/handler.ts";
import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";

// ---------------------------------------------------------------------------
// Test helpers: stub the Parse lookup and global fetch (the S3 request) so no
// network is touched. Every test restores the originals.
// ---------------------------------------------------------------------------

const mockBook = (baseUrl: string): Book =>
  ({
    objectId: "validBookId",
    baseUrl,
    title: "Test Book",
    bookInstanceId: "",
    uploader: {
      objectId: "testUserId",
      email: "",
      username: "",
      sessionToken: "",
    },
    tags: [],
    brandingProjectName: "",
    updateSource: "test",
    uploadPendingTimestamp: 0,
    inCirculation: true,
    ACL: {},
    harvestState: "Done",
  }) as Book;

const kDefaultBaseUrl =
  "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/";

// Runs `fn` with getBookByDatabaseId returning a book for "validBookId" (and
// undefined otherwise) and with global fetch replaced by `s3Response`.
// Captures what the handler sent to "S3" for assertions.
async function withStubs(
  s3Response: (() => Response) | null,
  fn: (captured: { url?: string; init?: RequestInit }) => Promise<void>,
  baseUrl: string = kDefaultBaseUrl
) {
  const originalGetBook = BloomParseServer.prototype.getBookByDatabaseId;
  const originalFetch = globalThis.fetch;
  const captured: { url?: string; init?: RequestInit } = {};

  BloomParseServer.prototype.getBookByDatabaseId = (
    objectId: string
  ): Promise<Book | undefined> =>
    Promise.resolve(objectId === "validBookId" ? mockBook(baseUrl) : undefined);

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    captured.url = input.toString();
    captured.init = init;
    if (!s3Response) {
      throw new Error("Test made an unexpected network request: " + input);
    }
    return Promise.resolve(s3Response());
  }) as typeof fetch;

  try {
    await fn(captured);
  } finally {
    BloomParseServer.prototype.getBookByDatabaseId = originalGetBook;
    globalThis.fetch = originalFetch;
  }
}

const request = (path: string, init?: RequestInit) =>
  new Request(`http://localhost:54321${path}`, init);

// ---------------------------------------------------------------------------
// URL parsing / validation
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - 400 when 'fs' segment is missing",
  fn: async () => {
    await withStubs(null, async () => {
      const response = await handleFsRequest(request("/v1/other/a/b/c"));
      assertEquals(response.status, 400);
    });
  },
});

Deno.test({
  name: "fs handler - 400 when fewer than 3 segments follow 'fs'",
  fn: async () => {
    await withStubs(null, async () => {
      const response = await handleFsRequest(
        request("/v1/fs/upload/validBookId")
      );
      assertEquals(response.status, 400);
    });
  },
});

Deno.test({
  name: "fs handler - 400 for unknown bucket",
  fn: async () => {
    await withStubs(null, async () => {
      const response = await handleFsRequest(
        request("/v1/fs/bogus-bucket/validBookId/test.pdf")
      );
      assertEquals(response.status, 400);
    });
  },
});

Deno.test({
  name: "fs handler - 404 for a book that does not exist",
  fn: async () => {
    await withStubs(null, async () => {
      const response = await handleFsRequest(
        request("/v1/fs/upload/noSuchBookId/test.pdf")
      );
      assertEquals(
        response.status,
        404,
        "A missing book is 'not found', not a malformed request"
      );
    });
  },
});

Deno.test({
  name: "fs handler - 400 (not 500) for malformed percent-encoding",
  fn: async () => {
    await withStubs(null, async () => {
      // A lone "%" makes decodeURIComponent throw URIError; the handler must
      // report a client error rather than crashing to a 500.
      const response = await handleFsRequest(
        request("/v1/fs/upload/validBookId/100%.pdf")
      );
      assertEquals(response.status, 400);
    });
  },
});

Deno.test({
  name: "fs handler - 405 for non-GET/HEAD methods",
  fn: async () => {
    await withStubs(null, async () => {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf", { method })
        );
        assertEquals(response.status, 405, `${method} should be rejected`);
        assert(
          (response.headers.get("allow") ?? "").includes("GET"),
          "405 response should carry an Allow header"
        );
      }
    });
  },
});

// ---------------------------------------------------------------------------
// Proxying behavior
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - proxies a 200 from S3 with its body and headers",
  fn: async () => {
    await withStubs(
      () =>
        new Response("file-bytes", {
          status: 200,
          headers: { "content-type": "application/pdf", etag: '"abc"' },
        }),
      async (captured) => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf")
        );
        assertEquals(response.status, 200);
        assertEquals(await response.text(), "file-bytes");
        assertEquals(response.headers.get("content-type"), "application/pdf");
        assertEquals(response.headers.get("etag"), '"abc"');
        assert(
          captured.url!.includes("test.pdf"),
          "should have requested the file from S3"
        );
      }
    );
  },
});

Deno.test({
  name: "fs handler - passes 304 Not Modified through (not 404)",
  fn: async () => {
    await withStubs(
      () => new Response(null, { status: 304, headers: { etag: '"abc"' } }),
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf", {
            headers: { "if-none-match": '"abc"' },
          })
        );
        assertEquals(
          response.status,
          304,
          "Conditional-request revalidation must surface 304, not 404"
        );
      }
    );
  },
});

Deno.test({
  name: "fs handler - maps S3 failure statuses to 404",
  fn: async () => {
    for (const s3Status of [403, 404]) {
      await withStubs(
        () => new Response("denied", { status: s3Status }),
        async () => {
          const response = await handleFsRequest(
            request("/v1/fs/upload/validBookId/test.pdf")
          );
          assertEquals(response.status, 404);
        }
      );
    }
  },
});

Deno.test({
  name: "fs handler - forwards whitelisted headers to S3 and drops others",
  fn: async () => {
    await withStubs(
      () => new Response("ok", { status: 200 }),
      async (captured) => {
        await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf", {
            headers: {
              range: "bytes=0-99",
              "if-none-match": '"abc"',
              authorization: "Bearer secret",
              "x-amz-date": "20260710T000000Z",
            },
          })
        );
        const sent = new Headers(captured.init?.headers);
        assertEquals(sent.get("range"), "bytes=0-99");
        assertEquals(sent.get("if-none-match"), '"abc"');
        assertEquals(sent.get("authorization"), null);
        assertEquals(sent.get("x-amz-date"), null);
      }
    );
  },
});

Deno.test({
  name: "fs handler - forwards HEAD to S3 as HEAD",
  fn: async () => {
    await withStubs(
      () => new Response(null, { status: 200 }),
      async (captured) => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf", { method: "HEAD" })
        );
        assertEquals(response.status, 200);
        assertEquals(captured.init?.method, "HEAD");
      }
    );
  },
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - answers OPTIONS preflight with CORS headers",
  fn: async () => {
    await withStubs(null, async () => {
      const response = await handleFsRequest(
        request("/v1/fs/upload/validBookId/test.pdf", {
          method: "OPTIONS",
          headers: { origin: "https://bloomlibrary.org" },
        })
      );
      assertEquals(response.status, 204);
      assertEquals(
        response.headers.get("access-control-allow-origin"),
        "https://bloomlibrary.org"
      );
      assertEquals(
        response.headers.get("access-control-allow-methods"),
        "GET, HEAD, OPTIONS"
      );
    });
  },
});

Deno.test({
  name: "fs handler - echoes allowed origins on success responses",
  fn: async () => {
    await withStubs(
      () => new Response("ok", { status: 200 }),
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf", {
            headers: { origin: "https://embed.bloomlibrary.org" },
          })
        );
        assertEquals(
          response.headers.get("access-control-allow-origin"),
          "https://embed.bloomlibrary.org",
          "https subdomains of bloomlibrary.org are allowed"
        );
        assert(
          (response.headers.get("vary") ?? "").includes("Origin"),
          "response must vary on Origin for caches"
        );
      }
    );
  },
});

Deno.test({
  name: "fs handler - no Allow-Origin header for disallowed origins",
  fn: async () => {
    for (const origin of [
      "https://evil.com",
      "https://notbloomlibrary.org",
      "http://bloomlibrary.org", // https only
    ]) {
      await withStubs(
        () => new Response("ok", { status: 200 }),
        async () => {
          const response = await handleFsRequest(
            request("/v1/fs/upload/validBookId/test.pdf", {
              headers: { origin },
            })
          );
          assertEquals(
            response.headers.get("access-control-allow-origin"),
            null,
            `${origin} must not be allowed`
          );
        }
      );
    }
  },
});

Deno.test({
  name: "fs handler - error responses carry CORS headers too",
  fn: async () => {
    await withStubs(null, async () => {
      // 404 (book not found) and 405 both need CORS headers, or the browser
      // hides the real status from the calling page.
      const notFound = await handleFsRequest(
        request("/v1/fs/upload/noSuchBookId/test.pdf", {
          headers: { origin: "https://bloomlibrary.org" },
        })
      );
      assertEquals(notFound.status, 404);
      assertEquals(
        notFound.headers.get("access-control-allow-origin"),
        "https://bloomlibrary.org"
      );

      const badMethod = await handleFsRequest(
        request("/v1/fs/upload/validBookId/test.pdf", {
          method: "POST",
          headers: { origin: "https://bloomlibrary.org" },
        })
      );
      assertEquals(badMethod.status, 405);
      assertEquals(
        badMethod.headers.get("access-control-allow-origin"),
        "https://bloomlibrary.org"
      );
    });
  },
});

Deno.test({
  name: "fs handler - Parse lookup failure returns 500 with CORS headers",
  fn: async () => {
    const original = BloomParseServer.prototype.getBookByDatabaseId;
    BloomParseServer.prototype.getBookByDatabaseId = () =>
      Promise.reject(new Error("parse server unreachable"));
    try {
      const response = await handleFsRequest(
        request("/v1/fs/upload/validBookId/test.pdf", {
          headers: { origin: "https://bloomlibrary.org" },
        })
      );
      assertEquals(response.status, 500);
      assertEquals(
        response.headers.get("access-control-allow-origin"),
        "https://bloomlibrary.org",
        "even unexpected failures must carry CORS headers"
      );
    } finally {
      BloomParseServer.prototype.getBookByDatabaseId = original;
    }
  },
});

// ---------------------------------------------------------------------------
// S3 header hygiene
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - strips x-amz-* headers from S3 responses",
  fn: async () => {
    await withStubs(
      () =>
        new Response("ok", {
          status: 200,
          headers: {
            etag: '"abc"',
            "x-amz-request-id": "REQUESTID123",
            "x-amz-id-2": "OPAQUEID456",
          },
        }),
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf")
        );
        assertEquals(response.headers.get("etag"), '"abc"');
        assertEquals(response.headers.get("x-amz-request-id"), null);
        assertEquals(response.headers.get("x-amz-id-2"), null);
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Harvest thumbnail caching rule
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - harvest thumbnails get a valid one-year Cache-Control",
  fn: async () => {
    await withStubs(
      () =>
        new Response("png-bytes", {
          status: 200,
          headers: { "cache-control": "no-cache" },
        }),
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/harvest/validBookId/thumbnails/thumbnail-256.png")
        );
        assertEquals(response.status, 200);
        // "max-age=31536000" is HTTP syntax; "max-age:31536000" (a former bug)
        // is an invalid directive that browsers ignore.
        assertEquals(
          response.headers.get("cache-control"),
          "max-age=31536000"
        );
      }
    );
  },
});

Deno.test({
  name: "fs handler - dev-harvest thumbnails get the same caching rule",
  fn: async () => {
    await withStubs(
      () =>
        new Response("png-bytes", {
          status: 200,
          headers: { "cache-control": "no-cache" },
        }),
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/dev-harvest/validBookId/thumbnails/thumbnail-256.png")
        );
        assertEquals(
          response.headers.get("cache-control"),
          "max-age=31536000"
        );
      },
      // dev-harvest resolves against the sandbox bucket
      "https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/user@example.com/book-guid/Book+Title/"
    );
  },
});

Deno.test({
  name: "fs handler - non-thumbnail harvest files keep S3's Cache-Control",
  fn: async () => {
    await withStubs(
      () =>
        new Response("bytes", {
          status: 200,
          headers: { "cache-control": "no-cache" },
        }),
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/harvest/validBookId/book.bloomd")
        );
        assertEquals(response.headers.get("cache-control"), "no-cache");
      }
    );
  },
});
