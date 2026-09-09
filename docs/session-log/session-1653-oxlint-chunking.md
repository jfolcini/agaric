# Session 1653 — a type checker cut into sixteen pieces

`prek run --all-files oxlint` and `npm run lint` disagreed about the same tree,
in both directions, per site.

## The issue's framing was wrong, and the real cause is worse

#4894 called it walk-vs-named. It is not: a walk and a single named run over
the same 1927 files produce byte-identical output — 65 diagnostics each, and
both report analysing the same 1924 files.

The variable is the SIZE of the input set, because prek chunks it. Instrumented
by pointing the hook's `entry` at an arg-logger, `--all-files` was **sixteen
separate `oxlint --type-aware` processes of about 121 arbitrary files each**.

`--type-aware` is a type checker. Each process builds its programs from only
its own chunk members, so a file's verdict is a function of which chunk it
landed in rather than of its content. One probe flipped on a single extra
input:

    scripts/check-main-module-detection.mjs at d9d054d2e^
      named alone .......................... 1 diagnostic
      named with all 73 scripts/ ........... 1
      named with all 1927 files ............ 0
      the probe + one unrelated config ..... 0

## It had already cost a review round

This is #4892: three `require-array-sort-compare` sites were "fixed" there and
#4895 had to revert them. They were never defects — they were `any[]` inferred
from type information that a chunk did not contain.

## The fix

`pass_filenames = false`, which is the rung the sibling `tsc` hook already sits
on for exactly this reason ("its answer for one file depends on the whole
program"), and which 101 hooks in `prek.toml` already use. `types_or` /
`exclude` still decide WHEN the hook runs, not what it reads.

No new script and no new guard. A coverage guard was considered and rejected
under "Guards earn their keep" condition 1: the walk reaches every file today,
and no defect of that shape has occurred.

## Verification

On a tree with the pre-fix content restored, the incident reproduced exactly —
`npm run lint` exit 0 with the file unmentioned, `prek run --all-files oxlint`
Failed on `scripts/check-main-module-detection.mjs:408:10`. After the change
both are green on it.

Agreement is not agreement-by-blindness. Two injected violations, each against
a `cp` backup and `cmp`-restored, were caught identically by both entry points:

- a dropped `/** @type {string[]} */` — `require-array-sort-compare`;
- a `!` non-null assertion in `src/lib/utils.ts` — `no-non-null-assertion`.

Gating still works: `README.md` skips, `src/lib/bindings.ts` skips, a normal
`.ts` runs.

Side benefit: the hook goes from 9.4 s wall / 99 s CPU to 3.0 s / 16 s, because
it is one process instead of sixteen. A small commit pays about 3 s where it
paid 0.6 s.

## Left undone

The issue body still describes this as walk-vs-named; a comment on #4894
records the correction rather than a silent edit. Nothing was reported
upstream: the chunking is prek's, and oxlint is correct given its inputs.
`oxfmt` keeps `pass_filenames = true` — it is a formatter with no cross-file
analysis, so chunking cannot change its answer.

Closes #4894.
