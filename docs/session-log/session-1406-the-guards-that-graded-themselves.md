# Session 1406 — the guards that graded themselves

An overnight autonomous run, opened by a bug report from a phone: the Android hamburger
could not be tapped, and the app was still painting over the OS status bar. That got fixed
against real hardware, and the rest of the night was a batch loop. Nine items reached a PR.

The through-line is not any one of them. It is that **every single reviewer found something
real**, and that the sharpest findings were guards reporting safety they had not verified —
including inside guards written that same night specifically to stop a guard from failing
open.

## What shipped

| | |
|---|---|
| **#4426** | Android: inset the webview out of the system bars, plus an on-device e2e |
| **#4424** | Release: a comment inside a YAML folded block scalar would have failed the apt step at release time |
| **#4427** (merged) | The session-log reference now describes the logs people write |
| **#4429** | Dependabot: a human commit on their branch survives only if you make it survive |
| **#4430** | Delete the 37 `src/lib/tauri/` wrappers kept alive only by their own test file |
| **#4431** | CI: catch two open PRs claiming the same session number |
| **#4432** | `create_property_def` refusing a declaration the key's own stored values would violate |
| **#4434** | Nine prek hooks that could be silently defanged, plus a meta-guard |
| **#4435** | The shipped `.so` is 4 KB-aligned and cannot load on a 16 KB page device (#4425) |

Filed: **#4425**, **#4428**, **#4433**. Closed as duplicate: **#4415** → #4294.

## The Android bug was two symptoms of one thing

`targetSdk = 36` forces the activity edge-to-edge, so the webview was laid out at the full
display size: bounds `[0,0][1080,2400]` against a 132px status-bar inset, with the hamburger
at `[21,21][139,139]`. The status bar window sits *above* the app window in the z-order, so
it did not merely cover the button — it ate the touch. Overlap and dead tap were never two
bugs.

#4301's fix could not have worked, and the reason is in wry rather than in our code: wry
calls `setWebView` — which invokes `onWebViewCreate` — **before** `loadUrl`. So the injected
CSS always landed on the pre-navigation document and was wiped. The code anticipated that
and re-armed on every layout pass, but the re-arm re-entered a `lastInsets` cache that
compared insets, which had not changed. Only the document had. Two mechanisms, each correct
alone, cancelling to a no-op.

It could not be seen in a screenshot either: the status bar's clock is drawn in the OS's own
tint, so against a light app header in night mode it is white-on-white. The bar looked
absent while it was very much present and consuming touches.

## Measured, then measured again

Three hypotheses about #4418 have now been wrong. The third was mine.

The issue's last comment says the weekly Xvfb lane is "very likely the same mechanism" as
the release smoke hang. Going to apply the same dbus mitigation, I pulled the logs first —
and the AT-SPI warning that mechanism rests on appears in **all six workers of the passing
control run too**, followed by a normal boot. It is a constant ~30s tax, not the failure.
The lane is actually red for two unrelated reasons: a `tag-roundtrip.e2e.ts` UI assertion,
and a run where all six workers panicked in `init_logging` with `SetLoggerError` — the
global tracing subscriber initialised twice.

Shipping the dbus fix there would have made two real bugs look addressed. Filed as #4428
instead.

The same discipline paid twice more. A relayed "this issue is already resolved" turned out
to end with the maintainer writing *"Leaving this issue open"*. And the claim that
`dbus-run-session` ships in `dbus-x11` is false — `dpkg -S` says `dbus-daemon`; `dbus-x11`
carries only `dbus-launch` and reaches it through a dependency edge.

## Where the reviewers earned their cost

Six findings, all of the same family.

**A guard whose exit code aliased onto the runtime's.** #4431's collision check ran on its
own PR and printed `a session-log number is claimed by more than one open PR`. The script
had never executed — node exited 1 for a missing module, and 1 was also the code for "real
collision". The fix uses 20, outside every code node or the shell can synthesize, plus a
verdict line written with `writeSync`, because piped `console.log` is async and
`process.exit` drops it. Two agents independently hit that same async-write bug in different
files the same night.

