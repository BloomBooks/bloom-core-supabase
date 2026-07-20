import {
  type ContentfulEntry,
  getContentfulCollectionAndBannerEntries,
  validateContentfulEnvironmentVariables,
} from "../_shared/contentful.ts";

// The shape of one Crowdin l10n file: message id -> string + translator note.
type L10nJson = Record<string, { message: string; description: string }>;

// Pulls localizable strings (collection labels and page banners) from Contentful,
// transforms them into l10n JSON files, and uploads them to Crowdin.
//
// In Azure this ran on a daily timer trigger. Supabase edge functions have no
// timer trigger, so a scheduled GitHub Actions workflow invokes this function
// instead (see .github/workflows/cron-contentful-to-crowdin.yml).

const kCrowdinProjectId = 261564;
const kCrowdinHighPriorityFileId = 106;
const kCrowdinLowPriorityFileId = 108;
const kCrowdinChurchFileId = 104;

export interface SyncResult {
  highPriorityStringCount: number;
  lowPriorityStringCount: number;
  churchStringCount: number;
}

export async function readTransformUpload(): Promise<SyncResult> {
  if (!validateEnvironmentVariables()) {
    throw new Error("unable to run contentfulToCrowdin; see log.");
  }

  console.log("Querying Contentful...");
  const contentfulEntries = await getContentfulCollectionAndBannerEntries();

  const highPriorityJson = transformContentfulEntriesToL10nJson(
    contentfulEntries,
    includeInHighPriorityFile
  );
  const lowPriorityJson = transformContentfulEntriesToL10nJson(
    contentfulEntries,
    includeInLowPriorityFile
  );
  const churchJson = transformContentfulEntriesToL10nJson(
    contentfulEntries,
    includeInChurchFile,
    "NOTE: This is a Biblical or Christian term which should be translated with particular care and in accordance with how these terms are used in the church in this language."
  );

  const files = [
    { label: "high-priority", json: highPriorityJson, fileId: kCrowdinHighPriorityFileId },
    { label: "low-priority", json: lowPriorityJson, fileId: kCrowdinLowPriorityFileId },
    { label: "church", json: churchJson, fileId: kCrowdinChurchFileId },
  ];

  assertNoEmptyFiles(files);

  const counts: SyncResult = {
    highPriorityStringCount: Object.keys(highPriorityJson).length,
    lowPriorityStringCount: Object.keys(lowPriorityJson).length,
    churchStringCount: Object.keys(churchJson).length,
  };

  // Writing to Crowdin is opt-in: only an environment that explicitly sets
  // BLOOM_CONTENTFUL_TO_CROWDIN_ENABLE_UPLOAD=true (i.e. production) actually
  // uploads. Everywhere else (local dev, staging) is a dry run that still
  // queries Contentful and reports the counts but never touches the real Crowdin
  // project. This inverts the Azure approach, which ran for real unless it
  // detected a local environment — so Azure staging had to be disabled by hand.
  if (uploadEnabled()) {
    await Promise.all(
      files.map((file) => updateCrowdinFile(file.json, file.fileId))
    );
    console.log(`Uploaded to Crowdin: ${JSON.stringify(counts)}`);
  } else {
    console.log(
      `[dry-run] BLOOM_CONTENTFUL_TO_CROWDIN_ENABLE_UPLOAD is not "true"; ` +
        `skipping Crowdin upload. Would have uploaded: ${JSON.stringify(counts)}`
    );
  }

  return counts;
}

// Real Crowdin writes happen only when explicitly enabled (production). See the
// note in readTransformUpload.
function uploadEnabled(): boolean {
  return Deno.env.get("BLOOM_CONTENTFUL_TO_CROWDIN_ENABLE_UPLOAD") === "true";
}

// Lower-bound safety guard. Each upload REPLACES the whole Crowdin file, so an
// empty result would blank it and delete its source strings (and the
// translations attached to them). A zero count almost always means a mistake
// upstream (e.g. the last entry in a bucket lost its Contentful "localization"
// tag), not a deliberate "clear this file", so we fail loudly rather than wipe.
// This is the lower-bound counterpart to the >= 1000 guard in
// getContentfulEntries, and it runs in dry runs too so staging surfaces it.
export function assertNoEmptyFiles(
  files: { label: string; json: L10nJson }[]
) {
  for (const file of files) {
    if (Object.keys(file.json).length === 0) {
      throw new Error(
        `Refusing to update Crowdin: the ${file.label} file has zero strings; ` +
          `uploading it would wipe the existing source strings. Check that ` +
          `Contentful still has entries for this file.`
      );
    }
  }
}

function validateEnvironmentVariables() {
  let valid = true;
  if (!validateContentfulEnvironmentVariables()) {
    console.error("unable to run contentfulToCrowdin.");
    valid = false;
  }

  // The Crowdin token is only needed for a real upload; a dry run (the default
  // outside production) reads Contentful and reports counts without it.
  if (uploadEnabled() && !Deno.env.get("BLOOM_CROWDIN_API_TOKEN")) {
    console.error(
      "env.BLOOM_CROWDIN_API_TOKEN is not set; unable to run contentfulToCrowdin."
    );
    valid = false;
  }
  return valid;
}

