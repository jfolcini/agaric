# Session 1417 — the decision that is the action

#4283 and #4451, which turn out to be the same shape twice: an input trusted without being
validated, and in one case published to a public GitHub issue.

## Reading a symlink into a public bug report

`recent_errors` decided what to read with `Path::is_file()`, which follows symlinks. A
symlink planted in the log directory under `agaric.log` or `agaric.log.YYYY-MM-DD` was read
and its content went into the prefilled body of a **public** issue.

The fix is not an `is_symlink()` check before the read, because that is a check-then-act
pair and the window between them is the whole vulnerability. It opens with `O_NOFOLLOW`,
which makes the kernel fail at resolution time, so **the decision is the action**. The
regular-file proof is an `fstat` on the returned descriptor rather than a `stat` on the
path, and every subsequent read uses that same descriptor, so a post-open swap cannot
retarget it. `O_NONBLOCK` is there so a planted FIFO fails fast instead of blocking on a
writer that never comes.

Canonicalize-then-prefix-compare was considered and rejected: compared against an
un-canonicalised log directory it breaks a legitimately symlinked log directory, which the
issue explicitly refuses to break. Confining the *final component* sidesteps that, because
entry names from `read_dir` contain no separator — "the final component is not a link" is
exactly "directly inside this directory".

Classification is positive throughout: a regular file, opened without traversing a link,
directly inside the log directory, under an already-matched log name. A deny-list of
forbidden shapes fails open on the one nobody thought of, which is how this class survives.

## The exposure one level up

The issue named files. The same trick works on directories: `read_dir` on a symlinked
`traces/` enumerates whatever it points at, and the winner is then a *real regular file with
a real name inside another directory*. Every file-level guard is satisfied and no link
appears anywhere in the opened path. Before the fix it exfiltrated `traces/id_rsa`.

Worth noting how it was found — not by reading the issue, but by asking what else in a
publicly-published payload is derived from the filesystem. The answer was "the subdirectory
walk", and nothing else: the remaining fields are the app's own version, OS, arch and
device id.

## Where the "not racy" claim stopped being true

The file gate is genuinely not a TOCTOU pair. The **subdirectory** guard is one, and review
proved it rather than arguing it: `symlink_metadata(dir)` then `read_dir(dir)` then open —
an attacker who can swap `<log_dir>/traces` between the first two syscalls gets a real file
with a real name, and `O_NOFOLLOW` never fires because there is no link left to refuse.

Closing it needs `openat`-relative I/O, which this crate cannot spell today — it is
`deny(unsafe_code)` and there is no safe `openat` in std or any current dependency. So it is
recorded at the guard, in the code, saying what it is. That matters more than it sounds: the
alternative was shipping a comment that read as race-free next to a check that is not, which
is the exact defect class this session spent its night on. The residual is strictly better
than the pre-fix behaviour — it costs an attacker a race instead of nothing — and it shares
its precondition with the hard-link case below.

## Two residuals kept on purpose

A **hard link** still reads its target. `O_NOFOLLOW`, `fstat` and canonicalisation are all
blind to it, and refusing `st_nlink > 1` would silently drop real logs on any machine running
a hard-linking backup tool — a permanent loss of exactly the data a bug report exists to
carry. The attacker it would stop must already be writing inside the app's data directory and
be on the same filesystem as the target.

Both residuals are written at the code rather than filed alone, because the person who needs
them is the next person reading that function.

## "Non-self" before and after normalisation are different questions

#4451 was the stated device id being validated while the heads-derived fallback beside it
took the wire value verbatim into a **permanent** `peer_refs` row — `bind_endpoint_id`
validates only non-emptiness and then refuses to be re-pointed. The same value reaches the
device list, a sync event, tracing fields at WARN and ERROR, and per-peer metric maps. The
tracing reach is what ties the two issues together: a newline in it forges whole log lines,
which `recent_errors` then publishes publicly.

The fix applies the same normaliser in both interpreters through one shared function, so they
cannot drift. Review then found a defect in it: the normaliser **trims**, so a head spelled
with our own id surrounded by whitespace passes the "find a head that is not us" filter and
then normalises *to* our id — a value the old code could never produce. The post-condition
the function's name claims was not one it held. Fixed by filtering after normalisation.

That is a good miniature of the whole class: a predicate evaluated on one representation of a
value, and the value then converted to another.

## A test whose doc claimed more than the test proved

Review added a case pinning that the read re-decides at open time rather than inheriting the
enumeration filter's answer — then falsified its own new test and found its doc comment
overclaimed. Rewriting the gate into a racy `lstat`-then-`open` shape leaves the test green,
because a swap landing precisely between two adjacent syscalls is not schedulable from a test;
only dropping `O_NOFOLLOW` reddens it.

So the doc now says exactly what it proves and carries a "what this does NOT prove" section.
A test that reads as demonstrating race-freedom, and does not, would be worse than no test —
it would retire the question.

## What shipped

- #4283 — symlink confinement at the file level via `O_NOFOLLOW` plus an `fstat` on the open
  handle, a real-directory requirement for the subdirectory walk, six tests that each plant a
  real symlink and assert the pair (secret absent **and** a legitimate line still present),
  and two residuals recorded at the code.
- #4451's validation asymmetry — one shared normaliser for both interpreters, plus the
  trim-then-compare defect review found in it. The issue's remaining items need a decision and
  it stays open.
