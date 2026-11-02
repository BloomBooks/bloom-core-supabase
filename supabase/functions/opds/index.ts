import { ApiAccount } from "../_shared/BloomParseServer.ts";
import {
  Environment,
  getPublicUrl,
  parseBooleanQueryParam,
} from "../_shared/utils.ts";
import { getApiAccount } from "./apiAccount.ts";
import Catalog, { CatalogParams } from "./catalog.ts";

// Generates an OPDS 1.2 catalog (XML) of Bloom Library books.
// See https://specs.opds.io/opds-1.2.html for the OPDS catalog standard.
// See https://validator.w3.org/feed/docs/atom.html for the basic (default) tags
// See https://www.dublincore.org/specifications/dublin-core/dcmi-terms/ for the Dublin Core
//     (dcterms) tags
// Example use: https://api.bloomlibrary.org/v1/opds?key=you@example.com:yourAccountId&lang=fr
Deno.serve(async (req: Request) => {
  // Use the public URL (forwarded by the Cloudflare routing worker in the
  // custom x-bloom-public-url header; see getPublicUrl) so generated links
  // don't leak the Supabase URL.
  const publicUrl = getPublicUrl(req);
  const baseUrl = publicUrl.origin + publicUrl.pathname;
  // (Catalog derives the fs-link base from baseUrl; there is deliberately no
  // shared mutable state between requests.)

  const params: CatalogParams = Object.fromEntries(
    publicUrl.searchParams.entries()
  ) as CatalogParams;
  // The values above are all strings; interpret the boolean-typed params so that
  // e.g. epub=false / minimalnavlinks=false actually disable the option rather
  // than being treated as truthy non-empty strings.
  if (publicUrl.searchParams.has("epub")) {
    params.epub = parseBooleanQueryParam(publicUrl.searchParams.get("epub"));
  }
  if (publicUrl.searchParams.has("minimalnavlinks")) {
    params.minimalnavlinks = parseBooleanQueryParam(
      publicUrl.searchParams.get("minimalnavlinks")
    );
  }

  let account: ApiAccount | undefined;
  if (params.key) {
    const accountResult = await getApiAccount(
      params.key,
      (params.src as string)?.toLowerCase() as Environment
    );
    if (accountResult.resultCode) {
      return new Response(accountResult.errorMessage, {
        status: accountResult.resultCode,
      });
    } else {
      account = accountResult.account;
      // each OPDS api account has a tag that we propagate through all
      // links for eventual use in analytics.
      params.ref = account?.referrerTag;
    }
  }
  try {
    const body = await Catalog.getCatalog(baseUrl, params, account);
    return new Response(body, {
      headers: { "Content-Type": "application/xml" },
    });
  } catch (err) {
    return new Response(String(err), { status: 500 });
  }
});
