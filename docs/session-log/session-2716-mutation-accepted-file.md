# Session 2716 — Accepted-equivalent mutants move out of the issue bodies (#5986)

The weekly mutation lanes kept the mutants triage proved unkillable in a
hand-pasted block in the body of #4690 and #4691, keyed by
`(file, line, column, mutator)`. Any PR that moved a line expired entries, the
filer dropped them ("re-anchoring"), the children reopened, and the maintainer
re-pasted ids. The block and its history were about half of #4691's body.

**What replaced it.** `mutation-accepted.tsv` at the repo root, one file with a
lane column (the filer reads one path; the two lanes' keys differ in shape, so
each line starts with its lane). The key is line-independent:

- frontend: file, mutator, trimmed text of the mutated line, column relative to
  that text, nth occurrence of that text in the file (from the Stryker report's
  own `source`);
- rust: file, cargo-mutants description (function included), trimmed line, read
  from the `src-tauri` checkout.

The text is part of the key, so an entry whose line was edited is inert and can
never suppress another mutant. The filer logs how many entries matched nothing;
it writes no accepted state and no history into any body. A line that does not
parse throws, so the lane goes red through the existing scheduled-failures
reporter: no new hook or job. `--accept` (stdin) turns survivor-block ids into
file lines for the PR that proves an equivalence.

**Deleted:** `renderAcceptedBlock`, `parseAcceptedSurvivors`/`parseAcceptedOn`,
`appendReanchorNote`, `parseReanchorNotes`, `noteSafeId`, `announceReanchoring`
and their three self-tests (about 700 lines).

**Kept on purpose.** The rust key has no column: two mutants with one
description on one line (`!=` twice in `attachment_ops.rs`) share an entry, which
accepts both, as the ids did. The child close note still names the accepted ids.

**Migration.** 286 frontend + 13 rust ids converted by `--accept`. One frontend
id (`vault-import.ts:65:10`) pointed at a blank line at `origin/main`, so it was
already inert and was not carried over; the two `!=` rust ids collapsed into one
entry. Verification and red proofs are in the PR body.
