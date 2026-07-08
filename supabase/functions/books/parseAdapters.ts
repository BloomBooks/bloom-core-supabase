// This file contains functions which sit in on the edge between the parse server and our books API.
// They don't belong in BloomParseServer because they are only applicable to the books API.
// But I wanted to extract all the parse-specific stuff from the general books API code.
// I think that makes the code cleaner now and will hopefully make it easier to replace
// parse with something else in the future.

import { Book } from "../_shared/BloomParseServer.ts";

// query params as a plain object (equivalent of Azure's HttpRequestQuery)
export type ApiQueryParams = Record<string, string | undefined>;

function getNumber(query: ApiQueryParams, key: string): number | undefined {
  const value = query[key];
  if (!value) return undefined;
  const num = parseInt(value);
  return isNaN(num) ? undefined : num;
}

function getBooleanAsOneOrZero(
  query: ApiQueryParams,
  key: string
): number | undefined {
  const value = query[key];
  if (value === "true") return 1;
  if (value === "false") return 0;
  return undefined;
}

export function convertApiQueryParamsIntoParseAdditionalParams(
  query: ApiQueryParams
): { limit?: number; skip?: number; count?: number } {
  const additionalParams = {
    // If no limit is specified, we get 100. That's never the default
    // we want. Override it with a number which will retrieve all records.
    limit: getNumber(query, "limit") ?? 10000000,
    skip: getNumber(query, "offset"),
    count: getBooleanAsOneOrZero(query, "count"),
  };

  return additionalParams;
}

export function convertExpandParamToParseFields(
  _expandStr: string | undefined
): string[] {
  // We actually have to get the full language and uploader records from parse either way
  // because even our unexpanded record contains the language tags and email addresses
  // and parse doesn't return those unless we ask for the full records.
  // And for now, those are the only two fields we can expand,
  // so there's no sense in doing extra processing.
  return ["langPointers", "uploader"];
}

export function convertApiQueryParamsIntoParseWhere(
  query: ApiQueryParams
): string {
  const {
    lang: langParam,
    uploader: uploaderParam,
    instanceIds: instanceIdsParam,
  } = query;
  const where: Record<string, unknown> = {};

  // If one of these xParam variables is falsy, either the user didn't include it in the query
  // or they included it but didn't provide a value (e.g. `?lang=`).
  // We are treating both the same. The idea is, if the user didn't provide a value,
  // we treat it as the default value, which is unconstrained.
  if (langParam) {
    where.langPointers = {
      $inQuery: {
        where: { isoCode: { $in: langParam.split(",") } },
        className: "language",
      },
    };
  }
  if (uploaderParam) {
    where.uploader = {
      $inQuery: {
        where: { email: { $in: uploaderParam.split(",") } },
        className: "_User",
      },
    };
  }
  if (instanceIdsParam) {
    where.bookInstanceId = { $in: instanceIdsParam.split(",") };
  }
  return JSON.stringify(where);
}

// Given a raw parse book record, reshape it into the format we want to return
// from our API.
export function reshapeBookRecord(
  book: Book,
  expandStr: string | null = null,
  isForClientUnitTest = false
) {
  const expand = expandStr ? commaSeparatedStringToArray(expandStr) : [];

  // Whitelist just the fields we want.
  // If we change out minds and decide to blacklist, we can just do
  // const reshapedBook = {...book};
  // and then delete the fields we don't want.
  const {
    // editor uses
    createdAt,
    updatedAt,
    baseUrl,
    draft,
    phashOfFirstContentImage,
    inCirculation,
    harvestState,
    brandingProjectName,
    // assumed to be needed by blorg eventually... there will certainly be more
    lastUploaded,
    tags,
    summary,
    features,
    bookLineage,
  } = book as any;
  const reshapedBook = {
    createdAt,
    updatedAt,
    baseUrl,
    draft,
    phashOfFirstContentImage,
    inCirculation,
    harvestState,
    brandingProjectName,
    lastUploaded,
    tags,
    summary,
    features,
    bookLineage,
  } as any;

  reshapedBook["id"] = book.objectId;
  reshapedBook["instanceId"] = book.bookInstanceId;

  reshapedBook["titles"] = [];
  if ((book as any)["allTitles"]) {
    let allTitlesObject;
    try {
      allTitlesObject = JSON.parse((book as any)["allTitles"]);
    } catch (_e) {
      try {
        // Properly encoded JSON strings will have \n escaped as \\n,
        // but we don't have properly encoded JSON, apparently.
        allTitlesObject = JSON.parse(
          (book as any)["allTitles"].replaceAll("\n", "\\n")
        );
      } catch (e2) {
        console.error(
          `Error parsing allTitles for book ${book.objectId}, ${(book as any)[
            "allTitles"
          ].replaceAll("\n", "\\n")}:  ${e2}`
        );
      }
    }
    for (const lang in allTitlesObject) {
      reshapedBook["titles"].push({
        lang: lang,
        title: allTitlesObject[lang],
      });
    }
  }

  reshapedBook["titleFromUpload"] = (book as any)["title"];

  reshapedBook["languages"] = [];
  ((book as any)["langPointers"] ?? []).forEach((langPointer: any) => {
    if (expand.includes("languages"))
      reshapedBook["languages"].push({
        id: langPointer.objectId,
        tag: langPointer.isoCode,
        name: langPointer.name,
        englishName: langPointer.englishName,
        usageCount: langPointer.usageCount,
      });
    else
      reshapedBook["languages"].push({
        tag: langPointer.isoCode,
      });
  });

  reshapedBook["uploader"] = { email: book.uploader.username };
  if (expand.includes("uploader")) {
    reshapedBook["uploader"]["id"] = book.uploader.objectId;
  }

  // Simplify all date fields to ISO strings
  for (const field in reshapedBook) {
    if (
      reshapedBook[field] instanceof Object &&
      reshapedBook[field].__type === "Date"
    ) {
      reshapedBook[field] = reshapedBook[field].iso;
    }
  }

  // There are a couple fields which the client (Bloom editor) unit tests check as an integration test
  // of the wider system. But we don't want to return them with the book record in
  // general since we don't think any real clients will ever use them.
  if (isForClientUnitTest) {
    reshapedBook["updateSource"] = book.updateSource;
    reshapedBook["uploadPendingTimestamp"] = book.uploadPendingTimestamp;
  }

  return reshapedBook;
}

function commaSeparatedStringToArray(commaSeparatedString: string): string[] {
  return commaSeparatedString.split(",").map((item) => item.trim());
}
