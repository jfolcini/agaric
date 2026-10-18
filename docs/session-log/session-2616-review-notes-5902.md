# Session 2616 — review note from #5902

`scripts/e2e-related.sh`'s `src-tauri/tauri.conf.json` case was identical
to the `package.json|…` case above it; it joins that pattern, with its
reason as a comment. The node test's `tauri.conf.json` row still pins it.

Ran: `node --test scripts/e2e-related.test.mjs` (10), shellcheck.
