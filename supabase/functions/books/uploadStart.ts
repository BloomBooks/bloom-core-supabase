import BloomParseServer, { User } from "../_shared/BloomParseServer.ts";
import {
  IBookFileInfo,
  copyBook,
  deleteFilesByPrefix,
  getS3PrefixFromEncodedPath,
  getS3UrlFromPrefix,
  getTemporaryS3Credentials,
  isArrayOfIBookFileInfo,
  processFileHashes,
} from "../_shared/s3.ts";
import { Environment } from "../_shared/utils.ts";
import {
  createResponseWithAcceptedStatusAndStatusUrl,
  startLongRunningOperation,
} from "../_shared/longRunningOperations.ts";
import {
  BookUploadErrorCode,
  handleBookUploadError,
  canClientUpload,
} from "./utils.ts";

const kPendingString = "pending";

// upload-start is a long-running function (see the status function).
// The client calls it to initiate the upload of a new or existing book.
// It creates or modifies a book record in Parse, and returns an S3 URL and credentials to upload files.
// The reason it is long-running is, for existing books, it copies the existing book files to a new folder.
// That copy will be the starting point for the client to sync book files to S3.
export async function handleUploadStart(
  req: Request,
  body: any,
  bookIdOrNew: string,
  userInfo: User,
  env: Environment,
  publicRequestUrl: string,
  corsHeaders: Record<string, string>
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Unhandled HTTP method", {
      status: 400,
      headers: corsHeaders,
    });
  }

  if (!bookIdOrNew) {
    return new Response(
      'book ID is required: /books/{id}:upload-start (id is "new" for a new book)',
      { status: 400, headers: corsHeaders }
    );
  }

  // The new API design is for "name", but we first implemented it with "title".
  // So we accept either for now. With the next breaking change, we can remove "title".
  const bookTitle: string = body["name"] || body["title"] || "";

  let bookFiles: IBookFileInfo[];
  try {
    bookFiles = JSON.parse(body["files"]);
    if (!bookFiles?.length || !isArrayOfIBookFileInfo(bookFiles))
      throw new Error();
  } catch (_error) {
    // Handle parsing/validation errors
    return new Response(
      '"files" must be an array of objects, each with a path and hash property',
      { status: 400, headers: corsHeaders }
    );
  }

  const bloomClientVersion = body["clientVersion"];

  const instanceId = await startLongRunningOperation(() =>
    longRunningUploadStart({
      bookIdOrNew,
      bookTitle,
      bookFiles,
      bloomClientVersion,
      userInfo,
      env,
    })
  );

  return createResponseWithAcceptedStatusAndStatusUrl(
    instanceId,
    publicRequestUrl,
    corsHeaders
  );
}

