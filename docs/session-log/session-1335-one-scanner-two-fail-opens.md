# Session 1335

## One scanner, two fail-opens

#3950 and #3953 read like separate defects in the mutation-harness clone guard — one about a regex
literal breaking bracket matching, one about `const` initializers being unpinnable. They are the
same missing capability, and fixing either one properly required the same thing: a lexer that can
tell a regex literal from a division.

### The fail-open, reproduced before it was fixed

`skipString` / `stripComments` / `findMatchingBracket` were copy-pasted between
`check-mutation-harness-clones.mjs` and `check-set-property-args.mjs`, and neither copy knew what a
regex literal was. Run against the code as it stood on `main`, two versions of one function
differing by real code **after** a regex containing a bare `}` extract to the *same* truncated text
and hash to the *same* sha256:

```
extracted A: "export function stripTrailingBraces(s: string): string {\n  const re = /\\}"
extracted B: "export function stripTrailingBraces(s: string): string {\n  const re = /\\}"
hashes identical: true
```

That is the guard reporting OK about drift it structurally cannot see. The second symptom in the
same root cause — a regex containing a quote (`/['"]/`) read as a string opener — made the old
scanner return `null` for the whole function, and made the sibling guard silently *skip* a
`setProperty` call site whose literal contained a brace-bearing regex: `literalCount: 0,
skippedCount: 1`, violations `[]`, even with `value_bool` genuinely missing.

### Deciding `/` needs the previous token, and where it cannot be decided it must redden

`scripts/lib/js-scanner.mjs` resolves the ambiguity by tracking the previous *significant* token,
with a paren-context stack (`if (x) /re/.test(s)` is a regex; `(a + b) / c` is not) and a
brace-context stack (block close vs object-literal / JSX expression close). Two positions are not
decidable this way and were chosen deliberately rather than guessed:

- `/` after `++`/`--` **across a newline** depends on ASI. It throws `ScanError`; every caller turns
  that into a violation. Same line, it is division — the operand is already a complete expression.
- `<` and `>` never introduce a regex. In a `.tsx` file `</` is a closing tag; `a < /re/.source` is
  not code anyone writes. The cost is that this one position keeps the pre-#3950 behaviour,
  *including* the pre-#3950 failure mode — see the review section below, which falsified the
  "inert, never a truncation" wording this paragraph originally carried.

A second net sits under all of it: a regex candidate must actually lex as a regex terminating on
the same line, or the `/` degrades to a punctuator. That is what keeps a wrong decision from
swallowing text instead of merely mis-labelling one character.

### The JSX finding that changed a rule

The first version stopped a `'`/`"` literal at a newline, which ECMA-262 requires. Sweeping the
tokenizer over every `.ts`/`.tsx`/`.mjs` file in the repo turned up exactly one failure — a JSX
attribute value wrapped across two lines, which is legal. The rule was wrong for the language this
scanner actually walks, and only a sweep over real files would have said so. A guard whose
correctness argument is "the spec says" is not finished until it has met the tree.

### `const` pins, and why the KNOWN GAP blocks came out last

