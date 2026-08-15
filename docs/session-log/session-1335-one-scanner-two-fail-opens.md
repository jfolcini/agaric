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
