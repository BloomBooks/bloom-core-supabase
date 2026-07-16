# Bloom Supabase Core

Supabase Core Functionality for Bloom

## ⚡ Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Parse Server credentials

# Start local development (requires Docker)
pnpm dev

# Run tests
pnpm test
```

Test the fs function:
```bash
curl "http://127.0.0.1:54321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub" -o test.bloompub
```

## 📋 Prerequisites

- [pnpm](https://pnpm.io/) v11+ (pins its own version via `packageManager` and downloads
  Node.js v22.20.0 via `devEngines.runtime` in `package.json` — no Volta or manual Node install needed)
- [Deno](https://deno.com/) v2.9+ (runs and tests the edge functions)
- [Docker Desktop](https://docs.docker.com/desktop/) (local development only)
- [Supabase account](https://supabase.com/)

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
supabase/functions/
├── _shared/              # Shared utilities
│   ├── BloomParseServer.ts
│   └── utils.ts
├── fs/                   # S3 proxy function (streams book files)
│   ├── index.ts
│   ├── BookData.ts
│   └── README.md
└── tests/               # Deno tests
```

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
curl "http://localhost:54321/functions/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png"

# Download book (streams, no buffering)
curl "http://localhost:54321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub" -o book.bloompub

# Range request
curl -H "Range: bytes=0-1023" "http://localhost:54321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub"
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