With the scanner in place, `#<NAME>` resolves to a `function` declaration *or* a `const/let/var`
initializer (terminated by `;`, a top-level `,`, or the ASI boundary this semicolon-free codebase
relies on). `ATTACHMENT_REF_RE` — hand-cloned four times in the export-graph harness — and
`WORD_RE` are now pinned. The gate was demonstrated on the source, not argued: making group 3
optional (the exact edit the harness's equivalence claim is sensitive to) fails the guard, and
restoring it passes.

The two harnesses' KNOWN GAP blocks were deleted only after that demonstration. Until it ran they
were true statements, and a harness that documents a gap it no longer has is a harness that lies in
the other direction.

## Adversarial review of the above (same session, second agent)

Every claim in the section above was re-run rather than relayed. All of them reproduced: the
scanner self-test (41 assertions at the time), both guard self-tests (`13 pins`, `22 call sites / 0
skipped`), the const gate firing on the group-3-optional edit, and a repo sweep over 1781 files
with zero `ScanError`s. Nothing in the original claim set failed to reproduce. Four things were
nonetheless wrong, three of them the kind of wrong a passing suite cannot report.

### The decision table had a real hole: keywords as property names

`REGEX_PRECEDING_KEYWORDS` was consulted for *any* identifier token, including one that is a
property name. So `obj.in / y / z`, `obj.return / y / z`, `map.delete / y / z` and `obj?.of / y / z`
all lexed `/ y /` as a regex literal and desynced from there — the same shape as #3950 itself, a `/`
mis-decided as a regex swallowing whatever sits between it and the next `/` on the line, quotes and
braces included. Property position is the one place a reserved word is legally a plain identifier,
so it is the one place the keyword rule must not fire. Fixed by marking identifiers that directly
follow `.` (which also covers `?.`, whose `.` is the preceding punctuator) and returning DIVISION
for them. Not live in this tree — a sweep found zero `.keyword /` occurrences — which is exactly the
status #3950 had when it was filed.

`of` remains undecidable and is now documented as limitation 6: it is the only non-reserved member
of the set, so `for (x of /re/)` and `const of = 4; of / 2 / 3` cannot both be lexed correctly
without a parser. The for-of reading wins; the repo has zero `of` bindings.

### Three assertions were decoration, found by mutating the scanner

Eleven targeted mutations were applied to scratch copies of `js-scanner.mjs` and the self-test run
against each. Eight died. The three survivors named real holes:

| mutation | what survived means |
|---|---|
| `blockClose` hard-wired to `false` | the brace-context stack's **regex-permitting** half was untested — only the `}`→division half had an assertion |
| `<`/`>` flipped to permit a regex | the documented TSX choice was untested in **either** direction |
| the same-line bail removed from `tryScanRegex` | the "second, independent safety net" the header leans on was **entirely** untested |

The third is the instructive one. There *was* an assertion named "a `/` with no well-formed
same-line regex after it degrades to a punctuator" — but its `/` followed an identifier, so
`regexAllowedAfter` rejected it before `tryScanRegex` was ever called. It asserted the identifier
rule, which three other assertions already covered, under the name of the newline rule. A test can
name the right property and exercise a different one; only mutating the code it claims to protect
tells you which.

Nine assertions were added (41 → 50) and all eleven mutants now die.

### The `<`/`>` note over-claimed

The header called the `<`/`>` choice "inert — exactly the pre-#3950 behaviour, never a truncation."
The first half is true and the second is not, and they contradict each other: the pre-#3950
behaviour *was* a truncation. `function f() { const ok = n < /\}/.source.length; return ok }` closes
its bracket scan at offset 32 of 60. The choice is still right — permitting a regex after `<` makes
a one-line `<div>{a}</div><span>{b}</span>` lex `</div><span>{b}<` as a regex and desyncs brace
depth across ordinary TSX, which is far more code than the construct being protected — but it is a
deliberately unfixed corner, not an inert one. Both the header and the paragraph above now say so.

### What held up

- **Fail-closed is really fail-closed.** Tested by feeding each guard a genuinely unscannable file
  and reading the exit code, not by reading the code: `check-set-property-args` exits **1**
  (`src/…:1 — unterminated '…' string literal`), `check-mutation-harness-clones` exits **1**
  (`could not be scanned for pin markers`). Neither treats "cannot scan" as "nothing to check".
- **The guards genuinely exercise the fix.** Neutering `regexAllowedAfter` to always return `false`
  reddened the scanner self-test (3), the clone guard's self-test (5, exit 2), the setProperty
  guard's self-test (3, exit 2) *and* the live tree (exit 1). No half-covered pair here — the
  library and both call sites all move together.
- **All 13 pins** resolve to a real path and symbol and match. Both new const pins gate: the
  group-3-optional edit to `ATTACHMENT_REF_RE` and the `_`-dropped edit to `WORD_RE` each exit 1
  naming their own pin, the other eleven stay green, and restoring returns exit 0 with `git diff
  src/` empty.
- **The KNOWN GAP deletions are true.** Both blocks claimed the const "is NOT itself pinned". Both
  are now pinned *and* demonstrated to gate, which is the stronger of the two readings.
- **`PeerListItem.tsx:93` is what the sweep said it was** — a genuine double-quoted JSX attribute
  value spanning lines 93–94 (`className="device-peer-item …\n  … active:bg-accent/70"`), not a
  template literal and not JSX text. The rule was dropped for a real reason. Worth recording that
  the old `skipString` did not stop at newlines either, so this is inherited behaviour rather than a
  relaxation — and that the old one returned silently on an unterminated string where the new one
  throws.
- **Security.** No `eval`, no dynamic `import()`, no `child_process`; `js-scanner.mjs` imports only
  `realpathSync`, and only for its own entry-point check — it never opens a scanned file. Traversal
  is blocked twice (lexical `path.relative`, then a realpath symlink-containment check on a held
  fd), and an absolute pin path is neutralised by `path.join` rather than followed.

## Round two: `agaric-reviewer` CHANGES_REQUESTED on PR #3969

One blocking finding and six notes. The blocking one is the headline, and not because
of its size.

### The PR's own subject defect, reappearing inside its fix

`findStatementEnd`'s ASI test asked only whether the *next* token could continue the
expression. It never asked whether the *previous* one had left the expression
incomplete. So after a line ending in a binary operator, a newline, and then a string,
`continues` was false and the scan returned at the operator. Reproduced against the live
shape the reviewer named, `src/lib/__tests__/export-graph.test.ts`'s `REPORT_PREAMBLE`,
before changing anything:

```
kind    : const
reason  : null
>>>const REPORT_PREAMBLE =
  'Agaric export report\n' +<<<
hash    : 83e0af8e00e54db4818110d1ef53bdf4b2d1f187972928b115deda44843f4d41
```

Five lines of declaration, one line hashed. No `ScanError`, no `unbalanced`, no message —
a stable hash over a truncated prefix. Two initializers differing only after the first
operator produced byte-identical extractions and the identical digest
`ad997646a3e3…`, which is the #3950 signature word for word: *two versions differing by
real code after X hash identically, so genuine drift lands with the pin green.*

That is the thing worth recording. This PR exists to close a fail-open in a
bracket scanner. Its own new code path — the `const`-pin extractor, the feature the PR
adds — reintroduced the same fail-open in a different construct, and every suite stayed
green because the only multi-line assertion in the file (`foo(\n 1,\n 2,\n)`) sits at
bracket depth > 0, where the ASI branch never runs. The defect class the work is about is
the defect class the work is most likely to commit. A fix is not evidence that its own
shape has been ruled out; it is a reason to go looking for it.

The fix makes the boundary test look both ways. A punctuator that is not `)`, `]`, `}`,
`++` or `--` cannot end an expression, so the newline after it is not a boundary.
Keywords are deliberately excluded: `return`, `throw`, `yield`, `break` and `continue`
are restricted productions where ASI genuinely does fire, and treating a trailing keyword
as "incomplete" would be wrong exactly where it matters. Running out of input still
dangling on an operator returns `null` — fail-closed, because there is no defensible end
offset. `REPORT_PREAMBLE` now extracts all five lines and the two drifted variants hash
differently.

### Notes 1 and 2, both fail-open

**Note 1** — the property-name correction from round one reached `regexAllowedAfter` and
stopped there. The paren and brace context stacks consulted `CONTROL_HEAD_KEYWORDS` and
`BLOCK_PREV_KEYWORD` without it, so `obj.with(a, b) / y / z` desynced: the `)` carried
`controlHead: true` and permitted a regex. `otelContext.with(...)` is live at
`src/lib/observability/tracer.ts:249`, inert only because no `/` follows. A correction
applied at one of three call sites is a correction that has not been applied.

**Note 2** — an unterminated `/*` was the one unterminated construct that failed open.
It was consumed to EOF as a comment, so `stripComments` blanked the whole tail of the
file. The RED output before the fix, showing both halves:

```
FAIL - an unterminated block comment does not blank the rest of the file:
       "const a = 1\n               \n           \n           \n"
FAIL - a deficient call AFTER an unterminated block comment is still caught:
       {"violations":[],"literalCount":0,"skippedCount":0,"scanError":null}
```

A call missing `value_bool`, reported clean.

The obvious fix — raise `ScanError`, matching the other three unterminated constructs —
is wrong, and the tree said so within one run: it turned the live guard red on
`src/components/search/FilterHelperPopover.tsx:262`, which is
`<span>path:Journal/*</span>`. A glob in bare JSX text. Valid source, no defect, and
raising there would block every commit repo-wide. So the `/*` **degrades** instead: with
no closer it is not a comment at all, and its `/` and `*` become ordinary punctuators.
That is the same move the regex lexer already makes for a `/` that opens no well-formed
literal, and it closes the fail-open without inventing a false one. The first fix that
removes a symptom is not automatically the right fix; running it against the real tree is
what separates them.

### Notes 3–6

- **4** (fixed): `fnRe`/`constRe` used `(?:^|\n)\s*`, and `\s` matches indentation, so a
  function-local `const` was extracted and hashed as though it were the module-level
  symbol the pin names — despite the header and docstring both saying "top-level". Now
  anchored at column 0. All 13 pins still resolve.
- **5** (fixed): `CALL_RE` ran over text with comments blanked but strings intact, so a
  `commands.setProperty(` inside a string literal was analysed as a real call and
  reported four missing keys for a call that does not exist. Call sites are now
  discovered in a strings-blanked view and parsed from the unblanked one; offsets match
  because both transforms preserve length.
- **3** (fixed defensively, no reachable trigger found): a `ScanError` from
  `splitTopLevelCommas(argsInner)` or `parseObjectLiteral(args[2])` carries an index
  relative to that substring, so the reported line would be near 1. Re-based onto the
  call site. Recording plainly that no input reaching it was constructed: the top-level
  `stripComments` lexes the whole file first, so the inner calls only ever receive
  already-validated, bracket-balanced substrings, and the two views agree on every
  division-vs-regex decision at a segment boundary. The fix is correct by construction
  rather than demonstrated, and is written down as such rather than claimed as covered.
- **6** (documented): limitation 2's blast radius changed when this module landed. The
  old scanners mis-scanned one file silently; this one raises, and
  `check-set-property-args` exits 1 for the whole tree — so one contraction in bare JSX
  text stops every commit until escaped. Right default for a drift gate, but the cost is
  "the gate stops", not "one file is mis-scanned", and the note now says so.

### Coverage

Every new assertion was demonstrated RED before being trusted — 11 in the scanner, 2 in
the clone guard, 3 in the setProperty guard — and the six mutations covering the new
code (ASI both-ways, `EXPR_TERMINAL_PUNCT`, both `propertyName` stack guards, the block
comment) all die. Assertion counts: 50 → 65 scanner, 37 → 40 clones, 24 → 28 setProperty.
Repo sweep unchanged at 1781 files, zero `ScanError`s.

## Round three: the approving review's seven notes

#3969 was approved with seven notes; four were real gaps, one was inert-but-unstated, one
was the PR body's stale count (the coordinator's), and one was a stated verification limit.

