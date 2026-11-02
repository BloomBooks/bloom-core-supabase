import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import Catalog, { setNeglectXmlNamespaces } from "../opds/catalog.ts";
import BookEntry, {
  getLevelText,
  getNumberValueFromTags,
} from "../opds/bookentry.ts";

// Match the Azure unit tests: ignore XML namespaces so elements are plain tags.
setNeglectXmlNamespaces();

const kTestBookId = "abcdef";
// It appears we extract the title from the baseUrl and then use that in totally different urls (bloomd)
const titleInTheBaseUrl = "titleFromTheBaseUrl";
const kTestBookBaseUrl = `https://s3.amazonaws.com/BloomLibraryBooks/uploader/${titleInTheBaseUrl}`;

// The same fixture book used by the Azure bookEntry.test.ts.
function makeTestBook(): any {
  return {
    objectId: kTestBookId,
    tags: ["topic:Story Book", "computedLevel:3"],
    langPointers: [
      { objectId: "i6YEieQEDU", isoCode: "fil", name: "Filipino", usageCount: 10 },
      { objectId: "vTo23jVYzz", isoCode: "en", name: "English", usageCount: 3607 },
    ],
    bookInstanceId: "e62e76e7-da4d-4e6c-9c67-473f13272133",
    title: "my main title",
    allTitles:
      '{"en":"The Moon and the Cap","fil":"Ang Buwan at ang Sombrero","fr":"La lune et la casquette"}',
    baseUrl: kTestBookBaseUrl,
    license: "cc-by",
    copyright: "Copyright © 2018, Joselito B. Ucag",
    pageCount: 17,
    uploader: { objectId: "0YpcRpEw66", username: "joe@example.com" },
    createdAt: "2018-11-14T09:41:02.365Z",
    updatedAt: "2020-11-19T15:36:27.921Z",
    harvestStartedAt: { __type: "Date", iso: "2020-11-19T15:36:07.716Z" },
    harvestState: "Done",
    show: {
      pdf: {},
      epub: { harvester: true },
      bloomReader: { harvester: true },
      readOnline: { harvester: true },
    },
    originalPublisher: "Pratham Books",
  };
}

Deno.test("opds - omits draft books", () => {
  const book = makeTestBook();
  book.draft = true;
  assertEquals(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    "<!-- omitting a book because it is in DRAFT -->"
  );
});

Deno.test("opds - omits out-of-circulation books", () => {
  const book = makeTestBook();
  book.inCirculation = false;
  assertEquals(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    "<!-- omitting a book because it is out of circulation -->"
  );
});

Deno.test("opds - omits books awaiting review (system:Incoming)", () => {
  const book = makeTestBook();
  book.tags.push("system:Incoming");
  assertEquals(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    "<!-- omitting a book because it is awaiting site policy review -->"
  );
});

Deno.test("opds - omits unharvested books", () => {
  const book = makeTestBook();
  book.harvestState = "New";
  assertEquals(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    "<!-- omitting a book because of harvest state -->"
  );
});

Deno.test("opds - epubOnly omits books whose epub is hidden", () => {
  const book = makeTestBook();
  book.show["epub"] = false;
  assertEquals(
    BookEntry.getOpdsEntryForBook(book, true, "", ""),
    "<!-- omitting a book because of artifact settings -->"
  );
});

