# Session 1793 — the `v1` pin drifted out from under its comment

`main` was red on `full-suite-prek`, and `full-suite` with it, on twelve copies of
one zizmor finding: `ref-version-mismatch` against
`dtolnay/rust-toolchain@6c977a6c… # v1`. Nothing in the repo moved. Upstream
retagged `v1` onto `02cb101e…`, so the hash we pin and the version the comment
claims stopped naming the same commit, and the audit that reads the pair started
failing on a tree nobody had touched.

The pin is the security property and it held throughout — a moved tag cannot
change which bytes a pinned hash fetches. What broke is the comment's honesty,
which is exactly what `ref-version-mismatch` audits: a reader who trusts `# v1`
to mean "the current v1" was wrong for as long as the drift lasted. Restoring the
pair means moving the hash forward, not rewording the comment to a version that
no tag points at.

The six commits between the two hashes touch `action.yml`, the action's own CI
workflow and `scripts/update-revs.sh`: a 1.98.1 patch entry, branch predefinition
up to 1.120, and `--force-non-host` passed unconditionally. Nothing that changes
what the toolchain step does for the arguments every call site here passes.

All twelve sites move together — `.github/actions/toolchain/action.yml`,
`_validate.yml` (×2), `ci.yml`, `release.yml` (×2), `scheduled-deep-checks.yml`
(×5), `e2e-tauri-weekly.yml` — because a split pin is a second version of the
same drift, one that no longer shows up as twelve identical findings.

This is the blocker cleared ahead of the 0.13.1 tag: `scripts/release.sh` runs
every pre-commit hook in its preflight, so a red `zizmor` stops the cut before it
starts.
