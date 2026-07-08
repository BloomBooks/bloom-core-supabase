import { Environment } from "../_shared/utils.ts";
import { bookCleanupInternal } from "./bookCleanup.ts";

// Cleans up abandoned book uploads (S3 files and Parse records).
//
// Not a public API; a scheduled GitHub Actions workflow invokes this daily
// (see .github/workflows/cron-book-cleanup.yml), authenticated by the shared
// secret. Like the Azure timer version, it runs for development, then production.
//
// Query parameters:
//   safeMode=true  - log what would be done without deleting anything
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secret = Deno.env.get("BLOOM_CRON_SECRET");
  if (!secret || req.headers.get("x-bloom-cron-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const safeMode =
    new URL(req.url).searchParams.get("safeMode") === "true";

  const logLines: string[] = [];
  const log = (message: string) => {
    console.log(message);
    logLines.push(message);
  };

  try {
    log(`bookCleanup started ${new Date().toISOString()}`);
    log("running book cleanup for development");
    await bookCleanupInternal(Environment.DEVELOPMENT, safeMode, log);
    log("running book cleanup for production");
    await bookCleanupInternal(Environment.PRODUCTION, safeMode, log);
    log(`book cleanup succeeded ${new Date().toISOString()}`);
    return new Response(JSON.stringify({ safeMode, log: logLines }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("book cleanup failed", err);
    return new Response(
      JSON.stringify({
        safeMode,
        log: logLines,
        error: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