### Note 1 — the assertion that could not fail

Brace classification ignored TS return-type annotations. For `function f(): void { … }`
the token before the body `{` is the ident `void`, which is in neither `BLOCK_PREV_PUNCT`
nor `BLOCK_PREV_KEYWORD`, so the body was pushed as an *object literal* and its `}`
carried `blockClose: false`. The decision-table row this PR added an assertion for —
"`}` → REGEX if that `{` opened a BLOCK" — therefore did not fire for the most common
function shape in a TypeScript codebase.

What makes this worth writing down is *why* it survived two rounds of adversarial review,
including a mutation sweep that specifically hunted for decorative assertions. The
assertion covering that branch was:

```js
regexes('function f() { g() }\n/re/.test(s)')
```

Untyped. It passes with the bug and without it. Round one asked of each assertion "what
production change would redden this?" and this one had a real answer — hard-wiring
`blockClose` to `false` does redden it, which is exactly how the branch got its assertion
in the first place. The question it never got asked was the *complementary* one: "what
production behaviour does this assertion NOT reach?" A mutation sweep answers the first
question. It cannot answer the second, because a mutant that only breaks the typed path
still gets killed by some other assertion, and a fixture that is unrepresentative of the
codebase is invisible to every mutant. Coverage of the *branch* is not coverage of the
*inputs that reach it*.

