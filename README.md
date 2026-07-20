# Bloom Supabase Core

Supabase Core Functionality for Bloom

## ⚡ Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Parse Server credentials

# Start local development (requires a container runtime — see Prerequisites)
pnpm dev

# Run tests
pnpm test
```

Test the fs function:
```bash
curl "http://127.0.0.1:44321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub" -o test.bloompub
```

## 📋 Prerequisites

- [pnpm](https://pnpm.io/) v11+ (pins its own version via `packageManager` and downloads
  Node.js v22.20.0 via `devEngines.runtime` in `package.json` — no Volta or manual Node install needed)
- [Deno](https://deno.com/) v2.9+ (runs and tests the edge functions)
- A container runtime (local development only): [Podman](https://podman.io/) (see
  [Windows + Podman setup](#-windows--podman-setup) below) or
  [Docker Desktop](https://docs.docker.com/desktop/)
- [Supabase account](https://supabase.com/)

## 🪟 Windows + Podman setup

Podman is the supported non-Docker-Desktop way to run the local stack (verified 2026-07):

```powershell
winget install RedHat.Podman
podman machine init
podman machine set --rootful   # required: rootless port forwarding doesn't reach the Windows host
podman machine start
```

Then start the stack. If Docker Desktop is also installed, point the CLI at Podman's pipe
explicitly, and exclude the analytics services (on Windows they require a TCP-exposed
Docker daemon, which Podman doesn't provide):

```powershell
$env:DOCKER_HOST = "npipe:////./pipe/podman-machine-default"
pnpm exec supabase start -x logflare,vector
```

Gotchas we hit so you don't have to:

- **Local ports are 443xx, not Supabase's default 543xx** (API `44321`, DB `44322`,
  Studio `44323`, Mailpit `44324`). Windows reserves semi-random "excluded port ranges"
  for Hyper-V/WSL inside the dynamic range (49152+), and Supabase's defaults landed inside
  one — every service unreachable from the host, with no error anywhere. Ports below 49152
  can't be dynamically excluded. Check yours with
  `netsh interface ipv4 show excludedportrange protocol=tcp`.
- Podman (unlike Docker) doesn't auto-create missing bind-mount sources; the repo now
  commits `supabase/snippets/` and `supabase/seed.sql` so `supabase start` has everything
  it needs.
- `supabase stop`'s volume prune trips over a Podman/Docker API difference
  ("all" is an invalid volume filter) — harmless; use `supabase db reset` to get a truly
  fresh database.

### Dependency policy

Both package resolvers enforce a **7-day cooldown**: a version published less than 7 days
ago will not be installed (mitigates compromised-package supply-chain attacks).

- npm side (dev tooling): `minimumReleaseAge` in [`pnpm-workspace.yaml`](pnpm-workspace.yaml)
- Deno side (edge function imports): `minimumDependencyAge` in [`deno.json`](deno.json)

Dependencies are pinned to exact versions (`savePrefix: ""` for pnpm; exact versions in the
`deno.json` import map), and CI installs with frozen lockfiles. To update deps, run
`pnpm update` / `deno outdated --update` — both respect the cooldown — and commit the
lockfile changes.

## 📁 Project Structure

```
supabase/
├── migrations/           # SQL migrations (the database schema: books, languages, tags, ...)
├── seed.sql              # Local-dev seed (real data comes from packages/sync-tool)
└── functions/
    ├── _shared/          # Shared utilities
    │   ├── BloomParseServer.ts
    │   └── utils.ts
    ├── fs/               # S3 proxy function (streams book files)
    │   ├── index.ts
    │   ├── BookData.ts
    │   └── README.md
    └── tests/            # Deno tests
packages/
└── sync-tool/            # Parse -> Supabase data import (v0: sample importer)
docs/
└── db/                   # Database migration docs (field mapping, plan review, roadmap)
```

## 📚 Importing sample data (local dev)

With the local stack running, pull ~100 real books (plus their languages, tags, uploaders,
and relatedBooks) from the production Parse server into your local database:

```bash
pnpm --filter @bloom/sync-tool import-sample
```

Idempotent — re-run any time to refresh. It refuses to write to a non-localhost Supabase
unless you set `SYNC_ALLOW_REMOTE=1` (env vars are `SYNC_*`-prefixed on purpose; see
`packages/sync-tool/src/import-sample.mjs`).

## 🔧 Scripts

```bash
pnpm dev           # Start Supabase
pnpm dev:debug     # Start with debugger
pnpm test          # Run tests
pnpm test:watch    # Run tests in watch mode
pnpm run deploy    # Deploy to production ("run" needed: deploy is a pnpm built-in)
```

## 🗃️ fs Function

Streams book files from S3 without exposing bucket details.

**URL**: `/functions/v1/fs/{bucket}/{bookid}/{path...}`

**Example**:
```bash
# Get thumbnail
curl "http://localhost:44321/functions/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png"

# Download book (streams, no buffering)
curl "http://localhost:44321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub" -o book.bloompub

# Range request
curl -H "Range: bytes=0-1023" "http://localhost:44321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"
```

See [`supabase/functions/fs/README.md`](supabase/functions/fs/README.md) for details.

## 🌐 Deployment

This project uses a **staging → production** deployment workflow:

### Branching Strategy
- **`develop`** → Staging environment (auto-deploy on push)
- **`main`** → Production environment (auto-deploy on push)
- **`feature/*`** → Feature branches (PRs to `develop`)

### Deployment Flow
1. **Develop** on feature branch
2. **PR to `develop`** → Runs tests
3. **Merge to `develop`** → Deploys to **staging**
4. **Test in staging**
5. **PR from `develop` to `main`** → Runs tests
6. **Merge to `main`** → Deploys to **production**

### Manual Deploy
Actions tab → Choose workflow → Run workflow

See [`.github/workflows/README.md`](.github/workflows/README.md) for complete documentation.
