import { assert, assertEquals } from "@std/assert";

// The routing worker is plain JS with no dependencies, so Deno can run it
// directly; these tests cover the fs path, where the worker follows the fs
// function's redirect to S3 and shapes the file response itself.
// @ts-ignore: untyped JS module
import worker from "../../../cloudflare/worker.js";

const kSupabaseHost = "project.supabase.co";
const kWorkerSecret = "test-worker-secret";
const env: Record<string, string> = {
  SUPABASE_FUNCTIONS_HOST: kSupabaseHost,
  BLOOM_WORKER_SECRET: kWorkerSecret,
};
const kS3Url =
  "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/test.pdf";

interface Captured {
  fnRequest?: Request;
  s3Url?: string;
  s3Init?: RequestInit;
}

// What the fs function answers: by default a 302 to kS3Url carrying the CORS
// headers getCorsHeaders would give an allowed origin.
const redirectTo = (location: string, extraHeaders?: Record<string, string>) =>
  () =>
    new Response(null, {
      status: 302,
      headers: {
        Location: location,
        "Access-Control-Allow-Origin": "https://bloomlibrary.org",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        Vary: "Origin",
        ...extraHeaders,
      },
    });

// Runs `fn` with global fetch replaced: requests to the Supabase host get
// `fnResponse`, anything else gets `s3Response` (or fails the test if null).
async function withFetch(
  fnResponse: () => Response,
  s3Response: (() => Response) | null,
  fn: (captured: Captured) => Promise<void>
) {
  const originalFetch = globalThis.fetch;
  const captured: Captured = {};
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (input instanceof Request && new URL(input.url).hostname === kSupabaseHost) {
      captured.fnRequest = input;
      return Promise.resolve(fnResponse());
    }
    captured.s3Url = input.toString();
    captured.s3Init = init;
    if (!s3Response) {
      throw new Error("Test made an unexpected request to " + input);
    }
    return Promise.resolve(s3Response());
  }) as typeof fetch;
  try {
    await fn(captured);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const get = (
  path: string,
  init?: RequestInit,
  workerEnv: Record<string, string> = env
): Promise<Response> =>
  worker.fetch(
    new Request(`https://api.bloomlibrary.org${path}`, init),
    workerEnv
  );

// ---------------------------------------------------------------------------
// Following the redirect
// ---------------------------------------------------------------------------

Deno.test({
  name: "worker fs - asks the function without following its redirect",
  fn: async () => {
    await withFetch(redirectTo(kS3Url), () => new Response("ok"), async (c) => {
      await get("/v1/fs/upload/validBookId/test.pdf");
      assertEquals(
        c.fnRequest!.url,
        `https://${kSupabaseHost}/functions/v1/fs/upload/validBookId/test.pdf`
      );
      assertEquals(c.fnRequest!.redirect, "manual");
    });
  },
});

Deno.test({
  name: "worker fs - streams the S3 file to the client with its headers",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
      () =>
        new Response("file-bytes", {
          status: 200,
          headers: { "content-type": "application/pdf", etag: '"abc"' },
        }),
      async (c) => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf");
        assertEquals(response.status, 200);
        assertEquals(await response.text(), "file-bytes");
        assertEquals(response.headers.get("content-type"), "application/pdf");
        assertEquals(response.headers.get("etag"), '"abc"');
        assertEquals(response.headers.get("location"), null);
        assertEquals(c.s3Url, kS3Url);
      }
    );
  },
});

Deno.test({
  name: "worker fs - passes 206 partial content through",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
      () =>
        new Response("part", {
          status: 206,
          headers: { "content-range": "bytes 0-3/100" },
        }),
      async () => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf", {
          headers: { range: "bytes=0-3" },
        });
        assertEquals(response.status, 206);
        assertEquals(response.headers.get("content-range"), "bytes 0-3/100");
      }
    );
  },
});

Deno.test({
  name: "worker fs - passes 304 Not Modified through (not 404)",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
      () => new Response(null, { status: 304, headers: { etag: '"abc"' } }),
      async () => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf", {
          headers: { "if-none-match": '"abc"' },
        });
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
  name: "worker fs - maps S3 failure statuses to 404 with CORS headers",
  fn: async () => {
    for (const s3Status of [403, 404, 500]) {
      await withFetch(
        redirectTo(kS3Url),
        () => new Response("denied", { status: s3Status }),
        async () => {
          const response = await get("/v1/fs/upload/validBookId/test.pdf");
          assertEquals(response.status, 404);
          assertEquals(
            response.headers.get("access-control-allow-origin"),
            "https://bloomlibrary.org"
          );
        }
      );
    }
  },
});

