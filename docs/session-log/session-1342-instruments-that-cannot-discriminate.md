# Session 1342 — nine PRs, and a night of instruments that could not discriminate

An overnight batch run ending in the 0.9.7 release. Nine PRs merged across two batches. The
work was chosen for two themes the maintainer named — make the ratchet reliable, make the
mock faithful — but what the night actually turned up, over and over, was a narrower thing:
a check that returns the same answer whether the system is healthy or broken.

Six independent instances, in six unrelated subsystems, found by six different agents. None
of them was looking for the pattern. It is worth writing down together, because the shape is
more transferable than any of the individual fixes.

## The pairing bug, and why it stayed open for days

`#3852` — a first pair between two devices never completing — closed this session after three
confidently-held theories had been refuted, two of them ours.

The root cause is Android 15+'s per-uid `FIREWALL_CHAIN_BACKGROUND`, which drops every packet
for an app's uid whenever it is not top-of-stack. Screen off is enough. `dumpsys netpolicy`
said so directly:

```
UID=10408 state={procState=TPSL,seq=3377608,cap=-------TI}
  blocked_state={blocked=APP_BACKGROUND, allowed=NONE, effective=APP_BACKGROUND}
```

and 300 datagrams moved `/proc/net/udp`'s drop counter from 1928 to 2228 — exactly +300 —
with `rx_queue` never leaving zero. Discarded before enqueue, which is where the cgroup-BPF
hook lives.

**What kept it hidden was a log line that could not be false.** `session_supervisor.rs` logged
`"SyncDaemon started; announced over mDNS"` on the `Ok` of `daemon.register(...)` — which is
`send_cmd`, a `flume::try_send`. `Ok` means *a message reached a queue*. It cannot report a
network failure, because it has not touched the network. Three layers of silence sat behind
it: `register()` cannot fail for network reasons, `monitor()` — the channel mdns-sd documents
for exactly these failures — had zero call sites in the workspace, and mdns-sd's own `log`
records went nowhere because no `log`→`tracing` bridge was installed.

The fix demotes that line to an announce-*submitted* debug line and promotes only on a real
`DaemonEvent::Announce`, which the crate emits after `send_unsolicited_response` returns
outgoing addresses. Reading the vendored crate rather than its docs also corrected a claim we
had put on the issue: `DaemonEvent::Error` has exactly **one** emission site in mdns-sd 0.20.3,
a service-name-length check. It is not a daemon-health channel at all.

## The same shape, five more times

**A ratio guard that was a wall-clock budget.** `BlockTree.scale-envelope`'s bound was
`Math.max(first * 40, 50)` with `first` at 0.35–2.0 ms, so the floor dominated every
comparison — a fixed 50 ms budget wearing a ratio's clothes, blind to real regressions *and*
flaky under load from the same cause. Replaced with counting getters on the row objects, so
the assertion is reads-per-block at 10K over reads-per-block at 1K. Measured 1.000 with zero
spread across ten runs, five of them under a 48-way load spike that inflated wall-clock 8×.
The ceiling is derived, not chosen: a full comparison sort across a 10× span gives
log2(10000)/log2(1000) = 1.33×, any quadratic term gives ~10×, so 2 sits 1.5× above the worst
legitimate value and 5× below the smallest real signal.

**A test that stayed green when its subject was deleted.** `flushSync` on the blur flush path
had nothing observing it; removing it left the suite green. Now two tests, one per branch, and
the RED output is the pre-blur DOM.

**A guard that could not look.** The git-fixture isolation meta-guard scanned `.sh` only, so
every `.mjs` and `.py` fixture-builder was invisible; its argv-array blind spot meant
`execFileSync('git', ['init'])` matched nothing even in files it did open; and its isolation
probe asserted `--show-toplevel`, which stays pinned to the fixture under a leaked
`GIT_INDEX_FILE`. Only `--git-path index` moves.

