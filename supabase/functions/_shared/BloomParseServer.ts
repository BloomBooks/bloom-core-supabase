import { Environment } from "./utils.ts";

export type User = {
  objectId: string;
  email: string;
  username: string;
  sessionToken: string;
};

export type Book = {
  objectId: string;
  uploader: User;
  title: string;
  bookInstanceId: string;
  baseUrl: string;
  tags: string[];
  brandingProjectName: string;
  updateSource: string;
  uploadPendingTimestamp: number;
  inCirculation: boolean;
  ACL: Record<string, any>;
  harvestState: string;
};

export default class BloomParseServer {
  private environment: Environment;

  constructor(environment: Environment) {
    this.environment = environment;
  }

  public getEnvironment(): Environment {
    return this.environment;
  }

  public getParseUrlBase(): string {
    switch (this.environment) {
      case Environment.PRODUCTION:
      default:
        return "https://server.bloomlibrary.org/parse";
      case Environment.DEVELOPMENT:
        return "https://dev-server.bloomlibrary.org/parse";
      case Environment.UNITTEST:
        return "https://bloom-parse-server-unittest.azurewebsites.net/parse";
    }
  }

  public getParseTableUrl(tableName: string): string {
    return this.getParseUrlBase() + "/classes/" + tableName;
  }

  public getParseLoginUrl(): string {
    return this.getParseUrlBase() + "/login";
  }

  public getParseUserUrl(): string {
    return this.getParseUrlBase() + "/users/me";
  }

  public getParseAppId(): string {
    switch (this.environment) {
      case Environment.PRODUCTION:
      default:
        return (
          Deno.env.get("BLOOM_PARSE_APP_ID_PROD") || "BLOOM_PARSE_APP_ID_PROD is missing from env!"
        );
      case Environment.DEVELOPMENT:
        return (
          Deno.env.get("BLOOM_PARSE_APP_ID_DEV") || "BLOOM_PARSE_APP_ID_DEV is missing from env!"
        );
      case Environment.UNITTEST:
        return (
          Deno.env.get("BLOOM_PARSE_APP_ID_UNIT_TEST") ||
          "BLOOM_PARSE_APP_ID_UNIT_TEST is missing from env!"
        );
    }
  }

  // Given the book parse data and bucket, get the base URL for accessing the data stored on S3.
  // The base URL will look like one of the following:
  // https://s3.amazonaws.com/BloomLibraryBooks/<uploader-email>/<book-instance-guid>/<book-title>
  // https://s3.amazonaws.com/bloomharvest/<uploader-email>/<book-instance-guid>
  public static getS3LinkBase(rawBaseUrl: string, bucket: string): string {
    const baseUrl: string = rawBaseUrl.replace(/%2f/g, "/"); // I don't know why anyone thinks / needs to be url-encoded.
    const urlWithoutFinalSlash = baseUrl.replace(/\/$/, "");
    let url: string;
    if (bucket.startsWith("BloomLibraryBooks")) {
      url = urlWithoutFinalSlash;
    } else {
      // chop off the title at the end of baseUrl.
      const idx = urlWithoutFinalSlash.lastIndexOf("/");
      url = urlWithoutFinalSlash.substring(0, idx);
      if (bucket === "bloomharvest-sandbox") {
        url = url.replace("BloomLibraryBooks-Sandbox", bucket);
      } else if (bucket === "bloomharvest") {
        url = url.replace("BloomLibraryBooks", bucket);
      }
    }
    const idxCheck = url.indexOf("/" + bucket + "/");
    if (idxCheck < 0) {
      console.log(
        "ERROR: confusion between input bucket and url based on book's baseUrl"
      );
    }
    return url;
  }

