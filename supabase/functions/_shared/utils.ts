export enum Environment {
  UNITTEST = "unit-test",
  DEVELOPMENT = "dev", 
  PRODUCTION = "prod",
}

export let DefaultEnvironment: Environment = Environment.PRODUCTION;

export function setDefaultEnvironment(env: Environment) {
  DefaultEnvironment = env;
}

export function getEnvironment(request?: Request): Environment {
  if (!request) {
    return DefaultEnvironment;
  }
  
  const url = new URL(request.url);
  const env = url.searchParams.get("env");
  // Only accept known environment values; anything else (or nothing) means
  // the default. Without this check an arbitrary string would flow through
  // and be treated as production by downstream switch statements.
  if (env && (Object.values(Environment) as string[]).includes(env)) {
    return env as Environment;
  }
  return DefaultEnvironment;
}

export function getNumberFromQuery(
  searchParams: URLSearchParams,
  key: string
): number | undefined {
  const value = searchParams.get(key);
  if (!value) return undefined;
  const num = parseInt(value);
  return isNaN(num) ? undefined : num;
}

export function getBooleanFromQueryAsOneOrZero(
  searchParams: URLSearchParams,
  key: string
): number | undefined {
  const value = searchParams.get(key);
  if (value === "true") {
    return 1;
  } else if (value === "false") {
    return 0;
  } else {
    return undefined;
  }
}

// Browsers on https://bloomlibrary.org or any https subdomain of it may call
// our APIs. (The Azure Functions host CORS config enumerated the subdomains
// individually; since they are all ours and new ones appear over time, we
// allow the whole domain instead of maintaining a list.)
export function isAllowedCorsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "bloomlibrary.org" ||
      hostname.endsWith(".bloomlibrary.org")
    );
  } catch {
    return false; // malformed Origin header
  }
}

// For functions that browsers call cross-origin (from bloomlibrary.org) with a
// JSON body or custom headers, which triggers a CORS preflight. The function must
// answer OPTIONS itself and include these headers on every response.
// Allowed origins are echoed back (the CORS spec has no way to send a pattern).
export function getCorsHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, authentication-token",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    // the CORS response headers vary by requesting origin, so caches must key on it
    Vary: "Origin",
  };
  const origin = request.headers.get("origin");
  if (origin && isAllowedCorsOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function checkForRequiredEnvVars(envVars: string[]): void {
  const missing = envVars.filter((envVar) => !Deno.env.get(envVar));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}