export async function longRunningUploadStart(input: {
  bookIdOrNew: string;
  bookTitle: string | undefined;
  bookFiles: IBookFileInfo[] | undefined;
  bloomClientVersion: string;
  userInfo: User;
  env: Environment;
}) {
  const userInfo = input.userInfo;
  const env = input.env;
  const bookIdOrNew = input.bookIdOrNew;
  const parseServer = new BloomParseServer(env);

  const currentTime = Date.now();

  const canUpload = await canClientUpload(input.bloomClientVersion, env);
  if (!canUpload) {
    return handleBookUploadError(BookUploadErrorCode.ClientOutOfDate, null);
  }

  const isNewBook = bookIdOrNew === "new";
  let bookId: string;
  if (isNewBook) {
    const newBookRecord = {
      title: kPendingString,
      bookInstanceId: kPendingString,
      updateSource: "BloomDesktop via API",
      uploadPendingTimestamp: currentTime,
      inCirculation: false, // prevent various things from displaying it until upload-finish makes it a complete record
      uploader: {
        __type: "Pointer",
        className: "_User",
        objectId: userInfo.objectId,
      },
    };

    try {
      bookId = await parseServer.createBookRecord(
        newBookRecord,
        userInfo.sessionToken
      );
    } catch (err) {
      return handleBookUploadError(
        BookUploadErrorCode.ErrorCreatingBookRecord,
        err as Error
      );
    }
  } else {
    // We'll look it up below which will serve to validate it as a real, single, book ID.
    bookId = bookIdOrNew;
  }

  let bookFilesParentDirectory = input.bookTitle;
  if (bookFilesParentDirectory && !bookFilesParentDirectory.endsWith("/"))
    bookFilesParentDirectory += "/";

  const newS3Prefix = `${bookId}/${currentTime}/`;

  let filesToUpload: string[] = [];
  if (isNewBook) {
    // Some day we may have more complicated logic, including being able to restart a failed upload.
    // But for now, this is a simple pass-through of the files the client sent.
    filesToUpload = input.bookFiles!.map((file) => file.path);
  } else {
    // We are modifying an existing book.
    // Check that we have permission,
    // then copy unmodified book files to the new folder for a more efficient upload.
    // (So the client only has to upload new or modified files.)
    const existingBookInfo = await parseServer.getBookByDatabaseId(bookId);
    const isModerator = await parseServer.isModerator(userInfo);
    if (
      !isModerator &&
      !(await BloomParseServer.isUploaderOrCollectionEditor(
        userInfo,
        existingBookInfo!
      ))
    ) {
      return handleBookUploadError(
        BookUploadErrorCode.UnableToValidatePermission,
        null
      );
    }

    // In the form bookObjectId/timestamp/
    const existingS3Prefix = getS3PrefixFromEncodedPath(
      existingBookInfo!.baseUrl,
      env
    );

    // Delete any prior incomplete upload(s) for this book.
    // In other words, delete all the files under our book ID except the ones with the timestamp in the current baseUrl.
    // We will set a new uploadPendingTimestamp below which will be used for the new set of files.
    if (existingBookInfo!.uploadPendingTimestamp) {
      try {
        const prefixToDelete = bookId;
        const prefixToExclude = existingS3Prefix;
        await deleteFilesByPrefix(prefixToDelete, env, prefixToExclude);
      } catch (err) {
        return handleBookUploadError(
          BookUploadErrorCode.ErrorDeletingPreviousFiles,
          err as Error
        );
      }
    }

    try {
      let apiSuperUserSessionToken = null;
      if (!isModerator) {
        apiSuperUserSessionToken =
          await parseServer.loginAsApiSuperUserIfNeeded(
            userInfo,
            existingBookInfo!
          );
      }
      await parseServer.modifyBookRecord(
        bookId,
        {
          uploadPendingTimestamp: currentTime,
        },
        apiSuperUserSessionToken ?? userInfo.sessionToken
      );
    } catch (err) {
      return handleBookUploadError(
        BookUploadErrorCode.ErrorUpdatingBookRecord,
        err as Error
      );
    }

    let filesToCopy: string[] = [];
    try {
      [filesToUpload, filesToCopy] = await processFileHashes(
        input.bookFiles!,
        existingS3Prefix,
        env
      );
    } catch (err) {
      return handleBookUploadError(
        BookUploadErrorCode.ErrorProcessingFileHashes,
        err as Error
      );
    }

    if (filesToCopy.length) {
      try {
        // existingBookPath is in the form bookId/timestamp/title.
        // s3Prefix only has bookId/timestamp.
        // The client must provide the new title (bookFilesParentDirectory); it could have changed.
        await copyBook(
          existingS3Prefix,
          newS3Prefix + bookFilesParentDirectory,
          filesToCopy,
          env
        );
      } catch (err) {
        return handleBookUploadError(
          BookUploadErrorCode.ErrorCopyingBookFiles,
          err as Error
        );
      }
    }
  }

  let tempCredentials;
  try {
    tempCredentials = await getTemporaryS3Credentials(newS3Prefix, env);
  } catch (err) {
    return handleBookUploadError(
      BookUploadErrorCode.ErrorGeneratingTemporaryCredentials,
      err as Error
    );
  }

  const s3Path = getS3UrlFromPrefix(newS3Prefix, env);
  const body = {
    transactionId: bookId,
    credentials: tempCredentials,
    url: s3Path + bookFilesParentDirectory,
    filesToUpload,
  };
  return body;
}
