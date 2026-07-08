import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

// Long-running operations (currently book upload-start/upload-finish).
//
// The Azure version used Durable Functions: the books function queued an
// orchestration and returned 202 + an Operation-Location URL which the client
// polls (see the status function). Here, the work runs in the background of the
// same edge-function invocation via EdgeRuntime.waitUntil, and its state lives
// in the `operations` table in this project's Postgres (see
// supabase/migrations/*_create_operations_table.sql).
//
// Known difference from Azure: background work is bounded by the edge runtime's
// wall-clock limit (~400s) rather than the Azure functionTimeout (10 min), and
// if the worker dies mid-operation the row stays 'Running' forever (durable
// functions would retry). If either proves to be a problem in practice, the
// fallback plan is Supabase Queues; see MIGRATION-PLAN.md Phase 8.

export interface OperationRow {
  id: string;
  status: "Running" | "Succeeded" | "Failed";
  result: unknown | null;
  error: string | null;
}

function getSupabaseAdminClient(): SupabaseClient {
  // These are injected automatically into deployed edge functions
  // (and by `supabase start` locally).
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// Starts a long-running operation.
// Returns the instance ID which the client will use to check the status.
// e.g. https://api.bloomlibrary.org/v1/status/{instanceId}
export async function startLongRunningOperation(
  work: () => Promise<unknown>
): Promise<string> {
  const supabase = getSupabaseAdminClient();
  const { data, error } = await supabase
    .from("operations")
    .insert({ status: "Running" })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(
      `Failed to create operation record: ${error?.message ?? "no data"}`
    );
  }
  const id: string = data.id;

  const workPromise = (async () => {
    try {
      const result = await work();
      await supabase
        .from("operations")
        .update({
          status: "Succeeded",
          result: result ?? {},
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    } catch (err) {
      console.error("long-running operation failed", err);
      await supabase
        .from("operations")
        .update({
          status: "Failed",
          error: err instanceof Error ? err.message : String(err),
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);
    }
  })();

  // Let the work continue after we return the 202 response.
  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(workPromise);
  }
  // else: local `deno test` or older runtime; the floating promise still runs.

  return id;
}

export async function getOperation(id: string): Promise<OperationRow | null> {
  const supabase = getSupabaseAdminClient();
  const { data } = await supabase
    .from("operations")
    .select("id, status, result, error")
    .eq("id", id)
    .maybeSingle();
  return (data as OperationRow) ?? null;
}

export function createResponseWithAcceptedStatusAndStatusUrl(
  instanceId: string,
  originalRequestUrl: string,
  additionalHeaders: Record<string, string> = {}
): Response {
  // One could make the argument that the status should be "NotStarted",
  // but in the happy path, the action **has** already started.
  return new Response(JSON.stringify({ id: instanceId, status: "Running" }), {
    status: 202, // Accepted
    headers: {
      "Content-Type": "application/json",
      "Operation-Location": `${originalRequestUrl.substring(
        0,
        originalRequestUrl.indexOf("/v1/")
      )}/v1/status/${instanceId}`,
      ...additionalHeaders,
    },
  });
}

export function handleError(
  code: string,
  message: string | undefined,
  ...additionalParams: [string, string][]
) {
  // see https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md#post-or-delete-lro-pattern
  const errorObj: { code: string; message: string | undefined } & Record<
    string,
    string | undefined
  > = {
    code,
    message,
  };
  if (additionalParams) {
    additionalParams.forEach(([key, value]) => {
      errorObj[key] = value;
    });
  }
  return {
    error: errorObj,
  };
}
