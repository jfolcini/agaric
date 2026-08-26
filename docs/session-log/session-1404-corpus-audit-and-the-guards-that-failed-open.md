# Session 1404 — the corpus audit, and four guards that would have failed open

Follow-on to session 1403. The ask was narrow — update the `batch-issues` skill and the
agent memories, have a subagent review them and the repo's `AGENTS.md` files, ship it as one
PR, and clean the stale worktrees. It grew because the audit found that the instruction
corpus had drifted from the repo it describes, and then review found that my corrections had
drifted from the repo too.

## What shipped

- **#4420** (merged) — corpus corrections across root `AGENTS.md`, `batch-issues/SKILL.md`,
  `references/pitfalls.md`, `CONTRIBUTING.md`, four dependent skills,
  `src-tauri/src/mcp/AGENTS.md` and `src-tauri/benches/AGENTS.md`.
  (`docs/BUILD.md` was NOT changed and did not need to be: its wording was already
  conditional — "optional", "when available", "not a build or test prerequisite". An
  earlier draft of this log claimed otherwise.)
- **#4421** (open) — the release boot-smoke rewrite plus the MCP path-gate narrowing
  (#4419), and a CI-classifier fix so shell-only changes stop pinning the Rust suites.
- **#4418** — filed, then publicly corrected twice as measurement killed my hypotheses.
- Worktrees: 13 removed, **75 GB** reclaimed, every branch preserved.

## The through-line: guards that fail open

Four separate times, a guard I wrote and tested would have waved something through. None was
caught by testing that the guard *worked* — each was caught by asking what would make it
*not fire*.

1. **A CI-check recipe classified failures by deny-list.** It matched only
   `FAILURE|TIMED_OUT|ERROR|CANCELLED`, so `STARTUP_FAILURE`, `ACTION_REQUIRED` and
   `STALE` counted as neither pending nor failing and read as **green**. `dco` is a
   required context the recipe never extracted by name, so it rested entirely on that list.
2. **The boot smoke's liveness window collapsed from 20s to ~1s.** I replaced `timeout 20s`
   + exit-124 with "poll until the log line appears, then assert alive". `init_logging` is
   called *inside* Tauri's `.setup()` closure (`src-tauri/src/lib.rs:2475`) and is the
   first thing it does; `init_persistence` (`:2492`), `recover_and_bootstrap` (`:2505`),
   window creation and the whole `.run()` loop (`:2747`) all come after the log line
   appears. A panic at t≈2-4s used to exit 134 and go red — and under the new scheme would
   have reported a pass. **The AT-SPI/WebKit hang the PR exists to fix also lives after
   `init_logging`, so the fix would have called its own target failure green.**
3. **The process-group reap could SIGKILL the step's own group.** `$!` is the pid bash
   forked; it becomes a group leader only after `execve(setsid)` and the syscall return, and
   the `ps` that reads its pgid races that. On the losing side, `pgid` is the shell's own
   group. It ran on every attempt, including successful boots, and the retry loop could not
   recover because the shell running it was what died.
4. **A duplicated regex would have made a fix a silent no-op.** `unrec_ci` in the
   fail-closed arm was a verbatim copy of the classifier's CI pattern. Changing only the
   classifier would have left the fail-closed check still refusing to attribute
   `scripts/*.sh` — I would have reported success on a change that did nothing.

The generalisation, now in the skill and the memories: **classify positively.** An
allow-list of known-good states fails safe, because an unanticipated value lands outside it
and blocks. A deny-list of known-bad states fails open. Whenever the state set is not yours
to control — CI conclusions, exit codes, API enums — enumerate the good ones.

## Measurement beat reasoning, twice

The 0.9.9 release failed its AppImage boot smoke. I filed a confident root cause: extraction
of the ~97 MB AppImage eating the 20-second budget. It explained every observed fact.

**Extraction takes 0.73s.** Wrong by a factor of 27, and only discovered because I downloaded
the artifact and ran `time` on it. The second hypothesis — WebKitGTK headless flags — died the
same way: an `ubuntu:24.04` container with the release job's own deps boots the real 0.9.9
AppImage in ~60 ms, baseline and with both flags alike.

What measurement then revealed, cheaply: `init_logging` is called *inside* Tauri's `.setup()`
hook, so "no log file" means GUI init never completed — the guard was reporting a real
failure, and the investigation had been aimed at the wrong layer entirely.

The corrected note is in the agent-memory file `feedback_measure_not_imagine.md` (which
lives in `~/.claude/projects/.../memory/`, outside this repo — so it is not a path a reader
can open from a checkout): when a hypothesis rests on a
magnitude ("that's slow", "that's big"), the check costs seconds — spend them *before* filing
it, because a filed issue is a claim other people act on.

## The release is still broken, and that is the honest status

0.9.9 is a draft with 22 assets against 0.9.8's 41. No `latest.json`, so nothing can
auto-update onto it; no Linux or Windows updater signatures; no SBOMs or SLSA attestations
for any platform. All of it because one step failed and 24 downstream steps plus four jobs
gate on it — which the workflow's own comment predicted verbatim.

A plain re-run failed identically, so the failure is deterministic on the runner, not flaky.
The hang itself is **not** root-caused and #4421 does not claim to fix it. What it does is
stop one flaky-looking launch from silently unpublishing a release, and capture `wchan` so
the next occurrence names the syscall it is blocked in.

Re-cut of 0.9.9 is approved and staged behind three preconditions that abort rather than
assume: the fix present on `main`, `BOOT_SECONDS` at 90, and the signing identity matching
the key's UID.

## Smaller things worth keeping

- **Two memory index entries pointed at detail files that never existed** — `push.sh` and
  the DCO/`update-branch` trap, two of the most operationally important notes in the corpus.
  Same defect class as the guard invented in session 1403.
- **Root `AGENTS.md` told every agent to ALWAYS prefer a disabled MCP server** over
  Grep/Read — the file's most emphatic instruction, pointing at tools that cannot be called.
- **`gh pr checks` has no `--json` flag** in gh 2.45, and the required context is reported as
  `validate / validate-all`, not `validate-all`. Both cost real time; both are now written
  down with a pasted run rather than a description.
- A `.md` edit under `src-tauri/src/mcp/` forced a ~12-minute `agaric-mcp` release build, and
  a shell-only diff pinned the full Rust suite. Both fixed and falsified **in #4421, which is
  still open** — neither is on `main` yet, and the `unrec_ci` duplication is still present on
  the merge base.

## A note on this file's own format

`.claude/skills/batch-issues/references/session-log.md` prescribes a metadata table,
"Files touched", "Verification" and "Commit plan" sections and a `(YYYY-MM-DD)` heading
suffix. This log has none of them — and neither do 1401, 1402 or 1403, which deviate
identically. Practice moved to prose and the template did not follow.

That is the same drift class this session spent its day auditing, in a file the audit read,
and nothing enforces it: the numbering guard only greps for the `# Session NNNN` heading.
Recording it deliberately rather than leaving a fourth session to deviate silently. Filed as
**#4423** rather than fixed here, because deciding whether the template or the practice is
authoritative is a maintainer call, not a cleanup.
