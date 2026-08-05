# Session 1266 — the scheduled lane went red because an upstream branch moved

## What happened

The weekly `Scheduled deep checks` run failed on 2026-08-03 and again on the
dispatched run 30981051402. Two lanes were red — `prek-all-files` and
`full-suite` — and both had the same cause: the `zizmor` hook, which each lane
invokes via `prek run --all-files`.

`zizmor` reported 30 findings against `.github/workflows/`:

- 15 × `error[impostor-commit]` (High) — "commit with no history in referenced
  repository"
- 15 × `warning[ref-version-mismatch]` (Medium) — hash pin's version comment
  does not match the pinned commit

All 30 pointed at the same pin, repeated 15 times across six workflow files:

```
uses: dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4 # stable
```

## Why it broke without anything in this repo changing

The pinned commit still exists — `gh api` resolves it — but it is reachable
from **no branch**:

```
$ gh api /repos/dtolnay/rust-toolchain/commits/4cda84d.../branches-where-head
(empty)
$ gh api /repos/dtolnay/rust-toolchain/branches/stable --jq .commit.sha
4360b52568e2003a75bf9bc1d59f33a8e3fc893c   # committed 2026-08-05T04:31:12Z
```

`dtolnay/rust-toolchain` regenerates its `stable` branch by force-push. That
happened at 04:31 UTC on 2026-08-05, roughly two hours before the run. The
previously-pinned commit was orphaned by it.

That timing is the whole explanation for why 2026-08-03 was green and today was
not: nothing in this repository changed between the two runs.

An orphaned commit is not a cosmetic problem for `impostor-commit`. That audit
exists because GitHub serves fork commits from the parent repository, so
`org/action@<sha>` can resolve to a commit an attacker pushed to a fork. A pin
that is unreachable from any branch of the referenced repo is indistinguishable
from that case, which is exactly what the audit reports.

## The fix

All 15 occurrences repointed to the live `stable` head, count-preserving
(15 before, 15 after, 0 left over). The `# stable` comment stays accurate,
which is also what clears `ref-version-mismatch`.

## Verification

The locally-installed `zizmor` is 1.24.1; CI installs `zizmor@latest`, which is
now 1.28.0. A green run against 1.24.1 would have proved nothing about the lane,
so 1.28.0 was fetched and run against both states of the tree:

```
with the fix:   No findings to report. Good job! (9 ignored, 114 suppressed)
old pin:        153 findings (9 ignored, 114 suppressed): 15 medium, 15 high
```

## What this does not fix

The pin will go stale again on the next force-push, and Dependabot will not
catch it: `dtolnay/rust-toolchain` publishes no releases or tags, so there is no
version bump for the `github-actions` ecosystem to offer. The pin is to a
branch head that is rewritten on a schedule nobody here controls, so it can only
ever be refreshed by hand or by something purpose-built. Filed separately rather
than papered over with a `zizmor.yml` suppression — suppressing the audit would
convert a check that correctly went red into one that cannot, which is the
failure mode this work stream exists to remove.

Also worth recording: the deep-checks lane installs `zizmor@latest`, so an
upstream tool release can red the lane with no repository change. That is a
second, independent source of the same surprise.

## Note on the two red lanes

`full-suite` was red for this reason alone, not for a test failure. Its Rust
suite never ran — the job invokes `prek run --all-files` first and exits on its
failure. Anyone reading the job list would reasonably have concluded the test
suite was broken on `main`. It was not.
