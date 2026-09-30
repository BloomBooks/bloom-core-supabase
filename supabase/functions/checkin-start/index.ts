// POST /functions/v1/checkin-start — CONTRACTS.md §checkin-start
//
// Req: { collectionId, instanceId, proposedName, baseVersion?, checksum, clientVersion,
//        files: [{path, sha256, size}], checkoutGuid? }
// 200: { transactionId, changedPaths[], s3: { bucket, region, prefix, credentials } }
//      (check-in never issues a checkout GUID; the client makes its own for checkout_book)
// Errors: 400 InvalidManifest · 401/403 · 404 book_not_found ·
//         409 LockHeldByOther/CheckoutElsewhere/BaseVersionSuperseded · 426 ClientOutOfDate.
import {
    optionalField,
    requireField,
    serveJsonPost,
} from "../_shared/tc/handler.ts";
import { jsonResponse } from "../_shared/tc/errors.ts";
import { callTcRpc } from "../_shared/tc/rpc.ts";
import { getScopedCredentials, S3_WRITE_ACTIONS } from "../_shared/tc/s3.ts";
import { bookPrefix } from "../_shared/tc/paths.ts";

interface CheckinStartResult {
    transactionId: string;
    changedPaths: string[];
}

// Exported (rather than only passed inline to serveJsonPost) so Deno tests can import
// and call it directly with a mocked Request, without triggering Deno.serve — see the
// `import.meta.main` guard below.
export const handler = async (
    req: Request,
    body: Record<string, unknown>,
): Promise<Response> => {
    const collectionId = requireField<string>(body, "collectionId");
    const instanceId = requireField<string>(body, "instanceId");
    const proposedName = requireField<string>(body, "proposedName");
    const checksum = requireField<string>(body, "checksum");
    const clientVersion = requireField<string>(body, "clientVersion");
    const files = requireField<unknown[]>(body, "files");
    const baseVersion = optionalField<number>(body, "baseVersion");
    // The book folder's .checkout GUID, if the client holds the book (CONTRACTS.md,
    // "Checkout GUID").
    const checkoutGuid = optionalField<string>(body, "checkoutGuid");

    // Get the S3 credentials BEFORE calling checkin_start_tx, so nothing that can fail
    // happens after the RPC has committed (a lost response then only means a resumable
    // start). If the RPC refuses, these credentials are simply discarded (never returned).
    //
    // The book is named by (collectionId, instanceId), and checkin_start_tx checks or
    // creates exactly that book, so the credentials are scoped to the book the RPC
    // authorizes (it refuses a non-member, a book held by someone else, and a deleted one).
    const prefix = bookPrefix(collectionId, instanceId);
    const s3 = await getScopedCredentials(prefix, S3_WRITE_ACTIONS);

    const result = await callTcRpc<CheckinStartResult>(
        req,
        "checkin_start_tx",
        {
            p_collection_id: collectionId,
            p_instance_id: instanceId,
            p_proposed_name: proposedName,
            p_base_version: baseVersion,
            p_checksum: checksum,
            p_client_version: clientVersion,
            p_files: files,
            p_checkout_guid: checkoutGuid,
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
