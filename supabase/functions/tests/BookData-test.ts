import { assert, assertEquals, assertExists } from "jsr:@std/assert@1";

import BookData from "../fs/BookData.ts";
import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";

// Test helper function to create a mock book object
const createMockBook = (
  baseUrl: string,
  objectId: string = "testBookId123"
): Promise<Book> =>
  Promise.resolve({
    objectId,
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
    inCirculation: false,
    ACL: {},
    harvestState: "New",
  });

Deno.test({
  name: "BookData - getContentUrl returns null for invalid bucket",
  fn: async () => {
    const params = {
      bucket: "invalid-bucket",
      bookid: "testBookId",
      pathSegments: ["test.pdf"],
    };

    const result = await BookData.getContentUrl(params);
    assertEquals(result, null, "Should return null for invalid bucket");
  },
});

Deno.test({
  name: "BookData - getContentUrl handles upload bucket correctly",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "validBookId") {
        return createMockBook(
          "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/"
        );
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "upload",
        bookid: "validBookId",
        pathSegments: ["test.pdf"],
      };

      const result = await BookData.getContentUrl(params);
      assertExists(result, "Should return a URL for valid book");
      assert(
        result.includes("BloomLibraryBooks"),
        "URL should contain correct bucket"
      );
      assert(
        result.includes("test.pdf"),
        "URL should contain the requested file"
      );
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

Deno.test({
  name: "BookData - getContentUrl handles dev-upload bucket correctly",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "validBookId") {
        return createMockBook(
          "https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/user@example.com/book-guid/Book+Title/"
        );
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "dev-upload",
        bookid: "validBookId",
        pathSegments: ["test.pdf"],
      };

      const result = await BookData.getContentUrl(params);
      assertExists(result, "Should return a URL for valid book");
      assert(
        result.includes("BloomLibraryBooks-Sandbox"),
        "URL should contain correct dev bucket"
      );
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

Deno.test({
  name: "BookData - getContentUrl handles harvest bucket correctly",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "validBookId") {
        return createMockBook(
          "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/"
        );
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "harvest",
        bookid: "validBookId",
        pathSegments: ["test.pdf"],
      };

      const result = await BookData.getContentUrl(params);
      assertExists(result, "Should return a URL for valid book");
      // For harvest bucket, the title part should be removed from the URL
      assert(
        !result.includes("Book+Title"),
        "Harvest URL should not contain book title"
      );
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

Deno.test({
  name: "BookData - getContentUrl returns null for missing book",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method to return null
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      _objectId: string
    ): Promise<Book | undefined> {
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "upload",
        bookid: "nonExistentBookId",
        pathSegments: ["test.pdf"],
      };

      const result = await BookData.getContentUrl(params);
      assertEquals(result, null, "Should return null for non-existent book");
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

Deno.test({
  name: "BookData - getContentUrl returns null for book without baseUrl",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method to return book without baseUrl
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = async function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "bookWithoutBaseUrl") {
        const book = await createMockBook("", "bookWithoutBaseUrl");
        book.baseUrl = ""; // Empty baseUrl
        return book;
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "upload",
        bookid: "bookWithoutBaseUrl",
        pathSegments: ["test.pdf"],
      };

      const result = await BookData.getContentUrl(params);
      assertEquals(result, null, "Should return null for book without baseUrl");
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

Deno.test({
  name: "BookData - getContentUrl constructs URL with multiple parts",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "validBookId") {
        return createMockBook(
          "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/"
        );
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "upload",
        bookid: "validBookId",
        pathSegments: ["folder", "subfolder", "test file.pdf"],
      };

      const result = await BookData.getContentUrl(params);
      assertExists(
        result,
        "Should return a URL for valid book with multiple parts"
      );
      assert(result.includes("folder"), "URL should contain part1");
      assert(result.includes("subfolder"), "URL should contain part2");
      assert(
        result.includes("test%20file.pdf"),
        "URL should contain encoded part3"
      );
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

// Test the encodeUnicode function indirectly through URL construction
Deno.test({
  name: "BookData - URL encoding handles special characters correctly",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "validBookId") {
        return createMockBook(
          "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Test+Book/"
        );
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "upload",
        bookid: "validBookId",
        pathSegments: ["Doktor+Irwin.pdf"], // Plus signs should be handled correctly
      };

      const result = await BookData.getContentUrl(params);
      assertExists(result, "Should return a URL");
      // The + should be converted to space, then back to %20 encoding
      assert(
        result.includes("Doktor%20Irwin.pdf"),
        "Should properly encode plus signs as spaces"
      );
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});

// ---------------------------------------------------------------------------
// getS3LinkBase (pure function, tested directly)
// ---------------------------------------------------------------------------

Deno.test({
  name: "getS3LinkBase - upload bucket keeps full path, drops trailing slash",
  fn: () => {
    const result = BloomParseServer.getS3LinkBase(
      "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/",
      "BloomLibraryBooks"
    );
    assertEquals(
      result,
      "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title"
    );
  },
});

Deno.test({
  name: "getS3LinkBase - harvest bucket swaps bucket name and drops the title",
  fn: () => {
    const result = BloomParseServer.getS3LinkBase(
      "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title/",
      "bloomharvest"
    );
    assertEquals(
      result,
      "https://s3.amazonaws.com/bloomharvest/user@example.com/book-guid"
    );
  },
});

Deno.test({
  name:
    "getS3LinkBase - harvest-sandbox bucket swaps sandbox bucket name and drops the title",
  fn: () => {
    const result = BloomParseServer.getS3LinkBase(
      "https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/user@example.com/book-guid/Book+Title/",
      "bloomharvest-sandbox"
    );
    assertEquals(
      result,
      "https://s3.amazonaws.com/bloomharvest-sandbox/user@example.com/book-guid"
    );
  },
});

Deno.test({
  name: "getS3LinkBase - decodes %2f in the incoming baseUrl",
  fn: () => {
    const result = BloomParseServer.getS3LinkBase(
      "https://s3.amazonaws.com%2fBloomLibraryBooks%2fuser@example.com%2fbook-guid%2fBook+Title%2f",
      "BloomLibraryBooks"
    );
    assertEquals(
      result,
      "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Book+Title"
    );
  },
});

Deno.test({
  name: "BookData - URL encoding handles Unicode characters",
  fn: async () => {
    // Mock the parseServer.getBookByDatabaseId method
    const originalMethod = BloomParseServer.prototype.getBookByDatabaseId;

    BloomParseServer.prototype.getBookByDatabaseId = function (
      objectId: string
    ): Promise<Book | undefined> {
      if (objectId === "validBookId") {
        return createMockBook(
          "https://s3.amazonaws.com/BloomLibraryBooks/user@example.com/book-guid/Test+Book/"
        );
      }
      return Promise.resolve(undefined);
    };

    try {
      const params = {
        bucket: "upload",
        bookid: "validBookId",
        pathSegments: ["ทดสอบ.pdf"], // Thai characters that need encoding
      };

      const result = await BookData.getContentUrl(params);
      assertExists(result, "Should return a URL with encoded Unicode");
      assert(
        result.includes("%"),
        "URL should contain percent-encoded characters"
      );
    } finally {
      // Restore original method
      BloomParseServer.prototype.getBookByDatabaseId = originalMethod;
    }
  },
});
