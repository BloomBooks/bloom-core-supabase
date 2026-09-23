# Agent instructions

Guidance for coding agents working in this repo. `CLAUDE.md` imports this file.

# Repo basics

- Trunk is **`develop`**: branch from it and open PRs against it. Merging to `develop` deploys the
  edge functions to staging; `main` is production (see `README.md`).
- Use **pnpm** (the version pinned in `package.json`), never npm or yarn. Edge functions run on Deno.
- CI type-checks every `.ts` under `supabase/functions` (`deno check --frozen`) and runs
  `pnpm test:ci`, which only picks up `supabase/functions/tests/*-test.ts`. A test anywhere else
  never runs in CI.
- Dependencies are pinned to exact versions, with a 7-day cooldown on both resolvers; see
  "Dependency policy" in `README.md`.
- The Cloud Team Collections backend (the `tc` schema, its edge functions and its local dev stack)
  is described in `team-collections/README.md`.

# Issue tracker

This project tracks work in **YouTrack**, at https://issues.bloomlibrary.org/youtrack. Ticket ids
look like **`BL-16531`** (`BL-` plus a number). The skill that talks to it is **`youtrack-api`**:
use it for any tracker operation (read an issue, find the id for the current work, list or post
comments, set an issue's State).

To find the ticket id for the branch you are on, look for a `BL-XXXXX` token in the branch name.
Not every branch has a card, so finding no id is a normal outcome.
