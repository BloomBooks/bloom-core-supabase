import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";
import { Environment } from "../_shared/utils.ts";

export interface ContentUrlParams {
  bucket: string;
  bookid: string;
  pathSegments: string[];
}

// The bucket names accepted in fs URLs, mapped to the real S3 bucket, the
// Parse environment whose book records point into it, and whether the
// harvester (rather than an upload) writes its files.
const kBuckets = new Map<
  string,
  { s3Bucket: string; environment: Environment; harvested: boolean }
>([
  ["upload", { s3Bucket: "BloomLibraryBooks", environment: Environment.PRODUCTION, harvested: false }],
  ["dev-upload", { s3Bucket: "BloomLibraryBooks-Sandbox", environment: Environment.DEVELOPMENT, harvested: false }],
  ["harvest", { s3Bucket: "bloomharvest", environment: Environment.PRODUCTION, harvested: true }],
  ["dev-harvest", { s3Bucket: "bloomharvest-sandbox", environment: Environment.DEVELOPMENT, harvested: true }],
]);

export function isValidBucket(bucketKey: string): boolean {
  return kBuckets.has(bucketKey);
}

export interface Content {
  // The file's S3 URL.
  url: string;
  // The time (epoch ms) the files in this bucket last changed, when they are
  // final; otherwise null. See fileVersion.
  version: number | null;
}

export default class BookData {
  // The real URL for the content based on the input URL parameters, and the
  // version of the files it is in.
  public static async getContent(
    params: ContentUrlParams
  ): Promise<Content | null> {
    const bucketInfo = kBuckets.get(params.bucket);
    if (!bucketInfo) {
      return null;
    }
    const { s3Bucket, environment, harvested } = bucketInfo;

    const parseServer = new BloomParseServer(environment);
    const bookInfo: Book | undefined = await parseServer.getBookByDatabaseId(
      params.bookid
    );
    if (!bookInfo || !bookInfo.baseUrl) {
      return null;
    }
    const bookFolder = BloomParseServer.getS3LinkBase(bookInfo.baseUrl, s3Bucket);
    let url = bookFolder;

    // Append all path segments
    const pathSegments = params.pathSegments;
    for (const segment of pathSegments) {
      if (segment && segment.length > 0) {
        url = url + "/" + encodeUnicode(segment);
      }
    }

    return isInsideFolder(url, bookFolder)
      ? { url, version: fileVersion(bookInfo, harvested) }
      : null;
  }
}

// The version of a book's files in a bucket: the time (epoch ms) they last
// changed, or null if they may still be changing (or we can't tell). The
// routing worker caches a file under this version, so it must name final
// bytes.
// - Uploaded files: lastUploaded. Each upload writes a new folder, and the
//   record moves to it (baseUrl) in the same write that sets lastUploaded.
// - Harvested files: harvestStartedAt, which the harvester sets *before*
//   rewriting them in the same folder, so only once harvestState is Done.
function fileVersion(book: Book, harvested: boolean): number | null {
  if (harvested && book.harvestState !== "Done") {
    return null;
  }
  const changed = harvested ? book.harvestStartedAt : book.lastUploaded;
  const time = changed?.iso ? Date.parse(changed.iso) : NaN;
  return Number.isFinite(time) ? time : null;
}

// SECURITY: a segment can still be ".." once encodeUnicode has decoded it a
// second time (a client sends "%252e%252e"), and the URL parser then resolves
// it, walking out of the book's folder to other files in the bucket. So only
// accept a URL that, once resolved, names something strictly inside the
// book's folder.
function isInsideFolder(url: string, folder: string): boolean {
  try {
    const folderHref = new URL(folder + "/").href;
    const href = new URL(url).href;
    return href.startsWith(folderHref) && href.length > folderHref.length;
  } catch {
    return false; // not a URL at all
  }
}

// TODO: My only confidence in this is empirical, which isn't enough in matters of encoding! With this decode/encode, I haven't found any
// artifacts that can't be retrieved when navigating our OPDS from an OPDS client.
//
// The OPDS catalog (in this same project) is making links that invoke this service.
// Those links have some encoding already, e.g. "Doktor+Irwin.pdf"; If we re-encode that, well now we turn the + into %2B and of course S3 can't find it because we've now double encoded it.

// On the other hand, we have seen instances where we are given names with raw Thai characters, which *do* need to be encoded because S3 can't handle them.
// (note, it's not clear when this happens... a quick check of thai on dev )

// So... what I'm trying here is to just decode then re-encode.
function encodeUnicode(part: string): string {
  let s = part.replace(/\+/g, " "); // converts the + to space because decodeURIComponent left the + alone
  s = decodeURIComponent(s);
  return encodeURIComponent(s);
}
