## Session 1133 — fix tauri-action v1.0.0 post-merge release-pipeline breaks (#2148 follow-up) (2026-06-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-30 |
| **Subagents** | orchestrator-only |
| **Items closed** | follow-up to merged PR #2148 (no issue number) |
| **Files touched** | 1 (`.github/workflows/release.yml`) |

**Summary:** PR #2148 bumped `tauri-apps/tauri-action` 0.6.2 → 1.0.0 and was merged
without addressing the `agaric-reviewer` bot's two blocking review comments (the bot also
left a contradictory stale APPROVED review claiming "updater artifacts are currently
disabled" — false since #808 wired updater signing + `generate-latest-json`). Verified both
issues against the current `release.yml` and the tauri-action v1.0.0 source, then fixed them.

**Issue 1 — macOS in-app updater would 404 (high).** v1.0.0 breaking change #1194 inserts the
app version into `.app.tar.gz`/`.sig` release-asset names (`Agaric_<arch>.app.tar.gz` →
`Agaric_<version>_<arch>.app.tar.gz`). tauri-action uploads the *payload* under the new
versioned name, but our manual macOS `.sig` upload still named it `Agaric_<arch>.app.tar.gz.sig`,
so `generate-latest-json` (which derives each macOS download URL by stripping `.sig`) produced a
URL that no longer matches the payload asset → every macOS update check 404s.
Fix: embed `${GITHUB_REF_NAME#v}` in the sig filename. The `generate-latest-json` `case` globs
(`*_x64.app.tar.gz` / `*_aarch64.app.tar.gz`) already match the longer name and re-derive the
correct URL from it, so no logic change there.

**Issue 2 — auto-generated changelog silently erased (medium).** v1.0.0 semi-breaking change
#1277 makes the action overwrite the *name and body* of the existing draft release. The workflow
pre-creates the draft with `--generate-notes` for a real changelog, but tauri-action then
overwrites the body with the literal `releaseBody: 'See the assets…'` input; `finalize-release-notes`
read that placeholder and appended only the SLSA recipe → no changelog shipped.
The reviewer's suggested "just drop `releaseBody`" is wrong — verified against the v1.0.0 source
that an empty `releaseBody` overwrites the body with *empty*, which is no better. Robust fix:
`finalize-release-notes` now *regenerates* the changelog via the GitHub release-notes API
(`gh api …/releases/generate-notes`, same source the pre-create used) and writes the entire
`<changelog> --- <SLSA recipe>` body — immune to whatever tauri-action left, and idempotent on
reruns (overwrite, not append, so the old double-append guard is gone).

**Hardening:** added a CI guard to `generate-latest-json`'s smoke-assert that every updater
payload URL in `latest.json` resolves to an asset that actually exists on the release. The
prior check only asserted url/signature were non-empty, so it would not have caught this 404
class; the new check would have, and guards against future tauri-action naming drift.

**Verification:** can't run the release pipeline (tag-push only). `python3 -c yaml.safe_load`
passes; the macOS version string is guaranteed to match tauri-action's (verify-version proves
tag == manifest version, and tauri-action names the bundle from the manifest). Comments updated
throughout (the two pre-create blocks + the macOS sign/upload block + generate-latest-json) so
they no longer describe the pre-v1.0.0 behaviour.

**Commit plan:** single commit on `claude/fix-tauri-action-v1-release`, pushed, draft PR.
