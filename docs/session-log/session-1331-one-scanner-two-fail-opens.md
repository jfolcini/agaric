# Session 1331

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
  not code anyone writes. The cost is inert: the `/` becomes a punctuator, which is exactly the
  old behaviour.

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