function doNotLocalizeFilter(e: ContentfulEntry) {
  // Originally, I was using the existing "kind" field to control localization, which mostly worked.
  // That is what this "kindBlackList" is. If a collection is one of these "kinds", then we know
  // we don't want to localize it.
  // Note, we later added an explicit "localization" field, so once that gets filled in everywhere
  // we can retire using the kind field for localization purposes at all.
  const kindBlackList = [
    "Organization",
    "Project",
    "Language",
    "Publisher",
    "Series",
  ];

  if (e.fields.localization) return e.fields.localization === "No";
  // otherwise default for collections that don't have this field yet
  else return e.fields.kind && kindBlackList.indexOf(e.fields.kind) > -1;
}

export function includeInHighPriorityFile(e: ContentfulEntry) {
  if (doNotLocalizeFilter(e)) {
    return false;
  }
  return (
    // because this field is new, the majority are currently un-filled in
    !e.fields.localization ||
    // once these are marked, then we can just us this:
    e.fields.localization === "Localizable High Visibility"
  );
}

export function includeInLowPriorityFile(e: ContentfulEntry) {
  if (doNotLocalizeFilter(e)) {
    return false;
  }
  return e.fields.localization === "Localizable Low Visibility";
}

export function includeInChurchFile(e: ContentfulEntry) {
  if (doNotLocalizeFilter(e)) {
    return false;
  }
  return e.fields.localization === "Church";
}

export function transformContentfulEntriesToL10nJson(
  entries: ContentfulEntry[],
  filter: (entry: ContentfulEntry) => boolean,
  extraNotice?: string
): L10nJson {
  const output: L10nJson = {};
  // -      first do the page banners
  entries
    .filter((i) => i.sys.contentType.sys.id === "pageBanner")
    .filter(filter)
    .forEach((e) => {
      const previewLink = `https://alpha.bloomlibrary.org/_previewBanner/${e.sys.id}?uilang=en-US`;
      output["banner." + e.fields.title] = {
        message: e.fields.title,
        description: `This is a title part of a page banner. See ${previewLink}. ${
          extraNotice || ""
        }`,
      };
      if (e.fields.description) {
        // bold, headings, and links would seem to be relatively unambiguous ways to detect that there is markdown
        const markdownDetected =
          e.fields.description.indexOf("**") > -1 ||
          e.fields.description.indexOf("#") > -1 ||
          e.fields.description.indexOf("[") > -1;
        const markdownMessage = markdownDetected
          ? // this link at bit.ly is under john hatton sil account
            " MAKE SURE YOU PRESERVE THE MARKDOWN FORMATTING (see https://bit.ly/blorgmd). "
          : "";
        output["banner.description." + e.fields.title] = {
          message: e.fields.description,
          description: `This is the description part of a page banner titled "${
            e.fields.title
          }".  ${markdownMessage}To see this in Bloom Library, go to ${previewLink}. ${
            extraNotice || ""
          }`,
        };
      }
    });

  // -      next, do the collections
  entries
    .filter((i) => i.sys.contentType.sys.id === "collection")
    .filter(filter)
    .forEach((e) => {
      const kind = e.fields.kind ? e.fields.kind : "";
      output[e.sys.contentType.sys.id + "." + e.fields.urlKey] = {
        message: e.fields.label,
        // This uilang=en-US parameter isn't implemented in blorg yet, but it could be in the future and could be useful for testing
        // thing. Meanwhile it does not harm.
        description: `This is a label for a ${kind} collection. See "https://alpha.bloomlibrary.org/${
          e.fields.urlKey
        }?uilang=en-US" ${extraNotice || ""}`,
      };
    });

  return output;
}

// Upload the JSON to Crowdin as a new storage object, then point the existing
// project file at it. (Same two REST calls the Crowdin SDK made for the Azure
// version, but properly awaited — the Azure version fired and forgot.)
async function updateCrowdinFile(l10nJson: L10nJson, fileId: number) {
  const token = Deno.env.get("BLOOM_CROWDIN_API_TOKEN");

  const storageResponse = await fetch("https://api.crowdin.com/api/v2/storages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Crowdin-API-FileName": "Bloom Library Contentful.json",
      "Content-Type": "application/octet-stream",
    },
    body: JSON.stringify(l10nJson, null, 4),
  });
  if (!storageResponse.ok) {
    throw new Error(
      `Crowdin addStorage failed: ${storageResponse.status} ${await storageResponse.text()}`
    );
  }
  const storage = await storageResponse.json();
  console.log(`new storage id: ${storage.data.id}`);

  const updateResponse = await fetch(
    `https://api.crowdin.com/api/v2/projects/${kCrowdinProjectId}/files/${fileId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ storageId: storage.data.id }),
    }
  );
  if (!updateResponse.ok) {
    throw new Error(
      `Crowdin updateOrRestoreFile failed for file ${fileId}: ${updateResponse.status} ${await updateResponse.text()}`
    );
  }
  console.log(
    `crowdin update response: ${JSON.stringify(await updateResponse.json())}`
  );
}
