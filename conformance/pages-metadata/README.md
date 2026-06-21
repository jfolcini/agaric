# Cross-impl conformance: `list_pages_with_metadata`

`src/lib/tauri-mock/handlers.ts` re-implements the backend's page-listing
filter/sort/cursor logic in TypeScript so the e2e suite and many unit tests can
run without the Rust backend. `scripts/check-tauri-mock-parity.mjs` only checks
that handler **names** match the generated bindings — it never checks
**behaviour**, so a backend semantics change (sort order, cursor encoding) can
leave the mock stale while every suite stays green (#1886).

`sort-cursor.vectors.json` closes that gap for sort + cursor. It is the single
source of truth, asserted from both sides:

- **Rust** — `src-tauri/src/commands/tests/pages_metadata_conformance_tests.rs`
  seeds a temp DB from `rows` and drives the real
  `list_pages_with_metadata_inner` query path.
- **TypeScript** — `src/lib/tauri-mock/__tests__/sort-cursor-conformance.test.ts`
  drives the mock's `compareMetaRows` / `encodeNextCursor` re-implementation.

If they diverge, one side's test fails. When backend semantics intentionally
change, update this file to the new expected values; the mock test then fails
until `handlers.ts` is realigned — which is the whole point.

## Schema

```jsonc
{
  "rows": [ { "id", "content", "lastModifiedAt", "inboundLinkCount", "childBlockCount" } ],
  "scenarios": [
    {
      "sort": "default" | "recently-modified" | "most-linked" | "most-content",
      "expectedOrder": ["<id>", ...],            // full order, ties broken by id ASC
      "expectedCursorAfterFirst": {              // next_cursor minted after the 1st sorted row
        "id": "<id>",
        "position": <sort discriminator>,        // 2=recently-modified 3=most-linked 4=most-content 5=default
        "seq": <int>                             // present only for count sorts (most-linked/most-content)
      }
    }
  ]
}
```

Only `id` and `position` (the sort discriminator) are asserted on the cursor:
they are the representation-stable parts that the cross-mode-refresh contract
depends on. The key-slot value legitimately differs between impls (Rust stores
`recently-modified` as epoch-ms-as-string, the mock as an ISO string), so it is
**not** compared across languages; `seq` (an integer on both sides) is the
exception and is asserted for the count sorts.

## Scope (staged, per #1886)

- **In:** the four wire sorts — ordering + cursor discriminator (`position`/`seq`).
- **Out (follow-up #1908):** filter-primitive evaluation parity, and
  recently-modified key-slot byte-equality. `alphabetical` is intentionally
  excluded — it never crosses the wire (`pageSortWireFor('alphabetical')` returns
  `'default'`).