Deno.test("opds - entry contains expected artifact links", () => {
  const xml = BookEntry.getOpdsEntryForBook(makeTestBook(), false, "", "");
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/fs/upload/${kTestBookId}/${titleInTheBaseUrl}.pdf"`
  );
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/fs/harvest/${kTestBookId}/epub/${titleInTheBaseUrl}.epub"`
  );
  // no bloomPUBVersion on the fixture, so the old .bloomd extension
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/fs/harvest/${kTestBookId}/${titleInTheBaseUrl}.bloomd"`
  );
  assertStringIncludes(
    xml,
    `href="https://bloomlibrary.org/player/${kTestBookId}"`
  );
  assertStringIncludes(
    xml,
    `href="https://bloomlibrary.org/book/${kTestBookId}"`
  );
  // harvester-produced thumbnail (harvested after Feb 2020)
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/fs/harvest/${kTestBookId}/thumbnails/thumbnail-256.png?version=`
  );
});

Deno.test("opds - filename survives a baseUrl ending in an encoded slash", () => {
  // Real book records' baseUrl typically ends in %2f (an encoded trailing
  // slash). getBookFileName decodes it to a real "/", so the filename
  // extraction must strip the trailing slash before taking the last segment,
  // or the generated links get an empty filename (e.g. ".../uploader/.pdf").
  const book = makeTestBook();
  book.baseUrl = `https://s3.amazonaws.com/BloomLibraryBooks/uploader/${titleInTheBaseUrl}%2f`;
  const xml = BookEntry.getOpdsEntryForBook(book, false, "", "");
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/fs/upload/${kTestBookId}/${titleInTheBaseUrl}.pdf"`
  );
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/fs/harvest/${kTestBookId}/epub/${titleInTheBaseUrl}.epub"`
  );
});

Deno.test("opds - referrer tag is propagated to links", () => {
  const xml = BookEntry.getOpdsEntryForBook(
    makeTestBook(),
    false,
    "",
    "example tag"
  );
  assertStringIncludes(xml, "ref=example%20tag");
});

Deno.test("opds - no PDF link when the artifact does not exist", () => {
  const book = makeTestBook();
  book.show.pdf.exists = false;
  const xml = BookEntry.getOpdsEntryForBook(book, false, "", "");
  assert(!xml.includes(`title="PDF"`));
});

Deno.test("opds - user opinion beats harvester opinion", () => {
  const book = makeTestBook();
  book.show.epub = { harvester: true, user: false };
  const xml = BookEntry.getOpdsEntryForBook(book, false, "", "");
  assert(!xml.includes(`title="ePUB"`));
});

Deno.test("opds - title selection honors desiredLang via allTitles", () => {
  const xml = BookEntry.getOpdsEntryForBook(makeTestBook(), false, "fil", "");
  assertStringIncludes(xml, "<title>Ang Buwan at ang Sombrero</title>");
  const xmlNoLang = BookEntry.getOpdsEntryForBook(makeTestBook(), false, "", "");
  assertStringIncludes(xmlNoLang, "<title>my main title</title>");
});

Deno.test("opds - topic tag becomes a lowercased subject element", () => {
  const book = makeTestBook();
  book.tags = ["topic:Dogs", "computedLevel:3"];
  const xml = BookEntry.getOpdsEntryForBook(book, false, "", "");
  assertStringIncludes(xml, "<subject>dogs</subject>");
});

Deno.test("opds - level element uses level: tag, falling back to computedLevel:", () => {
  const book = makeTestBook();
  book.tags = ["level:1"];
  assertStringIncludes(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    `<level>${getLevelText(1)}</level>`
  );

  book.tags = ["computedLevel:2"];
  assertStringIncludes(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    `<level>${getLevelText(2)}</level>`
  );

  // level wins over computedLevel
  book.tags = ["level:3", "computedLevel:4"];
  assertStringIncludes(
    BookEntry.getOpdsEntryForBook(book, false, "", ""),
    `<level>${getLevelText(3)}</level>`
  );

  // if there's no level or computedLevel, don't include the entry
  book.tags = ["topic:Dogs"];
  assert(!BookEntry.getOpdsEntryForBook(book, false, "", "").includes("<level>"));
});

