import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createLinkHtml,
  handleSocialRequest,
  isAllowedLink,
} from "../social/social.ts";

Deno.test("isAllowedLink - allows bloomlibrary.org", () => {
  assert(isAllowedLink("https://bloomlibrary.org/book/123"));
});

Deno.test("isAllowedLink - allows subdomains of bloomlibrary.org", () => {
  assert(isAllowedLink("https://dev.bloomlibrary.org/book/123"));
  assert(isAllowedLink("http://alpha.bloomlibrary.org/"));
});

Deno.test("isAllowedLink - allows missing protocol", () => {
  assert(isAllowedLink("bloomlibrary.org/book/123"));
});

Deno.test("isAllowedLink - rejects other domains", () => {
  assert(!isAllowedLink("https://example.com/"));
  assert(!isAllowedLink("https://notbloomlibrary.org/"));
  assert(!isAllowedLink("https://bloomlibrary.org.evil.com/"));
});

Deno.test("isAllowedLink - true for empty link (handled later as 400)", () => {
  assert(isAllowedLink(undefined));
  assert(isAllowedLink(""));
});

Deno.test("social - 403 for disallowed link", async () => {
  const response = await handleSocialRequest(
    new Request("http://localhost/social?link=https://evil.com&title=Hi")
  );
  assertEquals(response.status, 403);
});

Deno.test("social - 400 when title is missing", async () => {
  const response = await handleSocialRequest(
    new Request("http://localhost/social?link=https://bloomlibrary.org/book/1")
  );
  assertEquals(response.status, 400);
});

Deno.test("social - 400 when link is missing", async () => {
  const response = await handleSocialRequest(
    new Request("http://localhost/social?title=Hi")
  );
  assertEquals(response.status, 400);
});

Deno.test("social - generates OpenGraph html", async () => {
  const response = await handleSocialRequest(
    new Request(
      "http://localhost/social?link=https://bloomlibrary.org/book/123&title=My+Book&img=https://bloomlibrary.org/thumb.png&description=A+nice+book"
    )
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("Content-Type"), "text/html");
  const html = await response.text();
  assertStringIncludes(html, `content="My Book"`);
  assertStringIncludes(html, `content = "https://bloomlibrary.org/thumb.png"`);
  assertStringIncludes(html, `content="A nice book"`);
  assertStringIncludes(
    html,
    `window.location.href="https://bloomlibrary.org/book/123"`
  );
});

Deno.test("social - accepts parameters via POST JSON body", async () => {
  const response = await handleSocialRequest(
    new Request("http://localhost/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        link: "https://bloomlibrary.org/book/123",
        title: "Posted Book",
      }),
    })
  );
  assertEquals(response.status, 200);
  assertStringIncludes(await response.text(), `content="Posted Book"`);
});

Deno.test("social - POST body of literal null does not crash", async () => {
  // req.json() returns null for a body that is literally `null`; the handler
  // must fall back to the query string rather than throwing on body[name].
  const response = await handleSocialRequest(
    new Request("http://localhost/social", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    })
  );
  assertEquals(response.status, 400);
});

Deno.test("social - scheme-less link is given an https scheme in the redirect", async () => {
  // A scheme-less link passes isAllowedLink; without a scheme, window.location
  // would treat it as a relative path, so the redirect must be absolute.
  const response = await handleSocialRequest(
    new Request("http://localhost/social?link=bloomlibrary.org/book/1&title=T")
  );
  assertEquals(response.status, 200);
  assertStringIncludes(
    await response.text(),
    `window.location.href="https://bloomlibrary.org/book/1"`
  );
});

Deno.test("social - default description and image sizes", async () => {
  const response = await handleSocialRequest(
    new Request(
      "http://localhost/social?link=https://bloomlibrary.org/1&title=T&img=https://bloomlibrary.org/i.png"
    )
  );
  const html = await response.text();
  assertStringIncludes(html, "Bloom makes it easy to create simple books");
  assertStringIncludes(html, `content = "256"`);
});

Deno.test("social - og:url uses X-Forwarded-Host from the routing worker", async () => {
  const response = await handleSocialRequest(
    new Request(
      "https://someproject.supabase.co/functions/v1/social?link=https://bloomlibrary.org/1&title=T",
      { headers: { "X-Forwarded-Host": "api.bloomlibrary.org" } }
    )
  );
  const html = await response.text();
  assertStringIncludes(
    html,
    `content="https://api.bloomlibrary.org/v1/social?link=https://bloomlibrary.org/1&amp;title=T"`
  );
  assert(!html.includes("supabase.co"));
});

Deno.test("social - og:url uses X-Bloom-Public-Url from the routing worker", async () => {
  const response = await handleSocialRequest(
    new Request(
      "https://someproject.supabase.co/functions/v1/social?link=https://bloomlibrary.org/1&title=T",
      {
        headers: {
          "X-Bloom-Public-Url":
            "https://social.bloomlibrary.org/v1/social?link=https://bloomlibrary.org/1&title=T",
        },
      }
    )
  );
  const html = await response.text();
  assertStringIncludes(
    html,
    `content="https://social.bloomlibrary.org/v1/social?link=https://bloomlibrary.org/1&amp;title=T"`
  );
  assert(!html.includes("supabase.co"));
});

Deno.test("social - spoofed X-Bloom-Public-Url host is ignored in og:url", async () => {
  const response = await handleSocialRequest(
    new Request(
      "https://someproject.supabase.co/functions/v1/social?link=https://bloomlibrary.org/1&title=T",
      { headers: { "X-Bloom-Public-Url": "https://phishing-domain.com/social" } }
    )
  );
  const html = await response.text();
  // A non-bloomlibrary.org host in the header must be ignored; we fall back to
  // the real request URL rather than trusting an arbitrary domain.
  assert(!html.includes("phishing-domain.com"));
  assertStringIncludes(html, "someproject.supabase.co");
});

Deno.test("social - spoofed X-Forwarded-Host is ignored in og:url", async () => {
  const response = await handleSocialRequest(
    new Request(
      "https://someproject.supabase.co/functions/v1/social?link=https://bloomlibrary.org/1&title=T",
      { headers: { "X-Forwarded-Host": "phishing-domain.com" } }
    )
  );
  const html = await response.text();
  // The untrusted host must not appear; we fall back to the real request URL.
  assert(!html.includes("phishing-domain.com"));
  assertStringIncludes(html, "someproject.supabase.co");
  // Lookalike domains don't pass the suffix check either.
  const lookalike = await handleSocialRequest(
    new Request(
      "https://someproject.supabase.co/functions/v1/social?link=https://bloomlibrary.org/1&title=T",
      { headers: { "X-Forwarded-Host": "evilbloomlibrary.org" } }
    )
  );
  assert(!(await lookalike.text()).includes("evilbloomlibrary.org"));
});

Deno.test("social - escapes html in parameters", () => {
  const html = createLinkHtml(
    "https://api.bloomlibrary.org/v1/social",
    "https://bloomlibrary.org/1",
    `Book "quoted" <script>`,
    undefined,
    "256",
    "256",
    undefined
  );
  assert(!html.includes("<script>alert"));
  assertStringIncludes(
    html,
    "Book &quot;quoted&quot; &lt;script&gt;"
  );
});
