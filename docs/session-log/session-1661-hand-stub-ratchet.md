# Session 1661 — a ratchet a swap could walk past

#4668's acceptance had two clauses. The first — type `mockInvokeCommands`
against the generated command return types — landed in #4840, and the brief
that started this session was written off a stale reading of the issue. The
maintainer's own comment already said so: *"with the deliberate exceptions
listed and reasoned" — NOT STARTED*. So the work was to verify step 1 rather
than rewrite it, and then do the clause nobody had.

## Verifying rather than rebuilding

The seam derives its mapping instead of hand-maintaining one, which is the
thing worth checking, since a hand-written table would be exactly the second
implementation the issue exists to remove. `InvokeReturn<K>` matches the
generated `commands` object's function type and extracts
`Extract<R, { status: 'ok' }>['data']` — unwrapping `typedError`'s envelope, so
the type is what the **invoke boundary** resolves rather than what the wrapper
returns. A `CamelToSnake<S>` conditional re-keys camelCase bindings to the
snake_case IPC names.

It catches drift, shown rather than assumed. Stubbing
`list_inherited_tags_for_block` (a `string[]`) with a paginated envelope:

    error TS2322: Type '{ items: never[]; next_cursor: null; }' is not
    assignable to type 'string[] | Promise<string[]> | undefined'.

And a partial `AttachmentRow` with an ISO-string `created_at` — the exact drift
an earlier session log records as real — fails naming the five missing fields.

## The number was the wrong baseline

The ratchet asserted `files.length === 56`. **A count is satisfied by a PR that
migrates one file and adds a hand-stub in another** — the arithmetic that hides
a regression behind a win.

Demonstrated: neutralise the stub in one baseline file, add a probe file with a
fresh `vi.mocked(invoke).mockResolvedValue({ anything: true })`, and the live
count stays exactly 56. `toBe(56)` passes. The baseline is now the file SET,
and that swap reds naming both halves.

The two arms are one assertion, not two, deliberately: a migrate-one-add-one
PR drifts both ways at once, and a second `expect` would never run to report
the half that motivates listing the files at all. That is the half-covered pair
AGENTS.md warns about, in the guard rather than in a test.

## Exceptions claimed only where provable

Two, each reasoned in place:

- `strict-invoke.test.ts` — the seam's own test. Its counted stub is the
  catch-all resolving `undefined` that proves an explicit stub overrides
  `strictInvokeFallback`. Routing it through `mockInvokeCommands` would test
  that helper instead of the fallback it asserts about.
- `ipc-helpers.test.ts` — `read_attachment` returns a raw-byte
  `tauri::ipc::Response`, which cannot carry a `specta::Type`, so it has no
  generated binding at all and is not a key of `CommandReturns`. The typed seam
  cannot name it.

The other 54 are `MIGRATION_BACKLOG`: not exceptions, just undone. Keeping the
two lists apart is the point — a speculative exception launders backlog as
permanent, which is the failure the clause exists to prevent.

The old docstring also claimed an **IPC rejection** is an exception class. It
is not: `mockInvokeCommands` takes a handler that rejects or throws, so those
migrate like any other stub. That text would have licensed permanent exceptions
that are not.

## Not done

Step 2, the migration itself, is untouched — the issue argues it should wait
for #4667, because routing suites through the mock before its fidelity improves
imports blind spots into tests that currently have none by construction.