Deno.test({
  name: "worker fs - forwards whitelisted headers to S3 and drops others",
  fn: async () => {
    await withFetch(redirectTo(kS3Url), () => new Response("ok"), async (c) => {
      await get("/v1/fs/upload/validBookId/test.pdf", {
        headers: {
          range: "bytes=0-99",
          "if-none-match": '"abc"',
          "if-modified-since": "Wed, 01 Jul 2026 00:00:00 GMT",
          authorization: "Bearer secret",
          cookie: "session=1",
          "x-amz-date": "20260710T000000Z",
        },
      });
      const sent = new Headers(c.s3Init?.headers);
      assertEquals(sent.get("range"), "bytes=0-99");
      assertEquals(sent.get("if-none-match"), '"abc"');
      assertEquals(sent.get("if-modified-since"), "Wed, 01 Jul 2026 00:00:00 GMT");
      assertEquals(sent.get("authorization"), null);
      assertEquals(sent.get("cookie"), null);
      assertEquals(sent.get("x-amz-date"), null);
    });
  },
});

Deno.test({
  name: "worker fs - forwards HEAD to S3 as HEAD",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
      () => new Response(null, { status: 200 }),
      async (c) => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf", {
          method: "HEAD",
        });
        assertEquals(response.status, 200);
        assertEquals(c.s3Init?.method, "HEAD");
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Function responses that are not redirects
// ---------------------------------------------------------------------------

