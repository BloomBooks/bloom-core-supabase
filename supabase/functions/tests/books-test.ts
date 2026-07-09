import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getIdAndAction, canClientUpload } from "../books/utils.ts";
import {
  convertApiQueryParamsIntoParseAdditionalParams,
  convertApiQueryParamsIntoParseWhere,
  reshapeBookRecord,
} from "../books/parseAdapters.ts";
import BloomParseServer from "../_shared/BloomParseServer.ts";
import { kAllBooksFilter } from "../_shared/contentful.ts";
import { Environment } from "../_shared/utils.ts";
import { handleBooksRequest } from "../books/books.ts";

Deno.test("books - getIdAndAction parses id and optional action", () => {
  assertEquals(getIdAndAction("abc123"), ["abc123", null]);
  assertEquals(getIdAndAction("abc123:upload-start"), [
    "abc123",
    "upload-start",
  ]);
  assertEquals(getIdAndAction("new:upload-start"), ["new", "upload-start"]);
  assertEquals(getIdAndAction(undefined), [null, null]);
  assertEquals(getIdAndAction("a:b:c"), [null, null]); // too many colons
});

Deno.test("books - isValidDatabaseId", () => {
  assert(BloomParseServer.isValidDatabaseId("abcDEF1234"));
  assert(!BloomParseServer.isValidDatabaseId("short"));
  assert(!BloomParseServer.isValidDatabaseId("abcDEF123!"));
  assert(!BloomParseServer.isValidDatabaseId("abcDEF12345"));
});

Deno.test("books - where clause built from query params", () => {
  assertEquals(convertApiQueryParamsIntoParseWhere({}), "{}");
  const where = convertApiQueryParamsIntoParseWhere({
    lang: "fr,en",
    uploader: "joe@example.com",
    instanceIds: "guid1,guid2",
  });
  assertStringIncludes(where, '"isoCode":{"$in":["fr","en"]}');
  assertStringIncludes(where, '"email":{"$in":["joe@example.com"]}');
  assertStringIncludes(where, '"bookInstanceId":{"$in":["guid1","guid2"]}');
});

Deno.test("books - additional params default limit, pass offset and count", () => {
  assertEquals(convertApiQueryParamsIntoParseAdditionalParams({}), {
    limit: 10000000,
    skip: undefined,
    count: undefined,
  });
  assertEquals(
    convertApiQueryParamsIntoParseAdditionalParams({
      limit: "5",
      offset: "10",
      count: "true",
    }),
    { limit: 5, skip: 10, count: 1 }
  );
});

Deno.test("books - reshapeBookRecord produces the API shape", () => {
  const book = {
    objectId: "abc123def4",
    bookInstanceId: "guid-1",
    title: "Original Title",
    allTitles: '{"en":"My Book","fr":"Mon Livre"}',
    baseUrl: "https://s3.amazonaws.com/BloomLibraryBooks/x/",
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2021-01-01T00:00:00.000Z",
    lastUploaded: { __type: "Date", iso: "2021-06-01T00:00:00.000Z" },
    tags: ["topic:Animals"],
    updateSource: "test",
    uploadPendingTimestamp: 123,
    langPointers: [
      {
        objectId: "lang1",
        isoCode: "fr",
        name: "français",
        englishName: "French",
        usageCount: 5,
      },
    ],
    uploader: { objectId: "user1", username: "joe@example.com" },
  } as any;

  const unexpanded = reshapeBookRecord(book);
  assertEquals(unexpanded.id, "abc123def4");
  assertEquals(unexpanded.instanceId, "guid-1");
  assertEquals(unexpanded.titleFromUpload, "Original Title");
  assertEquals(unexpanded.titles, [
    { lang: "en", title: "My Book" },
    { lang: "fr", title: "Mon Livre" },
  ]);
  assertEquals(unexpanded.languages, [{ tag: "fr" }]);
  assertEquals(unexpanded.uploader, { email: "joe@example.com" });
  // date objects simplified to ISO strings
  assertEquals(unexpanded.lastUploaded, "2021-06-01T00:00:00.000Z");
  // unit-test-only fields excluded by default
  assertEquals(unexpanded.updateSource, undefined);

  const expanded = reshapeBookRecord(book, "languages,uploader", true);
  assertEquals(expanded.languages[0], {
    id: "lang1",
    tag: "fr",
    name: "français",
    englishName: "French",
    usageCount: 5,
  });
  assertEquals(expanded.uploader, { email: "joe@example.com", id: "user1" });
  assertEquals(expanded.updateSource, "test");
  assertEquals(expanded.uploadPendingTimestamp, 123);
});

