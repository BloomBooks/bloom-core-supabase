Papercuts for bloom-core-supabase — small dev/agent/tooling friction points, captured now and
fixed later. See the "papercut" skill for the procedure.

Note: when resolving a git merge conflict here, keep both sides' entries unless they merge cleanly.

---

## 2026-07-18 — `pnpm test` hard-fails when `.env.local` doesn't exist

- **Cut:** `pnpm test` and `pnpm test:secrets-optional` both pass `--env-file=.env.local` to
  deno, and deno hard-fails ("node: .env.local: not found", exit 126) when the file is
  missing — the repo ships only `.env.example`. On a fresh checkout the only test script that
  runs at all is `pnpm test:ci`.
- **Idea:** Make `.env.local` optional (deno supports `--env-file` gracefully via a wrapper
  that checks existence, or document `cp .env.example .env.local` as a required setup step in
  the README / setup hook).
- **Context:** Hit running unit tests on branch parse-to-supabase-db-foundation; agent had to
  discover `test:ci` as the fallback by trial and error.
