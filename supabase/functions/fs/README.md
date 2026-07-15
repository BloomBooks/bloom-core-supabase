## Overview

The **fs** function provides "file system" style access to the file content stored in the Bloom Library S3 buckets, but hiding the fact in the URL that Amazon S3 storage is used.

## URL Format

```
/fs/{bucket}/{bookid}/{part1}/{part2?}/{part3?}
```

**Parameters:**
- `bucket`: One of "upload", "dev-upload", "harvest", "dev-harvest"
- `bookid`: The database ID of the book in Parse Server
- `part1`, `part2`, `part3`: Optional path components within the book's directory

## Examples

```bash
# Development harvest thumbnail
curl http://127.0.0.1:54321/functions/v1/fs/dev-harvest/U4KS7uOBBC/thumbnails/thumbnail-256.png

# Production book file
curl http://127.0.0.1:54321/functions/v1/fs/upload/XmdUIm6vEa/Hornbill+and+Cassowary.bloomd

# Audio file
curl http://127.0.0.1:54321/functions/v1/fs/dev-upload/fids0TH3Vy/audio/a96c71f9-c066-4e73-927f-9f8dcafee65c.mp3
```

## Environment Variables

Required in `.env.local` for local development:

```env
BLOOM_PARSE_APP_ID_PROD=your_production_parse_app_id
BLOOM_PARSE_APP_ID_DEV=your_development_parse_app_id
BLOOM_PARSE_APP_ID_UNIT_TEST=your_unittest_parse_app_id
```

## Authentication

The `fs` function is **publicly accessible** and does not require JWT authentication. This is configured in config.toml.

## Development

### Running Locally

```bash
# Start all Supabase services
yarn dev

# Or start with debugging enabled
yarn dev:debug

# Test the function
curl -I "http://127.0.0.1:54321/functions/v1/fs/dev-harvest/U4KS7uOBBC/thumbnails/thumbnail-256.png"
```

### Deployment

```bash
# Deploy all functions
yarn deploy

# Deploy only fs function
yarn deploy:fs

# Deploy to specific project
yarn deploy --project-ref your-project-id
```