Deno.test({
  name: "worker fs - passes the function's non-redirect responses through",
  fn: async () => {
    for (const status of [204, 400, 404, 405, 500]) {
      await withFetch(
        () =>
          new Response(status === 204 ? null : "msg", {
            status,
            headers: { "Access-Control-Allow-Origin": "https://bloomlibrary.org" },
          }),
        null, // must not touch S3
        async () => {
          const response = await get("/v1/fs/upload/validBookId/test.pdf", {
            method: status === 204 ? "OPTIONS" : "GET",
          });
          assertEquals(response.status, status);
          assertEquals(
            response.headers.get("access-control-allow-origin"),
            "https://bloomlibrary.org"
          );
        }
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Security: only follow redirects into our S3 buckets
// ---------------------------------------------------------------------------

Deno.test({
  name: "worker fs - refuses redirects outside our S3 buckets (no open proxy)",
  fn: async () => {
    for (const location of [
      "https://evil.example.com/BloomLibraryBooks/x.pdf",
      "http://s3.amazonaws.com/BloomLibraryBooks/x.pdf", // not https
      "https://s3.amazonaws.com.evil.com/BloomLibraryBooks/x.pdf",
      "https://s3.amazonaws.com:8443/BloomLibraryBooks/x.pdf",
      "https://user@s3.amazonaws.com/BloomLibraryBooks/x.pdf",
      "https://s3.amazonaws.com/someone-elses-bucket/x.pdf",
      "https://s3.amazonaws.com/bloomlibrarybooks/x.pdf", // bucket names are case-sensitive
      "https://s3.amazonaws.com/bloomharvest/", // the bucket itself, not an object
      "https://s3.amazonaws.com/bloomharvest", // bucket root without the slash
      "https://s3.amazonaws.com/bloomharvest/?list-type=2", // bucket operation
      "https://s3.amazonaws.com/bloomharvest/x.pdf?acl", // query string on an object
      "/relative/path",
      "not a url",
    ]) {
      await withFetch(redirectTo(location), null, async () => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf");
        assertEquals(response.status, 502, `${location} must be refused`);
        assertEquals(
          response.headers.get("access-control-allow-origin"),
          "https://bloomlibrary.org",
          "errors still carry CORS headers"
        );
      });
    }
  },
});

Deno.test({
  name: "worker fs - follows redirects into each of our four buckets",
  fn: async () => {
    for (const bucket of [
      "BloomLibraryBooks",
      "BloomLibraryBooks-Sandbox",
      "bloomharvest",
      "bloomharvest-sandbox",
    ]) {
      const location = `https://s3.amazonaws.com/${bucket}/user@example.com/book-guid/x.pdf`;
      await withFetch(redirectTo(location), () => new Response("ok"), async (c) => {
        const response = await get("/v1/fs/upload/validBookId/x.pdf");
        assertEquals(response.status, 200);
        assertEquals(c.s3Url, location);
      });
    }
  },
});

Deno.test({
  name: "worker fs - S3 network failure returns 502 with CORS headers",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
      () => {
        throw new Error("connection reset");
      },
      async () => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf");
        assertEquals(response.status, 502);
        assertEquals(
          response.headers.get("access-control-allow-origin"),
          "https://bloomlibrary.org"
        );
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Response header shaping
// ---------------------------------------------------------------------------

Deno.test({
  name: "worker fs - strips x-amz-* headers from S3 responses",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
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
        const response = await get("/v1/fs/upload/validBookId/test.pdf");
        assertEquals(response.headers.get("etag"), '"abc"');
        assertEquals(response.headers.get("x-amz-request-id"), null);
        assertEquals(response.headers.get("x-amz-id-2"), null);
      }
    );
  },
});

Deno.test({
  name: "worker fs - copies the function's CORS headers and appends Vary",
  fn: async () => {
    await withFetch(
      redirectTo(kS3Url),
      () =>
        new Response("ok", {
          status: 200,
          headers: { vary: "Accept-Encoding" },
        }),
      async () => {
        const response = await get("/v1/fs/upload/validBookId/test.pdf", {
          headers: { origin: "https://bloomlibrary.org" },
        });
        assertEquals(
          response.headers.get("access-control-allow-origin"),
          "https://bloomlibrary.org"
        );
        assertEquals(
          response.headers.get("access-control-allow-methods"),
          "GET, HEAD, OPTIONS"
        );
        const vary = response.headers.get("vary") ?? "";
        assert(vary.includes("Accept-Encoding"), "S3's Vary is preserved");
        assert(vary.includes("Origin"), "response must vary on Origin");
      }
    );
  },
});

Deno.test({
  name: "worker fs - harvest and dev-harvest thumbnails get a one-year Cache-Control",
  fn: async () => {
    for (const bucket of ["harvest", "dev-harvest", "Harvest"]) {
      await withFetch(
        redirectTo(kS3Url),
        () =>
          new Response("png-bytes", {
            status: 200,
            headers: { "cache-control": "no-cache" },
          }),
        async () => {
          const response = await get(
            `/v1/fs/${bucket}/validBookId/thumbnails/thumbnail-256.png`
          );
          // "max-age=31536000" is HTTP syntax; "max-age:31536000" (a former bug)
          // is an invalid directive that browsers ignore.
          assertEquals(
            response.headers.get("cache-control"),
            "max-age=31536000",
            bucket
          );
        }
      );
    }
  },
});

Deno.test({
  name: "worker fs - other files keep S3's Cache-Control",
  fn: async () => {
    for (const path of [
      "/v1/fs/harvest/validBookId/book.bloomd",
      "/v1/fs/upload/validBookId/thumbnails/thumbnail-256.png",
    ]) {
      await withFetch(
        redirectTo(kS3Url),
        () =>
          new Response("bytes", {
            status: 200,
            headers: { "cache-control": "no-cache" },
          }),
        async () => {
          const response = await get(path);
          assertEquals(response.headers.get("cache-control"), "no-cache", path);
        }
      );
    }
  },
});

// ---------------------------------------------------------------------------
// Other functions are unaffected
// ---------------------------------------------------------------------------

Deno.test({
  name: "worker - non-fs Supabase functions are proxied as before",
  fn: async () => {
    await withFetch(
      () => new Response("<html>", { status: 200 }),
      null,
      async (c) => {
        const response = await get("/v1/social?link=x");
        assertEquals(response.status, 200);
        assertEquals(await response.text(), "<html>");
        assertEquals(
          c.fnRequest!.url,
          `https://${kSupabaseHost}/functions/v1/social?link=x`
        );
      }
    );
  },
});

// ---------------------------------------------------------------------------
// Worker secret: the worker proves itself to fs; clients can't supply it and
// it never reaches S3
// ---------------------------------------------------------------------------

Deno.test({
  name: "worker - sends the worker secret to Supabase, replacing the client's",
  fn: async () => {
    await withFetch(redirectTo(kS3Url), () => new Response("ok"), async (c) => {
      await get("/v1/fs/upload/validBookId/test.pdf", {
        headers: { "x-bloom-worker-secret": "client-guess" },
      });
      assertEquals(
        c.fnRequest!.headers.get("x-bloom-worker-secret"),
        kWorkerSecret
      );
    });
  },
});

Deno.test({
  name: "worker - never forwards the worker secret to S3",
  fn: async () => {
    await withFetch(redirectTo(kS3Url), () => new Response("ok"), async (c) => {
      await get("/v1/fs/upload/validBookId/test.pdf");
      const sent = new Headers(c.s3Init?.headers);
      assertEquals(sent.get("x-bloom-worker-secret"), null);
    });
  },
});

Deno.test({
  name: "worker - without a configured secret, drops a client-supplied one",
  fn: async () => {
    await withFetch(
      () => new Response("Unauthorized", { status: 401 }),
      null,
      async (c) => {
        const response = await get(
          "/v1/fs/upload/validBookId/test.pdf",
          { headers: { "x-bloom-worker-secret": "client-guess" } },
          { SUPABASE_FUNCTIONS_HOST: kSupabaseHost }
        );
        assertEquals(response.status, 401, "fs's 401 passes through");
        assertEquals(c.fnRequest!.headers.get("x-bloom-worker-secret"), null);
      }
    );
  },
});
