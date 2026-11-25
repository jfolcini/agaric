# Session 4441 — the npm provenance check stops reddening PRs that change no dependency

**Ask.** #7073 went red in `lint` at "Verify npm package provenance signatures". It changes no npm file. npm's attestation endpoint answered `@tiptap/extension-code-block-lowlight@3.34.0` with an `OK` body where JSON belongs, on all three attempts of `npm-audit-retry.sh`. Each attempt had its own empty cache (#7054), so the registry itself served the bad answer for at least 25 s. A few minutes later the same URL returned the attestation. This is the second time on 2026-11-25; #7050 and #7054 hit the same fault in the morning.

**Fix.** The maintainer chose to make the check advisory on a PR that changes no dependency manifest, which is how `cargo audit` and the npm advisory scan are already gated:
- "Classify dependency changes" moves ahead of the provenance check, so `DEPS_CHANGED` is set before it.
- The provenance check takes `continue-on-error: ${{ env.DEPS_CHANGED != 'true' }}`. Its verdict depends only on the lockfile and the registry.
- It stays blocking on a PR that touches a Cargo or npm manifest, and on every push to `main`, scheduled run and release.

The auto-mode classifier refused the first attempt at this edit as a weakened security check. The edit went in once the maintainer chose it.

**Copies fixed.** The lint job's header comment, the classifier's comment, `npm-audit-retry.sh`'s usage note, `docs/BUILD.md` (phase G said both audits block in CI) and `SECURITY.md` § Mitigations.

**Not changed.** The retry window stays at 5 s and 15 s. A longer one would not reach a fault that outlasts it, and the bad body may sit in npm's CDN for longer than any wait we would accept.

**Ran.**
- prek over the changed files: actionlint, zizmor, markdownlint and typos.
- Nothing can falsify a step condition offline. The first run of this PR, which changes no manifest, shows the gate: the classifier prints `Dependency manifests changed: false`.
