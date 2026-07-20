import { handleSendConcernEmailRequest } from "./concernEmail.ts";

// Replaces the legacy Parse cloud function `sendConcernEmail`: a blorg visitor
// reports a concern about a book, and we email the report to the Bloom team.
// The logic lives in concernEmail.ts so tests can call it directly.
Deno.serve(handleSendConcernEmailRequest);