Deno.test("opds - hreflang attributes appear only when langTag is known", () => {
  const book = makeTestBook();
  let xml = BookEntry.getOpdsEntryForBook(book, false, "", "");
  assert(!xml.includes("hreflang"));

  book.show.pdf.langTag = "fr";
  book.show.epub.langTag = "fr";
  xml = BookEntry.getOpdsEntryForBook(book, false, "", "");
  assertStringIncludes(xml, `hreflang="fr"`);
});

Deno.test("opds - getNumberValueFromTags parses numbers, non-numbers, and missing tags", () => {
  const tags = ["level:1", "computedLevel:0", "topic:Dogs"];
  assertEquals(getNumberValueFromTags(tags, "level:"), 1);
  assertEquals(getNumberValueFromTags(tags, "computedLevel:"), 0);
  assert(Number.isNaN(getNumberValueFromTags(tags, "topic:")));
  assertEquals(getNumberValueFromTags(tags, "prefixNotPresent:"), undefined);
});

Deno.test("opds - root catalog offers epub and all-books subsections", async () => {
  const xml = await Catalog.getCatalog(
    "https://api.bloomlibrary.org/v1/opds",
    {},
    undefined,
    true // skipServerElementsForFastTesting
  );
  assertStringIncludes(xml, "<title>ePUB books organized by language</title>");
  assertStringIncludes(xml, "<title>All books organized by language</title>");
  assertStringIncludes(xml, "YOU SHOULD GET A KEY FROM US ASAP");
  assertStringIncludes(
    xml,
    `href="https://api.bloomlibrary.org/v1/opds?epub=true&amp;organizeby=language"`
  );
});

Deno.test("opds - language catalog without a key still renders (fast test mode)", async () => {
  const xml = await Catalog.getCatalog(
    "https://api.bloomlibrary.org/v1/opds",
    { lang: "fr", minimalnavlinks: true },
    undefined,
    true // skipServerElementsForFastTesting
  );
  assertStringIncludes(xml, "<feed");
  assertStringIncludes(xml, "<title>Bloom Library Books</title>");
  // minimalnavlinks: no self/start/up links
  assert(!xml.includes(`rel="self"`));
});

// --- ported from the Azure catalog.test.ts / apiAccount.test.ts ---

import { getApiAccount } from "../opds/apiAccount.ts";
import { Environment } from "../_shared/utils.ts";
import { testRequiringSecrets } from "./testSecrets.ts";

// offline: getCatalog with skipServerElementsForFastTesting
async function makeCatalog(params: Record<string, unknown>, requiresServer = false) {
  return await Catalog.getCatalog(
    "https://example.org",
    params as any,
    undefined,
    !requiresServer
  );
}

// the href of the feed's rel="self" link (the equivalent of the Azure tests'
// feed/link[@rel="self"]/@href xpath)
function selfHref(xml: string): string {
  const match = /<link rel="self" href="([^"]*)"/.exec(xml);
  return match ? match[1] : "";
}

Deno.test("opds - self link carries the epub param only when set", async () => {
  assertStringIncludes(selfHref(await makeCatalog({ epub: true })), "epub=true");
  // since "all" artifact types is the default, we don't want to list it when it is chosen
  assert(!selfHref(await makeCatalog({ epub: false })).includes("epub="));
  assert(!selfHref(await makeCatalog({})).includes("epub="));
});

Deno.test("opds - self link carries the organizeby param", async () => {
  assertStringIncludes(
    selfHref(await makeCatalog({ epub: true, organizeby: "language" })),
    "organizeby=language"
  );
});

Deno.test("opds - self link carries the apiAccount key param only when present", async () => {
  assertStringIncludes(
    selfHref(await makeCatalog({ key: "pat@example.com:123abcd" })),
    "key=pat%40example.com%3A123abcd"
  );
  assert(!selfHref(await makeCatalog({})).includes("key="));
});

Deno.test("opds - self link carries the lang param", async () => {
  assertStringIncludes(
    selfHref(await makeCatalog({ organizeby: "language", lang: "fr" })),
    "lang=fr"
  );
});

