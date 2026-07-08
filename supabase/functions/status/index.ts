import { handleStatusRequest } from "./status.ts";

// Polling endpoint for long-running operations (book upload-start/upload-finish).
// Example use: https://api.bloomlibrary.org/v1/status/6f0f5b0a-...
Deno.serve(handleStatusRequest);
