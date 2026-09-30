// POST /functions/v1/collection-files-start — CONTRACTS.md §collection-files-start/finish
// Req: { collectionId, expectedVersion, files[] } -> two-phase like check-in. files is the
// collection's whole set of collection files, paths relative to the collection folder.
// Admin only (403 admin_required). 409 VersionConflict ⇒ client receives first (repo-wins rule).
import { requireField, serveJsonPost } from "../_shared/tc/handler.ts";
import { jsonResponse } from "../_shared/tc/errors.ts";
import { callTcRpc } from "../_shared/tc/rpc.ts";
import { getScopedCredentials, S3_WRITE_ACTIONS } from "../_shared/tc/s3.ts";
import { collectionFilesPrefix } from "../_shared/tc/paths.ts";

interface CollectionFilesStartResult {
    transactionId: string;
    changedPaths: string[];
}

// Exported so Deno tests can import and call it directly — see checkin-start/index.ts's
// comment on the `import.meta.main` guard below.
export const handler = async (
    req: Request,
    body: Record<string, unknown>,
): Promise<Response> => {
    const collectionId = requireField<string>(body, "collectionId");
    const expectedVersion = requireField<number>(body, "expectedVersion");
    const files = requireField<unknown[]>(body, "files");

    // Get the S3 credentials BEFORE collection_files_start_tx commits an attempt (as
    // checkin-start does), so a credential failure cannot leave an open attempt the
    // client never heard of. If the RPC refuses, these credentials are simply discarded.
    const prefix = collectionFilesPrefix(collectionId);
    const s3 = await getScopedCredentials(prefix, S3_WRITE_ACTIONS);

    const result = await callTcRpc<CollectionFilesStartResult>(
        req,
        "collection_files_start_tx",
        {
            p_collection_id: collectionId,
            p_expected_version: expectedVersion,
            p_files: files,
        },
    );

    return jsonResponse(200, {
        transactionId: result.transactionId,
        changedPaths: result.changedPaths,
        s3,
    });
};

if (import.meta.main) {
    serveJsonPost(handler);
}
