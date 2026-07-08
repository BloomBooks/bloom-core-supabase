import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  appendAxiosStyleParams,
  generateAddParseBooksToTempTableStatement,
  getSqlFunctionName,
  isValidDateStr,
} from "../stats/events.ts";
import { handleStatsRequest } from "../stats/stats.ts";

Deno.test("stats - isValidDateStr accepts strict YYYY-MM-DD", () => {
  assert(isValidDateStr("2024-01-31"));
  assert(isValidDateStr("2000-12-01"));
});

Deno.test("stats - isValidDateStr rejects bad formats and impossible dates", () => {
  assert(!isValidDateStr("2024-1-31"));
  assert(!isValidDateStr("01-31-2024"));
  assert(!isValidDateStr("2024-02-30")); // not a real date
  assert(!isValidDateStr("2024-13-01")); // no 13th month
  assert(!isValidDateStr("garbage"));
  assert(!isValidDateStr(""));
  assert(!isValidDateStr(undefined));
});

Deno.test("stats - category/rowType map to stored procedures", () => {
  assertEquals(getSqlFunctionName("reading", "book"), "common.get_book_stats");
  assertEquals(
    getSqlFunctionName("reading", "per-day"),
    "common.get_reading_perday_events"
  );
  assertEquals(
    getSqlFunctionName("reading", "per-book"),
    "common.get_reading_perbook_events"
  );
  assertEquals(
    getSqlFunctionName("reading", "overview"),
    "common.get_reading_overview"
  );
  assertEquals(
    getSqlFunctionName("reading", "locations"),
    "common.get_reading_locations"
  );
});

Deno.test("stats - unknown category/rowType throws", () => {
  let threw = false;
  try {
    getSqlFunctionName("reading", "nonsense");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("stats - temp table statement is parameterized", () => {
  const statement = generateAddParseBooksToTempTableStatement([
    { objectId: "abc", bookInstanceId: "guid-1" },
    { objectId: "def'; DROP TABLE books; --", bookInstanceId: "guid-2" },
  ]);
  assert(statement);
  assertEquals(
    statement!.text,
    "CREATE TEMP TABLE temp_book_ids(book_id,book_instance_id) AS VALUES ($1,$2),($3,$4)"
  );
  // the injection attempt stays inert inside a parameter value
  assertEquals(statement!.values, [
    "abc",
    "guid-1",
    "def'; DROP TABLE books; --",
    "guid-2",
  ]);
});

Deno.test("stats - temp table statement is undefined for no books", () => {
  assertEquals(generateAddParseBooksToTempTableStatement([]), undefined);
});

Deno.test("stats - appendAxiosStyleParams serializes like axios", () => {
  const url = appendAxiosStyleParams("https://parse/classes/books", {
    limit: 5,
    keys: "objectId,bookInstanceId",
    where: { inCirculation: true },
  });
  assertStringIncludes(url, "limit=5");
  assertStringIncludes(url, "keys=objectId%2CbookInstanceId");
  // object values are JSON-stringified, as axios did
  assertStringIncludes(
    url,
    "where=%7B%22inCirculation%22%3Atrue%7D"
  );
});

Deno.test("stats - OPTIONS preflight echoes an allowed origin", async () => {
  const response = await handleStatsRequest(
    new Request("https://x/functions/v1/stats/reading/per-book", {
      method: "OPTIONS",
      headers: { Origin: "https://bloomlibrary.org" },
    })
  );
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://bloomlibrary.org"
  );
  assertEquals(response.headers.get("Vary"), "Origin");
  assert(
    response.headers
      .get("Access-Control-Allow-Headers")!
      .includes("content-type")
  );
});

Deno.test("stats - preflight allows any https bloomlibrary.org subdomain", async () => {
  const response = await handleStatsRequest(
    new Request("https://x/functions/v1/stats/reading/per-book", {
      method: "OPTIONS",
      headers: { Origin: "https://some-future-subdomain.bloomlibrary.org" },
    })
  );
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://some-future-subdomain.bloomlibrary.org"
  );
});

Deno.test("stats - preflight from disallowed origins gets no allow-origin header", async () => {
  for (const origin of [
    "https://evil.example.com",
    "https://evilbloomlibrary.org", // suffix without the dot must not match
    "https://bloomlibrary.org.evil.com",
    "http://bloomlibrary.org", // https only
    "null", // opaque origin (sandboxed iframe, file://)
  ]) {
    const response = await handleStatsRequest(
      new Request("https://x/functions/v1/stats/reading/per-book", {
        method: "OPTIONS",
        headers: { Origin: origin },
      })
    );
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      null,
      `origin ${origin} should not be allowed`
    );
  }
});

Deno.test("stats - 400 when filter is missing", async () => {
  const response = await handleStatsRequest(
    new Request("https://x/functions/v1/stats/reading/per-book", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://dev.bloomlibrary.org",
      },
    })
  );
  assertEquals(response.status, 400);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://dev.bloomlibrary.org"
  );
});

Deno.test("stats - 400 with message for invalid dates", async () => {
  const response = await handleStatsRequest(
    new Request("https://x/functions/v1/stats/reading/overview", {
      method: "POST",
      body: JSON.stringify({ filter: { fromDate: "not-a-date" } }),
      headers: { "Content-Type": "application/json" },
    })
  );
  assertEquals(response.status, 400);
  assertStringIncludes(await response.text(), "Invalid from date");
});
