# Session 1627 — clearing the first four type-aware lint rules

The maintainer wants oxc's type-aware rules adopted across the repo. This is
the first step: the rules that can be cleared outright, so the flag has less
standing in its way when it goes on.

## What was already there, and dormant

`oxlint-tsgolint` has been a dependency since #4408, with a `tsgolint-version-pin`
prek guard whose whole purpose is keeping it in step with `typescript` so that
`oxlint --type-aware` stays meaningful. The flag is passed nowhere: not in the
`lint` script, not in the prek hook, not in CI. So none of these rules had ever
run against this tree.

Running it costs 2.98s against 0.61s without, whole-tree, measured on this
machine.

## The backlog it exposes

326 violations across twelve rules:

| Rule | Count |
|---|---|
| unbound-method | 138 |
| no-floating-promises | 56 |
| require-array-sort-compare | 42 |
| no-base-to-string | 22 |
| restrict-template-expressions | 18 |
| only-throw-error | 13 |
| await-thenable | 10 |
| no-misused-spread | 8 |
| no-redundant-type-constituents | 7 |
| no-duplicate-type-constituents | 7 |
| require-await | 4 |
| no-useless-default-assignment | 1 |

Only these twelve are active: a probe file violating `no-unnecessary-type-assertion`
went unreported, so switching the flag on without clearing anything would not
have bought a single new check.

## What this ships

The bottom four rules, cleared to zero — 19 sites, all in this repo's own code.

The `require-await` ones were not `async` by accident: each is a thunk whose
type has to be Promise-returning, so they become `Promise.resolve(...)` rather
than losing the `async` and the return type with it. The duplicate-constituent
ones are all optional *parameters*, where `?: T | undefined` and `?: T` are the
same type — `exactOptionalPropertyTypes` governs properties, so nothing there
changes meaning. The redundant-constituent ones were mostly
`ReturnType<typeof vi.spyOn> | null`, where the spy type resolves through `any`
and swallows the `| null`; they are now `MockInstance`, which is both accurate
and stricter than what they had.

## What it deliberately does not ship

The flag itself. Two things have to be settled first, and both are the
maintainer's call rather than mine:

`only-throw-error` is already pinned to `error` here and passes without type
information. With it, thirteen sites fail — two in production that throw the
raw `{ kind, message, code? }` wire object on purpose (`tauri-mock/index.ts`
says so in a comment), and eleven in tests that throw a string or a bare object
precisely to exercise the non-Error path. Holding the rule at `warn` to burn
those down, the way the React Compiler block above it does, would weaken a gate
that is currently clean. Thirteen reason-carrying per-site disables would keep
it at `error`. I did not pick between them.

And the remaining seven rules need the same `warn` → burn-down → `error`
ratchet that block already documents, which is a decision about how much
warning noise to carry at once.

## Verification

18973 unit tests pass; `npm run typecheck` is clean; `npx oxlint --type-aware`
reports zero for the four rules this clears, against 19 before.
