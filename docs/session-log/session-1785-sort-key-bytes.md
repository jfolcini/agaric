# Session 1785 — the sort key orders by bytes, and the sentinel is gone

#5098, split out of #5097 because the fix was a design decision rather than a
comparator swap.

`compareSortKeys` compared with JS `<`, i.e. UTF-16 code units; the backend's
`cmp_group` is a Rust `str` comparison, i.e. UTF-8 bytes. They disagree whenever
an astral character is ranked against one in `U+E000`–`U+FFFF`: bytes put the
astral one second (`F0 …` > `EF …`), code units put it first (its lead surrogate
`D83C` < `FF71`). Reachable through grouped-backlink `page_title`, which is user
text.

## Why the sentinel blocked the obvious fix

The same path used `TITLELESS_SORTS_LAST = '￿'` to mean "sorts after every
real title". That works under code units, where `U+FFFF` is the maximum BMP
value. It does not work under bytes: an astral title encodes as `F0 …`, above
`U+FFFF`'s `EF BF BF`, so a page titled with an emoji would have jumped past the
titleless group. Swapping the comparator alone would have broken the
titleless-sorts-last contract silently, and its cursor with it.

## The shape

`SortKey` now admits `null`, and `compareSortKeys` has an explicit branch for it
— `null` sorts last, which is what SQL does and what `cmp_group` means by
`None`. The sentinel is deleted; `links.ts` passes the title through as
`string | null`.

The cursor is the half that had to move with it. `encodeBlocksCursor` now omits
a slot whose component is `null`, because every `Cursor` slot on the backend is
`#[serde(skip_serializing_if = "Option::is_none")]` — so a titleless group's
cursor is byte-faithful to `Cursor::for_group(pid, None)`, `{"id":…,"version":1}`,
where before it carried a literal `"￿"`. `slotSentinel('deleted_at')`
becomes `null` rather than `''`, which is what closes the round trip.

That sentinel carries a different column on each branch, so it can only match
one of them. It now matches the grouped reader, which is the only branch either
stack mints a slotless cursor from; `list_agenda_range` binds `""` where the
mock decodes `null`, and trash and history refuse such a cursor outright. All
three are unreachable from a cursor either stack mints, and the
`decodeBlocksCursor` docs now say that rather than the older claim.

`compareTrashKeys` negates only its lead component and `compareSortKeysDesc`
negates the whole tuple; neither can hold a null — trash rows carry a non-null
`deleted_at`, history keys are `created_at`/`seq`/`device_id` — so both were
left alone.

## Pinned

A new backend-authored fixture, `query_backlink_groups_binary_order.json`,
seeds `🍎` *before* `ｱ` so the code-unit answer is also the insertion order and
cannot pass by accident. The backend authored `ｱ` first, `🍎` second. It carries
a limit-1 page pair so the keyset resume is pinned under the same compare.

The titleless cursor is not fixture-reachable: `insert_seed_block` seeds content
as `unwrap_or("")`, so no conformance seed can make `blocks.content` NULL. It is
pinned by a vitest test instead — two titleless pages, `limit: 3`, page 1 ending
on the first of them — and the test says why it lives there.

## Falsified

Four mutations, each against a copy, restored and `cmp`-verified:

1. bytes → `String(a) < String(b)`: fixture red, apple above `ｱ` on all three
   steps.
2. the null branch's direction flipped: page 1 came back `[N1, N2, Alpha]`
   instead of `[Alpha, Zulu, N1]`.
3. `slotSentinel` back to `''`: page 2 answered `has_more: true` and re-served
   the entire first page.
4. the encoder's omission made unconditional: `cursor: "v1:{deleted_at,id}"`
   where `"v1:{id}"` was expected.

Each half of the change is covered on its own, so neither arm rides on the
other.

## Verified

`npx vitest run src/lib/tauri-mock/__tests__/ conformance` — 50 files, 995
passed. Full `npx vitest run` — 837 files, 19252 passed, 1 expected fail, 51
skipped. `npm run typecheck` clean. `oxfmt --check` and `oxlint` clean on the
changed files. The fixture was regenerated with `CONFORMANCE_UPDATE=1` and then
`npx oxfmt --write conformance/fixtures/`; no other fixture moved.
