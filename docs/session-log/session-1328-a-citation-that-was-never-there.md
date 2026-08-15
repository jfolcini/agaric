# Session 1328

## A citation that was never there

Two issues about artefacts that read as evidence and cannot function as evidence. #3804: the
equivalence ledgers cite sweep harnesses that were never committed, so their empirical half
cannot be re-run. #3907: the harnesses that *were* committed hand-clone their target function
with nothing tying the clone to the source.

Both are the same defect in different tenses — a claim you cannot re-check.

### Four of five premises held; the fifth had never existed

The ledgers cited five harnesses. Two were already fixed by #3906. Three were real, uncommitted
and live, and are now committed.

The fifth was `date-utils`, whose entry cites "1,980,276 probes across four timezones". No such
citation exists in `date-utils.test.ts`, `date-utils.property.test.ts` or `parse-date.test.ts`.
`git log --all -S` on the number in both comma and bare forms, and on the phrase, returns zero
hits across every ref — and the commit the entry claims to originate from contains no probe count
or timezone-sweep language at all.

So the claim is not stale. It never happened. Its 22 equivalent-mutant entries are pure deductive
arguments, which is fine and which #3804 explicitly allows — but the sentence dressing them as an
empirical sweep was fabricated, and no amount of searching for the missing harness would have found
it. Worth checking a negative before acting on it, and worth recording that the check was `-S`
across all refs rather than a look at the current tree.

### The controls are the claim

A sweep reporting `0/200168 differing` is worthless on its own — it is equally consistent with
"the mutation is equivalent" and "the harness cannot detect anything". So each new harness carries
a control: a deliberately non-equivalent mutation at the same site, which must fire.

- `inline-property-parse`: 0/200,168 on both claims, control fires 1,937×
- `export-graph`: 0/50,000, control fires 16,253×
- `in-page-find-matcher`: 0/47,943 on all four claims, controls fire 3,652× and 29×

The review's contribution was checking that each control exercises the **same** code path as the
claim beside it, not a neighbouring one — a control firing on unrelated input proves nothing. All
three are single-node mutations of the identical clone. The matcher's pair is the sharpest: the
outer and inner readings of the *same* textual `&&`→`||` change, which demonstrates the harness can
distinguish two AST interpretations of one edit.

One claim rides without its own adjacent control, and that is recorded rather than glossed:
`lineIndexes.size === 0 → false` is equivalent by construction (with an empty set, `.filter` is a
no-op and `.has()` is always false, so the guarded path is unreachable). Deductive, which the ledger
permits — but it should not be counted as empirically covered.

### The gate, and the lesson it did not inherit

Every `*.harness.ts` now carries `mutation-harness-source-pin: <path>#<fn> sha256=<hex>`, and a prek
guard extracts the named function, hashes it, and fails on mismatch, missing pin, dead path, or
renamed function. Demonstrated across four falsify/restore cycles through the real `prek run`, not
just the self-test.

Then the review found the hook lacked `always_run = true` — so a staged deletion of a pinned source
file made prek report `(no files to check) Skipped` and exit 0, while the guard run directly
correctly detected the dead pin and exited 1. prek's changed-file set excludes deletions.

That is the **third** time this session that fact has mattered, and this instance is the worst of
the three: the lesson is documented in a comment directly above the insertion point, on the sibling
`migrations-immutable` hook, and the new hook still did not inherit it. Proximity is not
transmission.

### The extractor fails open on one input

A bracket-depth scanner over TypeScript is where this class of guard breaks, so the review attacked
it with twelve adversarial inputs. Eleven either extract correctly or fail **closed** — strings
containing braces, balanced regex quantifiers, wholly unbalanced regexes, `${ }` nesting, generics
carrying object types, nested functions, same-named arrows, comments with backticks, `export
default`.

One fails **open**: a regex literal containing a bare unmatched `}`. Two source versions differing
by real code after the regex hash identically, so the pin matches and the drift is invisible. None
of the twelve currently-pinned functions has that shape, but two of the pinned modules are
regex-heavy, and the self-test covers regex literals not at all.

Filed as #3950 rather than improvised, because a correct fix needs division-vs-regex disambiguation
via previous-token tracking, and the same root cause ships in a sibling guard — so the right fix is
one shared scanner, not two hurried ones.

### A smaller thing, and the reason it is here

Eight `line:col` citations in the touched test files had drifted — one by 129 lines. Found by
checking rather than assuming, which is the same move that turned up the `date-utils` fabrication.
The seventh was corrected; the eighth was left with a caveat because the correction was uncertain.

An uncertain correction stated as certain would have been a new instance of exactly what this
session was cleaning up.

### The guard failed open on the largest harness it shipped

Two review rounds later, the sharpest finding of the three: `scanLiteralFolded` ends with
`): Array<{ start: number; end: number }> {`, and the extractor took the **first** `{` after the
closing paren as the body brace. That brace is inside the return-type annotation, and its match is
on the same line — so the pin hashed the **signature only**, and the entire body fell outside it.

Which body? The one whose line 430 all four equivalence claims are about, and which six 40-line
clones exist to reproduce. Edit that line and the pin still matched: `matchCount === 1`, no
violation, `OK: … all match their source`, prek green, and the harness carries on asserting
`diffBoth`/`diffStart`/`diffEnd`/`diffInnerOr` are zero about a function that no longer resembles
its clone.

Self-consistently green, too, because the pin was generated by the same extractor that misread it.

The doc comment directly above the defect named this exact limitation and then asserted "Neither
function this guard currently pins has that shape." It was true when written for two pins and false
by the time a third landed — a claim that decayed silently into misinformation sitting on top of the
thing it described.

Fixed by tracking angle-bracket depth from the close-paren so only a `{` at depth 0 opens the body,
with the pin regenerated and a self-test case for object-literal return types — the fourteen
existing cases covered dollar-names, `../` escapes, backslashes before backticks, JSDoc pins and
const-arrows, and nothing with a brace in a return type, which is exactly why it landed green. Every
other pinned function was then checked for the same shape; none has it.

Four more fail-open paths came out of the same round and are closed: a missing harness directory
printed `OK: 0 pins across 0 files` and exited 0, so moving the directory silently disarmed the whole
gate; a pin naming a directory crashed with an uncaught `EISDIR` instead of reporting a violation; the
containment check was lexical, so a symlink inside the repo pointing out of it was still read; and
`readdirSync` was non-recursive, so a harness in a subdirectory was never required to carry a pin at
all.

Worth stating without softening: this was the fourth review round on a change whose entire subject is
guards that pass for the wrong reason, and it was still failing open on its own largest artefact. The
lesson is not that the reviews worked — though they did. It is that "the guard is green" was, once
again, a different claim from "the thing the guard checks is true", and only an adversary who went
looking at the extractor rather than the output could tell them apart.
