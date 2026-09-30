// POST /functions/v1/checkin-finish — CONTRACTS.md §checkin-finish
//
// Req: { transactionId, comment?, keepCheckedOut? }
// Verifies each changed object's sha256 attribute server-side, captures S3
// version-ids, then commits the single atomic DB transaction (tc.checkin_finish_tx).
// 200: { version } · 409 MissingOrBadUploads { paths[], stalePaths? } (stalePaths: uploads
// older than the commit window, see uploadWindows.ts) · 409 transaction_aborted (a newer
// checkin-start replaced this attempt) · 410 expired.
import {
    optionalField,
    requireField,
    serveJsonPost,
} from "../_shared/tc/handler.ts";
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
import { resolveBookPrefix } from "../_shared/tc/paths.ts";
import { s3Env } from "../_shared/tc/env.ts";

interface CheckinAttemptRow {
    id: string;
    collection_id: string;
    book_id: string;
    changed_paths: string[];
    proposed_files: { path: string; sha256: string; size: number }[];
    status: string;
}

interface CheckinFinishResult {
    version: number;
    manifest?: unknown;
}

// Exported so Deno tests can import and call it directly with a mocked Request,
// without triggering Deno.serve — see the `import.meta.main` guard below.
export const handler = async (
    req: Request,
    body: Record<string, unknown>,
): Promise<Response> => {
    const transactionId = requireField<string>(body, "transactionId");
    const comment = optionalField<string>(body, "comment");
    const keepCheckedOut = Boolean(body["keepCheckedOut"]);

    // Who is calling, established from their own JWT (see rpc.ts). Done first so a bad
    // token is rejected before any S3 work.
    const caller = await callerIdentity(req);

    // Read back our own attempt (RLS restricts this to rows we started) so we know which
    // S3 objects to verify — checkin-finish's request body carries no file list per
    // CONTRACTS.md. An attempt's proposal never changes once made (a start that proposes
    // something else aborts it and opens another), so what we verify is what the RPC
    // commits, or the RPC refuses the attempt as aborted.
    const tx = await selectTcRow<CheckinAttemptRow>(
        req,
        "checkin_attempts",
        `id=eq.${transactionId}&select=id,collection_id,book_id,changed_paths,proposed_files,status`,
    );
    if (!tx) {
        throw new HttpError(404, { error: "transaction_not_found" });
    }

    const prefix = await resolveBookPrefix(req, tx.collection_id, tx.book_id);
    const { bucket } = s3Env();
    const client = adminS3Client();

    // Verify every changed path against S3; anything that fails is simply omitted
    // from `captured` — tc.checkin_finish_tx independently detects and reports the
    // gap as 409 MissingOrBadUploads, so there is no duplicated logic here. An upload too
    // old to commit safely (the stale-upload sweep may delete it; see uploadWindows.ts) is
    // omitted too, and named in that error's `stalePaths`.
    const { captured, stalePaths } = await captureVerifiedUploads(
        client,
        bucket,
        prefix,
        tx.changed_paths,
        tx.proposed_files,
    );

    // Service-role call: checkin_finish_tx trusts p_captured, so only this function
    // (which has just verified those uploads) may call it. The RPC itself re-checks
    // that caller.userId started the attempt and still holds the book's lock.
    const result = await callTcServiceRpc<CheckinFinishResult>(
        "checkin_finish_tx",
        {
            p_transaction_id: transactionId,
            p_user_id: caller.userId,
            p_comment: comment,
            p_keep_checked_out: keepCheckedOut,
            p_captured: captured,
        },
    ).catch((e) => {
        throw withStalePaths(e, stalePaths);
    });

    if (result.manifest) {
        // Best-effort backup; never blocks the response (see writeManifestBackup).
        await writeManifestBackup(client, bucket, prefix, result.version, result.manifest);
    }

    return jsonResponse(200, { version: result.version });
};

if (import.meta.main) {
    serveJsonPost(handler);
}
