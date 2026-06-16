# Session 1060 — #1343 + #1344: resolve-cache 200-tag truncation + slash-menu mid-word trigger

2026-06-16. From the 2026-06 round-2 Opus audit. `/loop /batch-issues` run. Two small, independent
frontend fixes shipped together.

## #1343 (high) — tag resolve-cache truncated at 200
`runPreloadScan` (resolve store) fetched tags via `listTagsByPrefix({ prefix: '' })`; the backend
defaults a null limit to `MAX_TAGS_PREFIX = 200`, silently truncating the resolve cache so `#`/`[[ ]]`
chips beyond 200 tags rendered broken in large vaults. Swapped to the existing no-clamp
`listAllTagsInSpace(spaceId)` (same `TagCacheRow[]` shape, no adaptation). Test: 250-tag preload
asserts all are cached.

## #1344 (medium) — slash menu fired mid-word
`slash-command.ts` had `allowedPrefixes: null`, so `/` triggered anywhere (URLs, `6/15`, "and/or").
Set it to `[' ', ' ', '\n']` — byte-for-byte matching the `@`/emoji pickers (block start /
after whitespace). Test asserts the config equals the `@` picker's prefix set.

## Verification
Builder + independent reviewer (verdict FIXED-1: reviewer caught two stale `'list_tags_by_prefix'`
mocks in `App.test.tsx` that the swap broke, updated to `'list_all_tags_in_space'`). Full frontend
suite **12780 passed / 0 failed**; tsc clean.
