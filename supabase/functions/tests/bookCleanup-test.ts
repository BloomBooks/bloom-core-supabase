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

// --- Live end-to-end test against the unit-test Parse server and the      ---
// --- BloomLibraryBooks-UnitTests bucket (ported from the Azure            ---
// --- bookCleanup.test.ts). Skipped unless the required env vars are       ---
// --- present.                                                             ---

import BloomParseServer from "../_shared/BloomParseServer.ts";
import {
  deleteFilesByPrefix,
  listPrefixContentsKeys,
  uploadTestFileToS3,
} from "../_shared/s3.ts";
import { testRequiringSecrets } from "./testSecrets.ts";

const kLiveCleanupSecrets = [
  "BLOOM_PARSE_APP_ID_UNIT_TEST",
  "BLOOM_PARSE_BOOK_CLEANUP_PASSWORD_UNIT_TEST",
  "BLOOM_UPLOAD_PERMISSION_MANAGER_S3_ACCESS_KEY_ID_UNIT_TEST",
  "BLOOM_UPLOAD_PERMISSION_MANAGER_S3_SECRET_ACCESS_KEY_UNIT_TEST",
];

testRequiringSecrets({
  name: "bookCleanup - live: cleans up old failed uploads, leaves recent and completed ones",
  secrets: kLiveCleanupSecrets,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const env = Environment.UNITTEST;
    const testBookInstanceId = "supabaseFunctionBookCleanupTests";
    const oldTimestamp = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
    const recentTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    const parseServer = new BloomParseServer(env);
    const sessionToken = await parseServer.loginAsUser(
      "unittest@example.com",
      "unittest"
    );

    const makeBookEntry = (
      title: string,
      uploadPendingTimestamp: number,
      baseUrl?: string
    ) => ({
      title,
      bookInstanceId: testBookInstanceId,
      updateSource: "SupabaseFunctionsUnitTest",
      uploadPendingTimestamp,
      inCirculation: false,
      uploader: {
        __type: "Pointer",
        className: "_User",
        objectId: "testUserId",
      },
      ...(baseUrl ? { baseUrl } : {}),
    });

    const cleanupParse = async () => {
      const remaining = (
        await parseServer.getBooks(
          `{"bookInstanceId":{"$eq":"${testBookInstanceId}"}}`
        )
      ).books;
      for (const book of remaining) {
        await parseServer.deleteBookRecord(book.objectId, sessionToken);
      }
    };

    const bookIds: string[] = [];
    try {
      await cleanupParse();

      // A: old failed upload of a new book -> record and files deleted
      // B: recent incomplete upload of a new book -> untouched
      // C: old failed re-upload of an existing book -> timestamp cleared,
      //    pending files deleted, original files kept
      const entries = [
        makeBookEntry("unit test book A", oldTimestamp),
        makeBookEntry("unit test book B", recentTimestamp),
        makeBookEntry(
          "unit test book C",
          oldTimestamp,
          "https://s3.amazonaws.com/BloomLibraryBooks/testBookId/someTimestamp/"
        ),
      ];
      for (const entry of entries) {
        const bookId = await parseServer.createBookRecord(entry, sessionToken);
        assert(bookId);
        bookIds.push(bookId);
        await uploadTestFileToS3(
          `${bookId}/${entry.uploadPendingTimestamp}`,
          env
        );
      }
      const [idA, idB, idC] = bookIds;
      // book C imitates a preexisting book getting modified; upload an "old"
      // book file to make sure it doesn't get deleted
      await uploadTestFileToS3(`${idC}/someOtherTimestamp`, env);

      await bookCleanupInternal(env, false, () => {});

      // A: gone entirely
      assertEquals(await parseServer.getBookByDatabaseId(idA), undefined);
      assertEquals((await listPrefixContentsKeys(idA, env)).length, 0);

      // B: untouched
      const bookB = await parseServer.getBookByDatabaseId(idB);
      assert(bookB);
      assert(bookB!.uploadPendingTimestamp);
      assert((await listPrefixContentsKeys(idB, env)).length > 0);

      // C: record kept without the timestamp; pending files gone; originals kept
      const bookC = await parseServer.getBookByDatabaseId(idC);
      assert(bookC);
      assert(!bookC!.uploadPendingTimestamp);
      assertEquals(
        (await listPrefixContentsKeys(`${idC}/${oldTimestamp}`, env)).length,
        0
      );
      assert(
        (await listPrefixContentsKeys(`${idC}/someOtherTimestamp`, env)).length >
          0
      );
    } finally {
      await cleanupParse();
      for (const bookId of bookIds) {
        await deleteFilesByPrefix(bookId, Environment.UNITTEST);
      }
    }
  },
});
