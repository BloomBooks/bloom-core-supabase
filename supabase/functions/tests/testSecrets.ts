// Helper for tests that need real credentials (the live tests ported from Azure).
//
// Default behavior (`yarn test`): a test whose secrets are absent FAILS with a
// message naming the missing ones, so misconfiguration is loud.
//
// With `--secrets-optional` (passed after `--` by `yarn test:secrets-optional`
// and `yarn test:ci`): such tests are skipped instead, so the suite can run
// with whatever credentials the environment happens to have.

const secretsOptional = Deno.args.includes("--secrets-optional");

export function testRequiringSecrets(options: {
  name: string;
  secrets: string[];
  fn: () => Promise<void> | void;
  sanitizeOps?: boolean;
  sanitizeResources?: boolean;
}) {
  const missing = options.secrets.filter((name) => !Deno.env.get(name));

  if (missing.length === 0) {
    Deno.test({
      name: options.name,
      fn: options.fn,
      sanitizeOps: options.sanitizeOps,
      sanitizeResources: options.sanitizeResources,
    });
  } else if (secretsOptional) {
    // Say why in the log, so CI shows exactly what was not exercised.
    console.warn(
      `SKIPPING "${options.name}" - missing secrets: ${missing.join(", ")}`
    );
    Deno.test({ name: options.name, ignore: true, fn: () => {} });
  } else {
    Deno.test(options.name, () => {
      throw new Error(
        `Missing secrets required by this test: ${missing.join(", ")}.\n` +
          `Add them to .env.local (see .env.example for the full list), ` +
          `or run "yarn test:secrets-optional" to skip tests that need secrets.`
      );
    });
  }
}
