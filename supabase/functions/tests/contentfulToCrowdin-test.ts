import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertNoEmptyFiles,
  includeInChurchFile,
  includeInHighPriorityFile,
  includeInLowPriorityFile,
  transformContentfulEntriesToL10nJson,
} from "../contentfulToCrowdin/contentfulToCrowdin.ts";
import type { ContentfulEntry } from "../_shared/contentful.ts";

// These build deliberately-partial entries: a collection has no `title`, a
// banner has no `label`/`urlKey`, and each code path only reads its own type's
// fields. Cast through `unknown` so the fixtures don't have to name fields they
// never use.
function makeCollection(fields: Record<string, unknown>): ContentfulEntry {
  return {
    sys: { id: "id-" + fields.urlKey, contentType: { sys: { id: "collection" } } },
    fields,
  } as unknown as ContentfulEntry;
}

function makeBanner(fields: Record<string, unknown>): ContentfulEntry {
  return {
    sys: { id: "banner-id", contentType: { sys: { id: "pageBanner" } } },
    fields,
  } as unknown as ContentfulEntry;
}

const entries = [
  makeCollection({ urlKey: "sil-lead", label: "SIL LEAD", kind: "Organization" }),
  makeCollection({ urlKey: "animals", label: "Animal Books" }),
  makeCollection({
    urlKey: "health",
    label: "Health Books",
    localization: "Localizable High Visibility",
    kind: "Topic",
  }),
  makeCollection({
    urlKey: "obscure",
    label: "Obscure Books",
    localization: "Localizable Low Visibility",
  }),
  makeCollection({
    urlKey: "bible",
    label: "Bible Books",
    localization: "Church",
  }),
  makeCollection({
    urlKey: "secret",
    label: "Not Localized",
    localization: "No",
  }),
  makeBanner({ title: "Welcome Banner", description: "Read **books** here" }),
];

Deno.test("contentfulToCrowdin - high priority includes unmarked and high-visibility, excludes blacklist kinds", () => {
  const json = transformContentfulEntriesToL10nJson(
    entries,
    includeInHighPriorityFile
  );
  const keys = Object.keys(json);
  assert(keys.includes("collection.animals")); // no localization field -> high priority
  assert(keys.includes("collection.health"));
  assert(keys.includes("banner.Welcome Banner"));
  assert(keys.includes("banner.description.Welcome Banner"));
  assert(!keys.includes("collection.sil-lead")); // Organization kind blacklisted
  assert(!keys.includes("collection.obscure")); // low visibility
  assert(!keys.includes("collection.bible")); // church
  assert(!keys.includes("collection.secret")); // localization: No
});

Deno.test("contentfulToCrowdin - low priority file", () => {
  const json = transformContentfulEntriesToL10nJson(
    entries,
    includeInLowPriorityFile
  );
  assertEquals(Object.keys(json), ["collection.obscure"]);
  assertEquals(json["collection.obscure"].message, "Obscure Books");
});

Deno.test("contentfulToCrowdin - church file gets the extra notice", () => {
  const json = transformContentfulEntriesToL10nJson(
    entries,
    includeInChurchFile,
    "SPECIAL CHURCH NOTICE"
  );
  assertEquals(Object.keys(json), ["collection.bible"]);
  assert(json["collection.bible"].description.includes("SPECIAL CHURCH NOTICE"));
});

Deno.test("contentfulToCrowdin - banner description mentions markdown when detected", () => {
  const json = transformContentfulEntriesToL10nJson(
    entries,
    includeInHighPriorityFile
  );
  assert(
    json["banner.description.Welcome Banner"].description.includes(
      "PRESERVE THE MARKDOWN"
    )
  );
  assertEquals(
    json["banner.description.Welcome Banner"].message,
    "Read **books** here"
  );
});

Deno.test("contentfulToCrowdin - collection description includes kind and preview link", () => {
  const json = transformContentfulEntriesToL10nJson(
    entries,
    includeInHighPriorityFile
  );
  assert(
    json["collection.health"].description.includes("a Topic collection")
  );
  assert(
    json["collection.health"].description.includes(
      "https://alpha.bloomlibrary.org/health?uilang=en-US"
    )
  );
});

Deno.test("contentfulToCrowdin - assertNoEmptyFiles throws for a zero-string file (would wipe Crowdin)", () => {
  // A file with no strings must never be uploaded: it would blank the Crowdin
  // file and delete its source strings. The error names the offending file.
  const err = assertThrows(
    () =>
      assertNoEmptyFiles([
        { label: "high-priority", json: { "k": { message: "m", description: "d" } } },
        { label: "church", json: {} },
      ]),
    Error,
    "church",
  );
  assert((err as Error).message.includes("zero strings"));
});

Deno.test("contentfulToCrowdin - assertNoEmptyFiles allows files that all have strings", () => {
  assertNoEmptyFiles([
    { label: "high-priority", json: { "a": { message: "m", description: "d" } } },
    { label: "low-priority", json: { "b": { message: "m", description: "d" } } },
  ]);
});
