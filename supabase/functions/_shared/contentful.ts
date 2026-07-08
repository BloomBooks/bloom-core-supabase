// Read-only access to Bloom's Contentful space via the Content Delivery REST API.
// (The Azure version used the contentful npm client. For collection/pageBanner
// entries we only need flat fields, which the REST API returns directly; for
// the editor-collections permission check we resolve entry links manually —
// the one thing the SDK did for us.)

const kContentfulSpace = "72i7e2mqidxz";
export const kAllBooksFilter = "all-books";
const kRootCollectionUrlKey = "root.read";

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

// One day we may want to expand on this, but for now, it is just any object.
// deno-lint-ignore no-empty-interface
export interface IContentfulCollectionFilter {}

// Fetch the Contentful "user" entry for this email, with its editorCollections
// tree. The REST API returns linked entries unresolved (as {sys: {type: "Link"}}
// references) plus an includes.Entry array; buildLinkResolver lets callers look
// them up. Unpublished (draft) linked entries are simply absent from includes.
async function getUserEntryWithIncludes(emailAddress: string) {
  const url = new URL(
    `https://cdn.contentful.com/spaces/${kContentfulSpace}/environments/master/entries`
  );
  url.searchParams.set("content_type", "user");
  url.searchParams.set("fields.emailAddress", emailAddress);
  url.searchParams.set("select", "fields.editorCollections");
  url.searchParams.set("include", "10"); //depth
  url.searchParams.set(
    "access_token",
    Deno.env.get("BLOOM_CONTENTFUL_READ_ONLY_TOKEN") || ""
  );

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Contentful user request failed: ${response.status} ${await response.text()}`
    );
  }
  const data = await response.json();
  return { user: data.items?.[0], resolve: buildLinkResolver(data) };
}

// Returns a function which, given an entry or an entry link, returns the entry
// (or undefined for unresolvable links, e.g. drafts).
function buildLinkResolver(responseData: any): (linkOrEntry: any) => any {
  const entriesById = new Map<string, any>();
  for (const entry of responseData.includes?.Entry ?? []) {
    entriesById.set(entry.sys.id, entry);
  }
  return (linkOrEntry: any) => {
    if (!linkOrEntry?.sys) return undefined;
    if (linkOrEntry.sys.type === "Link") {
      return entriesById.get(linkOrEntry.sys.id);
    }
    return linkOrEntry;
  };
}

// In Contentful, we have a User type which can be connected to zero or more "Editor Collections"
// over which the user has editor permission. Each Editor Collection will also give editor
// permission to all of its child collections.
// This function returns the filters for all the collections for which the user has editor permission.
export async function getAllContentfulCollectionFiltersForUser(
  emailAddress: string
): Promise<Set<IContentfulCollectionFilter>> {
  const collectionDefiningFilters = new Set<IContentfulCollectionFilter>();

  const { user, resolve } = await getUserEntryWithIncludes(emailAddress);
  const editorCollections = (user?.fields?.editorCollections ?? [])
    .map(resolve)
    .filter((c: any) => c !== undefined);
  if (!editorCollections.length) {
    return collectionDefiningFilters;
  }

  // This is going to be common enough (for staff) that it is worth shortcutting.
  // Also, by providing the root collection, we really mean every book.
  // But every book probably isn't actually included in some descendant collection.
  if (
    editorCollections.some(
      (ec: any) => ec.fields?.urlKey === kRootCollectionUrlKey
    )
  ) {
    collectionDefiningFilters.add(kAllBooksFilter);
    return collectionDefiningFilters;
  }

  editorCollections.forEach((collection: any) => {
    collectFilters(collection, collectionDefiningFilters, resolve);
  });
  return collectionDefiningFilters;
}

// Collect all the filters for this collection and its children into the "filters" set.
function collectFilters(
  collection: any,
  filters: Set<IContentfulCollectionFilter>,
  resolve: (linkOrEntry: any) => any,
  depth = 0
) {
  if (!collection?.fields) {
    // Apparently, this is what we get if a child collection is a draft.
    return;
  }
  if (depth > 20) {
    // Handle pathological case of a cyclic collection hierarchy.
    console.error(
      `collectFilters: depth > 20; probably a cycle in the collection hierarchy`
    );
    return;
  }

  if (collection.fields.childCollections) {
    collection.fields.childCollections.forEach((childCollection: any) => {
      collectFilters(resolve(childCollection), filters, resolve, depth + 1);
    });
  }

  if (collection.fields.filter) {
    filters.add(collection.fields.filter);
  } else if (collection.fields.useSimpleBookshelfFilter !== false) {
    filters.add({ tag: `bookshelf:${collection.fields.urlKey}` });
  }
}
