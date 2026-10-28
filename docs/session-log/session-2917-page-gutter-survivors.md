# Session 2917 — page-gutter mutation survivors

#6108, the first of the frontend survivor issues the maintainer asked to clear (2026-10-28). Stryker on `src/editor/page-mode/page-gutter.ts` reported 35 survivors and 8 no-coverage mutants out of 245; the issue lists 30 + 7 because its ids merge variants that share a spot.

**Killed:** nine tests in `page-gutter.test.tsx`, each driving the grip through the real editor and drag plugin. They cover:
- the grip's position against the editor's frame;
- press and release opening the block menu;
- hiding through a drag and while the selection moves;
- leaving the editor or its frame;
- recreating the plugin views;
- which presses in the lane keep the caret.

**Accepted:** 13 mutants, in `mutation-accepted.tsv`, each with a `#` reason line above its entry. The format has no reason column, because the whole line is the key. They are:
- a constant's text;
- redraw guards that redraw the same thing;
- null arms that exist only for the type;
- listeners left on after `destroy()`, which act on a detached frame;
- an attribute value CSS matches by presence;
- `cancelAnimationFrame(null)`.

**Left reported:** the capture flag on the lane mousedown (`page-gutter.ts`, `addEventListener('mousedown', this.pressLane, true)`). Flipping it changes nothing in happy-dom or Playwright, but it would matter in a real browser if ProseMirror flushed a pending DOM change on that press. It is not proven equivalent, so it stays a visible gap rather than an accepted line. #6108 therefore stays open on that one mutant.

**Traps:**
- **Splitting a run:** a run near the 590 s cap has to be split with `--mutate file:a-b`, which `scripts/run-mutation.mjs` does not pass through. A split also drops any mutant that crosses the cut; the body of `hold()` fell out and was broken by hand.
- **Sibling variants:** the accept key has no replacement, so accepting one variant at a spot also accepts its siblings. Accepting `281:9 → true` also hides `281:9 → false`, which a test kills today.

**Also here:** the `scheduled-deep-checks.yml` comment that said state was "not a committed baseline file" now names `mutation-accepted.tsv`.

**Suites:**
- the page-gutter tests;
- typecheck;
- oxlint and oxfmt on the test file;
- a split Stryker re-run: 231 killed, 14 survived, of which 13 are accepted plus the capture flag, and 0 no-coverage;
- a filer dry run, which suppresses the accepted 13.
