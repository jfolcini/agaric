# Session 1391 — twelve open PRs, five distinct red causes

The same overnight `/batch-issues` run as session 1390, after a one-line
correction from the maintainer:

> you have 12 open PRs, merge them

I had twelve open and believed I had two. Every PR-board sweep this session ran
`gh pr list --author @me`, which is exactly the wrong filter for a board whose
majority author is Dependabot. The sweep was not lax; it was blind, and it
reported "board clear" each time with complete confidence.

That is the finding worth keeping. A filter that hides work reads identically to
an absence of work.

## Five red PRs, five unrelated causes

The instinct on a board of red dependency bumps is that one upstream change
broke them all. None of these shared a cause.

**#4331 — a bundle budget failure that was not upstream growth.** The npm group
pushed the `highlight` chunk 7391 bytes over budget. The obvious reading is that
highlight.js grew. It did not: the root bump to 11.12.0 fell outside `lowlight`'s
`~11.11.0` pin, so npm nested a *second* complete highlight.js core beside the
first. 7098 of the 7391 bytes were one library shipped twice. The real upstream
growth was 293 bytes. An `overrides` entry deduped it and the budget baseline
never had to move — where raising the baseline, the reflexive fix, would have
permanently enshrined a duplicated library as the expected size.

**#4329 — CI was green on code it never ran.** The tiptap group's 27-package bump
had a passing Playwright run, so the editor specs looked clear. That run started
fifty minutes *before* #4312 merged. It had never executed the freeze regression
test at all; the branch predated it. Rebuilding against the real merge target
ran the test for the first time, and it passed in 4.3s — the same answer, but
now actually measured. `ReactNodeView.update()` is byte-identical between 3.29.2
and 3.30.1 and prosemirror-view was not bumped, which is the evidence that
matters; the first green check was not evidence of anything.

**#4332 and #4333 — an exact peer pin, in both directions.** Dependabot split the
Stryker 9.6.1 → 10.0.0 major into two PRs because `core` and `vitest-runner` are
separate entries in `package.json`. They peer-depend on each other at an *exact*
version, so each PR alone fails `npm ci` with ERESOLVE before a single test runs.
Neither is fixable on its own branch. #4333 merged with its partner's bump folded
in; #4332 was closed as structurally unmergeable, which is a different verdict
from "failing" and worth stating as such.

**#4326 — a stale audit stamp over live claims.** Not a red check. The PR carried
a block reading *"Audited against the locked `mdns-sd` 0.20.3"* above pinned
factual claims about upstream internals, while bumping to 0.21.0. The honest fix
is not to edit the stamp — it is to re-run the audit. Against 0.21.0,
`DaemonEvent::Error` still has exactly one emission site
(`service_daemon.rs:2221`, reachable only via `register_service` →
`check_service_name_length`), and `shutdown()` still only sends `Command::Exit`.
Both claims held, so no code changed. The point is that they were *checked*, and
a stamp naming a version nobody verified against is worse than no stamp.

## The Stryker split, closed at the source

#4332 could not be merged, but it also should not have existed. Dependabot's
config had no group covering `@stryker-mutator/*`, so the next major will split
the same way and produce the same unmergeable pair. #4350 adds one, placed above
the `minor-and-patch` catch-all because first match wins, with
`update-types: [major, minor, patch]` — majors are the only level at which the
exact pin actually breaks.

Its review then found the fix had made the file's own header false: the header
claimed `codeql-action` was the *sole* group opting majors in. That header is
where someone checks the repo's majors policy before editing a group, so it now
names both, and states the shared reason rather than restating the rule twice.

The review also found the gap the fix does not close: groups default to
`applies-to: version-updates`, so a CVE against `@stryker-mutator/core` alone
still opens a solo PR into the same ERESOLVE. Filed as #4351 — the version path
is now protected and the security path is not, which is the wrong way round,
since the security path is the one that arrives under time pressure.

## Does StrykerJS 10 support the native TypeScript port?

Asked directly, and worth recording because the answer is not the one the release
notes suggest. **No.** `stryker.config.mjs` points `tsconfigFile` at a
deliberately non-existent path to make Stryker skip its tsconfig-rewrite step,
which crashes on `typescript@^7` — the native port exposes neither
`ts.parseConfigFileTextToJson` nor the rest of the compiler API.

v10 *does* carry TS7 work, but it lives in `typescript-checker`, a package this
repo does not install. The crash is in **core's** `ts-config-preprocessor`, which
at `core@10.0.0` still calls `ts.parseConfigFileTextToJson`
(`sandbox/ts-config-preprocessor.js:45-46`); `require('typescript')@7.0.2`
exposes only `version` and `versionMajorMinor`. So the workaround stays.

It is also stable rather than lucky: the guard is `if (tsconfigFile)` from
`project.files.get()`, and the dynamic `import('typescript')` sits *inside* that
branch. With the path missing, TypeScript is never loaded at all — the
workaround does not depend on the crashing call staying where it is.

## Verified, not inferred

Two answers this session were things I could have reasoned my way to and would
have gotten wrong.

The device-name work needed to know what `uname -n` returns on Android. Booting an
Android 14 emulator answered it: `localhost`, on every device. The recognisable
name lives in `Settings.Global.device_name`, which that API cannot reach. The
filter also has to catch `(none)`, which is what GKI's `CONFIG_DEFAULT_HOSTNAME`
leaves behind.

The history pagination fix (#4277) needed to know what the attachment disjunct
does to the query plan. Measured: `SEARCH ol USING INDEX idx_op_log_block_id`
degrades to `SCAN ol USING INDEX idx_op_log_created`. The common case *improves*
anyway — 0.64ms at 50k rows, because `LIMIT` short-circuits — while the
empty-page worst case goes from 0.025ms to 21.8ms. A candidate partial index to
recover it measured 13× *slower* on the common case, so it was not added. Both
numbers are in the code comment, including the one that argues against the change.
