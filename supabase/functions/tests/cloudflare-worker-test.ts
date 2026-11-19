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

// ---------------------------------------------------------------------------
// Caching: when fs reports the file's version (X-Bloom-File-Version), the S3
// file is cached under it for a year. Clients may put a version in the URL,
// either ?v={epochMs} (downloads) or {bookId}@{epochMs} (read-online); it is
// stripped before asking fs, and only decides Cache-Control: immutable.
// ---------------------------------------------------------------------------

const kVersion = "1757995714210";
const kFnBase = `https://${kSupabaseHost}/functions/v1/fs`;
const kYearCache = {
  cacheEverything: true,
  cacheTtlByStatus: { "200-299": 31536000, "300-599": -1 },
};
const kImmutable = "public, max-age=31536000, immutable";

// fs's answer for a file whose version it knows.
const versionedRedirect = (version = kVersion, location = kS3Url) =>
  redirectTo(location, { "X-Bloom-File-Version": version });

// S3's file, with a Cache-Control the worker keeps only when nothing is cached.
const kS3CacheControl = "max-age=14400";
const okFile = () =>
  new Response("file-bytes", {
    status: 200,
    headers: { "content-type": "application/pdf", "cache-control": kS3CacheControl },
  });

const cfOf = (c: Captured) => (c.s3Init as { cf?: unknown } | undefined)?.cf;

Deno.test({
  name: "worker fs caching - caches the S3 file under fs's version, for old clients too",
  fn: async () => {
    await withFetch(versionedRedirect(), okFile, async (c) => {
      const response = await get("/v1/fs/upload/validBookId/test.pdf");
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "file-bytes");
      assertEquals(c.s3Url, `${kS3Url}?v=${kVersion}`, "the version is in the cache key");
      assertEquals(cfOf(c), kYearCache, "cache successes for a year, never errors");
      // This URL doesn't name a version, so browsers must check back.
      assertEquals(response.headers.get("cache-control"), "no-cache");
      assertEquals(response.headers.get("content-disposition"), null);
      assertEquals(response.headers.get("x-bloom-file-version"), null);
      assertEquals(response.headers.get("location"), null);
    });
  },
});

Deno.test({
  name: "worker fs caching - nothing is cached when fs reports no (valid) version",
  fn: async () => {
    for (const fnResponse of [
      redirectTo(kS3Url),
      versionedRedirect("abc"),
      versionedRedirect(""),
      versionedRedirect("1?x=1"),
      versionedRedirect("12345678901234567"),
    ]) {
      for (const path of [
        "/v1/fs/upload/validBookId/test.pdf",
        `/v1/fs/upload/validBookId/test.pdf?v=${kVersion}`,
      ]) {
        await withFetch(fnResponse, okFile, async (c) => {
          const response = await get(path);
          assertEquals(c.s3Url, kS3Url, path);
          assertEquals(cfOf(c), undefined, path);
          assertEquals(response.headers.get("cache-control"), kS3CacheControl, path);
        });
      }
    }
  },
});

Deno.test({
  name: "worker fs caching - query form: strips v for fs; immutable when it matches",
  fn: async () => {
    await withFetch(versionedRedirect(), okFile, async (c) => {
      const response = await get(`/v1/fs/upload/validBookId/test.pdf?v=${kVersion}`);
      assertEquals(c.fnRequest!.url, `${kFnBase}/upload/validBookId/test.pdf`);
      assertEquals(c.s3Url, `${kS3Url}?v=${kVersion}`);
      assertEquals(response.headers.get("cache-control"), kImmutable);
      // A version alone doesn't make a download.
      assertEquals(response.headers.get("content-disposition"), null);
    });
  },
});

Deno.test({
  name: "worker fs caching - path form: strips @version from the book id",
  fn: async () => {
    for (const bookSegment of [`validBookId@${kVersion}`, `validBookId%40${kVersion}`]) {
      await withFetch(versionedRedirect(), okFile, async (c) => {
        const response = await get(
          `/v1/fs/harvest/${bookSegment}/bloomdigital/audio/a.mp3`
        );
        assertEquals(response.status, 200);
        assertEquals(
          c.fnRequest!.url,
          `${kFnBase}/harvest/validBookId/bloomdigital/audio/a.mp3`,
          bookSegment
        );
        assertEquals(c.s3Url, `${kS3Url}?v=${kVersion}`);
        assertEquals(response.headers.get("cache-control"), kImmutable);
        assertEquals(response.headers.get("content-disposition"), null);
      });
    }
  },
});

Deno.test({
  name: "worker fs caching - a URL version that isn't fs's only loses immutable",
  fn: async () => {
    for (const path of [
      "/v1/fs/upload/validBookId/test.pdf?v=1",
      "/v1/fs/upload/validBookId@1/test.pdf",
      `/v1/fs/upload/validBookId/test.pdf?v=0${kVersion}`,
    ]) {
      await withFetch(versionedRedirect(), okFile, async (c) => {
        const response = await get(path);
        assertEquals(c.s3Url, `${kS3Url}?v=${kVersion}`, `${path}: cached under fs's version`);
        assertEquals(response.headers.get("cache-control"), "no-cache", path);
      });
    }
  },
});

Deno.test({
  name: "worker fs caching - path version wins over v=, other query params are kept",
  fn: async () => {
    await withFetch(versionedRedirect(), okFile, async (c) => {
      const response = await get(
        `/v1/fs/harvest/validBookId@${kVersion}/x/y.htm?v=123&lang=en`
      );
      assertEquals(c.fnRequest!.url, `${kFnBase}/harvest/validBookId/x/y.htm?lang=en`);
      assertEquals(response.headers.get("cache-control"), kImmutable);
    });
  },
});

