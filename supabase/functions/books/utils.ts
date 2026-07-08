import BloomParseServer from "../_shared/BloomParseServer.ts";
import { Environment } from "../_shared/utils.ts";
import { handleError } from "../_shared/longRunningOperations.ts";

export function getIdAndAction(
  idAndAction: string | undefined
): [string | null, string | null] {
  if (!idAndAction) {
    return [null, null];
  }

  // Path is either {id} or {id}:{action}
  const match = idAndAction.match(/^([^:]+)(?::([^:]+))?$/);
  if (!match) {
    return [null, null];
  }
  const id = match[1];
  const action = match[2] || null;

  return [id, action];
}

export async function canClientUpload(version: string, env: Environment) {
  if (!version || typeof version !== "string") {
    return false;
  }
  const versionParts = version.split(".");
  const clientMajorVersion = parseInt(versionParts[0]);
  const clientMinorVersion = parseInt(versionParts[1]);
  if (isNaN(clientMajorVersion) || isNaN(clientMinorVersion)) {
    return false;
  }

  const parseServer = new BloomParseServer(env);
  const versionString = await parseServer.getMinDesktopVersion();
  const requiredVersionParts = versionString.split(".");
  const requiredMajorVersion = parseInt(requiredVersionParts[0]);
  const requiredMinorVersion = parseInt(requiredVersionParts[1]);

  let canUpload;
  if (clientMajorVersion === requiredMajorVersion)
    canUpload = clientMinorVersion >= requiredMinorVersion;
  else canUpload = clientMajorVersion >= requiredMajorVersion;
  return canUpload;
}

export enum BookUploadErrorCode {
  ClientOutOfDate = "ClientOutOfDate",
  UnableToValidatePermission = "UnableToValidatePermission",
  ErrorGeneratingTemporaryCredentials = "ErrorGeneratingTemporaryCredentials",
  MissingBaseUrl = "MissingBaseUrl",
  InvalidBaseUrl = "InvalidBaseUrl",
  ErrorCreatingBookRecord = "ErrorCreatingBookRecord",
  ErrorUpdatingBookRecord = "ErrorUpdatingBookRecord",
  ErrorDeletingPreviousFiles = "ErrorDeletingPreviousFiles",
  ErrorCopyingBookFiles = "ErrorCopyingBookFiles",
  ErrorProcessingFileHashes = "ErrorProcessingFileHashes",
}

export const bookUploadErrorCodeMessageMap = new Map<
  BookUploadErrorCode,
  string
>([
  [
    BookUploadErrorCode.ClientOutOfDate,
    "Sorry, this version of Bloom Desktop is not compatible with the current version of BloomLibrary.org. Please upgrade to a newer version.",
  ],
  [
    BookUploadErrorCode.UnableToValidatePermission,
    "Please provide a valid Authentication-Token and book ID",
  ],
  [
    BookUploadErrorCode.ErrorGeneratingTemporaryCredentials,
    "Error generating temporary credentials",
  ],
  [
    BookUploadErrorCode.MissingBaseUrl,
    "Please provide valid book info, including a baseUrl, in the body",
  ],
  [
    BookUploadErrorCode.InvalidBaseUrl,
    "Invalid book base URL. Please use the prefix provided by the upload-start function",
  ],
  [BookUploadErrorCode.ErrorCreatingBookRecord, "Unable to create book record"],
  [BookUploadErrorCode.ErrorUpdatingBookRecord, "Unable to modify book record"],
  [
    BookUploadErrorCode.ErrorDeletingPreviousFiles,
    "Unable to delete files for previous pending upload",
  ],
  [BookUploadErrorCode.ErrorCopyingBookFiles, "Unable to copy book"],
  [
    BookUploadErrorCode.ErrorProcessingFileHashes,
    "Unable to process file hashes",
  ],
]);

export function handleBookUploadError(
  code: BookUploadErrorCode,
  error: Error | null,
  messageIntendedForUser?: string
) {
  if (error) console.error(error);
  if (messageIntendedForUser) {
    return handleError(code.toString(), bookUploadErrorCodeMessageMap.get(code), [
      "messageIntendedForUser",
      messageIntendedForUser,
    ]);
  } else {
    return handleError(code.toString(), bookUploadErrorCodeMessageMap.get(code));
  }
}
