# Browser runtime readability

- Use names that explain the value or purpose, including callback parameters.
  Prefer `candidate`, `nameWords`, `roleSynonyms`, and `matchedTokenCount` over
  `c`, `nameW`, `syn`, and `hit`. Do not merely pad short names to satisfy lint.
- Single-letter names are allowed only for `x` and `y` coordinates.
- Separate functions with a blank line, including functions assigned to variables.
- Use explicit branches instead of nested ternaries.
- Preserve matching weights and browser behavior during readability cleanups.
- Edit TypeScript source, then regenerate embedded assets with `pnpm build:runtime`.
- Run `pnpm lint:runtime` and `pnpm test:runtime` after runtime changes.
