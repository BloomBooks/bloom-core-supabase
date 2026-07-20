import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { handleSendConcernEmailRequest } from "../send-concern-email/concernEmail.ts";
import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";

// ---------------------------------------------------------------------------
// Test helpers: stub the Parse lookup and global fetch (the Mailgun request) so
// no network is touched, and control the Mailgun env vars. Every test restores
// the originals so it can't leak into other test files.
// ---------------------------------------------------------------------------

const kValidBookId = "validBookI"; // 10 chars, matches BOOK_ID_PATTERN

const mockBook = (overrides: Partial<Book> = {}): Book =>
  ({
    objectId: kValidBookId,
    title: "Flowers for Foobar",
    copyright: "Copyright 2020 Jane Author",
    license: "cc-by",
    bookInstanceId: "",
    baseUrl: "",
    uploader: {
      objectId: "testUserId",
      email: "uploader@example.com",
      username: "uploader@example.com",
      sessionToken: "",
    },
    tags: [],
    brandingProjectName: "",
    updateSource: "test",
    uploadPendingTimestamp: 0,
    inCirculation: true,
    ACL: {},
    harvestState: "Done",
    ...overrides,
  }) as Book;

// Runs `fn` with getBookByDatabaseId returning `book` for kValidBookId (and
// undefined for anything else), and with global fetch replaced by `mailgunResponse`.
// Captures what the handler sent to "Mailgun" for assertions.
async function withStubs(
  book: Book | undefined,
  mailgunResponse: (() => Response) | null,
  fn: (captured: { url?: string; init?: RequestInit }) => Promise<void>
) {
  const originalGetBook = BloomParseServer.prototype.getBookByDatabaseId;
  const originalFetch = globalThis.fetch;
  const captured: { url?: string; init?: RequestInit } = {};

  BloomParseServer.prototype.getBookByDatabaseId = (
    objectId: string
  ): Promise<Book | undefined> =>
    Promise.resolve(objectId === kValidBookId ? book : undefined);

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    captured.url = input.toString();
    captured.init = init;
    if (!mailgunResponse) {
      throw new Error("Test made an unexpected network request: " + input);
    }
    return Promise.resolve(mailgunResponse());
  }) as typeof fetch;

  try {
    await fn(captured);
  } finally {
    BloomParseServer.prototype.getBookByDatabaseId = originalGetBook;
    globalThis.fetch = originalFetch;
  }
}

// Runs `fn` with the given Mailgun-related env vars set (or deleted, for undefined),
// restoring the previous values afterward so tests can't leak into each other or
// into whatever real .env.local a developer has locally.
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>
) {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = Deno.env.get(key);
  }
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  }
}

