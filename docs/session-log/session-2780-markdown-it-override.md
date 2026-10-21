# Session 2780 — markdown-it 15.0.3 through an override, so the npm audit passes again

Three markdown-it advisories published after `main`'s last run red `validate / lint` on every PR: GHSA-r7fv-28h4-cvq7 and GHSA-gfr2-rv44-r23c (high) and GHSA-vfgh-jcmw-g37q (low), all quadratic-time parsing. The one path to markdown-it is `markdownlint-cli2` (the docs lint), whose latest release, 0.23.3, pins `markdown-it` to exactly 15.0.1, so no direct bump reaches it. An `overrides` entry takes it to `^15.0.3`, which fixes all three, beside the repo's other transitive security overrides.

15.0.3 is five days old, under `.npmrc`'s `min-release-age=7`, so the lock was refreshed with the documented `--min-release-age=0`. It brought `argparse` 3.0.3, which 15.0.3 requires and the same maintainers published the day before. Nothing else in the lock moved.

Checks run: `npm install --package-lock-only --ignore-scripts --min-release-age=0` (the lock diff is those two packages), and `bash scripts/npm-audit-retry.sh npx better-npm-audit audit`, which passes.
