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
  const env = url.searchParams.get("env") as Environment;
  return env || DefaultEnvironment;
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

export function checkForRequiredEnvVars(envVars: string[]): void {
  const missing = envVars.filter((envVar) => !Deno.env.get(envVar));
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}