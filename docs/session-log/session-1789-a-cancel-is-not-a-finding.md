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
cancellation does not unmake a finding.

The same distinction was drawn one script over in session 1709, where
`check-workflow-liveness.mjs` was reporting superseded-cancelled `main` runs as
lane failures.

## The half the issue's own text hides

The maintainer pointed at a later run, and it changes the diagnosis. Run 42
(`35395444072`) was dispatched at 21:11 — the minute run 41 was cancelled — and
succeeded: all seven targets fuzzed clean in 52 minutes. Its triage job ran at
22:48, 44 minutes after the issue was filed, and its log reads

```
fuzz target statuses: attachment_path_parse=ok … pagination_cursor_decode=ok
fuzz findings this run: 0
no new fuzz findings — no-op (tracking issue left untouched)
(7 previously-known finding(s) no longer present — not a reason to touch the
 issue on their own: [not-run] attachment_path_parse: target never executed, …)
```

So the lane knew the issue was false and said nothing, by design: the filer only
ever wrote on a NEW finding. A set that resolves itself never clears, and #5110
would have sat at "7 of 7 fuzz targets did not pass this run" until some
unrelated finding happened to arrive. Both sibling filers already close on an
empty set — `file-mutation-survivors.mjs` closes the parent when its set empties,
`file-scheduled-failures.mjs` when every lane is green — so this was a gap in the
family, not a trade any of them made.

A clean run now closes the issue and empties the marker block, but only for the
findings a clean run actually DISPROVES. `[not-run]` and `[lane]` are claims
about the run, and a run in which every target executed and passed is their
direct negation. Every other prefix is a claim about the code, and a quiet run is
not evidence against it: libFuzzer writes a reproducer to `artifacts/`, not into
the corpus, so the next run never re-executes it and a `[crash]` line can go
quiet with the bug intact. Those stay for a human, which is what the issue's own
instructions ask for. That rule came out of a test: the first version keyed the
close on "the tracked set emptied", and the arm pinning a tracked `[crash]`
caught it announcing the crash as resolved and closing the issue on it.

`allTargetsClean` is keyed on the per-target statuses rather than on
`needs.fuzz.result`, so a lane whose targets all passed and whose job then failed
in a later step still clears; and it is false for an empty result list, because a
lost artifact must never read as a clean week (#3360).

## Verified

- `node --test scripts/file-fuzz-findings.test.mjs`: 9 passed. The file is new;
  the script had no tests. Wired into `_validate.yml`'s `lint` job beside
  `check-workflow-liveness.test.mjs`, named explicitly per that step's comment,
  and the folded `run:` re-parsed with `yaml.safe_load` to confirm it is still
  one command.
- Falsified against a copy, five times, each mutation restored and `cmp`-checked.
  Dropping `if (cancelled) break` from the `not_run` arm reddens two (the
  all-cancelled case files seven findings; the mixed case files the `[not-run]`
  line beside the crash). Neutralising `!cancelled` in the `[lane]` condition
  reddens a third. Neutralising `resolvedOnes.every(isRunShapeFinding)` reddens
  the tracked-`[crash]` arm; making `isRunShapeFinding` always true reddens that
  one and the prefix table; dropping `results.length > 0` from `allTargetsClean`
  reddens the lost-artifact arm. The arms pinning the other side — a `failure`
  lane's per-target line and its `[lane]` fallback — stay green under every
  mutation, which is what they exist for.
- The first mutation attempt on the run-shape clause was a no-op (the pattern
  missed after oxfmt reflowed the condition) and printed a green run. Re-run
  against the real text, it reddens. A mutation that changes nothing proves
  nothing, and a green result from one reads exactly like a covered guard.
- `current.length === 0` was dropped from the close condition rather than
  covered: every target reporting `ok` already means `buildFindings` returned
  nothing, so no production change could have reddened it.
- End-to-end through the CLI with both runs' real inputs and the workflow's own
  flags: run 41's (seven `not_run`, `--job-status cancelled`) is a no-op where it
  filed seven findings; run 42's (seven `ok`, a body carrying the seven lines)
  closes the issue. A lost artifact does not, and neither does a tracked
  `[crash]`.
- The new body of #5110 fed through `parseKnownFindings`: 0 known findings, both
  markers present.
- Not run here: the lane itself. The next weekly `scheduled-deep-checks` run is
  the end-to-end check.

## Review

`agaric-reviewer` approved and re-derived the load-bearing claim independently:
`file-scheduled-failures.mjs`'s `isFailing` is `result !== 'success'`, so a
cancelled `fuzz` lane is still reported by `report-scheduled-failures` and
`RESULT_LABEL.cancelled` renders it `⚠️ cancelled`. It also checked that
`scripts/*.test.mjs` is outside vitest's `include`, so the new file runs exactly
once, in `lint`.

Its first non-blocking note was right and is applied: the cancelled rule was
stated in four places (the module header, the `buildFindings` JSDoc, the
`assertLaneInputs` JSDoc, and a `console.log` in `main`), where AGENTS.md wants
one. The `buildFindings` paragraph is the one a reader of `if (cancelled) break`
is looking at, so it keeps the statement; `assertLaneInputs` keeps a clause and a
pointer, because its own premise ("a `failure`/`cancelled` lane is the `[lane]`
finding's job") had gone false and needed correcting either way. The header line
and the `console.log` are deleted — the same run already prints `fuzz findings
this run: 0` beside a lane the reporter has marked `⚠️ cancelled`. It rode this
push because DCO forced one anyway; it would not have earned a push of its own.

Its second note — that the whole split rides on a job-level timeout surfacing as
`failure` rather than `cancelled` — is accepted as stated and not acted on. If
that is wrong the cost is granularity in a notification the reporter still sends,
not silent data loss. Not verifiable from here; it is written down in the
`buildFindings` JSDoc so the next reader can check it against a real timeout.

## Not done

- `assertLaneInputs` still does not fire `--require-results` for a cancelled
  lane. That is unchanged and still right — a cancelled lane legitimately wrote
  nothing, and now deliberately reports nothing — but the comment explaining the
  split said `cancelled` was the `[lane]` finding's job, so it was corrected.
- Whether `[not-run]` earns its keep at all under a `failure` result was not
  revisited. `report-scheduled-failures` names the lane; the per-target lines
  name which targets lost coverage, which is the part a job-level timeout makes
  worth reading.