**A guard that counted the wrong thing.** The corrected version of that same check treated
every *touched* session-log path as a claim, including modified ones. Two PRs merely editing
an existing log would be reported as colliding — and `docs/session-log/` has 15 files on
session-1000.

**A meta-guard blind to eleven dependency forms.** #4434's guard exists to find hooks whose
`files:` misses a module they import. A synthetic tree with eleven hooks, each carrying a
real missed dependency, reported `BROKEN: 0, UNVERIFIABLE: 0`. Its own header claimed to
cover the shell `source` keyword; the regex matched only the dot form. Its `runGuard()` exit
path was untested — replacing the body with `return 0` passed both its own hooks.

**A ratchet that fails open on empty input.** #4424's broadened tree scan prints
`every tracked non-scripts CI path agrees` when `git ls-files` returns nothing, having
compared zero paths — while every sibling guard in the same block fails closed.

**A predicate with three unfalsifiable arms.** #4432's shape check mirrors the engine's
`type_matches` arm for arm. Mutating it to reinstate the #4382 trap for `ref` and `boolean`
left the suite **silent at 518 passed**. `number`, `date` and select-membership each had a
refusal test; `ref`, `boolean` and the `value_ref` half of the `text | select` arm had
none.

**A fix that was not enough.** #4435's link flag gets the ELF to `0x4000` — but
`release.yml` ran `zipalign -p -f 4`, whose `-p` is documented as "4kb page-align uncompressed .so
files". The library is stored uncompressed, so the loader mmaps it in place and the payload
must also *begin* on a 16 KB boundary. 0.9.9's landed there by arithmetic luck.

## Two regressions I introduced, caught in review

Removing `--author @me` from the PR sweep was right — the board is majority-Dependabot and
the filter hid exactly the PRs the skill authorises merging. But §1 then said "any red is
yours to fix" about *every* open PR, including a stranger's, while the same file draws a
trust boundary a few lines above. Seeing and acting got conflated.

And an `NNNN` → `NNN` edit, made to settle a width mismatch, turned an accurate quote of the
guard's own error string into a wrong one.

Both were fixed before merge. Neither would have been caught by tests.

## Things that turned out to be more interesting than the claim

The Dependabot squash story was rewritten twice. The first version said the human commit's
message never reaches `main`. The repo's settings are `COMMIT_OR_PR_TITLE` /
`COMMIT_MESSAGES`, so the body is concatenated by default and the message *does* land — only
the subject is lost. Of the eight PRs in the sample, five took the default and lost nothing;
in three someone overrode the body as well, which is what erased the bump line. The
recommendation inverted accordingly.

The `zero losses` figure in that same entry is unmeasurable by construction: inspecting
merged PRs is survivorship-biased, since a commit force-pushed away and never restored
leaves a PR that looks exactly like one that never needed a commit.

## Operational notes

- **Serena's symbol tools read from the main checkout, not the worktree.** The known
  "Serena writes to main" trap extends to reads: a worktree agent asking for a file's
  symbols gets main's pre-change content and is quietly misled. Worktree subagents were told
  not to use them at all.
- `gh pr edit` is broken by a GraphQL Projects-classic deprecation in this `gh`;
  `gh api -X PATCH .../pulls/N -F body=@file` works.
- A `push.sh` run now exceeds the background-task cap and gets killed mid-gate. The
  postcondition check is what makes that visible rather than silent — remote and local SHAs
  simply disagreed. `setsid nohup` detaches it properly.
- Two commits aborted on the two known traps, both recovered by reading the named failing
  hook rather than retrying: a new shebang script needs `chmod +x`, and a deletion breaks
  path-keyed doc citations the same way a move does.
