# Session 1001 — eqeqeq + tsgo adoption

Follow-up to session 1000 (#1873). Closes the two deferred items in one PR:
enable oxlint `eqeqeq` (#1874) and migrate the TypeScript typechecker from
`tsc` to **tsgo** (`@typescript/native-preview`, the Go port — "tsc 7").

## eqeqeq (#1874)

Enabled `eslint/eqeqeq` as `["error", "always", { "null": "ignore" }]`.

Measured against the tree: with `null: "ignore"` there are **0** violations;
with `null: "always"` there are **468** — i.e. every `==`/`!=` in the codebase
is a deliberate `== null` / `!= null` nullish check. The `null: "ignore"`
option therefore enables the rule with **zero code churn** and guards against
future non-null `==`/`!=` creeping in. No source edits were needed (adds no
`oxlint-disable` directives, consistent with #1502).

## tsgo ("tsc 7")

Swapped `tsc -b` → `tsgo -b` everywhere it runs the typecheck:

- `prek.toml` `tsc` hook entry → `npx tsgo -b --noEmit`
- `package.json` `build` / `build:e2e` scripts → `tsgo -b && vite build`
- `src-tauri/tauri.conf.json` `beforeDevCommand` → `npx tsgo -b --noEmit`
- `.github/workflows/_validate.yml` build-step name (cosmetic)

Added `@typescript/native-preview` as a devDependency. Its binary ships
prebuilt via platform `optionalDependencies` (linux/darwin/win × x64/arm), so
it resolves under `.npmrc` `ignore-scripts=true` exactly like esbuild — no
install script runs. All 8 platform packages are pinned in `package-lock.json`.

Verified: tsgo agrees with tsc (both exit 0 under the strict flags) and is
**~8× faster** cold — ≈2.5s vs ≈19.5s. Full `npm run build` (`tsgo -b &&
vite build`) passes end-to-end; `oxlint` clean.

Both tsconfigs are `noEmit: true`, so `tsc -b`/`tsgo -b` are pure typecheck
gates here (vite does the bundling) — the swap changes no emitted output.