  // Get the URL where we find book thumbnails if they have not been harvested recently
  // enough to have a harvester-produced thumbnail. Includes a fake query designed to defeat
  // caching of the thumbnail if the book might have been modified since last cached.
  private static getLegacyThumbnailUrl(book: any, apiBaseUrl: string) {
    const baseUrl = this.getUploadBaseUrl(book, apiBaseUrl);
    if (!baseUrl) {
      return undefined;
    }
    return `${baseUrl}/thumbnail-256.png?version=${book.updatedAt}`;
  }

  // Get the URL where we find book thumbnails if they have been harvested recently
  // enough to have a harvester-produced thumbnail. Includes a fake query designed to defeat
  // caching of the thumbnail if the book might have been modified since last cached.
  private static getHarvesterProducedThumbnailUrl(
    book: any,
    apiBaseUrl: string
  ): string | undefined {
    const harvestTime = book.harvestStartedAt;
    if (!harvestTime || new Date(harvestTime.iso) < new Date(2020, 1, 11, 11)) {
      // That date above is FEBRUARY 12! at 11am. If the harvest time is before that,
      // the book was not harvested recently enough to have a useful harvester thumbnail.
      // (We'd prefer to do this with harvester version, or even to just be
      // able to assume that any harvested book has this, but it's not yet so.
      // When it is, we can use harvestState === "Done" and remove harvestStartedAt from
      // Book, IBasicBookInfo, and the keys for BookGroup queries.)
      return undefined;
    }
    const harvesterBaseUrl = this.getHarvesterBaseUrl(book, apiBaseUrl);
    if (!harvesterBaseUrl) {
      return undefined;
    }
    return `${harvesterBaseUrl}/thumbnails/thumbnail-256.png?version=${book.updatedAt}`;
  }

  // Get the place we should look for a book thumbnail.
  public static getThumbnailUrl(
    book: any,
    apiBaseUrl: string = BloomParseServer.DefaultApiBaseUrl
  ) {
    return (
      this.getHarvesterProducedThumbnailUrl(book, apiBaseUrl) ||
      this.getLegacyThumbnailUrl(book, apiBaseUrl)
    );
  }

  private static isHarvested(book: any) {
    return book && book.harvestState === "Done";
  }

  // The public base URL of this API, used when generating links to the fs function.
  // Callers that know the URL the request actually arrived on (e.g. opds) pass it
  // through the apiBaseUrl parameters instead of relying on this default.
  public static readonly DefaultApiBaseUrl = "https://api.bloomlibrary.org/v1";

  // typical book.baseUrl:
  // https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/ken%40example.com%2faa647178-ed4d-4316-b8bf-0dc94536347d%2fsign+language+test%2f
  // want:
  // https://api.bloomlibrary.org/v1/fs/dev-upload/U8INuhZHlU
  // We come up with that URL by
  //  (a) start new URL with "https://api.bloomlibrary.org/v1/fs"
  //  (b) match BloomLibraryBooks{-Sandbox} in input URL to {dev-}upload in output URL
  //  (c) append another / and book's objectId
  public static getUploadBaseUrl(
    book: any,
    apiBaseUrl: string = BloomParseServer.DefaultApiBaseUrl
  ): string | undefined {
    if (!book) {
      return undefined;
    }
    if (!book.baseUrl) {
      return undefined;
    }
    if (book.baseUrl.includes("/BloomLibraryBooks-Sandbox/")) {
      return `${apiBaseUrl}/fs/dev-upload/${book.objectId}`;
    } else if (book.baseUrl.includes("/BloomLibraryBooks/")) {
      return `${apiBaseUrl}/fs/upload/${book.objectId}`;
    } else {
      return undefined; // things have changed: we don't know what's what any longer...
    }
  }

