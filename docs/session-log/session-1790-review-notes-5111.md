# Session 1790 — review notes from #5111

The two non-blocking notes `agaric-reviewer` left on #5111, batched here rather
than pushed onto that branch once it was approved and green. Both are deletions.

`closeResolvedIssue`'s `existingIssue === null` arm could not be reached.
Getting into that function needs `resolvedOnes.length > 0`; `resolvedOnes` is
derived from `parseKnownFindings(existingIssue?.body)`, so a null issue yields an
empty known set and the caller's guard has already returned. The
`state === 'CLOSED'` half is live — a human can close the issue with lines still
in the block — and stays, with "absent or" gone from its message.

`isRunShapeFinding` carried sixteen lines of prose over a one-line predicate.
One sentence in it was not derivable from the function's own name: libFuzzer
saves a reproducer under `artifacts/` rather than into the corpus, so the next
run never re-executes it and a `[crash]` can go quiet with the bug intact. That
sentence is why the predicate excludes the code-shape prefixes at all, so it
stays; the paragraph restating the name and the one that follows from it are
gone. Eight lines.

Session 1789 cut four restatements of the cancellation rule down to one on the
same reviewer's note. This is the same cut one level down, and #5111's own
`closeResolvedIssue` docblock is the next candidate if it reads long later.

## Verified

- `node --test scripts/file-fuzz-findings.test.mjs`: 10 passed, up from 9.
- A dead-code deletion cannot be falsified by deleting it — nothing observable
  changes, which is the claim. So the claim itself is pinned instead: a new test
  drives `main` with no tracking issue at all (`--known-body-file` at an absent
  path) over a clean run, and asserts the no-op. `runMain` had always written a
  marker block, so it could not express "no issue yet"; it now writes the file
  only for a non-empty id list.
- Falsified against a copy: dropping `resolvedOnes.length > 0` from the caller's
  condition — the guard that makes the deleted arm unreachable — reddens that
  test with `Cannot read properties of null (reading 'state')`, which is exactly
  the dereference the deleted arm used to absorb. Copy restored, `cmp` clean.
  The other nine pass under that mutation, which is why the new one exists.
- Ran the same shape through the CLI directly before writing the test: a clean
  two-target run with no existing issue prints `no new fuzz findings` and exits
  0, never reaching the close.

## Not done

- #5112 — the mixed-set half of the dedup false negative, filed from the same
  review and not touched here. Clearing only the run-shape ids means writing a
  body whose `all` carries a `[crash]` id absent from `byId`, and `renderDetails`
  skips ids without details, so that crash's reproduce command and log excerpt
  would silently vanish. It needs a way to carry a tracked finding's details
  forward; that is a design call, not a patch.
- The reviewer could not execute `node --test` in its sandbox and said so, so
  every passing count in #5111 and here is from local runs, not its verification.
