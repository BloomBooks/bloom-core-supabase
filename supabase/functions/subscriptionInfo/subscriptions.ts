import { checkForRequiredEnvVars } from "../_shared/utils.ts";

// Looks up a subscription code in a Google Sheet and returns information about it.
// The sheet is read via a Google service account using the Sheets REST API.

export interface SubscriptionResult {
  code: string;
  replacementCode: string;
  tier: string;
  brandingLabel: string;
  showMessage: string;
}

// The named range in the spreadsheet. It covers these columns:
// Code, Replacement Code, Tier, Branding Label, Show Message
const RANGE = "SUBSCRIPTION_API_DATA";

// No CORS headers or OPTIONS preflight handling here, unlike the browser-facing
// sibling functions: the documented consumer of /v1/subscriptionInfo is Bloom
// Desktop (a native client, not a browser), so CORS is not needed. Add the
// shared getCorsHeaders/isAllowedCorsOrigin handling only if a browser consumer
// (e.g. blorg) is ever confirmed. (Reviewed 2026-07; decided to leave as is.)
export async function handleSubscriptionInfoRequest(
  req: Request
): Promise<Response> {
  const code = getCodeFromUrl(req.url);
  if (!code) {
    return new Response("Missing required parameter: code", { status: 400 });
  }

  try {
    checkForRequiredEnvVars([
      "BLOOM_GOOGLE_SERVICE_ACCOUNT_EMAIL",
      "BLOOM_GOOGLE_SERVICE_PRIVATE_KEY",
      "BLOOM_SUBSCRIPTION_SPREADSHEET_ID",
    ]);

    const accessToken = await getGoogleAccessToken(
      Deno.env.get("BLOOM_GOOGLE_SERVICE_ACCOUNT_EMAIL")!,
      Deno.env.get("BLOOM_GOOGLE_SERVICE_PRIVATE_KEY")!,
      "https://www.googleapis.com/auth/spreadsheets.readonly"
    );

    const rows = await getSheetRows(
      accessToken,
      Deno.env.get("BLOOM_SUBSCRIPTION_SPREADSHEET_ID")!,
      RANGE
    );

    // The first row is labels. findSubscriptionRow deliberately searches all
    // rows including this header: slicing it off (rows.slice(1)) would risk
    // dropping a real row if the SUBSCRIPTION_API_DATA named range is ever
    // defined to exclude the header, and the only downside of keeping it is a
    // client querying the literal code "Code". (Reviewed 2026-07; left as is.)
    if (rows?.length) {
      const result = findSubscriptionRow(rows, code);
      if (result) {
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Did not find a row with that code", {
        status: 404,
      });
    }
    return new Response("No data found", { status: 404 });
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : String(error)
    );
    return new Response(null, { status: 500 });
  }
}

// URL format: .../subscriptionInfo/{code}
export function getCodeFromUrl(requestUrl: string): string | undefined {
  const pathSegments = new URL(requestUrl).pathname
    .split("/")
    .filter((segment) => segment !== "");
  const fnIndex = pathSegments.findIndex(
    (segment) => segment === "subscriptionInfo"
  );
  if (fnIndex === -1 || fnIndex + 1 >= pathSegments.length) {
    return undefined;
  }
  return decodeURIComponent(pathSegments[fnIndex + 1]);
}

// find the first row matching the code we were given
export function findSubscriptionRow(
  rows: unknown[][],
  code: string
): SubscriptionResult | undefined {
  // The Sheets API returns unformatted values, so a purely-numeric cell comes
  // back as a number; compare and store everything as strings so a numeric
  // code still matches and the response fields keep their string type. The API
  // also omits trailing empty cells, so default each field to "" (via toText)
  // to keep the response shape stable — every key is always present.
  const toText = (value: unknown) => (value == null ? "" : String(value));
  const cells = rows.find((columns) => toText(columns[0]) === code);
  if (!cells) return undefined;
  return {
    code: toText(cells[0]),
    replacementCode: toText(cells[1]),
    tier: toText(cells[2]),
    brandingLabel: toText(cells[3]),
    showMessage: toText(cells[4]),
  };
}

async function getSheetRows(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<unknown[][] | undefined> {
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range
    )}?valueRenderOption=UNFORMATTED_VALUE`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!response.ok) {
    throw new Error(
      `Google Sheets request failed: ${response.status} ${await response.text()}`
    );
  }
  const data = await response.json();
  return data.values;
}

// Authenticate as the service account using a signed JWT and exchange it
// for an OAuth access token. (The Azure version used the googleapis npm
// package; this is the same flow using WebCrypto and fetch.)
// A fresh token is fetched on every request (no caching). That is fine for
// this low-traffic lookup; caching it until near expiry would only save a
// round-trip. (Reviewed 2026-07; decided to leave as is.)
export async function getGoogleAccessToken(
  serviceAccountEmail: string,
  privateKeyPem: string,
  scope: string
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccountEmail,
    scope,
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const unsigned =
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(header))) +
    "." +
    base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = unsigned + "." + base64UrlEncode(new Uint8Array(signature));

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Google token request failed: ${response.status} ${await response.text()}`
    );
  }
  const data = await response.json();
  return data.access_token;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // The env var may contain literal \n sequences instead of newlines.
  const cleaned = pem
    .replace(/\\n/g, "\n")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  const der = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