  // typical book.baseUrl:
  // https://s3.amazonaws.com/BloomLibraryBooks-Sandbox/ken%40example.com%2faa647178-ed4d-4316-b8bf-0dc94536347d%2fsign+language+test%2f
  // want:
  // https://api.bloomlibrary.org/v1/fs/dev-harvest/U8INuhZHlU
  // We come up with that URL by
  //  (a) start new URL with "https://api.bloomlibrary.org/v1/fs/"
  //  (b) match BloomLibraryBooks{-Sandbox} in input URL to {dev-}harvest in output URL
  //  (c) append another / and book's objectId
  public static getHarvesterBaseUrl(
    book: any,
    apiBaseUrl: string = BloomParseServer.DefaultApiBaseUrl
  ): string | undefined {
    if (!book) {
      return undefined;
    }
    if (book.baseUrl === null) {
      return undefined;
    }
    if (!this.isHarvested(book)) {
      return undefined;
    }
    if (book.baseUrl.includes("/BloomLibraryBooks-Sandbox/")) {
      return `${apiBaseUrl}/fs/dev-harvest/${book.objectId}`;
    } else if (book.baseUrl.includes("/BloomLibraryBooks/")) {
      return `${apiBaseUrl}/fs/harvest/${book.objectId}`;
    } else {
      return undefined; // things have changed: we don't know what's what any longer...
    }
  }

  public static getImageContentType(href: string | undefined) {
    let imageType = "image/jpeg";
    if (href && href.toLowerCase().includes(".png")) {
      imageType = "image/png";
    }
    return imageType;
  }

  public static MakeUrlSafe(text: string): string {
    // This needs to match whatever Harvester is using. The first replace is probably enough.
    const text1 = text.replace("@", "%40");
    return text1.replace(/ /g, "+");
  }

  public static getBookFileName(book: Book): string {
    const baseUrl = book.baseUrl.replace(/%2f/g, "/"); // I don't know why anyone thinks / needs to be url-encoded.
    const name = BloomParseServer.extractBookFilename(baseUrl);
    return name;
  }

  private static extractBookFilename(baseUrl: string): string {
    // Strip a trailing slash before taking the last path segment. The typical
    // book.baseUrl ends in an encoded slash (%2f) which getBookFileName turns
    // into a real trailing "/", so without this the last segment would be empty.
    const urlWithoutFinalSlash = baseUrl.replace(/\/$/, "");
    return urlWithoutFinalSlash.substring(
      urlWithoutFinalSlash.lastIndexOf("/") + 1
    );
  }

  public async getBookByDatabaseId(
    objectId: string,
    fieldsToExpand: string[] = []
  ): Promise<Book | undefined> {
    return await this.getBook(
      JSON.stringify({ objectId: { $eq: objectId } }),
      fieldsToExpand
    );
  }

  public async getBook(
    where: string,
    fieldsToExpand: string[] = []
  ): Promise<Book | undefined> {
    try {
      const result = await this.doBookQuery(where, fieldsToExpand, {});
      if (result.results.length > 1) {
        throw new Error("More than one book found for " + where);
      }
      return result.results[0];
    } catch (err) {
      console.log("ERROR: caught fetch error: " + err);
      throw err;
    }
  }

  public async getBooks(
    where: string,
    fieldsToExpand: string[] = [],
    additionalParams: Record<string, any> = {}
  ): Promise<{ books: Book[]; count: number }> {
    try {
      const result = await this.doBookQuery(
        where,
        fieldsToExpand,
        additionalParams
      );
      return { books: result.results, count: result.count };
    } catch (err) {
      console.log("ERROR: caught fetch error: " + err);
      throw err;
    }
  }

