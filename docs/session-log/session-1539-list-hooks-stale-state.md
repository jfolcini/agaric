# Session 1539 — Two list hooks that reset on the wrong signal

Fourth PR of the batch run alongside a second agent in another container (sessions 1536 to 1538 carry the first three). This PR closes #3283 in the scope the maintainer narrowed on 2026-09-02; the cursor-recovery third of the original issue was dropped there as unreachable.

`useListMultiSelect` cleared its selection only when the item count changed, so a Trash filter swap that landed the same row count carried the previous filter's ids into a batch purge of rows the user never saw selected. The reset now keys on the item id set (the ids joined into one signature, compared in the same effect), so a membership change clears and a same-ids rerender keeps. The signature is order-sensitive, so a pure reorder such as changing the sort in the page browser also clears; that is the conservative direction against a bug that failed the other way, and the maintainer named this exact mechanism, so it stays.

`useKeyboardNavigableList` accepted a `resetKey` but never forwarded it to `useListKeyboardNavigation`, running its own reset-to-zero effect instead, so the primitive's clamp on an item-count change was dead for the Due and Done panels: a Load More or a completed task snapped focus to the first row. The key is now forwarded and the duplicate effect is deleted; the primitive already skips the mount run. A `resetKey` change still resets, growth preserves, shrink clamps.

Verified: four new tests, both arms of each pair; three go red with the fixes reverted against copies and the same-ids guard stays green as it should, restored `cmp`-identical. Full vitest: 807 files, 18592 passed, 1 expected fail, 37 skipped. Typecheck and oxlint clean.

Shipped: fix for #3283.
