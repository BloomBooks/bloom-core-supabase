import BloomParseServer, { User } from "../_shared/BloomParseServer.ts";
import {
  Environment,
  getCorsHeaders,
  getEnvironment,
  getPublicUrl,
} from "../_shared/utils.ts";
import { handleUploadStart } from "./uploadStart.ts";
import { handleUploadFinish } from "./uploadFinish.ts";
import { getIdAndAction } from "./utils.ts";
import {
  ApiQueryParams,
  convertApiQueryParamsIntoParseAdditionalParams,
  convertApiQueryParamsIntoParseWhere,
  convertExpandParamToParseFields,
  reshapeBookRecord,
} from "./parseAdapters.ts";

// The main book API:
//   GET  /books                     - query a collection of books
//   POST /books                     - like GET, but instanceIds can come in the body
//   GET  /books/{id}                - one book
//   GET  /books/{id}:permissions    - the caller's permissions on the book
//   POST /books/{id}:upload-start   - begin a book upload (long-running; see status function)
//   POST /books/{id}:upload-finish  - finalize a book upload (long-running)
//   DELETE /books/{id}              - delete a book
export async function handleBooksRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const env = getEnvironment(req);
  const parseServer = new BloomParseServer(env);

  const publicUrl = getPublicUrl(req);

  // path is .../books or .../books/{id-and-action}
  const pathSegments = publicUrl.pathname
    .split("/")
    .filter((segment) => segment !== "");
  const booksIndex = pathSegments.findIndex((segment) => segment === "books");
  const idAndActionSegment =
    booksIndex >= 0 && pathSegments.length > booksIndex + 1
      ? decodeURIComponent(pathSegments[booksIndex + 1])
      : undefined;
  const [bookDatabaseId, action] = getIdAndAction(idAndActionSegment);

  let body: any;
  if (req.method === "POST" || req.method === "DELETE") {
    body = await req.json().catch(() => ({}));
  }

  let userInfo: User | null = null;
  if (requiresAuthentication(req.method, action)) {
    userInfo = await getUserFromSession(parseServer, req);
    // for actions for which we need to validate the authentication token
    if (!userInfo) {
      return new Response(
        "Unable to validate user. Did you include a valid Authentication-Token header?",
        { status: 400, headers: corsHeaders }
      );
    }
  }

  if (bookDatabaseId) {
    // Do this before validating the book ID; see comment about 204/404 in handleDelete.
    if (req.method === "DELETE")
      return await handleDelete(
        userInfo!,
        bookDatabaseId,
        parseServer,
        corsHeaders
      );

    if (!isValidBookId(bookDatabaseId)) {
      return new Response("Invalid book ID", {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (!action) {
      // Query for a specific book
      return await handleGetOneBook(
        bookDatabaseId,
        publicUrl.searchParams.get("expand") ?? undefined,
        parseServer,
        corsHeaders
      );
    }

    switch (action) {
      case "upload-start":
        return await handleUploadStart(
          req,
          body,
          bookDatabaseId,
          userInfo!,
          env,
          publicUrl.toString(),
          corsHeaders
        );
      case "upload-finish":
        return await handleUploadFinish(
          req,
          body,
          bookDatabaseId,
          userInfo!,
          env,
          publicUrl.toString(),
          corsHeaders
        );
      case "permissions":
        return await handlePermissions(
          userInfo!,
          bookDatabaseId,
          parseServer,
          corsHeaders
        );

      default:
        return new Response("Invalid action type", {
          status: 400,
          headers: corsHeaders,
        });
    }
  }

  // Endpoint is /books
  // i.e. no book ID, no action
  // We are querying for a collection of books.
  return await findBooks(req, body, publicUrl, parseServer, corsHeaders);
}

async function findBooks(
  req: Request,
  body: any,
  publicUrl: URL,
  parseServer: BloomParseServer,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const query: ApiQueryParams = Object.fromEntries(
    publicUrl.searchParams.entries()
  );

  // Hacking in this specific use case for now.
  // This is used by the editor to get the count of books in a language.
  if (
    query.lang &&
    query.limit &&
    query.limit === "0" &&
    query.count &&
    query.count === "true"
  ) {
    const count = await parseServer.getBookCountByLanguage(query.lang);
    return new Response(
      // A GET/POST to /books always returns an array of books, even if it's empty.
      // In this temporary, hacked use case, it is always empty.
      JSON.stringify({ results: [], count }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (req.method === "POST" && body?.instanceIds?.length) {
    // POST to /books is a special case.
    // We treat it basically the same as a GET, but know we have to look
    // for something (so far, just instanceIds) in the body to tell us which books to return
    // (rather than just the query parameters).
    // We use a POST because the list of instanceIds might be too long for a GET request.
    // This is used by the editor to get a set of books by bookInstanceIds for the blorg status badges.
    query.instanceIds = body.instanceIds.join(",");
  }
  const where = convertApiQueryParamsIntoParseWhere(query);
  const rawBookRecordsAndCount = await parseServer.getBooks(
    where,
    convertExpandParamToParseFields(query.expand),
    convertApiQueryParamsIntoParseAdditionalParams(query)
  );

  const isForClientUnitTest =
    parseServer.getEnvironment() === Environment.UNITTEST;
  const bookRecords = rawBookRecordsAndCount.books.map((book) =>
    reshapeBookRecord(book, query.expand ?? null, isForClientUnitTest)
  );

  return new Response(
    // Properties aren't included in objects if the value is undefined, so count
    // won't be returned if it is undefined (meaning the user didn't ask for it).
    JSON.stringify({ results: bookRecords, count: rawBookRecordsAndCount.count }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

async function handlePermissions(
  userInfo: User,
  bookDatabaseId: string,
  parseServer: BloomParseServer,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const bookInfo = await parseServer.getBookByDatabaseId(bookDatabaseId);

  if (!bookInfo) {
    return new Response("Invalid book ID", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const isModerator = await parseServer.isModerator(userInfo);
  if (isModerator) {
    return new Response(
      JSON.stringify({
        reupload: true,
        becomeUploader: true,
        delete: true,
        editSurfaceMetadata: true,
        editAllMetadata: true,
      }),
      { status: 200, headers: jsonHeaders }
    );
  }

  const isUploaderOrCollectionEditor =
    await BloomParseServer.isUploaderOrCollectionEditor(userInfo, bookInfo);
  return new Response(
    JSON.stringify({
      // Must be uploader or collection editor
      reupload: isUploaderOrCollectionEditor,
      becomeUploader: isUploaderOrCollectionEditor,
      delete: isUploaderOrCollectionEditor,
      editSurfaceMetadata: isUploaderOrCollectionEditor,

      // Must be moderator
      editAllMetadata: false,
    }),
    { status: 200, headers: jsonHeaders }
  );
}

async function handleGetOneBook(
  bookDatabaseId: string,
  expandParam: string | undefined,
  parseServer: BloomParseServer,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const parseFieldsToExpand = convertExpandParamToParseFields(expandParam);

  const rawParseBook = await parseServer.getBookByDatabaseId(
    bookDatabaseId,
    parseFieldsToExpand
  );
  if (!rawParseBook) {
    return new Response("Book not found", {
      status: 404,
      headers: corsHeaders,
    });
  }
  const isForClientUnitTest =
    parseServer.getEnvironment() === Environment.UNITTEST;
  const bookRecord = reshapeBookRecord(
    rawParseBook,
    expandParam ?? null,
    isForClientUnitTest
  );
  return new Response(JSON.stringify(bookRecord), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function handleDelete(
  userInfo: User,
  bookDatabaseId: string,
  parseServer: BloomParseServer,
  corsHeaders: Record<string, string>
): Promise<Response> {
  try {
    const bookInfo = await parseServer.getBookByDatabaseId(bookDatabaseId, [
      "uploader",
    ]);

    if (bookInfo) {
      const isUploaderOrCollectionEditor =
        await BloomParseServer.isUploaderOrCollectionEditor(userInfo, bookInfo);

      let isModerator = false;
      if (!isUploaderOrCollectionEditor) {
        isModerator = await parseServer.isModerator(userInfo);
      }

      if (isUploaderOrCollectionEditor || isModerator) {
        let superUserSessionToken = null;
        if (!isModerator) {
          // Moderators and the book uploader have row-level permission to modify or delete
          // the book record in the database. Users who have permission to modify the book because they are
          // collection editors must make use of the super user to gain that permission in the database.
          superUserSessionToken = await parseServer.loginAsApiSuperUserIfNeeded(
            userInfo,
            bookInfo
          );
        }

        await parseServer.deleteBookRecord(
          bookDatabaseId,
          superUserSessionToken ?? userInfo.sessionToken
        );
      } else {
        return new Response(null, { status: 403, headers: corsHeaders }); // Forbidden
      }
    }

    // Return 204 even if the book wasn't found.
    // That's on the recommendation of https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md
    // which we've generally been trying to follow.
    return new Response(null, { status: 204, headers: corsHeaders });
  } catch (e) {
    // This shouldn't happen. If the book record isn't there, we should have failed to get the book info above
    // (and returned a 204).
    // But in case two deletes happen at almost the same time, handle it again here.
    if ((e as { status?: number }).status === 404) {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    return new Response("Unable to delete book", {
      status: 500,
      headers: corsHeaders,
    });
  }
}

// Validate the session token and return the user info
async function getUserFromSession(
  parseServer: BloomParseServer,
  req: Request
): Promise<User | null> {
  let authenticationToken: string | null;
  if (parseServer.getEnvironment() === Environment.UNITTEST) {
    authenticationToken = await parseServer.loginAsUnitTestUser();
  } else {
    authenticationToken = req.headers.get("authentication-token");
  }
  if (!authenticationToken) return null;
  return await parseServer.getLoggedInUserInfo(authenticationToken);
}

// We want this written in such a way that new actions require authentication by default.
function requiresAuthentication(
  method: string,
  action: string | null
): boolean {
  if (method === "DELETE") return true;

  // Usually any POST request would need authentication,
  // but we use POST when the url might be too long for a GET request.

  if (action) return true;

  return false;
}

function isValidBookId(bookDatabaseId: string): boolean {
  // Special case
  if (bookDatabaseId === "new") return true;

  // Check that it's a valid parse database ID
  return BloomParseServer.isValidDatabaseId(bookDatabaseId);
}