  private async doBookQuery(
    where: string,
    fieldsToExpand: string[],
    additionalParams: Record<string, any>
  ): Promise<{ results: Book[]; count: number }> {
    const body = {
      _method: "GET",
      where,
      include: fieldsToExpand.join(","),
      ...additionalParams, // e.g. limit, skip, count
    };

    const response = await fetch(this.getParseTableUrl("books"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Parse-Application-Id": this.getParseAppId(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Parse server request failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data;
  }

  // This function logs in to the Parse server, using a hard-coded user name ("catalog-service").
  // That account has a ParseServer "role" which is allowed to read the `apiAccount` and `user` tables.
  public async loginAsCatalogService(): Promise<string> {
    const env = (globalThis as any).Deno?.env;
    return await this.loginAsUser(
      "catalog-service",
      env?.get("BLOOM_PARSE_CATALOG_SERVICE_PASSWORD") // should be the same for dev and production
    );
  }

  public async loginAsUser(
    username: string,
    password: string
  ): Promise<string> {
    const response = await fetch(this.getParseLoginUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Parse-Application-Id": this.getParseAppId(),
      },
      body: JSON.stringify({
        username,
        password,
      }),
    });

    if (!response.ok) {
      throw new Error(`Parse login failed: ${response.statusText}`);
    }

    const data = await response.json();
    return data.sessionToken;
  }

  public async loginAsBookCleanupUser(): Promise<string> {
    let password;
    switch (this.environment) {
      case Environment.PRODUCTION:
        password = Deno.env.get("BLOOM_PARSE_BOOK_CLEANUP_PASSWORD_PROD");
        break;
      case Environment.DEVELOPMENT:
        password = Deno.env.get("BLOOM_PARSE_BOOK_CLEANUP_PASSWORD_DEV");
        break;
      case Environment.UNITTEST:
        password = Deno.env.get("BLOOM_PARSE_BOOK_CLEANUP_PASSWORD_UNIT_TEST");
        break;
    }
    return await this.loginAsUser("book-cleanup", password || "");
  }

  // This function logs in to the parse server using a hard-coded user name ("api-super-user").
  // That account has a parse server "role" which is allowed to modify all book records.
  // We use it when a user has permission to upload a book by being a collection editor
  // (as opposed to being the book uploader).
  private async loginAsApiSuperUser(): Promise<string> {
    let password;
    switch (this.environment) {
      case Environment.PRODUCTION:
        password = Deno.env.get("BLOOM_PARSE_SUPER_USER_PASSWORD_PROD");
        break;
      case Environment.DEVELOPMENT:
        password = Deno.env.get("BLOOM_PARSE_SUPER_USER_PASSWORD_DEV");
        break;
    }
    return await this.loginAsUser("api-super-user", password || "");
  }

  // Be sure you've already checked that the user has permissions to perform the operation on this book.
  public async loginAsApiSuperUserIfNeeded(userInfo: User, bookInfo: Book) {
    if (!BloomParseServer.isUploader(userInfo, bookInfo)) {
      return await this.loginAsApiSuperUser();
    }
    return undefined;
  }

  public async loginAsUnitTestUser(): Promise<string> {
    if (this.environment !== Environment.UNITTEST) {
      throw new Error("This function is only for unit tests");
    }
    return await this.loginAsUser("unittest@example.com", "unittest");
  }

  public async getLoggedInUserInfo(sessionToken: string): Promise<User | null> {
    try {
      const response = await fetch(this.getParseUserUrl(), {
        headers: {
          "X-Parse-Application-Id": this.getParseAppId(),
          "X-Parse-Session-Token": sessionToken,
        },
      });

      if (!response.ok) {
        return null; // not a valid session token; no user info to return
      }

      return (await response.json()) as User;
    } catch (error) {
      return null; // not a valid session token; no user info to return
    }
  }

  // Helper methods for permission checking
  public static isUploader(userInfo: User, bookInfo: Book) {
    if (!bookInfo?.uploader?.objectId) return false;
    if (!userInfo?.objectId) return false;

    return bookInfo.uploader.objectId === userInfo.objectId;
  }

