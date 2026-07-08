import { assert, assertEquals } from "@std/assert";
import { bookCleanupInternal } from "../bookCleanup/bookCleanup.ts";
import { Environment } from "../_shared/utils.ts";

// Run cleanup in SAFE MODE against a stubbed Parse server. Safe mode makes no
// S3 or Parse mutations, so the only stubs needed are login and the book query.
Deno.test("bookCleanup - safe mode logs intended actions without mutating", async () => {
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/login")) {
      return Promise.resolve(
        new Response(JSON.stringify({ sessionToken: "cleanup-session" }), {
          status: 200,
        })
      );
    }
    if (url.includes("/classes/books")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              // never-completed book: no baseUrl -> record would be deleted
              { objectId: "newbook123", uploadPendingTimestamp: 111 },
              // existing book with a pending upload -> timestamp would be cleared
              {
                objectId: "existing456",
                uploadPendingTimestamp: 222,
                baseUrl:
                  "https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/existing456/333/title/",
              },
            ],
          }),
          { status: 200 }
        )
      );
    }
    return Promise.reject(new Error("Unexpected fetch in safe mode: " + url));
  };

  const log: string[] = [];
  try {
    await bookCleanupInternal(Environment.DEVELOPMENT, true, (m) =>
      log.push(m)
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(log, [
    "Safe Mode. Would have deleted files with prefix newbook123/111 from S3.",
    "Safe Mode. Would have deleted book record with ID newbook123.",
    "Safe Mode. Would have deleted files with prefix existing456/222 from S3.",
    "Safe Mode. Would have updated book record with ID existing456 to remove uploadPendingTimestamp.",
  ]);

  // no mutations: only the login POST and the book query hit the network
  assert(
    requests.every(
      (r) => r.includes("/login") || r.includes("/classes/books")
    ),
    `unexpected requests: ${requests.join("; ")}`
  );
});

Deno.test("bookCleanup - queries with a cutoff about one day ago", async () => {
  let capturedWhere = "";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/login")) {
      return new Response(JSON.stringify({ sessionToken: "s" }), {
        status: 200,
      });
    }
    if (url.includes("/classes/books")) {
      capturedWhere = JSON.parse(init?.body as string).where;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    throw new Error("Unexpected fetch: " + url);
  };

  try {
    await bookCleanupInternal(Environment.DEVELOPMENT, true, () => {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const match = /"uploadPendingTimestamp":\{"\$lt":(\d+)\}/.exec(
    capturedWhere
  );
  assert(match, `where clause not as expected: ${capturedWhere}`);
  const cutoff = parseInt(match![1]);
  const expected = Date.now() - 24 * 60 * 60 * 1000;
  assert(Math.abs(cutoff - expected) < 60 * 1000); // within a minute
});
