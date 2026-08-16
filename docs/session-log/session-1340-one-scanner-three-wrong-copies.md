# Session 1340

## Six implementations of one problem, and five of them wrong

The finding is not any of the individual bugs. It is the count.

"Skip the parts of a file that are not code" is one problem. Every JS-side guard in this repo that
needed it wrote its own answer, and **every answer written outside `scripts/lib/js-scanner.mjs` is
wrong in the same direction**: no string-literal awareness, so a block-comment opener sitting inside
a string plus any terminator later in the file blanks the code between them, and the guard reports
clean on source it never parsed. Fail-open, in guards whose whole job is to notice one line.

#3991 was filed on the belief that there were three such implementations, and asked whether a
*fourth* existed "because nobody looked for the third". There are three more. They are byte-identical
to each other and to the copy this session deleted:

| implementation | verdict |
| --- | --- |
| `scripts/lib/js-scanner.mjs` | correct — the sanctioned one |
| `check-wdio-driver-gate.mjs` `stripTsComments` | fail-open, **deleted this session** (#3990 item 1) |
| `check-raw-invoke.mjs` `stripComments` | fail-open, filed as #3993 |
| `check-tauri-import-baseline.mjs` `stripComments` | fail-open, filed as #3993 |
| `check-persist-hooks.mjs` `stripComments` (+ its own `skipQuoted`) | fail-open, filed as #3993 |
| `opaque_prefix_len` (Rust, `observability.rs`) | off-by-one on `'\''` — #3988, owned elsewhere |

`check-bulk-equivalence.mjs`'s `blank(src, { blankStrings })` is *not* in that list: it is a
purpose-built lexer offering a structural-vs-content view `js-scanner` does not expose, and it is
string-aware in both modes.

The header of `js-scanner.mjs` now says, at the top, that it is the sanctioned implementation, names
every copy found, and says to extend it rather than start a seventh.

Issues #3991, #3990, #3984. Follow-up filed: #3993.

### #3990 item 1 — the fail-open, reproduced before it was fixed

`stripTsComments` ran `/\*[\s\S]*?\*\//g` with no idea what a string was. `wdio.conf.ts:249`
**already** contains `'./e2e-tauri/**/*.e2e.ts'`, whose opener the pass matched — harmless only
because it self-terminates. Widen the glob so it does not, add any JSDoc block below `capabilities`,
put a real `browserName` in between:

```
  specs: ['./e2e-tauri/**'],
  …
      browserName: 'chrome',
      'tauri:options': {
```

```
$ node scripts/check-wdio-driver-gate.mjs --conf wdio.probe.ts
check-wdio-driver-gate: ok (no browserName capability; remote driver configured)
exit=0
```

The guard exists to notice exactly that line, and it reported ok. After pointing it at
`scripts/lib/js-scanner.mjs` and deleting the private copy, the same file exits 1 naming
`no-browser-session`.

### #3990 item 2 — evidence from code WDIO never reads

`remoteDriverEvidence` matched `port:` / `hostname:` / `path:` / `user:`+`key:` anywhere in the file,
and `HOSTNAME_RE.exec` read only the first match. `definesRemoteDriver(options)` is handed `config`
and reads its **top-level** options, so gate 2 now scans the exported `config` object literal with
everything nested deeper than one level blanked, reads **every** match, and takes the last (duplicate
keys resolve to the last one in JS).

Gate 1 deliberately stays file-wide. The two gates fail in opposite directions: a stray `browserName`
outside `config` makes gate 1 *fire* (a false alarm), a stray `port` outside `config` would make gate
2 *pass*. Each is scoped toward its own safe side, and the asymmetry is argued in the file.

A source with no readable `export const config` is now `UnscannableConfError` → exit 2, not "the
remote-driver gate is broken". "I could not read it" is not a verdict about the config.

### #3990 items 3–5 — `verify-ci-equivalent.sh`

* **3.** The "NEVER skipped" list said the opposite of what the code does: `SKIP=gitleaks git push`
  genuinely omits gitleaks from Phase A via the #3968 union. The comment now claims what is true —
  never skipped *by category* — and points at the ⚠ line and the PASS banner that announce the rest.
* **4.** `st_clobber_lines` piped through `grep -v` and numbered second, so it reported positions in
  the comment-stripped stream. Reproduced: a clobber on file line 10 announced as `1:`. The prefilter
  is **gone**, not reordered — the `^` anchor is what excludes the prose, and the comment crediting
  the filter was a stale justification. Case 25 now drives that exclusion against a fixture and pins
  the line number against a nine-comment-line fixture, which a one-line fixture could not do.
* **5.** `IFS=',' read -ra` reads one *line*, so `SKIP=$'gitleaks\ntypos'` composed to
  `vitest,cargo-test,gitleaks` and warned about `gitleaks` alone — the run omitted a hook it did not
  name. Now `IFS=$',\n' read -r -d ''`.

### #3984 — four context leaks in the scanner, one live

1. **`ternaryStack` entries were never discarded when their bracket closed.** Live, and measured on
   the real file: `src/components/help/SearchHelpDialog.tsx:197-200` renders `(?=…)`, `(?!…)`,
   `(?<=…)`, `(?<!…)` as bare JSX text. An instrumented run over that file shows four pushes at
   depth 5 and a stack of `[5,5,5,5]` at end of file. With the file's own second `<Trans
   components={{…}}>` idiom holding a typed function expression, the `): ReactNode` colon landed at
   that depth and was eaten: `blockClose=false` where the control (same file, those four lines
   deleted) gives `true`. Fixed by discarding entries above the depth a closer returns to. The
   comparison is strictly `>`, pinned by `const v = c ? (a) : { b: 2 }` — `>=` would throw away a
   live ternary's entry and reintroduce the error the stack was added to stop.
2. **`returnTypeContext` was never cleared by the `}` closing a member list.** `interface I { f():
   void }` left it set, so `export default { a: 1 }` — an object literal whose preceding token clears
   nothing — became a block. Cleared now when a closer drops below the depth the annotation was
   opened at.
3. **`EXPR_TERMINAL_PUNCT` omitted `!`.** `const A = cache.get(k)!` read as incomplete, so
   `findStatementEnd` extracted `cache.get(k)!\nconst B = 2`. Fail-closed, but a false positive
   whenever the neighbour changes. `!=`/`!==` lex as `!` then `=`, so the two readings do not collide
   — pinned from both sides.
4. **`tokenize` read `src[i + 1]` unbounded by `to`.** `tokenize('a=>b', { to: 2 })` produced a `=>`
   spanning `[1,3)`. Unreachable via an invariant of the only sub-range caller, with nothing in the
   tokenizer pinning it.

### The audit, and what it could not reach

Round four's executable-probe audit missed leak 1. This round drove **25 mutations of the
context-clearing paths specifically** — every push, pop, discard and clear of `ternaryStack`,
`returnTypeContext`, `returnTypeAngleDepth`, `returnTypeDepth`, `parenStack` and `braceStack` — and
ten survived the 104-assertion suite:

* the brace-consume and the `>` decrement that lets it fire (every existing typed-body assertion
  writes `{ g() }`, whose `(` clears the context by itself);
* both context stacks replaced by a **peek** instead of a pop — every existing assertion used a flat
  shape where the most recent push is also the matching one;
* `;`, `,` and `=>` individually removed from the clearing set — no input had ever reached the
  annotation-ends-*without-a-body* path;
* the `?.`-followed-by-a-digit check (`a?.5:b`), which had a comment and no assertion;
* `(`/`)` individually, `=`, and the `a?: T` optional-marker exclusion.

Assertions were added for the first four groups; 104 → 126. The last group is reported rather than
asserted, because those mutations are **unfalsifiable by construction**, and inventing an input that
only looks like a counterexample would be worse than saying so:

* `(` and `)` are a pair — any input containing one contains the other, so only dropping **both** is
  detectable, and that is what the added assertion covers.
* `=` needs a `)`-then-`:` annotation followed by an `=` with no `=>`, `;`, `,`, `(` or `)` between,
  which TS cannot produce.
* the `a?: T` exclusion is now **redundant**: only whitespace may sit between the `?` and the `:`, so
  they are always at the same bracket depth and a pushed entry would be popped by that very colon.
  It mattered before the stack was depth-matched. Recorded in the file so the next audit does not
  spend a round hunting for the distinguishing input.

A newline-trailing `SKIP` is the same shape one level down in the shell script: the empty-entry drop
and the whitespace trim each independently guarantee it, so no assertion there could fail either.
Said in the file rather than decorated with one.

### Counts

| suite | before | after |
| --- | --- | --- |
| `js-scanner.mjs --self-test` | 104 | 126 |
| `check-wdio-driver-gate.mjs --self-test` | 15 | 21 |
| `check-mutation-harness-clones.mjs --self-test` | 56 | 56 |
| `check-set-property-args.mjs --self-test` | 31 | 31 |
| `verify-ci-equivalent.sh --self-test` | 28 | 31 |

`npx oxlint scripts/` clean; the `ScanError` sweep over every `.ts/.tsx/.js/.jsx/.mjs/.cjs` file in
the tree (1801 today) still raises zero.
