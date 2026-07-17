import { assert, assertEquals } from "@std/assert";
import {
  findSubscriptionRow,
  getCodeFromUrl,
  handleSubscriptionInfoRequest,
} from "../subscriptionInfo/subscriptions.ts";
import { testRequiringSecrets } from "./testSecrets.ts";

const kRows = [
  ["Code", "Replacement Code", "Tier", "Branding Label", "Show Message"],
  ["OLD-CODE-1", "NEW-CODE-1", "Pro", "Old Branding", "Please upgrade"],
  ["ACTIVE-CODE", "", "Enterprise", "Some Branding", ""],
];

Deno.test("subscriptionInfo - getCodeFromUrl extracts the code", () => {
  assertEquals(
    getCodeFromUrl("https://x/functions/v1/subscriptionInfo/ABC-123"),
    "ABC-123"
  );
  assertEquals(
    getCodeFromUrl("https://api.bloomlibrary.org/v1/subscriptionInfo/ABC-123"),
    "ABC-123"
  );
});

Deno.test("subscriptionInfo - getCodeFromUrl handles url-encoded codes", () => {
  assertEquals(
    getCodeFromUrl("https://x/v1/subscriptionInfo/A%20B"),
    "A B"
  );
});

Deno.test("subscriptionInfo - getCodeFromUrl returns undefined when missing", () => {
  assertEquals(getCodeFromUrl("https://x/v1/subscriptionInfo"), undefined);
  assertEquals(getCodeFromUrl("https://x/v1/other/ABC"), undefined);
});

Deno.test("subscriptionInfo - findSubscriptionRow finds matching row", () => {
  const result = findSubscriptionRow(kRows, "OLD-CODE-1");
  assertEquals(result?.code, "OLD-CODE-1");
  assertEquals(result?.replacementCode, "NEW-CODE-1");
  assertEquals(result?.tier, "Pro");
  assertEquals(result?.brandingLabel, "Old Branding");
  assertEquals(result?.showMessage, "Please upgrade");
});

Deno.test("subscriptionInfo - findSubscriptionRow returns undefined for unknown code", () => {
  assertEquals(findSubscriptionRow(kRows, "NO-SUCH-CODE"), undefined);
});

Deno.test("subscriptionInfo - findSubscriptionRow matches numeric codes and keeps fields as strings", () => {
  // The Sheets API returns unformatted values, so an all-digit code arrives
  // as a number; the lookup and the returned fields should still be strings.
  const numericRows = [
    ["Code", "Replacement Code", "Tier", "Branding Label", "Show Message"],
    [1234, 5678, "Pro", "Branding", "Message"],
  ];
  const result = findSubscriptionRow(numericRows, "1234");
  assertEquals(result?.code, "1234");
  assertEquals(result?.replacementCode, "5678");
  assertEquals(result?.tier, "Pro");
});

Deno.test("subscriptionInfo - findSubscriptionRow defaults trailing blank fields to empty strings", () => {
  // The Sheets API omits trailing empty cells, so a row can arrive short; every
  // response key should still be present as "" rather than dropping out.
  const shortRows = [
    ["Code", "Replacement Code", "Tier", "Branding Label", "Show Message"],
    ["ACTIVE-CODE"],
  ];
  const result = findSubscriptionRow(shortRows, "ACTIVE-CODE");
  assertEquals(result, {
    code: "ACTIVE-CODE",
    replacementCode: "",
    tier: "",
    brandingLabel: "",
    showMessage: "",
  });
});

Deno.test("subscriptionInfo - 400 when code missing from url", async () => {
  const response = await handleSubscriptionInfoRequest(
    new Request("https://x/functions/v1/subscriptionInfo")
  );
  assertEquals(response.status, 400);
});

