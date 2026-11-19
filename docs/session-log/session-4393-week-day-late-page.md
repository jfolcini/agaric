# Session 4393 — a week day whose page arrives late mounts once it is on screen

Fixes #6990. `useEnteredViewport` read its element from a `useRef` inside an effect keyed on `[enabled, entered, rootMargin]`. A week day with no page renders no `day-section-lazy-placeholder`, so on first render the effect found no element and returned. When the page came later (restored from the Trash, or synced), the placeholder appeared but none of the effect's dependencies had changed, so the observer never attached and the day stayed blank.

The hook now holds its element in state behind a callback ref, and the effect depends on it. That is the hook's only change; its callers pass the ref to `ref={…}` as before. `e2e/link-chip-lifecycle.spec.ts` joins `REAL_BACKEND_SPECS`, which slice 12 of #6926 had kept it out of for this bug.

`useControlledViewportEntry` (`DaySection.tsx`, the stream view's path) has the same ref-in-effect shape. It is left as it is, since no failure has been seen there.

## What ran

- `src/hooks/__tests__/useEnteredViewport.test.tsx`: the case where the element mounts after the hook fails on the old hook (`Unable to find … entered`) and passes on the new one.
- `npx vitest run` over the hook test and `src/components/{journal,attachments,backlinks}` (748 pass), `npm run typecheck`.
- `e2e/link-chip-lifecycle.spec.ts` and `journal-week-empty-day-add-block.spec.ts` on the mock: 11 pass.
- On the bridge (`cargo build -p agaric-diagnostics --features bridge --bin bridge`, `--project=real-backend`): "a journal page restored from the trash shows on the journal again (#5247)" with `--repeat-each=3` and the old hook failed 2 of 3 at the day's text. With the fix, the whole spec passed with `--repeat-each=3` (27 pass).
