// POST /functions/v1/collection-files-finish — CONTRACTS.md §collection-files-start/finish
// Req: { transactionId } -> bumps the collection files' version atomically. Admin only.
// 409 VersionConflict ⇒ client receives first (repo-wins rule); 409 MissingOrBadUploads
// { paths[], stalePaths? } (stalePaths: uploads older than the commit window, uploadWindows.ts).
// 409 transaction_aborted: a newer collection-files-start replaced this attempt.
import { requireField, serveJsonPost } from "../_shared/tc/handler.ts";
import { HttpError, jsonResponse } from "../_shared/tc/errors.ts";
import {
    callerIdentity,
    callTcServiceRpc,
    selectTcRow,
} from "../_shared/tc/rpc.ts";
import {
    adminS3Client,
    captureVerifiedUploads,
    withStalePaths,
    writeManifestBackup,
} from "../_shared/tc/s3.ts";
import { collectionFilesPrefix } from "../_shared/tc/paths.ts";
import { s3Env } from "../_shared/tc/env.ts";

interface CollectionFileAttemptRow {
    id: string;
    collection_id: string;
    changed_paths: string[];
    proposed_files: { path: string; sha256: string; size: number }[];
}

interface CollectionFilesFinishResult {
    version: number;
    manifest?: unknown;
}

// Exported so Deno tests can import and call it directly — see checkin-start/index.ts's
// comment on the `import.meta.main` guard below.
export const handler = async (
    req: Request,
    body: Record<string, unknown>,
): Promise<Response> => {
    const transactionId = requireField<string>(body, "transactionId");

    // See checkin-finish: identity from the caller's own JWT, before any S3 work.
    const caller = await callerIdentity(req);

    const tx = await selectTcRow<CollectionFileAttemptRow>(
        req,
        "collection_file_checkin_attempts",
        `id=eq.${transactionId}&select=id,collection_id,changed_paths,proposed_files`,
    );
    if (!tx) {
        throw new HttpError(404, { error: "transaction_not_found" });
    }

    const prefix = collectionFilesPrefix(tx.collection_id);
    const { bucket } = s3Env();
    const client = adminS3Client();

    // Same skip-unverified (and skip-too-old) semantics as checkin-finish — see
    // captureVerifiedUploads.
    const { captured, stalePaths } = await captureVerifiedUploads(
        client,
        bucket,
        prefix,
        tx.changed_paths,
        tx.proposed_files,
    );

    // Service-role call, for the same reason as in checkin-finish.
    const result = await callTcServiceRpc<CollectionFilesFinishResult>(
        "collection_files_finish_tx",
        {
            p_transaction_id: transactionId,
            p_user_id: caller.userId,
            p_captured: captured,
        },
    ).catch((e) => {
        throw withStalePaths(e, stalePaths);
    });

    if (result.manifest) {
        await writeManifestBackup(client, bucket, prefix, result.version, result.manifest);
    }

    return jsonResponse(200, { version: result.version });
};

if (import.meta.main) {
    serveJsonPost(handler);
}
