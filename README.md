# Bloom Supabase Core

Supabase Core Functionality for Bloom

## ⚡ Quick Start

```bash
# Install dependencies
yarn

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Parse Server credentials

# Start local development (requires Docker)
yarn dev

# Run tests
yarn test
```

Test the fs function:
```bash
curl "http://127.0.0.1:54321/functions/v1/fs/harvest/VuebFgcL0R/Ososi.bloompub" -o test.bloompub
```

## 📋 Prerequisites

- [Volta](https://volta.sh/) (manages Node.js v22.20.0 and Yarn v1.22.22)
- [Docker Desktop](https://docs.docker.com/desktop/) (local development only)
- [Supabase account](https://supabase.com/)

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
yarn dev           # Start Supabase
yarn dev:debug     # Start with debugger
yarn test          # Run tests
yarn test:watch    # Run tests in watch mode
yarn deploy        # Deploy to production
```

## 🗃️ fs Function

Streams book files from S3 without exposing bucket details.

**URL**: `/functions/v1/fs/{bucket}/{bookid}/{path...}`

**Example**:
```bash
# Get thumbnail
curl "http://localhost:54321/functions/v1/fs/dev-harvest/U4KS7uOBBC/thumbnails/thumbnail-256.png"

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