Fixed with a `returnTypeContext` flag: a `:` directly after a `)` opens a return-type
annotation, and the next `{` at generic-depth 0 is the body. Ternary `:` is excluded (a
`?` that is neither `?.` nor `a?:` opens one), so `c ? f() : { a: 1 }` stays an object
literal, and generic depth is tracked so the type-literal brace in `): Array<{ a }> {`
does not consume the annotation before the real body brace. Assertions cover five typed
signatures, a class method, both regression guards, and the nested-generic shape — the
last added only after a mutation showed the angle-depth guard had no assertion at all.

### Note 4 — a `>` at a line end is undecidable, so it now refuses

`EXPR_TERMINAL_PUNCT` had no `>`, so `leavesExpressionIncomplete` called a trailing `>`
incomplete and `findStatementEnd` ran past the newline; `const El = <div>x</div>`
over-extended into the next statement. The obvious fix — add `>` to the terminal set —
is wrong in the dangerous direction: it truncates `const x = a >\n  b` into a stable hash
over `a >`, which is the fail-open of round two, reintroduced for the third time.

Both readings are real and a lexer cannot tell them apart, so the case now returns `null`
and fails closed. A JSX-valued `const` is unpinnable rather than mis-pinned. That is the
third time in this PR that the tempting fix for a noisy symptom was a silent fail-open,
and the third time the right answer was to refuse.

