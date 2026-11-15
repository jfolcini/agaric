# Session 4206 — shfmt hook and a pinned shellcheck

#6762, all three items, as the maintainer approved them on the issue: an `shfmt (write)` hook, the tree formatted once, and shellcheck pinned instead of taken from apt, brew or the runner image.

## Decisions

- **Versions:** shellcheck 0.11.0 and shfmt 3.14.1, the newest the pinned `taiki-e/install-action` (v2.90.1) manifest carries, so CI's `tool:` list can install them. The release-asset digests in `scripts/setup-hooks.sh` were recomputed from the downloads and match that manifest's.
- **Local install:** `release_get_pinned` fetches the upstream release binary, checks its SHA-256, and installs it into `~/.cargo/bin`, replacing a copy on PATH at any other version (the old apt shellcheck 0.9.0 included). It has no package-manager fallback: an unpinned copy is the drift this fixes. The versions sit in `pinned_version_for`, which `tool-pins` already reads.
- **Options:** `-ci -bn` with two-space indent changed the fewest files (23 of 42; `-i 2` alone changed 28). They live in `.editorconfig`'s `[*.sh]` section, and the hook passes no flags, because shfmt ignores `.editorconfig` when given any.
- **The freed slot:** `no-retired-pending-doc-refs` is deleted. It blocked citations of the `pending/*.md` workplans retired under #2233, and the tree cites none.
- **Blame:** the repo keeps no `.git-blame-ignore-revs`, so the reformat goes in this PR as its own commit. A squash merge folds it into one commit on `main`.
- **The reformat's one hand edit:** two `verify-ci-equivalent.sh --self-test` anchors matched their target lines' four-space indent; they now match two.

## Verified

- In this cloud session, with no shellcheck or shfmt installed, `.claude/hooks/session-start.sh` ran `setup.sh`, and its background `setup-hooks.sh` installed both at the pins before it wired the hooks.
- Shown red: `tool-pins` with shfmt drifted in `setup-hooks.sh`, and with shellcheck drifted in `_validate.yml`; the `shfmt` hook on a misindented `scripts/push.sh`.
- shellcheck 0.11.0 over every tracked script is clean. The `dco-signoff.sh` and `verify-ci-equivalent.sh` self-tests, `node --test scripts/*.test.mjs`, the classify-changes and release-vault vitests, `prek run --all-files`, and the full pre-push verify all pass.