Deno.test("books - allTitles with unescaped newlines still parses", () => {
  const book = {
    objectId: "abc123def4",
    bookInstanceId: "guid-1",
    allTitles: '{"en":"My\nBook"}',
    uploader: { objectId: "user1", username: "joe@example.com" },
  } as any;
  const reshaped = reshapeBookRecord(book);
  assertEquals(reshaped.titles, [{ lang: "en", title: "My\nBook" }]);
});

Deno.test("books - bookMatchesAtLeastOneFilter", () => {
  const book = {
    tags: ["bookshelf:SIL-LEAD", "topic:Animals"],
    brandingProjectName: "ABC-Branding",
  } as any;
  assert(
    BloomParseServer.bookMatchesAtLeastOneFilter(book, [
      { tag: "bookshelf:SIL-LEAD" },
    ])
  );
  assert(
    BloomParseServer.bookMatchesAtLeastOneFilter(book, [
      { tag: "bookshelf:other" },
      { brandingProjectName: "ABC-Branding" },
    ])
  );
  assert(BloomParseServer.bookMatchesAtLeastOneFilter(book, [kAllBooksFilter]));
  assert(
    !BloomParseServer.bookMatchesAtLeastOneFilter(book, [
      { tag: "bookshelf:other" },
      { brandingProjectName: "other" },
    ])
  );
  assert(!BloomParseServer.bookMatchesAtLeastOneFilter(book, []));
});