Deno.test({
  name: "worker fs caching - a URL without a valid version reaches fs unchanged",
  fn: async () => {
    for (const path of [
      "/v1/fs/upload/validBookId/test.pdf",
      "/v1/fs/upload/validBookId/test.pdf?v=abc",
      "/v1/fs/upload/validBookId/test.pdf?download=0",
      "/v1/fs/upload/validBookId/test.pdf?v=",
      "/v1/fs/upload/validBookId/test.pdf?v=12345678901234567",
      "/v1/fs/upload/validBookId@abc/test.pdf",
      "/v1/fs/upload/validBookId@/test.pdf",
      "/v1/fs/upload/@123/test.pdf",
      `/v1/fs/upload/validBookId@${kVersion}`, // no file path
    ]) {
      await withFetch(redirectTo(kS3Url), okFile, async (c) => {
        const response = await get(path);
        assertEquals(
          c.fnRequest!.url,
          `${kFnBase}${path.slice("/v1/fs".length)}`,
          `${path}: fs sees the URL unchanged`
        );
        assertEquals(response.headers.get("cache-control"), kS3CacheControl, path);
        assertEquals(response.headers.get("content-disposition"), null, path);
      });
    }
  },
});

Deno.test({
  name: "worker fs caching - download=1 is stripped for fs, with or without a version",
  fn: async () => {
    for (const [path, fnPath] of [
      ["/v1/fs/upload/validBookId/test.pdf?download=1", "/upload/validBookId/test.pdf"],
      [`/v1/fs/upload/validBookId/test.pdf?v=${kVersion}&download=1`, "/upload/validBookId/test.pdf"],
      ["/v1/fs/upload/validBookId/test.pdf?download=1&lang=en", "/upload/validBookId/test.pdf?lang=en"],
    ]) {
      await withFetch(versionedRedirect(), okFile, async (c) => {
        const response = await get(path);
        assertEquals(c.fnRequest!.url, `${kFnBase}${fnPath}`, path);
        assert(
          response.headers.get("content-disposition")?.startsWith("attachment; "),
          path
        );
      });
    }
    // Any other value is not ours, even beside a version.
    await withFetch(versionedRedirect(), okFile, async (c) => {
      await get(`/v1/fs/upload/validBookId/test.pdf?v=${kVersion}&download=0`);
      assertEquals(c.fnRequest!.url, `${kFnBase}/upload/validBookId/test.pdf?download=0`);
    });
  },
});

Deno.test({
  name: "worker fs caching - downloads are named after the S3 object",
  fn: async () => {
    // The last segment of the S3 URL fs resolved is the URL-encoded object
    // name, however the public URL spelled it.
    const folder = "https://s3.amazonaws.com/BloomLibraryBooks/validBookId/123/Book";
    for (const [s3Name, header] of [
      ["one%20%2B%20one.pdf", `attachment; filename="one + one.pdf"; filename*=UTF-8''one%20%2B%20one.pdf`],
      ["100%25%20sure.bloompub", `attachment; filename="100% sure.bloompub"; filename*=UTF-8''100%25%20sure.bloompub`],
      ["El%20Ni%C3%B1o's%20(1).pdf", `attachment; filename="El Ni_o's (1).pdf"; filename*=UTF-8''El%20Ni%C3%B1o%27s%20%281%29.pdf`],
      ["say%20%22hi%22.pdf", `attachment; filename="say _hi_.pdf"; filename*=UTF-8''say%20%22hi%22.pdf`],
    ]) {
      await withFetch(versionedRedirect(kVersion, `${folder}/${s3Name}`), okFile, async () => {
        const response = await get("/v1/fs/upload/validBookId/whatever.pdf?download=1");
        assertEquals(response.headers.get("content-disposition"), header, s3Name);
      });
    }
  },
});

Deno.test({
  name: "worker fs caching - thumbnails keep their rule unless the URL names the version",
  fn: async () => {
    const path = "/v1/fs/harvest/validBookId/thumbnails/thumbnail-256.png";
    await withFetch(versionedRedirect(), okFile, async (c) => {
      const plain = await get(path);
      assertEquals(plain.headers.get("cache-control"), "max-age=31536000");
      assertEquals(cfOf(c), kYearCache);
      const versioned = await get(`${path}?v=${kVersion}`);
      assertEquals(versioned.headers.get("cache-control"), kImmutable);
    });
  },
});

Deno.test({
  name: "worker fs caching - a cached file's Cache-Control and Age come from us, not Cloudflare",
  fn: async () => {
    // What a cached copy may look like: a browser TTL Cloudflare added, and
    // its age.
    const cachedFile = () =>
      new Response("file-bytes", {
        status: 200,
        headers: { "cache-control": "public, max-age=14400", age: "31000000" },
      });
    await withFetch(versionedRedirect(), cachedFile, async () => {
      const plain = await get("/v1/fs/upload/validBookId/test.pdf");
      assertEquals(plain.headers.get("cache-control"), "no-cache");
      assertEquals(plain.headers.get("age"), null);
      const versioned = await get(`/v1/fs/upload/validBookId/test.pdf?v=${kVersion}`);
      assertEquals(versioned.headers.get("cache-control"), kImmutable);
      assertEquals(versioned.headers.get("age"), null);
    });
    // Not cacheable: S3's headers pass through as before.
    await withFetch(redirectTo(kS3Url), cachedFile, async () => {
      const response = await get("/v1/fs/upload/validBookId/test.pdf");
      assertEquals(response.headers.get("cache-control"), "public, max-age=14400");
      assertEquals(response.headers.get("age"), "31000000");
    });
  },
});
