import { handleBooksRequest } from "./books.ts";

// The main book API (queries, permissions, upload, delete).
// Example use: https://api.bloomlibrary.org/v1/books?lang=fr
Deno.serve(handleBooksRequest);