### Notes 3, 2, 5

- **3** (fixed): `blankStringsAndTemplates` blanked `${…}` interpolations along with the
  literal text, so a real `commands.setProperty(…)` inside one was invisible to call-site
  discovery — not checked, and not counted as skipped either. Invisible, in the one guard
  whose thesis is that a call nobody checked must never read as clean. Blanking now
  recurses: literal chunks are blanked, interpolated *code* is preserved and itself
  blanked for nested strings. The call is now genuinely checked rather than merely
  surfaced.
- **2** (fixed rather than stated): `0xE+1` lexed as one number token that swallowed the
  `+`, because the exponent-sign rule never checked the radix; `1.5.toFixed(2)` ate the
  member access entirely, because the `.`-consuming loop allowed a second dot. Both were
  inert for bracket matching and for the division-vs-regex decision, and the note offered
  "fix it or state it" — but round two's own criticism of the `/*` handling was that
  leaving something neither fixed nor stated is the worst option, and both fixes were four
  lines. Four positive controls (`1e-3`, `0x1F`, `1_000n`, `.5`) guard the change.
- **5** (fixed): `check-set-property-args`'s prek `files` regex covered `src/**` and
  `scripts/lib/js-scanner.mjs` but not the guard script itself, so a commit touching only
  the guard ran its self-test and never re-evaluated the live tree. Closed with the
  `metric-provable` shape (name the script in `files`) rather than
  `mutation-harness-clones`'s `always_run = true`: `always_run` re-walks all of `src/**`
  on every unrelated commit, while naming the script keeps the live re-check scoped to
  exactly the commits that can invalidate it.

### Coverage

All 18 new assertions demonstrated RED first — 17 in the scanner, 1 in the setProperty
guard — and the eight mutations covering the new code all die. Counts: 65 → 86 scanner,
40 clones (unchanged), 28 → 29 setProperty. All 13 pins still resolve; sweep still 1781
files, zero `ScanError`s.

## Round four: the input-coverage gap recurred inside its own fix

Five notes on the second approving review. The one that matters is note 1, and what
matters about it is not the bug.

### `??` silently disarmed the fix from round three

Round three added `returnTypeContext` because `function f(): void { … }` — the most common
shape in this codebase — was being classified as an object literal. The ternary-exclusion
logic it shipped with checked, for each `?`, whether the next significant character was
`.` or `:`. But only `=>`, `++` and `--` were lexed as multi-character punctuators, so
`??` arrived as two separate `?` tokens. For each one the next character is neither `.`
nor `:`, so both incremented `ternaryDepth`, nothing balanced them, and the next two `:`
tokens anywhere in the file were eaten as ternary closers — including a `): T {`
return-type colon.

`?? null` is idiomatic here. It appears in this guard's own self-test fixture. So the fix
added specifically to handle the most common shape in the codebase was silently disabled
for most real `.ts` files, from their first `??` onward:

```
no ?? : ["/re/"] blockClose [true]
with ??: []
```

It fails conservatively — the body reverts to object-literal classification and a
following `/` is division, which is exactly pre-#3950 behaviour — so nothing reddened.

### The pattern, stated plainly

Round three's own log entry says: *"Mutation testing answers 'what production change
reddens this?' It cannot answer 'what production behaviour does this assertion never
reach?' … Branch coverage is not input coverage."*

That paragraph was written about the untyped-`function` fixture. The fix it was written to
justify then shipped with the same defect: **no self-test input contained a `??` outside a
string, so the entire `returnTypeContext` block was only ever exercised on inputs that
could not reach its own weakest branch.** Diagnosing a class of blind spot, writing it
down, and immediately reproducing it in the remedy is worth more as evidence than either
bug alone. Naming a failure mode does not confer immunity to it; the check has to be run,
not merely described.

So this round the audit was run as a procedure rather than a resolution. For each block
added in rounds one to three, the question asked was "what input has this never been
given?" — and the answers were written as executable probes, not as prose:

