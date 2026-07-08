import BloomParseServer, { User } from "../_shared/BloomParseServer.ts";
import {
  deleteFilesByPrefix,
  getS3PrefixFromEncodedPath,
  getS3UrlFromPrefix,
} from "../_shared/s3.ts";
import { Environment } from "../_shared/utils.ts";
import {
  createResponseWithAcceptedStatusAndStatusUrl,
  startLongRunningOperation,
} from "../_shared/longRunningOperations.ts";
import { BookUploadErrorCode, handleBookUploadError } from "./utils.ts";

// upload-finish is a long-running function (see the status function).
// The client calls it to finalize the upload of a new or existing book.
// On parse-server, it creates a language record if needed and modifies the book record.
// The reason it is long-running is, for existing books, it deletes the previous copy of the book files on S3.
export async function handleUploadFinish(
  req: Request,
  body: any,
  bookId: string,
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

  if (!bookId) {
    return new Response("book ID is required: /books/{id}:upload-finish", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const metadata = body.metadata;
  if (!metadata) {
    return new Response("Please provide a valid metadata object in the body", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const transactionId = body.transactionId;
  if (!transactionId || transactionId !== bookId) {
    // With this initial implementation, transaction ID is always the book ID.
    // But the API allows for them to be different some day.
    return new Response("Please provide a valid transactionId in the body", {
      status: 400,
      headers: corsHeaders,
    });
  }

  const becomeUploader: boolean = body.becomeUploader === true;

  const instanceId = await startLongRunningOperation(() =>
    longRunningUploadFinish({
      bookRecord: metadata,
      userInfo,
      env,
      bookId,
      becomeUploader,
    })
  );

  return createResponseWithAcceptedStatusAndStatusUrl(
    instanceId,
    publicRequestUrl,
    corsHeaders
  );
}

export async function longRunningUploadFinish(input: {
  bookRecord: any;
  userInfo: User;
  env: Environment;
  bookId: string;
  becomeUploader: boolean;
}) {
  const bookRecord = input.bookRecord;
  const userInfo = input.userInfo;
  const env = input.env;
  const bookId = input.bookId;
  const becomeUploader = input.becomeUploader;
  const parseServer = new BloomParseServer(env);

  const bookInfo = await parseServer.getBookByDatabaseId(bookId);
  const isModerator = await parseServer.isModerator(userInfo);
  if (
    !isModerator &&
    !(await BloomParseServer.isUploaderOrCollectionEditor(userInfo, bookInfo!))
  ) {
    return handleBookUploadError(
      BookUploadErrorCode.UnableToValidatePermission,
      null
    );
  }

  const newBaseUrl = bookRecord?.baseUrl;
  if (newBaseUrl === undefined) {
    return handleBookUploadError(BookUploadErrorCode.MissingBaseUrl, null);
  }

  if (!newBaseUrl.startsWith(getS3UrlFromPrefix(bookId, env))) {
    return handleBookUploadError(BookUploadErrorCode.InvalidBaseUrl, null);
  }

  // For performance reasons, we are letting uploadStart's copy process (for existing, unchanged files)
  // and the client (for new and modified files) set the public-read ACL instead
  // of doing an allowPublicRead pass here.

  const oldBaseURl = bookInfo!.baseUrl;
  const isNewBook = !oldBaseURl;

  if (isNewBook) {
    // Since the creation of a new book is now a two-step process
    // (upload-start creates an empty record and upload-finish fills it in),
    // we need to indicate to the parse cloud code that this is a new book
    // so it can appropriately set the harvestState field.
    bookRecord.updateSource += " (new book)";

    // When upload-start created the initial record, we set inCirculation to false
    // to prevent blorg and other book consumers from showing the book before it's ready.
    // Now that we have a real book ready, we need to set it to true.
    bookRecord.inCirculation = true;
  }

  delete bookRecord.uploader; // don't modify uploader

  if ("languageDescriptors" in bookRecord) {
    bookRecord.langPointers = [];
    for (let i = 0; i < bookRecord.languageDescriptors?.length; i++) {
      const languageId = await parseServer.getOrCreateLanguage(
        bookRecord.languageDescriptors[i]
      );
      bookRecord.langPointers.push({
        __type: "Pointer",
        className: "language",
        objectId: languageId,
      });
    }

    delete bookRecord.languageDescriptors;
  }

  bookRecord.uploadPendingTimestamp = null;
  bookRecord.lastUploaded = {
    __type: "Date",
    iso: new Date().toISOString(),
  };
  if (becomeUploader) {
    bookRecord.uploader = {
      __type: "Pointer",
      className: "_User",
      objectId: userInfo.objectId,
    };

    // Switch ACL (row-level permissions) to the new uploader
    bookRecord.ACL = bookInfo!.ACL;
    bookRecord.ACL[userInfo.objectId] = { write: true };
    delete bookRecord.ACL[bookInfo!.uploader.objectId];
  }
  try {
    let apiSuperUserSessionToken = null;
    if (!isModerator) {
      apiSuperUserSessionToken = await parseServer.loginAsApiSuperUserIfNeeded(
        userInfo,
        bookInfo!
      );
    }
    await parseServer.modifyBookRecord(
      bookId,
      bookRecord,
      apiSuperUserSessionToken ?? userInfo.sessionToken
    );
  } catch (e) {
    return handleBookUploadError(
      BookUploadErrorCode.ErrorUpdatingBookRecord,
      e as Error
    );
  }

  try {
    if (oldBaseURl) {
      const bookPathPrefix = getS3PrefixFromEncodedPath(oldBaseURl, env);
      await deleteFilesByPrefix(bookPathPrefix, env);
    }
  } catch (e) {
    console.log(e);
    // TODO future work: we want this to somehow notify us of the now-orphan old book files
  }
  return {};
}
