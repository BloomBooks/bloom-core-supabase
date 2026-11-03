import { assert, assertEquals } from "@std/assert";

import { handleFsRequest } from "../fs/handler.ts";
import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";

// ---------------------------------------------------------------------------
// Test helpers: stub the Parse lookup, and replace global fetch with one that
// fails the test, since the handler must redirect to S3, never fetch from it
// (that is what costs Supabase egress). Every test restores the originals.
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
// undefined otherwise).
async function withStubs(
  fn: () => Promise<void>,
  baseUrl: string = kDefaultBaseUrl
) {
  const originalGetBook = BloomParseServer.prototype.getBookByDatabaseId;
  const originalFetch = globalThis.fetch;

  BloomParseServer.prototype.getBookByDatabaseId = (
    objectId: string
  ): Promise<Book | undefined> =>
    Promise.resolve(objectId === "validBookId" ? mockBook(baseUrl) : undefined);

  globalThis.fetch = ((input: string | URL | Request) => {
    throw new Error("Test made an unexpected network request: " + input);
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    BloomParseServer.prototype.getBookByDatabaseId = originalGetBook;
    globalThis.fetch = originalFetch;
  }
}

// fs only answers the routing worker, which proves itself with this secret
// (see the "worker secret" tests below). Requests carry it unless a test says
// otherwise.
const kWorkerSecret = "test-worker-secret";
Deno.env.set("BLOOM_WORKER_SECRET", kWorkerSecret);

const request = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  if (!headers.has("x-bloom-worker-secret")) {
    headers.set("x-bloom-worker-secret", kWorkerSecret);
  }
  return new Request(`http://localhost:54321${path}`, { ...init, headers });
};

// A request as a direct caller of the Supabase URL would send it: no secret.
const directRequest = (path: string, init?: RequestInit) =>
  new Request(`http://localhost:54321${path}`, init);

// ---------------------------------------------------------------------------
// URL parsing / validation
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - 400 when 'fs' segment is missing",
  fn: async () => {
    await withStubs(async () => {
      const response = await handleFsRequest(request("/v1/other/a/b/c"));
      assertEquals(response.status, 400);
    });
  },
});

Deno.test({
  name: "fs handler - 400 when fewer than 3 segments follow 'fs'",
  fn: async () => {
    await withStubs(async () => {
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
    await withStubs(async () => {
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
    await withStubs(async () => {
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
    await withStubs(async () => {
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
    await withStubs(async () => {
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
// Redirect to S3 (the routing worker follows it; see cloudflare/worker.js)
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - 302s to the file's S3 URL with no body",
  fn: async () => {
    await withStubs(async () => {
      const response = await handleFsRequest(
        request("/v1/fs/upload/validBookId/test.pdf")
      );
      assertEquals(response.status, 302);
      assertEquals(
        response.headers.get("location"),
        "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/test.pdf"
      );
      assertEquals(response.body, null);
    });
  },
});

Deno.test({
  name: "fs handler - 302s HEAD requests too",
  fn: async () => {
    await withStubs(async () => {
      const response = await handleFsRequest(
        request("/v1/fs/upload/validBookId/test.pdf", { method: "HEAD" })
      );
      assertEquals(response.status, 302);
      assert(response.headers.get("location")!.endsWith("/test.pdf"));
    });
  },
});

Deno.test({
  name: "fs handler - percent-encodes non-ASCII from the Parse baseUrl in Location",
  fn: async () => {
    await withStubs(
      async () => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf")
        );
        assertEquals(response.status, 302);
        // Raw Thai would make the Location header throw; "+" stays as is.
        assertEquals(
          response.headers.get("location"),
          "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/%E0%B8%AB%E0%B8%99%E0%B8%B1%E0%B8%87+Book/test.pdf"
        );
      },
      "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/หนัง+Book/"
    );
  },
});

Deno.test({
  name: "fs handler - redirects harvest paths into the harvest bucket",
  fn: async () => {
    await withStubs(async () => {
      const response = await handleFsRequest(
        request("/v1/fs/harvest/validBookId/thumbnails/thumbnail-256.png")
      );
      assertEquals(response.status, 302);
      assertEquals(
        response.headers.get("location"),
        "https://s3.amazonaws.com/bloomharvest/user@example.com/book-guid/thumbnails/thumbnail-256.png"
      );
    });
  },
});

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - answers OPTIONS preflight with CORS headers",
  fn: async () => {
    await withStubs(async () => {
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
  name: "fs handler - echoes allowed origins on redirect responses",
  fn: async () => {
    await withStubs(
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
    await withStubs(async () => {
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
// Worker secret: only the routing worker may get redirects (they reveal S3
// addresses, which can contain uploader emails)
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - 401 without the worker secret, with CORS headers",
  fn: async () => {
    await withStubs(async () => {
      const response = await handleFsRequest(
        directRequest("/v1/fs/upload/validBookId/test.pdf", {
          headers: { origin: "https://bloomlibrary.org" },
        })
      );
      assertEquals(response.status, 401);
      assertEquals(response.headers.get("location"), null);
      assertEquals(
        response.headers.get("access-control-allow-origin"),
        "https://bloomlibrary.org"
      );
    });
  },
});

Deno.test({
  name: "fs handler - 401 with a wrong worker secret",
  fn: async () => {
    await withStubs(async () => {
      for (const secret of ["wrong", kWorkerSecret + "x", ""]) {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf", {
            headers: { "x-bloom-worker-secret": secret },
          })
        );
        assertEquals(response.status, 401, `secret "${secret}"`);
      }
    });
  },
});

Deno.test({
  name: "fs handler - refuses everyone when the secret isn't configured",
  fn: async () => {
    Deno.env.delete("BLOOM_WORKER_SECRET");
    try {
      await withStubs(async () => {
        const response = await handleFsRequest(
          request("/v1/fs/upload/validBookId/test.pdf")
        );
        assertEquals(response.status, 401);
      });
    } finally {
      Deno.env.set("BLOOM_WORKER_SECRET", kWorkerSecret);
    }
  },
});

Deno.test({
  name: "fs handler - answers OPTIONS preflights without the worker secret",
  fn: async () => {
    await withStubs(async () => {
      const response = await handleFsRequest(
        directRequest("/v1/fs/upload/validBookId/test.pdf", {
          method: "OPTIONS",
          headers: { origin: "https://bloomlibrary.org" },
        })
      );
      assertEquals(response.status, 204);
    });
  },
});

// ---------------------------------------------------------------------------
// Path traversal: a double-encoded ".." must not redirect outside the book
// ---------------------------------------------------------------------------

Deno.test({
  name: "fs handler - 404, not a redirect, for double-encoded .. segments",
  fn: async () => {
    await withStubs(async () => {
      for (const path of [
        "/v1/fs/upload/validBookId/%252e%252e/%252e%252e/", // the top of the bucket
        "/v1/fs/upload/validBookId/x/%252e%252e/%252e%252e/%252e%252e/other/file.pdf",
      ]) {
        const response = await handleFsRequest(request(path));
        assertEquals(response.status, 404, path);
        assertEquals(response.headers.get("location"), null, path);
      }
    });
  },
});