| block | inputs it had never been given | result |
|---|---|---|
| `returnTypeContext` | `??`, `?.`, ternary, `a?: T`, conditional types, optional properties, arrow return types | **`??` fails** — note 1 |
| number lexer | `1e5`, `0.5e-3`, `1..toString()`, `0b1010+1` | all pass |
| template blanking | empty `${}`, escaped backtick, template inside a string | all pass |
| `tryScanRegex` same-line net | backslash before a newline, same inside a character class | **both fail** — note 2 |
| `EXPR_TERMINAL_PUNCT` | line ending in a template, a regex, a `)` | all pass |

The audit independently reproduced both reviewer findings and cleared everything else,
which is the outcome that makes it worth keeping as a step rather than an anecdote. It
also found a second manifestation of note 2 the review did not list — the same
backslash-newline hole inside a regex character class.

### The other four

- **2** (fixed): `tryScanRegex`'s escape branch was tested BEFORE the newline guard, so a
  backslash immediately before a newline stepped over it and the scan kept hunting on
  later lines — a hole in the "terminates on the SAME LINE" property the header presents
  as the second, independent safety net. A regex literal may contain neither an escaped
  nor an unescaped line terminator, so the escape now refuses at a newline.
- **3** (fixed): two skip paths (`closeParenIdx === -1`, `args.length < 3`) continued
  without incrementing `skippedCount`, so an unparseable call site never appeared in the
  `OK: N … (M skipped)` summary at all. Both are counted now, and the code matches the
  header's claim that an undecidable construct is never a silent skip.
- **4** (reworded): the JSX-apostrophe note ranked its outcomes backwards. `scanQuoted`
  does not stop at a newline, so the apostrophe *usually* pairs with a later unrelated `'`
  and silently consumes everything between — the same desync class #3950 exists to close.
  `ScanError` and a repo-wide gate stop is the *lucky* case, and only occurs when no later
  quote exists. The note now names the likely outcome first.
