import { handleSocialRequest } from "./social.ts";

// This function generates an HTML page with OpenGraph metadata so that shared
// Bloom Library links get proper previews on social media.
// Example use: https://api.bloomlibrary.org/v1/social?link=https://bloomlibrary.org/book/abc&title=My+Book
Deno.serve(handleSocialRequest);
