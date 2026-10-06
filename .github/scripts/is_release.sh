#!/usr/bin/env bash
# Prints "true" when .changeset/ holds pending changesets, which is what gates a release.
set -euo pipefail
count=$(find .changeset -maxdepth 1 -name '*.md' ! -name 'README.md' | wc -l | tr -d ' ')
[ "$count" -gt 0 ] && echo "true" || echo "false"
