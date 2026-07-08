import { handleStatsRequest } from "./stats.ts";

// Returns reading/usage statistics from the analytics Postgres database.
// Example use: POST https://api.bloomlibrary.org/v1/stats/reading/per-book
//              with body {"filter": {"parseDBQuery": {...}}}
Deno.serve(handleStatsRequest);
