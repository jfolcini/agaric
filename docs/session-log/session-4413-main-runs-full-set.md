# Session 4413 — every main push runs the full set

**Ask.** On `main`, run every check as if the push touched every kind of file, instead of selecting lanes from a diff.

**Change.** `_validate.yml`'s `detect-changes` hands `classify-changes.sh` an empty base on a push to `main`; the classifier answers an unresolved base with the full set (every lane, the Linux bundle and Android builds included). That replaces #7013's lookup of main's last green run, so its `base` step and the job's `actions: read` go. `ci.yml`'s concurrency comment now gives the full set as the reason cancelling a superseded main run is safe.

**Shown.** `EVENT_NAME=push PUSH_BEFORE='' bash scripts/classify-changes.sh` prints "Base sha unresolved: running the full set" and every lane `true` (`vitest_e2e_tauri` stays `false`: the full vitest run covers it).

**Left alone.** The migrations append-only backstop in `lint` still checks the push's own range: it is not a lane selection, and every PR's range is checked on the PR.

**Ran:** the pre-commit hooks on both workflows (actionlint, zizmor).
