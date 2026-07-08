import { getCorsHeaders } from "../_shared/utils.ts";
import { IFilter, processEvents } from "./events.ts";

// Returns reading/usage statistics from the analytics Postgres database.
// URL format: /stats/{category}/{rowType} with a JSON body {filter: {...}}
// (categories/rowTypes are mapped to stored procedures in events.ts).
//
// Unlike most of our functions this one handles CORS itself: blorg calls it
// with a JSON POST, which triggers a preflight. (For the Azure version, CORS
// was configured at the Functions-host level, outside the code; the allowed
// origins are mirrored in _shared/utils.ts.)

export async function handleStatsRequest(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const pathSegments = url.pathname
      .split("/")
      .filter((segment) => segment !== "");
    const statsIndex = pathSegments.findIndex(
      (segment) => segment === "stats"
    );
    const category =
      statsIndex >= 0 ? pathSegments[statsIndex + 1] : undefined;
    const rowType = statsIndex >= 0 ? pathSegments[statsIndex + 2] : undefined;

    let body: any;
    if (req.method === "POST") {
      body = await req.json().catch(() => undefined);
    }

    let filter: IFilter | undefined = body?.filter;
    const filterFromQuery = url.searchParams.get("filter");
    if (!filter && filterFromQuery) {
      filter = JSON.parse(filterFromQuery);
    }

    if (category && rowType && filter) {
      const stats = await processEvents(category, rowType, filter);
      return new Response(JSON.stringify({ stats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return fail(
      corsHeaders,
      "Url and/or request body are not in a valid state. Be sure to provide a valid filter object in the request payload. This requires POST, not GET."
    );
  } catch (e) {
    return fail(corsHeaders, e instanceof Error ? e.message : String(e));
  }
}

function fail(
  corsHeaders: Record<string, string>,
  message: string
): Response {
  return new Response(message, { status: 400, headers: corsHeaders });
}
