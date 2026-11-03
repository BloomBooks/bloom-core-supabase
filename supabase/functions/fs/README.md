## Overview

The **fs** function provides "file system" style access to the file content stored in the Bloom Library S3 buckets, but hiding the fact in the URL that Amazon S3 storage is used.

## How it works: the function redirects, the worker carries the bytes

The function looks the book up in Parse and answers with a **302 to the file's S3 URL**; it
does not fetch the file. The Cloudflare routing worker ([`cloudflare/worker.js`](../../../cloudflare/worker.js))
follows that redirect **server-side**, fetches the file from S3 and streams it to the client, so
clients only ever see `api.bloomlibrary.org` and get the file body, not a redirect.

Why: Edge Function response bytes count as (uncached) Supabase egress. When this function
proxied the files itself, every thumbnail, `.bloompub`, PDF and audio file counted, and we
exceeded the Supabase egress quota. Cloudflare has no egress fees.

So the response shaping clients rely on lives in the worker, not here: forwarding only the
whitelisted request headers (`range`, `if-none-match`, `if-modified-since`, `if-match`,
`if-unmodified-since`, `accept-encoding`) to S3, GET vs HEAD, passing 304 through, mapping other
S3 failures to 404, stripping `x-amz-*` headers, and the one-year `Cache-Control` on
harvest/dev-harvest thumbnails. The function still owns validation (400 / 404 / 405 / 500), CORS
preflights, and the CORS headers; the worker copies the latter from the 302 onto the file
response. The worker only follows redirects into our four S3 buckets on `s3.amazonaws.com`;
anything else becomes a 502, so it can't be used as an open proxy.

**Only the worker may call it.** Because the 302 reveals the S3 address (older books' S3 paths
contain the uploader's email), the function answers **401** unless the request carries an
`x-bloom-worker-secret` header matching its `BLOOM_WORKER_SECRET` secret, which the worker
adds. OPTIONS preflights don't need it. Nothing in production calls the Supabase URL directly:
OPDS and BloomLibrary2 use `https://api.bloomlibrary.org/v1/fs/...`.

**The function, the worker and the secret must be deployed together** — see
[`cloudflare/README.md`](../../../cloudflare/README.md#fs-the-worker-carries-the-file-bodies).

## URL Format

```
/fs/{bucket}/{bookid}/{part1}/{part2?}/{part3?}
```

**Parameters:**
- `bucket`: One of "upload", "dev-upload", "harvest", "dev-harvest"
- `bookid`: The database ID of the book in Parse Server
- `part1`, `part2`, `part3`: Optional path components within the book's directory

## Examples

Against the local function each of these returns a `302` with the S3 URL in `Location`
(add `-L` to follow it, or `-I` to see just the headers). They send the worker secret, so set
`BLOOM_WORKER_SECRET` in your shell to the value in `.env.local`; without it you get a 401.

```bash
# Development harvest thumbnail
curl -I -H "x-bloom-worker-secret: $BLOOM_WORKER_SECRET" http://127.0.0.1:54321/functions/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png

# Production book file
curl -H "x-bloom-worker-secret: $BLOOM_WORKER_SECRET" http://127.0.0.1:54321/functions/v1/fs/upload/XmdUIm6vEa/Hornbill+and+Cassowary.bloomd

# Audio file
curl -H "x-bloom-worker-secret: $BLOOM_WORKER_SECRET" http://127.0.0.1:54321/functions/v1/fs/dev-upload/fids0TH3Vy/audio/a96c71f9-c066-4e73-927f-9f8dcafee65c.mp3
```

## Environment Variables

Required in `.env.local` for local development:

```env
BLOOM_PARSE_APP_ID_PROD=your_production_parse_app_id
BLOOM_PARSE_APP_ID_DEV=your_development_parse_app_id
BLOOM_PARSE_APP_ID_UNIT_TEST=your_unittest_parse_app_id
BLOOM_WORKER_SECRET=any_random_string
```

## Authentication

The `fs` function needs no JWT (`verify_jwt = false` in config.toml); instead it requires the
worker secret described above. The public reaches it only through the routing worker on
`api.bloomlibrary.org`.

## Development

### Running Locally

```bash
# Start all Supabase services
pnpm dev

# Or start with debugging enabled
pnpm dev:debug

# Test the function: expect "HTTP/1.1 302" and a Location on s3.amazonaws.com
curl -I -H "x-bloom-worker-secret: $BLOOM_WORKER_SECRET" "http://127.0.0.1:54321/functions/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png"
```

Without Docker you can serve just this function with Deno (port 8000, same handler, no gateway):

```bash
deno run --allow-all --env-file=.env.local supabase/functions/fs/index.ts
curl -I -H "x-bloom-worker-secret: $BLOOM_WORKER_SECRET" "http://localhost:8000/functions/v1/fs/dev-harvest/ZWI7FUQnDd/thumbnails/thumbnail-256.png"
```

To see what clients get (the file body), run the worker locally — see
[`cloudflare/README.md`](../../../cloudflare/README.md#testing-the-worker-locally).

### Deployment

```bash
# Deploy all functions ("run" needed: deploy is a pnpm built-in command)
pnpm run deploy

# Deploy only fs function
pnpm deploy:fs

# Deploy to specific project
pnpm run deploy --project-ref your-project-id
```