Deno.test("books - canClientUpload compares against minDesktopVersion", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/classes/version")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ results: [{ minDesktopVersion: "5.5" }] }),
          { status: 200 }
        )
      );
    }
    return Promise.reject(new Error("Unexpected fetch: " + url));
  };
  try {
    assert(await canClientUpload("5.5", Environment.DEVELOPMENT));
    assert(await canClientUpload("5.6", Environment.DEVELOPMENT));
    assert(await canClientUpload("6.0", Environment.DEVELOPMENT));
    assert(!(await canClientUpload("5.4", Environment.DEVELOPMENT)));
    assert(!(await canClientUpload("4.9", Environment.DEVELOPMENT)));
    assert(!(await canClientUpload("", Environment.DEVELOPMENT)));
    assert(!(await canClientUpload("garbage", Environment.DEVELOPMENT)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("books - DELETE without auth token returns 400", async () => {
  const originalFetch = globalThis.fetch;
  // no fetch should be needed: no token means getUserFromSession returns null
  globalThis.fetch = () =>
    Promise.reject(new Error("network should not be hit"));
  try {
    const response = await handleBooksRequest(
      new Request("https://x/functions/v1/books/abc123def4", {
        method: "DELETE",
      })
    );
    assertEquals(response.status, 400);
    assertStringIncludes(await response.text(), "Authentication-Token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("books - invalid action returns 400", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/users/me")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ objectId: "u1", sessionToken: "s" }),
          { status: 200 }
        )
      );
    }
    return Promise.reject(new Error("Unexpected fetch: " + url));
  };
  try {
    const response = await handleBooksRequest(
      new Request(
        "https://x/functions/v1/books/" +
          encodeURIComponent("abc123def4:bogus-action"),
        {
          method: "POST",
          headers: { "Authentication-Token": "token" },
          body: "{}",
        }
      )
    );
    assertEquals(response.status, 400);
    assertEquals(await response.text(), "Invalid action type");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("books - OPTIONS preflight gets CORS headers", async () => {
  const response = await handleBooksRequest(
    new Request("https://x/functions/v1/books", {
      method: "OPTIONS",
      headers: { Origin: "https://bloomlibrary.org" },
    })
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://bloomlibrary.org"
  );
});

// --- ported from the Azure parseAdapters.test.ts / books utils.test.ts ---

Deno.test("books - getIdAndAction pathological cases", () => {
  assertEquals(getIdAndAction(""), [null, null]);
  assertEquals(getIdAndAction(":action"), [null, null]);
});

Deno.test("books - exact where strings for each query param", () => {
  assertEquals(
    convertApiQueryParamsIntoParseWhere({ lang: "en" }),
    '{"langPointers":{"$inQuery":{"where":{"isoCode":{"$in":["en"]}},"className":"language"}}}'
  );
  assertEquals(
    convertApiQueryParamsIntoParseWhere({ lang: "en,fr,de" }),
    '{"langPointers":{"$inQuery":{"where":{"isoCode":{"$in":["en","fr","de"]}},"className":"language"}}}'
  );
  assertEquals(
    convertApiQueryParamsIntoParseWhere({ uploader: "bob@example.com" }),
    '{"uploader":{"$inQuery":{"where":{"email":{"$in":["bob@example.com"]}},"className":"_User"}}}'
  );
  assertEquals(
    convertApiQueryParamsIntoParseWhere({
      uploader: "bob@example.com,sue@ex.com",
    }),
    '{"uploader":{"$inQuery":{"where":{"email":{"$in":["bob@example.com","sue@ex.com"]}},"className":"_User"}}}'
  );
  assertEquals(
    convertApiQueryParamsIntoParseWhere({
      lang: "en",
      uploader: "bob@example.com",
    }),
    '{"langPointers":{"$inQuery":{"where":{"isoCode":{"$in":["en"]}},"className":"language"}},"uploader":{"$inQuery":{"where":{"email":{"$in":["bob@example.com"]}},"className":"_User"}}}'
  );
});

// the Azure fixture; note the raw newline inside the allTitles JSON string,
// which exercises the lenient-parsing fallback
const kAzureFixtureBook = {
  objectId: "123",
  title: "The Title",
  allTitles: '{ "en": "The Title", "fr": "Le Titre\n"}',
  langPointers: [
    {
      objectId: "456",
      isoCode: "fr",
      name: "français",
      englishName: "French",
      usageCount: 10,
    },
    {
      objectId: "789",
      isoCode: "en",
      name: "English",
      englishName: "English",
      usageCount: 1,
    },
  ],
  uploader: { objectId: "123", username: "bob@example.com" },
} as any;

Deno.test("books - reshape does not expand languages by default", () => {
  const result = reshapeBookRecord(kAzureFixtureBook);
  assertEquals(result["languages"], [{ tag: "fr" }, { tag: "en" }]);
});

Deno.test("books - reshape expands languages when asked", () => {
  const result = reshapeBookRecord(kAzureFixtureBook, "languages");
  assertEquals(result["languages"], [
    {
      id: "456",
      tag: "fr",
      name: "français",
      englishName: "French",
      usageCount: 10,
    },
    {
      id: "789",
      tag: "en",
      name: "English",
      englishName: "English",
      usageCount: 1,
    },
  ]);
});

Deno.test("books - reshape creates titles from allTitles with raw newline", () => {
  const result = reshapeBookRecord(kAzureFixtureBook);
  assertEquals(result["titles"], [
    { lang: "en", title: "The Title" },
    { lang: "fr", title: "Le Titre\n" },
  ]);
});

Deno.test("books - reshape returns properly shaped uploader object", () => {
  const result = reshapeBookRecord(kAzureFixtureBook);
  assertEquals(result["uploader"], { email: "bob@example.com" });
});