const request = (body: unknown, init?: RequestInit) =>
  new Request("http://localhost/send-concern-email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

const kValidBody = {
  fromAddress: "reporter@example.com",
  content: "This book has an offensive image on page 3.",
  bookId: kValidBookId,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

Deno.test("send-concern-email - 400 when bookId is missing", async () => {
  await withStubs(undefined, null, async () => {
    const response = await handleSendConcernEmailRequest(
      request({ ...kValidBody, bookId: undefined })
    );
    assertEquals(response.status, 400);
    const json = await response.json();
    assertStringIncludes(json.error, "bookId");
  });
});

Deno.test("send-concern-email - 400 when bookId has the wrong shape", async () => {
  await withStubs(undefined, null, async () => {
    const response = await handleSendConcernEmailRequest(
      request({ ...kValidBody, bookId: "tooShort" })
    );
    assertEquals(response.status, 400);
  });
});

Deno.test("send-concern-email - 400 when content is missing", async () => {
  await withStubs(mockBook(), null, async () => {
    const response = await handleSendConcernEmailRequest(
      request({ ...kValidBody, content: "" })
    );
    assertEquals(response.status, 400);
    const json = await response.json();
    assertStringIncludes(json.error, "content");
  });
});

Deno.test("send-concern-email - 400 when content exceeds the length cap", async () => {
  await withStubs(mockBook(), null, async () => {
    const response = await handleSendConcernEmailRequest(
      request({ ...kValidBody, content: "x".repeat(5001) })
    );
    assertEquals(response.status, 400);
  });
});

Deno.test("send-concern-email - 400 when fromAddress is not email-shaped", async () => {
  await withStubs(mockBook(), null, async () => {
    const response = await handleSendConcernEmailRequest(
      request({ ...kValidBody, fromAddress: "not-an-email" })
    );
    assertEquals(response.status, 400);
    const json = await response.json();
    assertStringIncludes(json.error, "fromAddress");
  });
});

Deno.test("send-concern-email - 400 for malformed JSON body", async () => {
  await withStubs(undefined, null, async () => {
    const response = await handleSendConcernEmailRequest(
      new Request("http://localhost/send-concern-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      })
    );
    assertEquals(response.status, 400);
  });
});

Deno.test("send-concern-email - 405 for GET", async () => {
  await withStubs(undefined, null, async () => {
    const response = await handleSendConcernEmailRequest(
      new Request("http://localhost/send-concern-email", { method: "GET" })
    );
    assertEquals(response.status, 405);
  });
});

Deno.test("send-concern-email - 204 with CORS headers for OPTIONS preflight", async () => {
  const response = await handleSendConcernEmailRequest(
    new Request("http://localhost/send-concern-email", {
      method: "OPTIONS",
      headers: { Origin: "https://bloomlibrary.org" },
    })
  );
  assertEquals(response.status, 204);
  assertEquals(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://bloomlibrary.org"
  );
});

// ---------------------------------------------------------------------------
// Book lookup
// ---------------------------------------------------------------------------

Deno.test("send-concern-email - 404 when the book does not exist", async () => {
  await withStubs(undefined, null, async () => {
    const response = await handleSendConcernEmailRequest(request(kValidBody));
    assertEquals(response.status, 404);
  });
});

// ---------------------------------------------------------------------------
// No-op parity with legacy test-environment behavior
// ---------------------------------------------------------------------------

Deno.test("send-concern-email - succeeds as a no-op when MAILGUN_API_KEY is unset", async () => {
  await withEnv(
    { MAILGUN_API_KEY: undefined, EMAIL_REPORT_BOOK_RECIPIENT: "team@bloomlibrary.org" },
    async () => {
      await withStubs(mockBook(), null, async () => {
        const response = await handleSendConcernEmailRequest(request(kValidBody));
        assertEquals(response.status, 200);
        const json = await response.json();
        assertEquals(json.success, true);
      });
    }
  );
});

Deno.test("send-concern-email - succeeds as a no-op when EMAIL_REPORT_BOOK_RECIPIENT is unset", async () => {
  await withEnv(
    { MAILGUN_API_KEY: "test-key", EMAIL_REPORT_BOOK_RECIPIENT: undefined },
    async () => {
      await withStubs(mockBook(), null, async () => {
        const response = await handleSendConcernEmailRequest(request(kValidBody));
        assertEquals(response.status, 200);
        const json = await response.json();
        assertEquals(json.success, true);
      });
    }
  );
});

// ---------------------------------------------------------------------------
// Happy path: exact Mailgun request shape
// ---------------------------------------------------------------------------

Deno.test("send-concern-email - happy path sends the expected Mailgun request", async () => {
  await withEnv(
    { MAILGUN_API_KEY: "test-key", EMAIL_REPORT_BOOK_RECIPIENT: "team@bloomlibrary.org" },
    async () => {
      await withStubs(
        mockBook(),
        () => new Response("OK", { status: 200 }),
        async (captured) => {
          const response = await handleSendConcernEmailRequest(request(kValidBody));
          assertEquals(response.status, 200);
          const json = await response.json();
          assertEquals(json.success, true);

          assertEquals(
            captured.url,
            "https://api.mailgun.net/v3/bloomlibrary.org/messages"
          );
          assertEquals(captured.init?.method, "POST");
          assertEquals(
            captured.init?.headers &&
              (captured.init.headers as Record<string, string>)[
                "Authorization"
              ],
            "Basic " + btoa("api:test-key")
          );

          const sentBody = new URLSearchParams(
            captured.init?.body as string
          );
          assertEquals(sentBody.get("from"), kValidBody.fromAddress);
          assertEquals(sentBody.get("to"), "team@bloomlibrary.org");
          assertEquals(
            sentBody.get("subject"),
            "[BloomLibrary] Book reported - Flowers for Foobar"
          );
          assertEquals(sentBody.get("template"), "report-a-book");

          const vars = JSON.parse(sentBody.get("h:X-Mailgun-Variables")!);
          assertEquals(vars, {
            title: "Flowers for Foobar",
            copyright: "Copyright 2020 Jane Author",
            license: "cc-by",
            uploader: "uploader@example.com",
            url: `https://bloomlibrary.org/book/${kValidBookId}`,
            body: kValidBody.content,
          });

          const text = sentBody.get("text")!;
          assertStringIncludes(text, "Flowers for Foobar");
          assertStringIncludes(text, kValidBody.content);
        }
      );
    }
  );
});

Deno.test("send-concern-email - falls back to 'unknown X' for missing book fields", async () => {
  await withEnv(
    { MAILGUN_API_KEY: "test-key", EMAIL_REPORT_BOOK_RECIPIENT: "team@bloomlibrary.org" },
    async () => {
      const bareBook = mockBook({
        title: "",
        copyright: undefined,
        license: undefined,
        uploader: {
          objectId: "testUserId",
          email: "",
          username: "",
          sessionToken: "",
        },
      });
      await withStubs(
        bareBook,
        () => new Response("OK", { status: 200 }),
        async (captured) => {
          await handleSendConcernEmailRequest(request(kValidBody));
          const sentBody = new URLSearchParams(captured.init?.body as string);
          const vars = JSON.parse(sentBody.get("h:X-Mailgun-Variables")!);
          assertEquals(vars.title, "unknown title");
          assertEquals(vars.copyright, "unknown copyright");
          assertEquals(vars.license, "unknown license");
          assertEquals(vars.uploader, "unknown uploader");
        }
      );
    }
  );
});

Deno.test("send-concern-email - 500 when Mailgun request fails", async () => {
  await withEnv(
    { MAILGUN_API_KEY: "test-key", EMAIL_REPORT_BOOK_RECIPIENT: "team@bloomlibrary.org" },
    async () => {
      await withStubs(
        mockBook(),
        () => new Response("Bad Request", { status: 400 }),
        async () => {
          const response = await handleSendConcernEmailRequest(request(kValidBody));
          assertEquals(response.status, 500);
        }
      );
    }
  );
});

Deno.test("send-concern-email - CORS headers are present on error responses too", async () => {
  await withStubs(undefined, null, async () => {
    const response = await handleSendConcernEmailRequest(
      new Request("http://localhost/send-concern-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://bloomlibrary.org",
        },
        body: JSON.stringify({ ...kValidBody, bookId: "bad" }),
      })
    );
    assertEquals(response.status, 400);
    assertEquals(
      response.headers.get("Access-Control-Allow-Origin"),
      "https://bloomlibrary.org"
    );
    assert(response.headers.get("Content-Type")?.includes("application/json"));
  });
});
