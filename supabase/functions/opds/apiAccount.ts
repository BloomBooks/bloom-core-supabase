import BloomParseServer, { ApiAccount } from "../_shared/BloomParseServer.ts";
import { DefaultEnvironment, Environment } from "../_shared/utils.ts";

export async function getApiAccount(
  key: string,
  devOrProductionServer?: Environment
): Promise<{
  account?: ApiAccount;
  resultCode: number;
  errorMessage?: string;
}> {
  if (!key || !key.trim()) {
    return {
      resultCode: 401,
      errorMessage:
        "Please include your API key. Example: https://api.bloomlibrary.org/v1/catalog?key=pat@example.com:1a2b3d4. For key information, please write to admin@bloomlibrary.org",
    };
  }

  const parseServer = new BloomParseServer(
    devOrProductionServer || DefaultEnvironment
  );

  try {
    // Test hook: simulate the parse server being unreachable. Checked before the
    // key-format guard so the sentinel need not be a well-formed key (it stands
    // in for a server error, which in real use happens after a valid-format key).
    if (key === "pretend-parse-server-down") {
      throw new Error("pretend problem talking to Parse Server");
    }

    const keyParts = key.split(":");
    if (keyParts.length < 2) {
      return {
        resultCode: 403,
        errorMessage: "Keys are of the form pat@example.com:1a2b3d4",
      };
    }
    const objectId = keyParts[keyParts.length - 1]; // last part when split by colons

    const account = await parseServer.getApiAccount(objectId);

    if (!account) {
      return {
        resultCode: 403,
        errorMessage: `Did not find apiAccount for '${objectId}'.`,
      };
    }
    // Note: originally I had wanted to use the user's email, but our version of parse server requires
    // masterkey to access that. In practice our user names are the same as emails, for better or for worse.
    // In any case, we're using username now.
    if (account && account.user.username !== keyParts[0]) {
      return {
        resultCode: 403,
        // This is a good compromise (between debuggability and not giving away the game):
        errorMessage: `Found the apiAccount, but the userName of the associated user did not match the key username.`,
      };
    }

    return { resultCode: 0, account: account };
  } catch (error) {
    return {
      resultCode: 503,
      errorMessage: `Our apologies: we had an internal problem validating your api key. If this problem persists, please write to admin@bloomlibrary.org.
        ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