- **5** (fixed, closes #3971): the `): { a: string } {` fail-open — the one shape that
  hashed a signature-only prefix and stayed green through arbitrary body drift — is now
  detected and refused with reason `ambiguous-return-type`, rather than documented and
  hand-audited per new pin. A union like `): { a } | { b } {` defeats any
  skip-one-literal heuristic, so refusing is the honest answer and correct extraction
  would need a real type grammar. Generic (`Array<{…}>`), plain and untyped return types
  all still extract their full bodies.

### Coverage

All 11 new assertions demonstrated RED first — 8 scanner, 2 setProperty, 1 clones — and
the six mutations covering the new code all die. Two of those mutation runs initially
reported false kills: the guard scripts import `./lib/js-scanner.mjs` relatively, so a
mutated copy in a scratch directory dies of `ERR_MODULE_NOT_FOUND` rather than of any
assertion. A mutant that "dies" because the harness could not load it proves nothing, and
that is worth remembering the next time a mutation sweep looks unanimously green. Re-run
inside `scripts/`, all six die on real assertions. Counts: 86 → 96 scanner, 40 → 42
clones, 29 → 31 setProperty. 13 pins resolve; sweep 1781 files, zero `ScanError`s.

## Round five: both must-fixes were the same class, and one had a residual

CHANGES_REQUESTED with two MUST FIX items, both silent truncation — a stable sha256 over
a prefix, no `ScanError`, no `unbalanced`, pin green through arbitrary drift. The reviewer
could not execute node, so both came from reading. Both reproduced exactly.

### MUST FIX 1 — `findStatementEnd` split on a comma inside generic type arguments

Verbatim, against the live file the review named:

```
reason  : null
>>>const prefetchMap = new Map<string<<<
hash    : b0f72f93b10dd86640cf512ce2adf35f4a686a3cf6086419ad93a89c08695f59
```

Changing the value type left the hash byte-identical (`b0f72f93…` both sides). The damning
detail was the reviewer's: `extractConstAt`'s own pre-`=` scan has tracked `angleDepth`
since #3953 landed, for exactly this reason. `findStatementEnd` simply did not — an
oversight, not a chosen corner, and ~20 top-level consts in `src/` already have the shape.

Fixed by tracking angle depth alongside `()[]{}` depth. `<` is genuinely ambiguous between
a generic and a comparison, so there is a backstop: if a comma was skipped on the strength
of a `<` that never closes, the `<` was a comparison and the skip ate a real declarator
boundary, so that combination returns `null`.

### MUST FIX 2 — the #3971 refusal covered the half its own docstring called hard

The probe skipped whitespace after the parameter list, tested for `:`, skipped whitespace,
and refused only if the very next character was `{`. The docstring three lines above named
`): { a } | { b } {` as the shape that defeats any skip-one-literal heuristic — and the
implementation covered only the arrangement where the literal comes first. For
`): Foo | { a: string } {` the probe saw `F`, declined, and the body-open loop took the
literal's brace as the body:

```
A extracted: "export function f(): Foo | { a: string }"
B extracted: "export function f(): Foo | { a: string }"
*** FAIL-OPEN: identical hash across arbitrary body drift ***
```

So what I reported last round as closing #3971 closed half of it, and the half it missed
was written down in the docstring directly above the code. Replaced with a
position-independent test: find the candidate brace, find its match, and if what follows
continues a TYPE (`{`, `|`, `&`, `[`) rather than ending the declaration, the candidate
was a type literal and the real body is further right — refuse.

### The residual the audit found, that neither review did

Running the audit-as-executable-probes pass over return-type shapes — the same procedure
that round four adopted after `??` — turned up a third instance the reviewer had not
listed: `): (x: { a: string }) => void {`. The body-open loop tracked angle depth but not
PAREN depth, so a literal inside a function-type parameter list was taken as the body
open. Same silent-truncation class, `driftVisible=false`.

It is worth noting what the right fix was, because my first assertion demanded the wrong
one. I wrote it expecting a refusal, by analogy with the union case. But a literal inside a
parameter list is not ambiguous at all — tracking paren depth makes it extract *correctly*.
Refusing would have been a worse outcome dressed as rigour. The assertion moved to a
positive control asserting full extraction with drift visible. Fail-closed is the right
default when a thing is undecidable; it is not a substitute for deciding when you can.

After the fix the return-type audit reports **0 silent truncations** across 14 shapes, and
the const-pin audit **17/17**.

### Non-blocking notes 1–4

- **1** (fixed): an object-literal KEY colon decremented `ternaryDepth`, so in
  `cond ? f({ a: 1 }) : { b: 2 }` the `a:` spent the ternary's budget, the real ternary
  colon then looked like a return-type colon, and the ALTERNATIVE's object literal was
  classified as a block — `blockClose=[false,true]`, and a following `/re/` lexed as a
  regex. This is the opposite error from the one round three's `returnTypeContext` fixed.
  Ternary colons are now matched at the bracket depth their `?` opened at. It did not
  reproduce on my first fixture (an intervening `=` clears the context) — worth recording,
  because "it didn't reproduce" nearly became the finding.
- **2** (fixed): every `null` from `findStatementEnd` was reported as "unbalanced
  brackets", so both DELIBERATE fail-closed rules surfaced as bracket errors naming
  neither cause nor remedy. My first attempt re-derived the reason in the guard by
  inspecting the source — and promptly misclassified a genuinely unbalanced initializer as
  a dangling operator. That is a second copy of the rule, which is the exact failure this
  entire PR exists to remove. Replaced with `findStatementEndDetailed`, which returns the
  reason from the code that makes the decision.
- **3** (fixed): `realpathSync(process.argv[1])` ran unguarded at module evaluation in all
  three scripts, so an unresolvable `argv[1]` threw `ENOENT` before any export existed —
  confirmed by importing with a bogus `argv[1]`. Now `try`/`catch` → `false`.
- **4** (fixed): the `findStatementEnd` docstring said it stops at a top-level comma with
  no mention of generics; it now states how a comma inside angle brackets is distinguished.

### Coverage

All 9 new assertions demonstrated RED first — 6 scanner, 3 clones. Six mutations cover the
new code; one initially SURVIVED (the suppressed-comma backstop reached at end of input
rather than at an ASI boundary is a separate return path, and no fixture reached it), so an
assertion was added and it now dies. Counts: 96 → 104 scanner, 42 → 54 clones, 31
setProperty. 13 pins resolve; sweep 1781 files, zero `ScanError`s.

**#3971 status:** the audit now reports zero silent truncations across every return-type
shape probed, so the refusal is complete as far as testing reaches. Two independent
arrangements of the same tokens were missed on the first attempt, though, so "complete"
here means "no probe finds one", not "proved exhaustive".