**A report that read as complete and was not.** The mutation-survivor filer cut its comment
body at exactly 60 000 characters — mid-identifier, with an unbalanced ``` fence so the
"truncated" footer rendered *inside* the code block, and no count. 1397 of 2000 findings
missing, invisibly.

**A fixture that matched because it was written to match.** A conformance step's
`expected_queries` was hand-authored from the Rust source because the recorder could not be
run — the #891 false-drift shape exactly. Verified three ways before shipping: a plain run
(which asserts the whole array), a `CONFORMANCE_UPDATE=1` re-record confirming byte-identical
output, and a mutation of the step proving the refusal tracks the limit rather than something
incidental.

## Comments that argued for code they did not describe

A second family, and the more embarrassing one, because several were ours from earlier the
same night.

- A `matchesFtsIndex` docstring cited `list_backlinks`' `Contains` filter as the reachable
  caller. There is no `list_backlinks` command.
- The #4017 guard sweep's own new documentation — the single "which tree is judged" reference
  a future guard author is meant to trust — named two cwd-rooted guards. There are four.
- A test comment documented the *narrow* escape form that the same PR identified as its second
  bug, sixty lines above a test asserting the wide one.
- A perf test's decomposition claimed a `{...child, depth}` spread was tallied. It never runs:
  the fixture defaults `depth: 0`, so every row takes the identity-preserving branch. A probe
  confirmed 7n−2 with the objects returned by identity — and found a second false row the
  review had missed, re-render being exactly 34n rather than the claimed 58n−24.
- A table parser's rule ended up doing precisely what its own docblock cited as the reason for
  rejecting a *different* rule.

Each was fixed by making the code true or the comment true, never by deleting the claim.

## Two fixes that were worse than the bug, caught before merge

**Markdown round-trip.** The first attempt fixed #4019 and broke 4-space list nesting — the
classic Markdown style — turning imported sub-lists into literal paragraph text, with a test
pinning the regression. Rejected. The second attempt closed it via CommonMark's 3-space
tolerance, and the rebuilt fuzz then found a second, previously unknown bug: the serializer's
leading-marker escape must be *wider* than the parser's tolerance, because a nested paragraph
is emitted indented and re-parsed dedented.

**Guard rooting.** The first attempt at #4017 replaced script-relative rooting with a
cwd-derived `git rev-parse --show-toplevel`. That agreed with prek and CI and silently
disagreed everywhere else: `pr-merge-result-check` runs a merged worktree's own guard copy
from a different cwd, so the guard rooted on the *caller's* repo, rejected every target as
out-of-tree, and exited 0. Measured in a scratch pair — cwd inside the tree caught the
violation, cwd elsewhere returned green over a tree it never read. The defect class #4017
exists to end, reintroduced by #4017.

It surfaced only because the commit hook runs an *unrelated* script's self-test. One of those
assertions expected exit 2, got exit 2, and still failed — because it asserts on stderr too,
and could tell "refuses to guess about a foreign repository" from "you forgot an argument".

## Two production bugs nobody had reported

**Property rename never worked.** The rename's old-key clear sent an all-null `set_property`
for a non-reserved key. `validate_set_property` accepts exactly one value, or zero only for a
reserved key — pinned by the store's own tests. So every user-key rename ended in a
`renameFailed` toast with the old chip still present.

The suite could not see it because `setProperty` was mocked as unconditionally successful.
Making that fixture reject what the backend rejects immediately reddened **three pre-existing
tests that were pinning the broken shape**, plus one written minutes earlier that had been
reproducing the live bug all along.

**Navigating to a collapsed block destroyed the saved layout.** #3276's reveal routed through
the same setter as the user's own chevron clicks, and that setter is the sole writer of
`PREFERENCES.blockCollapse`. One backlink click permanently deleted those ancestors, across
reloads, with no undo.

## On iroh

Asked whether pairing is underusing iroh. Answered from the builder chain rather than from
what iroh generally offers: relay and discovery are disabled at four independent layers, guarded
by four tests with negative controls, because "no cloud, no relay, no third-party servers" is a
promise in shipped docs. iroh 1.0 also ships no mDNS at all — it moved to a separate crate that
is not in the lockfile.

The real lever is elsewhere, and is filed as #4037: the QR code is already an authenticated
out-of-band channel, and it carries *only* the passphrase, with a test forbidding `host` and
`port`. Both fallbacks are structurally unavailable on a first pair — `last_address` is written
only after a successful sync, and manual entry lives on the peer list, which a not-yet-paired
device is not in. So on a first pair, mDNS is not the primary path with fallbacks; it is the
only path.

## What I got wrong

- Reported #4048 as "still finishing vitest" twice when it had **failed**. I was reading a red
  check as pending. The failure was a worker crash with all 17127 tests passing, and the PR
  contains no TypeScript, but I should have looked rather than assumed.
- Concluded a push had been running for 45 minutes when nothing was running — my `pgrep`
  pattern was matching its own command line. The remote ref told the truth; the process check
  did not.
- Left a stray non-ASCII character in a commit message, and dropped an executable bit that
  aborted a commit.
