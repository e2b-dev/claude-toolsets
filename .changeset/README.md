# Changesets

Describe each change with `pnpm changeset` and commit the generated file with it. A release runs `pnpm run version` and
`pnpm run release` in CI (`.github/workflows/release.yml`); do not run `changeset version` locally, or the release
finds nothing to publish. The npm and PyPI packages share one version.
