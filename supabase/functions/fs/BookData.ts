import BloomParseServer, { Book } from "../_shared/BloomParseServer.ts";
import { Environment } from "../_shared/utils.ts";

export interface ContentUrlParams {
  bucket: string;
  bookid: string;
  pathSegments: string[];
}

// The bucket names accepted in fs URLs, mapped to the real S3 bucket and the
// Parse environment whose book records point into it.
const kBuckets = new Map<
  string,
  { s3Bucket: string; environment: Environment }
>([
  ["upload", { s3Bucket: "BloomLibraryBooks", environment: Environment.PRODUCTION }],
  ["dev-upload", { s3Bucket: "BloomLibraryBooks-Sandbox", environment: Environment.DEVELOPMENT }],
  ["harvest", { s3Bucket: "bloomharvest", environment: Environment.PRODUCTION }],
  ["dev-harvest", { s3Bucket: "bloomharvest-sandbox", environment: Environment.DEVELOPMENT }],
]);

export function isValidBucket(bucketKey: string): boolean {
  return kBuckets.has(bucketKey);
}

export default class BookData {
  // Get the real URL for the content based on the input URL parameters.
  public static async getContentUrl(
    params: ContentUrlParams
  ): Promise<string | null> {
    const bucketInfo = kBuckets.get(params.bucket);
    if (!bucketInfo) {
      return null;
    }
    const { s3Bucket, environment } = bucketInfo;

    const parseServer = new BloomParseServer(environment);
    const bookInfo: Book | undefined = await parseServer.getBookByDatabaseId(
      params.bookid
    );
    if (!bookInfo || !bookInfo.baseUrl) {
      return null;
    }
    let url = BloomParseServer.getS3LinkBase(bookInfo.baseUrl, s3Bucket);
    
    // Append all path segments
    const pathSegments = params.pathSegments;
    for (const segment of pathSegments) {
      if (segment && segment.length > 0) {
        url = url + "/" + encodeUnicode(segment);
      }
    }
    
    return url;
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
