import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";
import { getCorsHeaders, getEnvironment } from "../_shared/utils.ts";

// Replaces the legacy Parse cloud function `sendConcernEmail` (bloom-parse-server,
// cloud/emails.js). A blorg visitor fills out a "report a concern about this book"
// form; we email the report to the Bloom team via a Mailgun template.
//
// Request: POST JSON { fromAddress, content, bookId }
// - fromAddress: the reporter's email (blorg passes the logged-in user's address).
//   Used as the outgoing email's "from" - there is no server-side account to
//   attribute this to since blorg users still authenticate via Parse, not Supabase.
// - content: the reporter's free-text description of the concern.
// - bookId: the Parse objectId of the book being reported.
//
// TODO: once blorg authenticates via Supabase Auth (see FUNCTIONS-MIGRATION-PLAN.md),
// require a Supabase JWT here and derive fromAddress from it instead of trusting the
// request body. Legacy had no server-side auth at all (only blorg's UI gated this
// behind login); this preserves that behavior for now rather than breaking blorg's
// existing flow ahead of the auth cutover.

const MAX_CONTENT_LENGTH = 5000;

// Parse's default objectId shape: 10 alphanumeric characters.
const BOOK_ID_PATTERN = /^[A-Za-z0-9]{10}$/;

// Not full RFC 5322 - just enough to reject obvious garbage. Deliberately permissive;
// Mailgun/the recipient's mail server is the real authority on validity.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ConcernEmailRequestBody {
  fromAddress?: unknown;
  content?: unknown;
  bookId?: unknown;
}

function jsonResponse(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string>
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...extraHeaders, "Content-Type": "application/json" },
  });
}

// Returns an error message if invalid, or null if the value is a usable book id.
function validateBookId(value: unknown): string | null {
  if (typeof value !== "string" || !BOOK_ID_PATTERN.test(value)) {
    return "bookId is required and must be a valid book id.";
  }
  return null;
}

function validateContent(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "content is required.";
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    return `content must be ${MAX_CONTENT_LENGTH} characters or fewer.`;
  }
  return null;
}

function validateFromAddress(value: unknown): string | null {
  if (typeof value !== "string" || !EMAIL_PATTERN.test(value)) {
    return "fromAddress is required and must be a valid email address.";
  }
  return null;
}

// The variables handed to the Mailgun "report-a-book" template (and to the plain-text
// fallback below). Field names/fallback text match the legacy template exactly.
function buildTemplateVariables(
  book: Book,
  reportContent: string
): Record<string, string> {
  return {
    title: book.title || "unknown title",
    copyright: book.copyright || "unknown copyright",
    license: book.license || "unknown license",
    uploader: book.uploader?.username || "unknown uploader",
    url: `https://bloomlibrary.org/book/${book.objectId}`,
    body: reportContent,
  };
}

// Fallback plain-text body, for Mailgun environments where the "report-a-book"
// dashboard template hasn't been configured (e.g. some test/sandbox domains).
// Assembled from the same variables as the template so the two stay in sync.
function buildTextFallback(vars: Record<string, string>): string {
  return (
    `A concern was reported about a Bloom Library book.\n\n` +
    `Title: ${vars.title}\n` +
    `Copyright: ${vars.copyright}\n` +
    `License: ${vars.license}\n` +
    `Uploader: ${vars.uploader}\n` +
    `URL: ${vars.url}\n\n` +
    `Reported concern:\n${vars.body}\n`
  );
}

// Sends the report via the Mailgun REST API directly (no mailgun-js dependency -
// it's deprecated). Returns without making a network call if either MAILGUN_API_KEY
// or EMAIL_REPORT_BOOK_RECIPIENT is unset, logging instead - this mirrors the legacy
// cloud function's no-op behavior on the unit-test Parse server, where those env
// vars are deliberately left unset.
export async function sendConcernEmail(
  fromAddress: string,
  book: Book,
  reportContent: string
): Promise<void> {
  const apiKey = Deno.env.get("MAILGUN_API_KEY");
  const recipient = Deno.env.get("EMAIL_REPORT_BOOK_RECIPIENT");

  if (!apiKey) {
    console.log(
      "MAILGUN_API_KEY is not set; sendConcernEmail will just log and no-op."
    );
    return;
  }
  if (!recipient) {
    console.log(
      "EMAIL_REPORT_BOOK_RECIPIENT is not set; sendConcernEmail will just log and no-op."
    );
    return;
  }

  const vars = buildTemplateVariables(book, reportContent);

  const form = new URLSearchParams();
  form.set("from", fromAddress);
  form.set("to", recipient);
  form.set("subject", `[BloomLibrary] Book reported - ${vars.title}`);
  form.set("template", "report-a-book");
  form.set("h:X-Mailgun-Variables", JSON.stringify(vars));
  form.set("text", buildTextFallback(vars));

  const response = await fetch(
    "https://api.mailgun.net/v3/bloomlibrary.org/messages",
    {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`api:${apiKey}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `Mailgun request failed: ${response.status} ${errorText}`
    );
    throw new Error(`Mailgun request failed: ${response.status}`);
  }
}

// Exported separately from index.ts so tests can exercise it with plain Request objects.
export async function handleSendConcernEmailRequest(
  req: Request
): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed" },
      405,
      { ...corsHeaders, Allow: "POST, OPTIONS" }
    );
  }

  let body: ConcernEmailRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, corsHeaders);
  }

  const bookIdError = validateBookId(body.bookId);
  if (bookIdError) {
    return jsonResponse({ error: bookIdError }, 400, corsHeaders);
  }
  const contentError = validateContent(body.content);
  if (contentError) {
    return jsonResponse({ error: contentError }, 400, corsHeaders);
  }
  const fromAddressError = validateFromAddress(body.fromAddress);
  if (fromAddressError) {
    return jsonResponse({ error: fromAddressError }, 400, corsHeaders);
  }

  const bookId = body.bookId as string;
  const content = body.content as string;
  const fromAddress = body.fromAddress as string;

  let book: Book | undefined;
  try {
    const parseServer = new BloomParseServer(getEnvironment(req));
    book = await parseServer.getBookByDatabaseId(bookId, ["uploader"]);
  } catch (error) {
    console.error("Error looking up book for concern email:", error);
    return jsonResponse({ error: "Internal Server Error" }, 500, corsHeaders);
  }

  if (!book) {
    return jsonResponse({ error: "Book not found" }, 404, corsHeaders);
  }

  try {
    await sendConcernEmail(fromAddress, book, content);
  } catch (error) {
    console.error("Error sending concern email:", error);
    return jsonResponse({ error: "Internal Server Error" }, 500, corsHeaders);
  }

  return jsonResponse({ success: true }, 200, corsHeaders);
}
