// Read-only access to Bloom's Contentful space via the Content Delivery REST API.
// (The Azure version used the contentful npm client; we only need flat fields on
// collection/pageBanner entries, which the REST API returns directly.)
//
// NOTE: the Azure common/contentful.ts also contains editor-collection permission
// helpers used by the books function; those should be ported when books migrates.

const kContentfulSpace = "72i7e2mqidxz";

export function validateContentfulEnvironmentVariables(): boolean {
  if (!Deno.env.get("BLOOM_CONTENTFUL_READ_ONLY_TOKEN")) {
    console.error("env.BLOOM_CONTENTFUL_READ_ONLY_TOKEN is not set");
    return false;
  }
  return true;
}

// A Contentful entry as returned by the Content Delivery API. This is a loose,
// combined view of the two content types we read: `label`/`urlKey` belong to
// `collection` entries and `title`/`description` to `pageBanner` entries, so
// each is only ever accessed on the type that actually has it. `localization`
// is the (often-unset) opt-out marker used by the filters below.
export interface ContentfulEntry {
  sys: { id: string; contentType: { sys: { id: string } } };
  fields: {
    label: string;
    urlKey: string;
    kind?: string;
    title: string;
    description?: string;
    localization?: string;
  };
}

async function getContentfulEntries(
  contentType: string
): Promise<ContentfulEntry[]> {
  const url = new URL(
    `https://cdn.contentful.com/spaces/${kContentfulSpace}/environments/master/entries`
  );
  url.searchParams.set("content_type", contentType);
  // Ask Contentful to omit entries explicitly opted out of localization
  // (localization === "No"). This mirrors the Azure implementation exactly
  // (common/contentful.ts used the same `fields.localization[ne]: "No"` on both
  // content types). Two things this relies on, both proven by years of the Azure
  // job running daily: [ne] still RETURNS entries that have no localization value
  // at all (most entries — the JS filters below depend on that), and the
  // `pageBanner` content type actually defines a `localization` field (otherwise
  // the CDA would 400). Keep both content types in sync with Azure here.
  url.searchParams.set("fields.localization[ne]", "No");
  // 1000 is the max we are allowed; beyond that, we will have to page.
  url.searchParams.set("limit", "1000");
  url.searchParams.set(
    "access_token",
    Deno.env.get("BLOOM_CONTENTFUL_READ_ONLY_TOKEN") || ""
  );

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Contentful request for ${contentType} failed: ${response.status} ${await response.text()}`
    );
  }
  const data = await response.json();
  if (data.items.length >= 1000)
    throw Error(
      `More than 1000 ${contentType} entries; don't update Crowdin until code is enhanced lest we delete strings.`
    );
  return data.items;
}

export async function getContentfulCollectionAndBannerEntries(): Promise<
  ContentfulEntry[]
> {
  const collections = await getContentfulEntries("collection");
  const banners = await getContentfulEntries("pageBanner");
  return [...collections, ...banners];
}
