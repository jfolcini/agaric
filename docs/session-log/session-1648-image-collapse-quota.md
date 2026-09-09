# Session 1648 — one folded screenshot stopped every preference from saving

`image_collapsed` stored each folded image's `src` verbatim. `isValidImageSrc`
accepts `data:`, so a pasted screenshot is a multi-megabyte src, and folding
one wrote it into a ~5 MB origin quota.

## Why it was worth fixing above everything else in the backlog

The blast radius is not the feature. `writePreference` swallows the resulting
`QuotaExceededError` with a `logger.warn`, so from the moment the quota fills,
*every* preference in the app silently stops persisting — theme, density, week
start, sort, starred pages, saved views, recent searches. Nothing tells the
user and nothing tells us. The fold that caused it also does not survive the
reload, which is the only symptom the user can see.

## The fix

`imageCollapseKey(src)` — a `d:`-prefixed 53-bit cyrb53 digest — is what the
list stores now. Digesting unconditionally rather than only long srcs: one
format is one code path, and no src is short enough to be worth a branch. The
digest is synchronous because the key is derived during render, and the
platform's only hash (`crypto.subtle.digest`) is async.

Truncation was the alternative and does not work: two screenshots share the
long `data:image/png;base64,` prefix and differ deep inside the payload.

## The stored format changed, so v1 entries are dropped

`version: 2` with a `migrate` that keeps only `d:`-prefixed entries. Keeping
the v1 srcs would carry the megabytes the change exists to stop storing; the
cost of dropping one is that an image renders expanded once.

The prefix is load-bearing: `migrate` runs on *every* read, not only the first
one after the bump, so it has to tell the formats apart. It cannot do that by
shape — a relative src like `logo` is indistinguishable from bare base36.

## Verification

Three mutations against a copy of `preferences.ts`, each red on the tests that
name its claim, `cmp`-restored after every one:

- key returns the `src` verbatim (the bug itself) — 7 red, including the two
  pre-existing persistence tests;
- `migrate` keeps everything — the v1-drop test alone;
- `migrate` discards everything — 5 red, led by "reads back a value it just
  wrote", which is the trap the prefix exists for.

Closes #4864.
