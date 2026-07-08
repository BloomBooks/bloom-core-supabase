import BloomParseServer from "../_shared/BloomParseServer.ts";
import { deleteFilesByPrefix } from "../_shared/s3.ts";
import { Environment } from "../_shared/utils.ts";

// Cleans up abandoned uploads: finds books whose uploadPendingTimestamp is more
// than a day old, deletes their partial S3 files, and either deletes the
// never-completed book record (if it has no baseUrl) or clears the pending
// timestamp.
//
// safeMode logs what would be done without doing it. Unlike the Azure version
// (where the equivalent flag was a hardcoded constant), it is a parameter so a
// staging run can be verified harmlessly.
export async function bookCleanupInternal(
  env: Environment,
  runInSafeMode: boolean,
  log: (message: string) => void
): Promise<void> {
  const parseServer = new BloomParseServer(env);

  const sessionToken = await parseServer.loginAsBookCleanupUser();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 1 day ago
  const booksToBeCleanedUp = (
    await parseServer.getBooks(`{"uploadPendingTimestamp":{"$lt":${cutoff}}}`)
  ).books;
  for (const book of booksToBeCleanedUp) {
    const bookPrefixToDelete = `${book.objectId}/${book.uploadPendingTimestamp}`;
    if (!runInSafeMode) {
      // Delete files from S3 for partial upload.
      await deleteFilesByPrefix(bookPrefixToDelete, env);
    }
    log(
      `${
        runInSafeMode ? "Safe Mode. Would have deleted" : "Deleted"
      } files with prefix ${bookPrefixToDelete} from S3.`
    );

    if (book.baseUrl === undefined) {
      if (!runInSafeMode) {
        // Delete new book record which was never fully created.
        await parseServer.deleteBookRecord(book.objectId, sessionToken);
      }
      log(
        `${
          runInSafeMode ? "Safe Mode. Would have deleted" : "Deleted"
        } book record with ID ${book.objectId}.`
      );
    } else {
      if (!runInSafeMode) {
        // Update book record to remove uploadPendingTimestamp.
        await parseServer.modifyBookRecord(
          book.objectId,
          {
            uploadPendingTimestamp: null,
          },
          sessionToken
        );
      }
      log(
        `${
          runInSafeMode ? "Safe Mode. Would have updated" : "Updated"
        } book record with ID ${
          book.objectId
        } to remove uploadPendingTimestamp.`
      );
    }
  }
}
