# Session 1789 — a cancel is not a finding

#5110 asked whether the auto-filed fuzz tracking issue was accurate. Its seven
`[not-run]` lines describe run
[35393649124](https://github.com/jfolcini/agaric/actions/runs/35393649124)
correctly and should not have been filed. That run was a `workflow_dispatch`
cancelled by hand 21 minutes in — the workflow declares no `concurrency` group
and the `fuzz` job used 16 of its 155 allowed minutes, so a manual stop is the
only thing that could have ended it. The lane pre-seeds every target's status to
`not_run` before it fuzzes anything, so all seven were still `not_run` when the
job stopped, and `buildFindings` turned each one into a tracked finding under a
heading that tells the reader to fix it and remove its line. There was nothing
to fix: no target reached the code, so the lane found nothing.

The seven lines were also a live false negative. Finding ids are the dedup key,
so `[not-run] fts_strip: target never executed` sitting in the marker block
would have swallowed the identical id from a future run that genuinely lost
`fts_strip` to a job-level timeout — the one shape of `not_run` that is worth
reading. They are removed from the issue body.

`buildFindings` now files neither the per-target `[not-run]` findings nor the
`[lane]` fallback when `needs.fuzz.result` is `cancelled`. Cancellation is
external — a hand-stopped dispatch, a superseding concurrency group — and the
lane's own result already has a channel: `report-scheduled-failures` (#3359)
renders it `⚠️ cancelled`. Everything else is untouched. A job-level timeout
reports `failure`, not `cancelled`, so it still files per-target; a crash or a
build break on a target that ran before the cancel is still filed, because a
cancellation does not unmake a finding. `main` now says the suppression out
loud rather than printing seven `not_run` statuses above a silent zero.

The same distinction was drawn one script over in session 1709, where
`check-workflow-liveness.mjs` was reporting superseded-cancelled `main` runs as
lane failures.

## Verified

- `node --test scripts/file-fuzz-findings.test.mjs`: 5 passed. The file is new;
  the script had no tests. Wired into `_validate.yml`'s `lint` job beside
  `check-workflow-liveness.test.mjs`, named explicitly per that step's comment,
  and the folded `run:` re-parsed with `yaml.safe_load` to confirm it is still
  one command.
- Falsified against a copy, twice. Dropping `if (cancelled) break` from the
  `not_run` arm reddens two of the five (the all-cancelled case files seven
  findings; the mixed case files the `[not-run]` line beside the crash);
  neutralising `!cancelled` in the `[lane]` condition to `true` reddens the
  fourth. The two arms that pin the non-cancelled side — a `failure` lane's
  per-target line, and its `[lane]` fallback — pass under both mutations, which
  is what they exist for. Copy restored, `cmp` clean.
- The new body of #5110 fed through `parseKnownFindings`: 0 known findings, both
  markers present.
- Not run here: the lane itself. The next weekly `scheduled-deep-checks` run is
  the end-to-end check.

## Not done

- `assertLaneInputs` still does not fire `--require-results` for a cancelled
  lane. That is unchanged and still right — a cancelled lane legitimately wrote
  nothing, and now deliberately reports nothing — but the comment explaining the
  split said `cancelled` was the `[lane]` finding's job, so it was corrected.
- Whether `[not-run]` earns its keep at all under a `failure` result was not
  revisited. `report-scheduled-failures` names the lane; the per-target lines
  name which targets lost coverage, which is the part a job-level timeout makes
  worth reading.