Deno.test("subscriptionInfo - full request against stubbed Google APIs", async () => {
  // Generate a real RSA key so the JWT-signing path is exercised end to end.
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const pem =
    "-----BEGIN PRIVATE KEY-----\n" +
    btoa(String.fromCharCode(...new Uint8Array(pkcs8))) +
    "\n-----END PRIVATE KEY-----\n";

  // Save any real credentials so the live integration tests below still see
  // them; this test overwrites the env with fakes and must put it back.
  const envKeys = [
    "BLOOM_GOOGLE_SERVICE_ACCOUNT_EMAIL",
    "BLOOM_GOOGLE_SERVICE_PRIVATE_KEY",
    "BLOOM_SUBSCRIPTION_SPREADSHEET_ID",
  ];
  const originalEnv = new Map(envKeys.map((k) => [k, Deno.env.get(k)]));

  Deno.env.set("BLOOM_GOOGLE_SERVICE_ACCOUNT_EMAIL", "test@example.iam.gserviceaccount.com");
  Deno.env.set("BLOOM_GOOGLE_SERVICE_PRIVATE_KEY", pem);
  Deno.env.set("BLOOM_SUBSCRIPTION_SPREADSHEET_ID", "sheet123");

  const originalFetch = globalThis.fetch;
  let tokenRequestJwt: string | undefined;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      tokenRequestJwt = new URLSearchParams(init?.body as string).get(
        "assertion"
      ) ?? undefined;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "fake-token" }), {
          status: 200,
        })
      );
    }
    if (url.startsWith("https://sheets.googleapis.com/")) {
      assert(url.includes("sheet123"));
      assert(url.includes("SUBSCRIPTION_API_DATA"));
      return Promise.resolve(
        new Response(JSON.stringify({ values: kRows }), { status: 200 })
      );
    }
    return Promise.reject(new Error("Unexpected fetch: " + url));
  };

  try {
    const response = await handleSubscriptionInfoRequest(
      new Request("https://x/functions/v1/subscriptionInfo/ACTIVE-CODE")
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Content-Type"), "application/json");
    const result = await response.json();
    assertEquals(result.code, "ACTIVE-CODE");
    assertEquals(result.tier, "Enterprise");

    // the JWT sent to Google should be a three-part token signed by our key
    assert(tokenRequestJwt);
    assertEquals(tokenRequestJwt!.split(".").length, 3);

    const notFound = await handleSubscriptionInfoRequest(
      new Request("https://x/functions/v1/subscriptionInfo/NO-SUCH")
    );
    assertEquals(notFound.status, 404);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [k, v] of originalEnv) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});

// --- Live integration tests against the real Google Sheet (ported from the ---
// --- Azure subscriptions.test.ts). They run only when the Google          ---
// --- service-account variables are present (e.g. via .env.local).         ---
const kGoogleSecrets = [
  "BLOOM_GOOGLE_SERVICE_ACCOUNT_EMAIL",
  "BLOOM_GOOGLE_SERVICE_PRIVATE_KEY",
  "BLOOM_SUBSCRIPTION_SPREADSHEET_ID",
];

testRequiringSecrets({
  name: "subscriptionInfo - live: provides the fields that go with 'Test-361769-1088'",
  secrets: kGoogleSecrets,
  fn: async () => {
    const response = await handleSubscriptionInfoRequest(
      new Request("https://x/v1/subscriptionInfo/Test-361769-1088")
    );
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Content-Type"), "application/json");
    const result = await response.json();
    assertEquals(result.code, "Test-361769-1088");
    assertEquals(result.replacementCode, "Test-727011-1339");
    assertEquals(result.showMessage, "Happy Testing");
  },
});

testRequiringSecrets({
  name: "subscriptionInfo - live: provides the fields that go with 'Legacy-Community'",
  secrets: kGoogleSecrets,
  fn: async () => {
    const response = await handleSubscriptionInfoRequest(
      new Request("https://x/v1/subscriptionInfo/Legacy-Community")
    );
    assertEquals(response.status, 200);
    const result = await response.json();
    assertEquals(result.code, "Legacy-Community");
    assertEquals(result.replacementCode, "Legacy-Community-005962-9361");
    assertEquals(result.tier, "Community");
    assertEquals(result.brandingLabel, "Legacy Community");
    assert(result.showMessage);
  },
});
