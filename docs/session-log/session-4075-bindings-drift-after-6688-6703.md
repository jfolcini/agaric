# Session 4075 — `main`'s TypeScript bindings drifted after #6688 and #6703

`ts_bindings_up_to_date` failed on every pull request that merged `main` after 2026-11-13 18:55Z. #6688 made the sync event types part of the generated bindings; #6703, written before it, edited two doc comments on `SyncEvent::InternetFacingBind`. Each was green alone; together the committed `src/lib/bindings.ts` carried the old comments.

## Shipped

`src/lib/bindings.ts` regenerated with `cargo test --lib -- specta_tests --ignored` on `main`. Doc comments only; no type changes.

## What ran

- The regeneration above, then `git diff --stat`: one file, comments only.
- `npm run typecheck`.

Not run: the suites. CI is the check.
