# Session 1642 — the boot-error test was racing its own bootstrap

`main-boot-error.test.ts` reddened CI on `main` and on every open PR with

```
AssertionError: expected null not to be null
```

at `expect(document.querySelector('[role="alert"]')).not.toBeNull()` — the
fatal boot screen apparently never rendered.

## It was not what the bisect said

CI conclusions across the eight commits before it put the first red exactly on
#4896, the storage-spy conversion. That was a coincidence. Re-running the same
commit with no code change came back fully green — both shards and coverage —
so the failure is scheduling-dependent, and the bisect had latched onto the
first run that happened to lose the race.

Three local reproductions had already failed to reproduce it: `--shard=1/2`
plain, the same with `--coverage`, and the same single-threaded. The shard file
list was confirmed identical to CI's by extracting it from the failing run's
blob artifact — 412 files either way — so the file set, coverage instrumentation
and sequential ordering were all ruled out before this.

## What it actually was, measured

The blob artifact records per-test durations. The failing test:

```
"duration": 1029.628474
```

against a sibling in the same file at 21.7 ms. `vi.waitFor`'s default budget is
1000 ms. The test did not observe a missing fallback screen; it stopped looking
21 ms before one arrived.

Locally the three cases measure 238 ms, 20 ms and 67 ms. `main()` is invoked as
an import side effect and its promise is not exported, so a test can only wait
for it — and the boot awaits two dynamic imports, `@/lib/tauri-mock` and the
locale chunk, before either outcome is reachable. On a contended four-core
runner with 400-odd files in the shard, 1000 ms is not a safe budget for that.

## The fix, and how it was shown red

All three waits in the file take a shared `BOOT_WAIT` of 15 s — they race the
same bootstrap, so raising one and not the others would just move the flake.

Falsified by reproducing the cause rather than the symptom: giving the mocked
`initFrontendObservability` a 1500 ms delay makes the boot genuinely slow, and

- with `BOOT_WAIT`, all three pass;
- with the default budget restored on that one call, the run reddens with
  `AssertionError: expected null not to be null` — CI's failure exactly.

Restored from a `cp` backup and `cmp`-verified.

15 s is not derived from the observed 1029 ms, because that number is the
timeout rather than the boot's real duration — the true figure is unknown and
only bounded below. It is chosen to be far enough above any plausible boot that
a timeout means something is wrong rather than something is slow, which is the
only honest thing a budget can mean here.

## What this does not fix

The same shape — `vi.waitFor` on the default budget around work that includes a
dynamic import — will exist elsewhere in the suite. This session did not sweep
for it. A test that fails by timing out reports the assertion inside it, so the
symptom always looks like a missing element rather than a slow one, and that is
worth knowing before the next one of these.
