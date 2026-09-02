# Session 1479 — Continuity and succession in GOVERNANCE.md

Issue #80 was narrowed on 2026-09-02 to a single deliverable: one `GOVERNANCE.md` section saying where repository administration, the commit-signing key, the release-signing secrets and DNS live, and how emergency access is recovered, so that OpenSSF `access_continuity` (the last unmet Silver MUST) can be flipped to Met with a URL to point at.

The section was written from what the repository already states rather than from anything new. The ruleset requires a valid signature on `main` but no particular key, and `scripts/bump-version.sh` deliberately hardcodes no key or address, so a successor signs releases with their own identity and the BDFL's GPG key needs no escrow. The updater key and the Android keystore live as Actions secrets, so repository admin alone keeps the release workflow signing; `SECURITY.md` already documents the rotation that recovers from a lost local copy and its user-facing cost. There is no domain: the updater endpoint and every published URL are on `github.com`, and `com.agaric.app` is a bundle identifier. That leaves one real handover, repository access, covered by GitHub's account-successor setting. The "currently informal" revisit trigger now points at the section.

One thing this PR cannot verify: whether the successor setting is actually populated on the BDFL's account. The section states it as the mechanism; the maintainer should confirm it before flipping the form row.

Docs only; no tests run beyond the pre-commit hooks.
