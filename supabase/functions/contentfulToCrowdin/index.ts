import { readTransformUpload } from "./contentfulToCrowdin.ts";

// Syncs localizable strings from Contentful to Crowdin.
//
// This is not a public API; it is invoked on a schedule by a GitHub Actions
// workflow (see .github/workflows/cron-contentful-to-crowdin.yml), which must
// send the shared secret. It can also be invoked manually the same way.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const secret = Deno.env.get("BLOOM_CRON_SECRET");
  if (!secret || req.headers.get("x-bloom-cron-secret") !== secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    console.log("contentfulToCrowdin starting", new Date().toISOString());
    const result = await readTransformUpload();
    console.log("contentfulToCrowdin finished", new Date().toISOString());
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(
      "Error: " + (err instanceof Error ? err.message : JSON.stringify(err)),
      { status: 500 }
    );
  }
});
