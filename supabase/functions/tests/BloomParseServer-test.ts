import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";
import "jsr:@std/dotenv/load";

import BloomParseServer from "../_shared/BloomParseServer.ts";
import { Environment } from "../_shared/utils.ts";

// A common updateSource used to delete books after tests run:
const testUpdateSource = "SupabaseFunctionsUnitTest";

const testBookInstanceId = "supabaseFunctionBloomParseServerTests";

let parseServer: BloomParseServer;
let token: string;
let myUserId: string;

// Setup function to initialize before all tests
const setupTests = async () => {
  parseServer = new BloomParseServer(Environment.UNITTEST);

  token = await parseServer.loginAsUser("unittest@example.com", "unittest");
  const userInfo = await parseServer.getLoggedInUserInfo(token);
  myUserId = userInfo!.objectId;
};

// Cleanup function to run after all tests
const cleanupTests = async () => {
  const testBooks = (
    await parseServer.getBooks(
      `{"updateSource":{"$eq":"${testUpdateSource}"}}`,
    )
  ).books;

  for (const book of testBooks) {
    await parseServer.deleteBookRecord(book.objectId, token);
  }
};

const testLangParams = {
  isoCode: "foo",
  name: "bar",
  ethnologueCode: "baz",
};

Deno.test({
  name: "BloomParseServer - Setup",
  fn: setupTests,
});

Deno.test({
  name:
    "BloomParseServer - getLanguages() returns a reasonable number of languages",
  fn: async () => {
    const langs = await new BloomParseServer(
      Environment.PRODUCTION,
    ).getLanguages();
    assert(
      langs.length > 500,
      `Expected more than 500 languages, got ${langs.length}`,
    );
  },
});

// This is actually testing parse cloud code; we didn't find a good way to test the logic there.
// Originally, this test lived in BloomDesktop but we moved it here so we could get rid of all traces of parse server from the editor.
// Eventually, we will likely move the code which handles setting the tag and harvestState out of cloud code into uploadFinish. But we can't do that until all upload clients are using the API.
Deno.test({
  name:
    "BloomParseServer - parse cloud code sets system:Incoming and harvestState",
  fn: async () => {
    const newBookRecord = {
      title: "test book",
      bookInstanceId: testBookInstanceId,
      updateSource: "BloomDesktop_supabaseFunctionUnitTest (new book)",
      uploadPendingTimestamp: 123456,
      inCirculation: false,
      uploader: {
        __type: "Pointer",
        className: "_User",
        objectId: myUserId,
      },
      languageDescriptors: [testLangParams],
    };

    const bookObjectId = await parseServer.createBookRecord(
      newBookRecord,
      token,
    );
    const book = await parseServer.getBookByDatabaseId(bookObjectId);
    assert(book);
    assertEquals(book.tags[0], "system:Incoming");
    assertEquals(book.harvestState, "New");

    const sessionToken = await parseServer.loginAsUnitTestUser();
    await parseServer.modifyBookRecord(
      bookObjectId,
      {
        updateSource: "BloomDesktop supabaseFunctionUnitTest",
        harvestState: "bogusHarvestState",
        tags: ["bogusTag"],
      },
      sessionToken,
    );
    const modifiedBook = await parseServer.getBookByDatabaseId(bookObjectId);
    assert(modifiedBook);
    assertEquals(modifiedBook.harvestState, "Updated");
    assert(modifiedBook.tags.includes("system:Incoming"));
  },
});

Deno.test({
  name:
    "BloomParseServer - successfully creates, modifies, and deletes Book records",
  fn: async () => {
    const newBookRecord = {
      title: "test book",
      bookInstanceId: testBookInstanceId,
      updateSource: `${testUpdateSource}`,
      uploadPendingTimestamp: 123456,
      inCirculation: false,
      uploader: {
        __type: "Pointer",
        className: "_User",
        objectId: myUserId,
      },
    };

    const bookObjectId = await parseServer.createBookRecord(
      newBookRecord,
      token,
    );
    const book = await parseServer.getBookByDatabaseId(bookObjectId);
    assert(book);
    assertEquals(book.title, newBookRecord.title);
    assertEquals(book.bookInstanceId, newBookRecord.bookInstanceId);
    assertEquals(book.updateSource, newBookRecord.updateSource);
    assertEquals(
      book.uploadPendingTimestamp,
      newBookRecord.uploadPendingTimestamp,
    );
    assertEquals(book.inCirculation, newBookRecord.inCirculation);
    assertEquals(book.uploader.objectId, newBookRecord.uploader.objectId);

    await parseServer.modifyBookRecord(
      bookObjectId,
      { title: "new title", uploadPendingTimestamp: null },
      token,
    );
    const book2 = await parseServer.getBookByDatabaseId(bookObjectId);
    assert(book2);
    assertEquals(book2.title, "new title");
    assert(
      !book2.uploadPendingTimestamp,
      "uploadPendingTimestamp should be falsy",
    );

    await parseServer.deleteBookRecord(bookObjectId, token);
    const shouldBeDeletedBook = await parseServer.getBookByDatabaseId(
      bookObjectId,
    );
    assert(!shouldBeDeletedBook, "Book should be deleted");
  },
});

Deno.test({
  name: "BloomParseServer - can get, create and delete languages",
  fn: async () => {
    const testLangParamString = JSON.stringify(testLangParams);
    const oldUnitTestLang = await parseServer.getLanguage(testLangParamString);
    const oldUnitTestLangId = oldUnitTestLang?.objectId;
    if (oldUnitTestLangId) {
      await parseServer.deleteLanguage(oldUnitTestLangId, token);
    }

    const oldLangIsStillThere = await parseServer.getLanguage(
      testLangParamString,
    );
    assert(!oldLangIsStillThere, "Old test language should be deleted");

    const langId = await parseServer.getOrCreateLanguage(testLangParamString);
    assertExists(langId, "Language ID should be created");
    const langId2 = await parseServer.getOrCreateLanguage(testLangParamString);
    assertEquals(
      langId2,
      langId,
      "Should return same language ID when called again",
    );
  },
});

Deno.test({
  name:
    "BloomParseServer - getBookCountByLanguage returns expected number of books",
  fn: async () => {
    const testLanguageId = await parseServer.getOrCreateLanguage(
      testLangParams,
    );
    const oldBooksWithTestLang = (
      await parseServer.getBooks(
        `{"langPointers":{"$in":[{"__type":"Pointer","className":"language","objectId":"${testLangParams.isoCode}"}]}}`,
      )
    ).books;

    for (const book of oldBooksWithTestLang) {
      await parseServer.deleteBookRecord(book.objectId, token);
    }

    // Create 3 books in the test language
    for (let i = 0; i < 3; i++) {
      const newBookRecord = {
        title: `testGetBookCountByLanguage book ${i}`,
        bookInstanceId: "testGetBookCountByLanguage",
        updateSource: `${testUpdateSource}`,
        uploader: {
          __type: "Pointer",
          className: "_User",
          objectId: myUserId,
        },
        langPointers: [
          {
            __type: "Pointer",
            className: "language",
            objectId: testLanguageId,
          },
        ],
      };
      await parseServer.createBookRecord(newBookRecord, token);
    }

    const count = await parseServer.getBookCountByLanguage(
      testLangParams.isoCode,
    );
    assertEquals(count, 3, "Should have created exactly 3 test books");
  },
});

Deno.test({
  name: "BloomParseServer - Cleanup",
  fn: cleanupTests,
});
