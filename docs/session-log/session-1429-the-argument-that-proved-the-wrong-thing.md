# Session 1429 — the argument that proved the wrong thing

Three reviewer findings left over from #4510, #4515 and #4516, all merged. Each was a claim
wider than the code behind it. Two of the three turned out to be worse than the review said,
and the third produced the clearest lesson: an argument that sounds like evidence and answers
a different question.

## The evidence that was about the tests, not the code

`resolveStatus` answered from `deleted` alone and did not consult the `resolved` flag #4238 had
just added. That is safe only while every writer of `resolved: false` also sets `deleted: true`,
and the flag's docblock promised more than that — it said a future writer flagging a placeholder
"cannot leak whatever it parked in `title` into a chip". A `{ resolved: false, deleted: false }`
sentinel would have rendered an *active* chip carrying the unresolved label.

Deriving status from the flag is a behaviour change, so it needed proof it was inert. The
argument offered was: with the derivation disabled, **288 of 291 pre-existing assertions still
passed**, and only the three new pins flipped.

That is a real measurement and it does not show what it appears to. Assertions that pass either
way prove they do not *exercise* the change — a fact about the test corpus, not about
production. It rules out one hazard (a pre-existing test silently depending on the old
behaviour) and says nothing about whether the app can reach the shape.

The inertness claim needed an enumeration instead, and review did it: one production writer of
`resolved: false`, and it sets `deleted: true`; all sixteen `set` call sites pass three
arguments so none supplies the flag; six of seven `batchSet` sites omit it and fall to the
default; `preload`'s merge arms write `resolved: true` literally; no `setState` outside tests, no
persist middleware that could rehydrate a pre-#4238 entry without the field. Only then is
`{ resolved: false, deleted: false }` unreachable.

Worth keeping the distinction: *no test covers this* and *no code path reaches this* are
different claims, and only the second licenses a behaviour change.

## Absent is not the same as answered

The derivation forced a decision the store had never had to make. An **absent** key now means
something different from an explicit `resolved: false`: absent stays optimistic and renders
active, because the title may still be in flight; the flag means the lookup happened and
returned nothing.

That split reads arbitrary until you notice a second surface already made the same ruling.
`useBacklinkResolution` keeps a hook-local attempted set and maps attempted-but-absent to
deleted, deliberately not parking in the shared store (#2635). So two writers, two
representations of "I asked and got nothing", both rendering deleted — and the store's default
is right precisely because only a caller knows whether it has asked.

The docblock now says that. Review added five lines because two of its sentences read in tension
in isolation, with the reconciling fact ten lines further down under a different heading — a
reader landing mid-block could reasonably conclude the two renderings diverge for no reason.

## A guard that covered the safer class and missed the exposed one

#4516's ratchet forced every React node view into a classification table. Review noted it did not
cover mark views. Checking the vendored source showed the gap is the wrong way round from what
you would guess:

- `MarkView.ignoreMutation` carries the first guard but not the leaf/atom guard that protects
  node views.
- `@tiptap/react`'s `ReactMarkView` builds its content host **unconditionally**, so the first
  guard cannot fire either.

Node views have two escape hatches; mark views have zero. So the rule for mark views has to be
unconditional, where the node-view rule is conditional — the enumeration had been guarding the
safer class and ignoring the exposed one. There are no mark views in this repo today, which is
why nothing was broken and also why nothing would have caught the first one.

There is a trap waiting for whoever adds it. The existing helper matches
`[data-node-view-content-react]`, but tiptap stamps a mark view's content host
`data-mark-view-content`, and the helper answers "ignore this" when it finds no match. Pasting it
onto a mark view would silently drop genuine content edits. The table now carries a content-host
selector per entry so an author has to confront that rather than inherit it.

## An empty table is satisfied by a broken scanner

The mark-view table is empty, which makes every assertion over it trivially true — including if
the scanner that populates it has quietly stopped working. That is the same shape as a test that
cannot fail, arriving by a different route.

The fix is a liveness test that runs a synthetic mark view through the same functions and
requires them to see it. Review proved it works by blinding each of the three scanners in turn:
two of them redden **only** the liveness test, every other mark-view assertion staying green —
which is exactly the failure the liveness test exists to catch, demonstrated rather than argued.

## Two messages one matcher could not tell apart

The third note was a documented case no arm exercised. `loadPathAliasMap` throws for a `paths`
that exists but has no modelled entry — a legal `"@/*": ["./*"]` lands there — and the only
nearby self-test arm wrote `{compilerOptions: {}}`, which throws a *different* error. Its matcher
was satisfied by both messages, so the arm stayed green whichever fired.

Both halves needed work: a new arm for the unmodelled shape, asserting text unique to it plus a
negative assertion that the *other* message is absent, and a tightened matcher on the old arm.
Proven by giving both throws the same text: the tightened arm fails, and with the old matcher
restored the same mutation passes. The tightening is load-bearing, not cosmetic.

## Verification

Doc-code-paths self-test at 157 arms, green, including the new one; guard green on the real tree.
507 tests across seven suites, `tsc -b` clean, `oxlint` and `oxfmt --check` clean on all eight
changed files.

Every fix falsified against a copied backup with the restore proven byte-identical.

Two residuals recorded rather than fixed, both inert for the same one-writer reason: a fifth
reader of the flag (`useTagClickHandler`'s fast path) that would navigate using a parked label,
and the fact that the earlier audit's list of direct `.title` readers was one entry short.
Neither is wrong today; both are worth an issue if a second sentinel writer ever appears.