Deno.test("opds - api key: 401 if no key at all", async () => {
  assertEquals((await getApiAccount("")).resultCode, 401);
});

Deno.test("opds - api key: 403 with format hint for a key with no colon", async () => {
  // A colon-less key is malformed; the guard should short-circuit to the
  // format-hint 403 without ever reaching the parse server.
  const result = await getApiAccount("nocolon");
  assertEquals(result.resultCode, 403);
  assertStringIncludes(result.errorMessage ?? "", "Keys are of the form");
});

Deno.test("opds - api key: 503 if parse server cannot be reached", async () => {
  assertEquals(
    (await getApiAccount("pretend-parse-server-down")).resultCode,
    503
  );
});

// --- live tests; skipped unless the relevant env vars are present ---

const kProdParseSecrets = ["BLOOM_PARSE_APP_ID_PROD"];
const kDevCatalogServiceSecrets = [
  "BLOOM_PARSE_APP_ID_DEV",
  "BLOOM_PARSE_CATALOG_SERVICE_PASSWORD",
];

testRequiringSecrets({
  name: "opds - live: language facets are consolidated by isoCode",
  secrets: kProdParseSecrets,
  fn: async () => {
    Catalog.DefaultEmbargoDays = 0;
    const xml = await Catalog.getCatalog("https://base-url-for-unit-test", {
      organizeby: "language",
    });
    // does not list the same language (by isoCode) twice
    assertEquals((xml.match(/iso="fr"/g) ?? []).length, 1);
    // uses the name that is most commonly used among duplicates
    assertStringIncludes(xml, 'title="français"');
    // adds up the usages of the duplicate languages
    const atMost = /iso="fr"[\s\S]*?atMost="(\d+)"/.exec(xml);
    assert(atMost && parseInt(atMost[1]) > 800, "fr atMost should be > 800");
    // has a reasonable number of language facets overall
    const facetCount = (xml.match(/opds:facetGroup="Languages"/g) ?? []).length;
    assert(facetCount >= 500, `only ${facetCount} language facets`);
  },
});

testRequiringSecrets({
  name: "opds - live: tag query returns a bounded set of books",
  secrets: kProdParseSecrets,
  fn: async () => {
    Catalog.DefaultEmbargoDays = 0;
    const xml = await Catalog.getCatalog("https://base-url-for-unit-test", {
      tag: "list:SEL",
      minimalnavlinks: true,
    } as any);
    const entryCount = (xml.match(/<entry>/g) ?? []).length;
    assert(entryCount >= 59, `only ${entryCount} entries`);
    assert(entryCount <= 300, `${entryCount} entries; are we getting ALL books?`);
  },
});

testRequiringSecrets({
  name: "opds - live: bogus api key gives 403",
  secrets: kDevCatalogServiceSecrets,
  fn: async () => {
    assertEquals(
      (await getApiAccount("bogus", Environment.DEVELOPMENT)).resultCode,
      403
    );
  },
});

testRequiringSecrets({
  name: "opds - live: finds the unit-test account on dev server",
  secrets: [
    ...kDevCatalogServiceSecrets,
    "BLOOM_PARSE_API_ACCOUNT_OBJECT_ID_UNIT_TEST",
  ],
  fn: async () => {
    const answer = await getApiAccount(
      `unit-test@example.com:${Deno.env.get(
        "BLOOM_PARSE_API_ACCOUNT_OBJECT_ID_UNIT_TEST"
      )}`,
      Environment.DEVELOPMENT
    );
    assertEquals(answer.errorMessage, undefined);
    assertEquals(answer.resultCode, 0);
    assert(answer.account);
    // undefined means default. This is different from 0, which means no embargo.
    assertEquals(answer.account!.embargoDays, undefined);
    assertEquals(answer.account!.user.username, "unit-test@example.com");
    assertEquals(answer.account!.referrerTag, "unit-test-account");
  },
});
