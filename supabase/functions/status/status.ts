import { getCorsHeaders } from "../_shared/utils.ts";
import { getOperation } from "../_shared/longRunningOperations.ts";

// Polling endpoint for long-running operations (see _shared/longRunningOperations.ts).
// URL format: /v1/status/{operation-id}
// Preserves the Azure Durable Functions status API's response shapes exactly.
export async function handleStatusRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const pathSegments = new URL(req.url).pathname
    .split("/")
    .filter((segment) => segment !== "");
  const statusIndex = pathSegments.findIndex(
    (segment) => segment === "status"
  );
  const operationId =
    statusIndex >= 0 && pathSegments.length > statusIndex + 1
      ? decodeURIComponent(pathSegments[statusIndex + 1])
      : undefined;

  if (!operationId) {
    return new Response("Provide a valid operation-id", {
      status: 400,
      headers: corsHeaders,
    });
  }

  let operation;
  try {
    operation = await getOperation(operationId);
  } catch (_e) {
    operation = null; // e.g. not a valid uuid
  }
  if (!operation) {
    return new Response("Status not found for the given operation-id", {
      status: 404,
      headers: corsHeaders,
    });
  }

  const body: {
    id: string;
    status: string;
    error?: unknown;
    result?: unknown;
  } = {
    id: operation.id,
    status: operation.status,
  };
  if (operation.status === "Failed") {
    // This would be a completely unexpected error.
    body.error = { code: 500, message: operation.error };
  } else if ((operation.result as { error?: unknown })?.error) {
    // This handles all the errors we have coded for.
    // i.e. all the ones for which we called longRunningOperations.ts' handleError.
    body.status = "Failed";
    body.error = (operation.result as { error?: unknown }).error;
  } else if (operation.result) {
    body.result = operation.result;
  }

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Retry-After": "1", // in seconds
    },
  });
}