  public async getLanguages() {
    const url = new URL(this.getParseTableUrl("language"));
    url.searchParams.append("limit", "10000");
    url.searchParams.append("where", '{"usageCount":{"$ne":0}}');

    const response = await fetch(url.toString(), {
      headers: {
        "X-Parse-Application-Id": this.getParseAppId(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get languages: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results;
  }

  // returns the objectId of the language record just created
  public async createLanguage(langJson: any): Promise<string> {
    const url = this.getParseTableUrl("language");
    // If langJson is already a string (JSON), use it directly; otherwise stringify it
    const body =
      typeof langJson === "string" ? langJson : JSON.stringify(langJson);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": this.getParseAppId(),
        "Content-Type": "application/json",
      },
      body: body,
    });

    if (!response.ok) {
      // Full Parse response goes to the server log only; the thrown message
      // stays minimal in case a caller echoes it to an HTTP client.
      const errorText = await response.text();
      console.error(
        `Failed to create language record: ${response.status} ${errorText}`
      );
      throw new Error(
        `Failed to create language record: ${response.status}`
      );
    }

    const data = await response.json();
    return data.objectId;
  }

  // returns the language record from Parse
  public async getLanguage(langJson: any): Promise<any> {
    const url = new URL(this.getParseTableUrl("language"));
    // If langJson is already a string (JSON), use it directly; otherwise stringify it
    const whereParam =
      typeof langJson === "string" ? langJson : JSON.stringify(langJson);
    url.searchParams.append("where", whereParam);

    const response = await fetch(url.toString(), {
      headers: {
        "X-Parse-Application-Id": this.getParseAppId(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get language: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results[0];
  }

  public async deleteLanguage(languageObjectId: string, sessionToken: string) {
    const response = await fetch(
      this.getParseTableUrl("language") + "/" + languageObjectId,
      {
        method: "DELETE",
        headers: {
          "X-Parse-Application-Id": this.getParseAppId(),
          "X-Parse-Session-Token": sessionToken,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to delete language: ${response.statusText}`);
    }

    return await response.json();
  }

  // returns the objectId of the first language matching the specifications of langJson, creating the language if necessary
  public async getOrCreateLanguage(langJson: any): Promise<string> {
    const lang = await this.getLanguage(langJson);
    if (lang) {
      return lang.objectId;
    }
    return await this.createLanguage(langJson);
  }

  // Get all the books in circulation that fit the current parameters.
  // Further filtering may be needed, but those two filters should reduce the transfer considerably.
  public async getBooksForCatalog(
    desiredLang: string | undefined,
    tag: string | undefined,
    embargoDays: number
  ): Promise<any[]> {
    let newestDate, newestDateString;
    try {
      newestDate = new Date(Date.now() - embargoDays * 24 * 60 * 60 * 1000);
      // add one day to make sure we get all books from the last day (since we're using less than or equal to the truncated date)
      newestDate.setDate(newestDate.getDate() + 1);
      newestDateString = newestDate.toISOString().split("T")[0];
    } catch (err) {
      throw "Problem with embargo date handling: " + String(err);
    }

    const where: Record<string, unknown> = {
      inCirculation: true,
      draft: false,
      createdAt: { $lte: { __type: "Date", iso: newestDateString } },
    };

    if (desiredLang)
      where.langPointers = {
        $inQuery: { where: { isoCode: desiredLang }, className: "language" },
      };

    if (tag) {
      // Note on querying tags, which is an array type. https://docs.parseplatform.org/rest/guide/#queries-on-array-values
      // says that its implicit that you're only requiring the value to exist in the array, and if you really mean to match
      // all of them, then you have to use $all.
      where.tags = tag;
    }

    const url = new URL(this.getParseTableUrl("books"));
    // ENHANCE: if we want partial pages like GDL, use limit and skip (with function params to achieve this)
    url.searchParams.append("limit", "100000");
    url.searchParams.append("order", "title");
    url.searchParams.append("include", "uploader,langPointers");
    url.searchParams.append("where", JSON.stringify(where));

    const response = await fetch(url.toString(), {
      headers: {
        "X-Parse-Application-Id": this.getParseAppId(),
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to get books for catalog: ${response.statusText}`
      );
    }

    const data = await response.json();
    return data.results;
  }

  // Get an object containing the data from the apiAccount table row with the
  // specified ID (not yet authenticated).
  public async getApiAccount(objectId: string): Promise<ApiAccount | null> {
    let sessionToken;
    try {
      sessionToken = await this.loginAsCatalogService();
      if (!sessionToken) {
        throw new Error(
          "The Catalog Service could not log in to Parse Server."
        );
      }
    } catch (err) {
      throw new Error(
        `Could not log in as catalog service: ${
          err instanceof Error ? err.message : JSON.stringify(err)
        }`
      );
    }
    try {
      const url = new URL(this.getParseTableUrl("apiAccount"));
      url.searchParams.append("include", "user");
      url.searchParams.append(
        "where",
        JSON.stringify({ objectId: { $eq: objectId } })
      );

      const response = await fetch(url.toString(), {
        headers: {
          "X-Parse-Application-Id": this.getParseAppId(),
          "X-Parse-Session-Token": sessionToken,
        },
      });

      if (!response.ok) {
        throw new Error(`status ${response.status}: ${await response.text()}`);
      }

      const data = await response.json();
      if (data?.results?.length === 1) {
        return data.results[0] as ApiAccount;
      }
    } catch (err) {
      throw new Error(
        `Could not get apiAccount: ${
          err instanceof Error ? err.message : JSON.stringify(err)
        }`
      );
    }
    return null;
  }

  // Get the count of books with the given language tag where 'rebrand' is false and 'inCirculation' is true and 'draft' is false.
  public async getBookCountByLanguage(languageTag: string) {
    const url = new URL(this.getParseTableUrl("books"));
    url.searchParams.append("count", "1");
    url.searchParams.append("limit", "0");
    url.searchParams.append(
      "where",
      JSON.stringify({
        langPointers: {
          $inQuery: {
            where: { isoCode: languageTag },
            className: "language",
          },
        },
        rebrand: false,
        inCirculation: true,
        draft: false,
      })
    );

    const response = await fetch(url.toString(), {
      headers: {
        "X-Parse-Application-Id": this.getParseAppId(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get book count: ${response.statusText}`);
    }

    const data = await response.json();
    return data.count;
  }

  public async createBookRecord(bookInfo: any, sessionToken: string) {
    const url = this.getParseTableUrl("books");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-Parse-Application-Id": this.getParseAppId(),
        "X-Parse-Session-Token": sessionToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(bookInfo),
    });

    if (response.status !== 201) {
      // Full Parse response goes to the server log only; the thrown message
      // stays minimal in case a caller echoes it to an HTTP client.
      const errorText = await response.text();
      console.error(
        `Failed to create book record: ${response.status} ${errorText}`
      );
      throw new Error(`Failed to create book record: ${response.status}`);
    }

    const data = await response.json();
    return data.objectId;
  }

  public async modifyBookRecord(
    bookObjectId: string,
    bookInfo: any,
    sessionToken: string
  ) {
    const response = await fetch(
      this.getParseTableUrl("books") + "/" + bookObjectId,
      {
        method: "PUT",
        headers: {
          "X-Parse-Application-Id": this.getParseAppId(),
          "X-Parse-Session-Token": sessionToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(bookInfo),
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to modify book record: ${response.statusText}`);
    }

    return await response.json();
  }

  public async deleteBookRecord(bookObjectId: string, sessionToken: string) {
    const response = await fetch(
      this.getParseTableUrl("books") + "/" + bookObjectId,
      {
        method: "DELETE",
        headers: {
          "X-Parse-Application-Id": this.getParseAppId(),
          "X-Parse-Session-Token": sessionToken,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to delete book record: ${response.statusText}`);
    }

    return await response.json();
  }
}

export type ApiAccount = {
  objectId: string;
  user: {
    objectId: string;
    username: string;
  };
  embargoDays?: number;
  referrerTag: string;
};
