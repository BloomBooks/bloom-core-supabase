import { handleFsRequest } from "./handler.ts";

// This function allows us to request a file in a book on S3 without knowing [it is on s3, who the uploader is, etc].
// Example use: https://api.bloomlibrary.org/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png
// The logic lives in handler.ts so tests can call it directly.
Deno.serve(handleFsRequest);
