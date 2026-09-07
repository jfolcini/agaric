# Session 1593 — enex-import: cover the no-coverage mutants (#4815)

#4815 reported 39 mutants in `src/lib/enex-import.ts` that **no test executed at
all**, plus 91 survivors. Per the parent (#4691), no-coverage outranks survivors:
until a test runs the code, no amount of strengthening an existing assertion can
touch them. This session took the no-coverage list only.

## What was uncovered

The 39 clustered in five places, all reachable through the public `parseEnex`:

- **`mimeToExt`'s unknown-mime fallback** (lines 277–278). Every existing
  attachment test used `image/png`, which the known-mime table answers, so the
  subtype-derivation branch — strip non-alphanumerics, lowercase, accept only a
  1..5-character result, else `bin` — had never run.
- **`uniqueResourcePath`'s extension-less and collision paths** (336, 343–346).
  Every fixture resource was either unnamed or already called `*.png`, so the
  "append an extension" arm and the whole short-hash disambiguation block were
  dead in the suite.
- **`indexNoteResources`' missing-`<data>` / missing-`<mime>` fallbacks**
  (313:80, 317:68).
- **`transformEnmlDom`'s already-shipped check** (398:27). `used.some(…)`'s
  callback never ran because no note referenced two `<en-media>`.
- **`enmlToMarkdown`'s empty and malformed-ENML early returns** (492:36, 495:57).

## What shipped

Ten tests in `src/lib/__tests__/enex-import.test.ts` (two new describe blocks),
each asserting the exact derived path / mime / body rather than a substring:
unknown-mime extension derivation across four mimes chosen for the boundaries
(`image/HEIC` uppercase, `image/x-icon` at exactly the 5-character cap,
a too-long subtype, and a mime with no `/` at all), extension-less file-name,
a file-name collision between two distinct resources, a data-less resource that
must be skipped before it can claim a file name, the octet-stream default, a
pretty-printed `<mime>` that must be trimmed, one attachment for a resource
referenced twice, two for two distinct resources, and the empty / missing /
malformed `<content>` degradations. No production code changed.

Two details were chosen for falsifiability, not decoration. The collision fixture
names both resources `a.png` so the dot sits at index 1: a suffix spliced at the
wrong offset, or an off-by-sign `dot === -1` test, moves the extension and is
visible. The data-less resource is placed **first** and shares the real one's
file name, because a skipped resource is otherwise unobservable — if it were
indexed it would take `x.png` and push the real attachment onto a disambiguated
path.

## Verification

Every test was falsified against a copy of `src/lib/enex-import.ts` (`cp` to
`/tmp`, mutate, run, restore, `cmp`), never in place. 30 hand-applied mutants
matching the reported findings were run: 28 went red naming a new test, and the
two that survived are equivalent — `[^a-z0-9]+` → `[^a-z0-9]*` is a no-op under
the `g` flag, and `dot === -1 ? '' : …` is unreachable because every candidate
path contains a dot.

One methodology correction worth recording: the first falsification driver
passed `--reporter=basic`, which vitest 4 does not know. Every run exited
non-zero and the driver reported all 28 mutants "killed". The tell was that the
`Tests …` summary line was missing from the captured output. Re-run without the
flag, four mutants actually survived, and two of those (`-1` → `+1` at 344:24
and 345:26) were then genuinely killed by moving the collision fixture to a
one-character stem. A driver that reads only an exit code is asserting something
true for two reasons.

Confirmed with the real lane, `node scripts/run-mutation.mjs enex-import`, run
twice: once with the pre-change test file restored from `HEAD` for a measured
baseline, once with the new one. No-coverage 47 → 8, survivors 95 → 89, killed
323 → 368, score 69.79 → 79.36 (470 mutants, ~80 s per run). Those raw counts
are higher than #4815's 39 / 91 because the issue dedups by location+mutator
while the report counts each mutant — one `ConditionalExpression` location emits
two. Of the issue's 39 no-coverage lines, 26 are fully cleared (every mutant at
that location+mutator killed), 5 are now covered but equivalent, and 8 remain
no-coverage — all `??` / ternary fallbacks that cannot be reached: `known[mime]
?? 'bin'` behind a `mime in known` guard, `.split('/').pop() ?? ''` on a
never-empty array, `textContent ?? ''` on elements, `mediaRefs[i] ?? ''` with an
always-in-range index, and `enNote == null` after the parser-error guard. They
belong in #4691's accepted-equivalent block rather than in a test.

Suites: `npx vitest run src/lib/__tests__/enex-import.test.ts
src/lib/__tests__/enex-import.property.test.ts` — 35 passed (was 25);
`npx tsc -b` clean; oxlint and oxfmt clean on the changed file.
