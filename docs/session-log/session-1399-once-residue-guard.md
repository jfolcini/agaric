# Session 1399 — 121 latent traps, zero defects, and a guard that had to be a runtime one

#4211: "123 files combine an unconsumed `*Once` mock with `vi.clearAllMocks()` — same #4040
hazard." The outcome is a guard and **no changes to any of the 121 files**, which needs
justifying.

## The population, with its denominator

Denominator: **783 `*.test.ts`/`*.test.tsx` files under `src/`** (416 + 367). The issue's 777
was measured on an older tree.

Re-running the issue's own query gives **125**. Stripping block and line comments before
re-testing removes **4** files whose only `*Once` is inside a comment — the issue excluded 1.

**Live population: 121.**

## The premise was verified at source, not assumed

A vitest bump could have retired the hazard, so it was checked in the installed 4.1.10:
`@vitest/spy`'s `mockClear` empties `calls`, `contexts`, `instances`, `invocationCallOrder`,
`results` and `settledResults`, and never touches `config.onceMockImplementations`. A direct
probe returns the leaked value after `mockClear()`. `vitest.config.ts` sets no global
`clearMocks`/`resetMocks`/`restoreMocks`. The premise holds.

**One adjacent claim was falsified mid-investigation.** Eight files were first bucketed as
already-mitigated because their `afterEach` calls `vi.restoreAllMocks()`. That is wrong: in
vitest 4 `restoreAllMocks` iterates only `MOCK_RESTORE` — spies created by `vi.spyOn` — so a
`vi.fn()` once-queue survives it. Probe: `vi.fn() after vi.restoreAllMocks() -> LEAK`. **Zero
of the 121 are mitigated file-wide.**

## The bucketing rule, and why it forbids the obvious sweep

> Unconsumed residue is a **latent trap**, not a defect. It becomes a defect only when a later
> test actually consumes it.

That distinction is the entire result. The first guard design failed any test that left
residue at teardown. Measured across shard 1/4 it produced exactly two failures, and **both
were false positives** — one of them `BlockPropertyEditor.test.tsx:945`, which is **#4040's own
regression test**, deliberately leaving an unconsumed once to prove its `beforeEach`
`mockReset()` drains it.

A rule that fails the code which already fixed the bug is the wrong rule. Any grep-shaped or
teardown-shaped rule has that property.

Structural risk ranking, for proactive hardening rather than sweeping:

| Bucket | Count | Why it ranks |
|---|---|---|
| **A** — positional `*Once` on the shared `invoke` mock | 64 | One mock multiplexes every Tauri command, so an incidental IPC steals the slot *within* a test too (#3217). `mockedInvoke` is 991 of ~1500 `*Once` calls. |
| **B** — queues a never-settling / hand-resolved promise | 36 | A leak burns the full 8s `asyncUtilTimeout` on a nonsense assertion — #4040's exact shape. |
| **C** — settled value on a single-purpose mock | 43 | Lowest. |

A ∨ B = 78, A ∧ B = 22.

## Measured: zero live leaks

With the guard active across the full suite, **0 cross-test leaks today**. All 121 are latent.
A 121-file rewrite would have been 121 files of unfalsifiable churn — no test would have gone
from red to green, and the diff would have been indistinguishable from a no-op that also
carried risk.

## Why a runtime guard and not `scripts/check-*.mjs`

This repo prefers a guard over a one-time sweep, and normally that means a static
`check-*.mjs`. **Here it must not.** A static guard sees only the grep, and the grep has a
measured **121:0 false-positive rate** against real defects. Whether a once-value is *consumed*
is a runtime fact and is not visible to any amount of source analysis.

The guard wraps `vi.fn`/`vi.spyOn`, stamps each value queued through
`mockImplementationOnce` (the funnel all four `*Once` helpers call) with the queuing test, and
reports when a *different* test consumes it. It records rather than throws — same reasoning as
the existing strict-IPC guard, since call sites `.catch` into loggers and error boundaries. It
adds a comparison and a delegating call, changing no value, no `this`, and no timing, so
enabling it cannot alter an outcome.

## Falsification

A two-test pair reproducing #4040:

```
Error: This test consumed 1 `*Once` mock value that an EARLIER test queued and never used:
  - a value queued on an unnamed vi.fn() at .../bad.test.ts:12:9
    by "#4040 in miniature > test 1: queues a deferred the code path never reaches"
    was consumed by "#4040 in miniature > test 2: innocent, asserts the happy path"
```

The bad fixture's *native* failure is `expected 'HUNG' to be 'HAPPY'` **on the innocent test** —
precisely the misattribution that cost #4040 a review cycle. The guard adds the true cause and
the exact queuing line.

Both halves are pinned permanently, including the no-false-positive half (`mockReset()`-drained
residue, never-consumed residue, module-scope stubs), so the guard cannot drift back to
over-reporting. One vacuous assertion written during development
(`expect(typeof rawOnce).toBe('function')`) was replaced with a real module-scope exercise.

Two guard bugs were caught by those tests: the call-site extractor skipped `@vitest/spy` by
name, but vitest bundles the spy into a `@vitest/runner` chunk, so it reported the bundle's
line; and its self-exclusion matched the substring `once-residue`, swallowing every frame in
its own test file and reporting `unknown location`.

## Considered and rejected

A global `beforeEach` doing `vi.mocked(invoke).mockReset()`. It is safer than the issue
assumes — `invoke` is created as `vi.fn(strictInvokeFallback)`, and `mockReset()` restores that
exact implementation rather than leaving `undefined`, so the issue's main objection does not
apply to the mock carrying most of the hazard. But with measured-zero live leaks it is a real
behaviour change buying nothing. It is the right lever if a bucket-A leak ever appears.

## Verification

`npx vitest run` — **784 files, 18052 passed**, 1 expected fail, 37 skipped, exit 0, **0 leaks**;
run twice. `tsc -b` clean; `oxlint` clean on all changed source files.
