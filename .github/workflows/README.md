# GitHub Actions Deployment Workflows

This repository follows Supabase's recommended workflow for managing multiple environments (staging and production) using GitHub Actions.

## Workflow Structure

### 1. CI Workflow (`ci.yml`)
- **Triggers**: On all pull requests and manual workflow dispatch
- **Purpose**: Run tests to validate changes before merging
- **Jobs**:
  - `test`: Runs the full test suite

### 2. Staging Workflow (`staging.yml`)
- **Triggers**: On push to `develop` branch and manual workflow dispatch
- **Purpose**: Automatically deploy to staging environment for testing
- **Jobs**:
  - `test`: Runs tests before deployment
  - `deploy-staging`: Deploys Edge Functions to staging Supabase project
- **Environment**: Uses GitHub environment `staging` with URL tracking

### 3. Production Workflow (`production.yml`)
- **Triggers**: On push to `main` branch and manual workflow dispatch
- **Purpose**: Deploy to production after changes are validated in staging
- **Jobs**:
  - `test`: Runs tests before deployment
  - `deploy-production`: Deploys Edge Functions to production Supabase project
- **Environment**: Uses GitHub environment `production` with URL tracking

## Branching Strategy

```
feature/new-feature
    ↓ (PR)
develop (staging environment)
    ↓ (PR)
main (production environment)
```

### Recommended Workflow:

1. **Create a feature branch** from `develop`:
   ```bash
   git checkout develop
   git pull
   git checkout -b feature/your-feature-name
   ```

2. **Make changes and test locally**:
   ```bash
   yarn test
   ```

3. **Open a PR to `develop`**:
   - CI workflow runs tests
   - Review and merge when tests pass

4. **Automatic deployment to staging**:
   - Merging to `develop` triggers the staging workflow
   - Edge Functions are deployed to staging Supabase project
   - Test in staging environment

5. **Promote to production**:
   - Open a PR from `develop` to `main`
   - CI workflow runs tests again
   - Review and merge when ready

6. **Automatic deployment to production**:
   - Merging to `main` triggers the production workflow
   - Edge Functions are deployed to production Supabase project

## Required GitHub Secrets

You need to configure the following secrets in your GitHub repository settings:

### Access Token
- `BLOOM_SUPABASE_ACCESS_TOKEN`: Your Supabase personal access token
  - Generate at: https://supabase.com/dashboard/account/tokens

### Project IDs
- `BLOOM_SUPABASE_STAGING_PROJECT_ID`: Staging project reference ID
- `BLOOM_SUPABASE_PRODUCTION_PROJECT_ID`: Production project reference ID
  - Find in project URL: `https://supabase.com/dashboard/project/<project-id>`

### Test Secrets (existing)
- `BLOOM_PARSE_APP_ID_PROD`
- `BLOOM_PARSE_APP_ID_DEV`
- `BLOOM_PARSE_APP_ID_UNIT_TEST`

## Setting Up GitHub Environments (Optional but Recommended)

GitHub Environments provide additional protection and visibility:

1. Go to **Settings** → **Environments** in your GitHub repository
2. Create two environments: `staging` and `production`
3. For **production**, add protection rules:
   - ✅ Required reviewers (add team members who must approve)
   - ✅ Wait timer (optional delay before deployment)
   - ⚠️ Deployment branches: Only `main` branch

This adds manual approval gates for production deployments while keeping staging automatic.

## Local Development

The workflows don't affect local development. Continue using:

```bash
# Start local Supabase
supabase start

# Run tests locally
yarn test

# Deploy functions locally
yarn dev:functions
```

## Deployment Commands

All deployments happen automatically through GitHub Actions, but you can also deploy manually:

```bash
# Deploy to staging
supabase functions deploy --project-ref <BLOOM_SUPABASE_STAGING_PROJECT_ID>

# Deploy to production
supabase functions deploy --project-ref <BLOOM_SUPABASE_PRODUCTION_PROJECT_ID>
```

Make sure you have `BLOOM_SUPABASE_ACCESS_TOKEN` set in your environment.

## Benefits of This Setup

✅ **Separation of Environments**: Staging and production are completely isolated
✅ **Automatic Testing**: Every deployment is preceded by tests
✅ **Safe Releases**: Test in staging before promoting to production
✅ **Audit Trail**: GitHub Actions logs show all deployments
✅ **Rollback Capability**: Easy to revert by reverting the git commit
✅ **Manual Overrides**: Can manually trigger workflows when needed
✅ **Protection Gates**: Optional approval requirements for production

## Troubleshooting

### Workflow fails with "Context access might be invalid"
- This is a lint warning because secrets aren't defined yet
- Add the required secrets in GitHub repository settings
- The workflows will work once secrets are configured

### Staging/Production environments don't exist
- The warnings are expected until you create the environments in GitHub
- They're optional but recommended for production protection
- Workflows will work without environments, but won't have URL tracking

### Want to test without deploying
- Workflows only deploy on push to `develop` or `main`
- PRs only run tests, not deployments
- Use `workflow_dispatch` to manually trigger specific workflows
