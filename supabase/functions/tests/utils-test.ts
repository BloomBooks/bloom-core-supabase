import { assertEquals, assertExists } from "@std/assert";

import {
  Environment,
  DefaultEnvironment,
  setDefaultEnvironment,
  getEnvironment,
  getNumberFromQuery,
  getBooleanFromQueryAsOneOrZero,
  parseBooleanQueryParam,
  isAllowedCorsOrigin,
} from "../_shared/utils.ts";

// Test setDefaultEnvironment and getEnvironment
Deno.test({
  name: "utils - setDefaultEnvironment changes the default environment",
  fn: () => {
    const originalDefault = DefaultEnvironment;

    setDefaultEnvironment(Environment.DEVELOPMENT);
    assertEquals(getEnvironment(), Environment.DEVELOPMENT);

    setDefaultEnvironment(Environment.UNITTEST);
    assertEquals(getEnvironment(), Environment.UNITTEST);

    // Restore original
    setDefaultEnvironment(originalDefault);
  },
});

Deno.test({
  name: "utils - getEnvironment returns default when no request provided",
  fn: () => {
    const env = getEnvironment();
    assertExists(env, "Environment should exist");
    assertEquals(typeof env, "string", "Environment should be a string");
  },
});

Deno.test({
  name: "utils - getEnvironment extracts env from request query params",
  fn: () => {
    const request1 = new Request("http://localhost:54321?env=dev");
    assertEquals(getEnvironment(request1), Environment.DEVELOPMENT);

    const request2 = new Request("http://localhost:54321?env=unit-test");
    assertEquals(getEnvironment(request2), Environment.UNITTEST);

    const request3 = new Request("http://localhost:54321?env=prod");
    assertEquals(getEnvironment(request3), Environment.PRODUCTION);
  },
});

Deno.test({
  name: "utils - getEnvironment returns default when env param not in request",
  fn: () => {
    const request = new Request("http://localhost:54321?other=value");
    assertEquals(getEnvironment(request), Environment.PRODUCTION);
  },
});

Deno.test({
  name: "utils - getEnvironment rejects unknown env values, using the default",
  fn: () => {
    // An arbitrary string must not leak through the Environment cast; it
    // should be treated the same as no env param at all.
    const request = new Request("http://localhost:54321?env=bogus");
    assertEquals(getEnvironment(request), Environment.PRODUCTION);
  },
});

// Test getNumberFromQuery
Deno.test({
  name: "utils - getNumberFromQuery returns number for valid input",
  fn: () => {
    const params = new URLSearchParams("page=5&limit=10");
    assertEquals(getNumberFromQuery(params, "page"), 5);
    assertEquals(getNumberFromQuery(params, "limit"), 10);
  },
});

Deno.test({
  name: "utils - getNumberFromQuery returns undefined for missing key",
  fn: () => {
    const params = new URLSearchParams("page=5");
    assertEquals(getNumberFromQuery(params, "missing"), undefined);
  },
});

Deno.test({
  name: "utils - getNumberFromQuery returns undefined for non-numeric value",
  fn: () => {
    const params = new URLSearchParams("page=abc");
    assertEquals(getNumberFromQuery(params, "page"), undefined);
  },
});

Deno.test({
  name: "utils - getNumberFromQuery handles zero correctly",
  fn: () => {
    const params = new URLSearchParams("page=0");
    assertEquals(getNumberFromQuery(params, "page"), 0);
  },
});

Deno.test({
  name: "utils - getNumberFromQuery handles negative numbers",
  fn: () => {
    const params = new URLSearchParams("offset=-5");
    assertEquals(getNumberFromQuery(params, "offset"), -5);
  },
});

// Test getBooleanFromQueryAsOneOrZero
Deno.test({
  name: "utils - getBooleanFromQueryAsOneOrZero returns 1 for 'true'",
  fn: () => {
    const params = new URLSearchParams("active=true");
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "active"), 1);
  },
});

Deno.test({
  name: "utils - getBooleanFromQueryAsOneOrZero returns 0 for 'false'",
  fn: () => {
    const params = new URLSearchParams("active=false");
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "active"), 0);
  },
});

Deno.test({
  name: "utils - getBooleanFromQueryAsOneOrZero returns undefined for non-boolean",
  fn: () => {
    const params = new URLSearchParams("active=maybe");
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "active"), undefined);
  },
});

Deno.test({
  name: "utils - getBooleanFromQueryAsOneOrZero returns undefined for missing key",
  fn: () => {
    const params = new URLSearchParams("other=value");
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "active"), undefined);
  },
});

Deno.test({
  name: "utils - getBooleanFromQueryAsOneOrZero is case-sensitive",
  fn: () => {
    const params1 = new URLSearchParams("active=True");
    assertEquals(getBooleanFromQueryAsOneOrZero(params1, "active"), undefined);

    const params2 = new URLSearchParams("active=FALSE");
    assertEquals(getBooleanFromQueryAsOneOrZero(params2, "active"), undefined);
  },
});

Deno.test({
  name: "utils - parseBooleanQueryParam treats false/0/no/empty as false",
  fn: () => {
    for (const falsey of ["false", "FALSE", "0", "no", "", "  false  "]) {
      assertEquals(parseBooleanQueryParam(falsey), false, `for ${falsey}`);
    }
    for (const truthy of ["true", "1", "yes", "anything"]) {
      assertEquals(parseBooleanQueryParam(truthy), true, `for ${truthy}`);
    }
    assertEquals(parseBooleanQueryParam(undefined), undefined);
    assertEquals(parseBooleanQueryParam(null), undefined);
  },
});

// Test isAllowedCorsOrigin
Deno.test({
  name: "utils - isAllowedCorsOrigin allows bloomlibrary.org and subdomains over https",
  fn: () => {
    assertEquals(isAllowedCorsOrigin("https://bloomlibrary.org"), true);
    assertEquals(isAllowedCorsOrigin("https://embed.bloomlibrary.org"), true);
    assertEquals(isAllowedCorsOrigin("https://a.b.bloomlibrary.org"), true);
    assertEquals(isAllowedCorsOrigin("https://BloomLibrary.org"), true);
  },
});

Deno.test({
  name: "utils - isAllowedCorsOrigin rejects other origins",
  fn: () => {
    assertEquals(isAllowedCorsOrigin("https://example.com"), false);
    // suffix attack: ends with bloomlibrary.org but is a different domain
    assertEquals(isAllowedCorsOrigin("https://evilbloomlibrary.org"), false);
    // https only
    assertEquals(isAllowedCorsOrigin("http://bloomlibrary.org"), false);
    // malformed Origin header must not throw
    assertEquals(isAllowedCorsOrigin("not a url"), false);
    assertEquals(isAllowedCorsOrigin(""), false);
  },
});

// Integration test for query param parsing
Deno.test({
  name: "utils - integration test for query param parsing",
  fn: () => {
    const url = new URL(
      "http://localhost:54321?page=2&limit=20&active=true&deleted=false"
    );
    const params = url.searchParams;

    assertEquals(getNumberFromQuery(params, "page"), 2);
    assertEquals(getNumberFromQuery(params, "limit"), 20);
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "active"), 1);
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "deleted"), 0);
    assertEquals(getNumberFromQuery(params, "missing"), undefined);
    assertEquals(getBooleanFromQueryAsOneOrZero(params, "missing"), undefined);
  },
});
