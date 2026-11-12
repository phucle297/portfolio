# Deploy and rollback

The site is a static Astro build served by the Cloudflare Worker `portfolio` (Workers static
assets, config in `wrangler.jsonc`). `.github/workflows/deploy.yml` does every deploy; the
Cloudflare credentials live only in the repository's Actions secrets (`CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`).

| Event                                          | What happens                                                           | URL                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Push to `main`                                 | `build` → `production`: `wrangler deploy` (100 % of traffic)           | https://portfolio.dppermees.workers.dev        |
| Pull request (opened / synchronize / reopened) | `build` → `preview`: `wrangler versions upload --preview-alias pr-<N>` | https://pr-<N>-portfolio.dppermees.workers.dev |

## Previews

- Each PR gets one alias, `pr-<N>`. Every push to the PR uploads a new **version** of the same
  `portfolio` Worker and moves the alias to it; production traffic is not touched.
- The workflow posts one sticky comment on the PR (marker `<!-- portfolio-preview -->`) with
  the alias URL, this version's own URL and the run link, and edits it in place on later pushes.
- Fork PRs and runs without the Cloudflare secrets skip the preview with a notice. Any other
  wrangler failure fails the job.
- Preview versions are tagged `pr-<N>` and their message is `PR #<N> <sha>`. They sit in the
  same version list as production versions (see below).

## Rollback

Rollback is the Owner's call. The quick path, which needs a token with Workers Scripts Edit:

1. List **deployments** (not versions) and pick the last good production one. Production
   deployments have the message `main <sha>`:

   ```sh
   bun x wrangler@4.160.1 deployments list
   ```

2. Roll back to that deployment's **version id**:

   ```sh
   bun x wrangler@4.160.1 rollback <version-id> --message "rollback to main <sha>: <reason>"
   ```

   Or in the dashboard: Workers & Pages → `portfolio` → Deployments → ⋯ → Rollback.

Rules:

- **Always pass an explicit version id taken from a production deployment.** Never pick one with
  a `pr-<N>` preview tag or a `PR #<N> <sha>` message, and do not run `wrangler rollback` without
  an id: PR preview versions share the version list, so "the previous version" can be a PR build
  (for example one with the PR-only `/ui-preview/` page) that was never reviewed for production.
- `bun x wrangler@4.160.1 deployments list` shows only the **10 most recent deployments**.
  wrangler 4.160.1's `--help` lists no pagination flag (only `--name` and `--json`). The same
  10-row cap applies to `bun x wrangler@4.160.1 versions list` (also only `--name` and `--json`).
  Rollback can still reach the **100 most recent versions**.
- To find an older production version id that has dropped off those 10 rows, use the dashboard
  (Workers & Pages → `portfolio` → Deployments history) and take a version whose message is
  `main <sha>`. Among the 10 rows the CLI does print, you can also run
  `bun x wrangler@4.160.1 versions list --json` and keep entries whose message is `main <sha>`
  (and whose tag is not `pr-<N>`). **Never roll back to a `pr-<N>` preview version.**
- Every PR push adds a version, so older production versions fall out of the 100-version window
  quickly.
- A rollback is a stopgap: the next push to `main` deploys again. **The durable fix is to revert
  the bad commit on `main`** (a revert PR); its push redeploys production from a clean build.

## CI path filters

`ci.yml` (PR #4) skips docs-only changes (`paths-ignore`: `**/*.md`, `docs/**`, `LICENSE`).
`deploy.yml` has no path filter, so a change to it (or any PR, docs included) runs the Deploy
workflow, including the preview job.
