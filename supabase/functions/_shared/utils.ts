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

// Hostnames we are willing to present as our own public URL (see getPublicUrl).
function isAllowedPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "bloomlibrary.org" || host.endsWith(".bloomlibrary.org");
}

// When a request comes through the Cloudflare worker that fronts api.bloomlibrary.org,
// the URL the function sees is the Supabase one
// (https://<project>.supabase.co/functions/v1/<fn>...). The worker sets X-Forwarded-Host
// to the original hostname; use it to reconstruct the public URL so that any URLs we
// generate (og:url, OPDS links) don't leak the Supabase project URL.
// Only bloomlibrary.org hostnames are honored: a caller who bypasses the worker and sets
// X-Forwarded-Host itself must not be able to spoof an arbitrary domain into those URLs.
export function getPublicUrl(request: Request): URL {
  // Preferred: the routing worker forwards the original public request URL in
  // this custom header. We use a non-standard name (not X-Forwarded-*) because
  // Supabase's edge strips proxy-managed forwarding headers before the function
  // sees them (verified on staging; see FUNCTIONS-MIGRATION-PLAN.md). Only
  // bloomlibrary.org hosts are honored, so a caller that sets the header itself
  // cannot spoof an arbitrary domain into the URLs we generate.
  const publicUrl = request.headers.get("x-bloom-public-url");
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      if (isAllowedPublicHost(parsed.hostname)) {
        return parsed;
      }
    } catch {
      // malformed header; fall through to the fallbacks below
    }
  }

  // Fallback (legacy): X-Forwarded-Host. Retained for now, but in practice it
  // does not survive Supabase's edge, so real traffic falls through to req.url.
  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost && isAllowedPublicHost(forwardedHost)) {
    url.hostname = forwardedHost;
    url.protocol = "https:";
    url.port = "";
    // /functions/v1/<fn> (Supabase) is /v1/<fn> on the public hostname
    if (url.pathname.startsWith("/functions/v1/")) {
      url.pathname = url.pathname.substring("/functions".length);
    }
  }
  return url;
}

export function checkForRequiredEnvVars(envVars: string[]): void {
  const missing = envVars.filter((envVar) => !Deno.env.get(envVar));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}