# Session 1596 — the `tauri.ts` default wrappers, one verdict each (#4412)

## Why this was its own issue

Ten wrappers applied `?? null` defaults before calling `commands.*`. Deleting
one is not a mechanical migration: omitting a defaulted field at a call site is
a silent behaviour change, not a compile error. The field simply arrives as
`undefined` instead of the default the wrapper supplied, and `tsc` says nothing.
So the safety argument had to come from reading the Rust, per wrapper.

Seven of the twelve originally listed still existed; `addAttachmentWithBytes`,
`restoreBlocksByIds`, `purgeBlocksByIds` and `listPageLinks` left with
`attachments.ts` / `links.ts` in earlier slices.

## The verdicts

| Wrapper | Class | Why |
|---|---|---|
| `listBlocks` | 1 — deleted | `ListBlocksRequest` (`commands/mod.rs`) has no `#[serde(default)]` on any field, so specta emits them REQUIRED — omission is a `tsc` error, not silence |
| `batchResolve` | 1 — deleted | `batch_resolve` takes two required args and has no defaults at all |
| `queryByProperty` | 1 — deleted | `QueryByPropertyRequest` likewise carries no `#[serde(default)]` |
| `setProperty` | 1 — deleted, but see below | all five of `SetPropertyArgs`' fields ARE `#[serde(default)] Option<T>` — and that is not the whole contract |
| `filteredBlocksQuery` | 1 — deleted | every default agrees: `vec![]` for the list fields, and `""` mapping to `=` / `OR` in `property_value_predicate_sql` |
| `searchBlocks` | 2 — kept | see below |
| `searchBlocksPartitioned` | 2 — kept | same |

The two search wrappers are the one real divergence. `SearchFilter::scope` is
`#[serde(default)]` over a `SpaceScope` whose `Default` is `Global`, while the
wrapper's default is `requireActiveScope` — the opposite. An omitted `scope`
silently searches EVERY space.

The narrowing comment says a class-2 default should be pushed into the Rust
signature and the wrapper then deleted. That is not available here: `Global` is
a deliberate, documented choice on the Rust side (its doc comment names these
very wrappers as the real callers), and the value the frontend wants is the
user's *active* space, which the backend cannot know. So this is the issue
body's other branch — keep a named helper — with the reason recorded at each
definition.

## `setProperty` is the one the guard caught

Reading serde alone said class 1: all five value fields are
`#[serde(default)] Option<T>`, so a missing key deserialises to `None`, exactly
what the wrapper's `?? null` sent. The migration dropped the keys on that
reasoning and `check-set-property-args` (#3127) refused the commit at five call
sites: the backend contract wants all five present with exactly one non-null,
because an omitted key drops whatever was previously stored.

Both readings are true at their own layer, and the serde one is the one that
loses. The verdict survives, but for a different reason than the audit gave:
`setProperty` is safe to delete because a guard already enforces the contract
the wrapper was enforcing — the ladder's "the codebase already does it" rung,
not "the defaults agree".

Worth naming that the first pass also updated five test files to expect the
four-key payload, so the suite went green around the regression. Same shape as
#4805: the test pinned the wrong value instead of catching it. Only the
pre-commit guard, which fails closed, said no.

## What moved

Five wrappers and four hand-declared duplicate types deleted (`ResolvedBlock`
was field-identical to the generated one); 28 call sites across 15 production
files migrated to `commands.*` + `unwrap`. `src/lib/list-style.ts` was a
submodule importer that a barrel-only grep would have missed.

`scripts/tauri-import-baseline.json`: 41 → 38. `DonePanel.tsx`,
`AttachmentRenderer.tsx` and `resolve.ts` left the wrapper layer entirely.

## The guard that is not here

A per-command omitted-field test was written and then removed: the 2026-09-02
narrowing dropped exactly that suite, on the grounds that a one-time read at
deletion time is the whole safety argument.

Worth recording what that costs, because it was measured rather than guessed.
Making `ListBlocksRequest.parentId` optional in the generated bindings turned
NOTHING red across the estate except that guard. The accepted risk is therefore
precise: if a future Rust change adds `#[serde(default)]` to a field one of
these deleted wrappers used to fill, every migrated call site starts sending
`undefined` and no test in the repo notices. Reinstating the file is a revert of
one commit if that trade ever stops looking right.

## Review round: the one field nothing typed

`SetPropertyParams` (`useBlockPropertyIpc.ts`) declares four value fields. The
deleted wrapper's own param type declared five. `buildSetPropertyParams`
returns `{ valueBool: false }` for a `value_type: 'boolean'` definition, and
because that is a variable rather than a fresh literal there is no
excess-property check — so `valueBool` reached the backend through the
WRAPPER's type and never through the hook's. Deleting the wrapper dropped it,
and `false` arriving as `null` makes `validate_set_property` reject a
boolean-property add outright.

This is the issue's own hazard landing on the issue's own PR: a silent default,
invisible to `tsc`, found by reading rather than by a red test. The field is
now on `SetPropertyParams` and forwarded, with a test that pins `value_bool:
false` — reverting the forward reddens it (`expected false, received null`).

## The guard had a fail-open, and this PR was about to widen it

`check-set-property-args` matched `/commands\.setProperty\s*\(/`, so a call
written across lines as `commands\n  .setProperty(` was skipped silently. Two
such sites already existed in `ImageResizeToolbar.tsx`, and this PR's two new
`AttachmentRenderer` sites were written the same way — the "OK at 26 call
sites" evidence excluded precisely the sites the PR added.

That is a guard failing OPEN on a shape it cannot parse, which its own section
of AGENTS.md lists as a requirement to fail closed. The dot now tolerates
surrounding whitespace: 26 visible call sites became 30. Proven rather than
asserted — the same half-formed-property mutant exits 0 under the old regex and
1 under the new one.

## A guard that lost its only test

The deleted `tauri.test.ts` block for `listBlocks({ spaceId: '' })` was the only
coverage of `requireActiveScope`'s empty-string throw — a tripwire under ~10
call sites, because an empty id deserialises into a never-matching filter that
silently returns nothing. Deleting the wrapper deleted its test, and removing
the throw would have gone green. `src/lib/__tests__/space-scope.test.ts`
restores it; deleting the guard reddens it.
