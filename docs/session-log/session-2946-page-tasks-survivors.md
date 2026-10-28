# Session 2946 — page-tasks mutation survivors

#5964 listed seven survivors in `src/editor/page-mode/page-tasks.ts`:
- the `group` class on a block row;
- five mutants of the NodeView's `stopEvent`;
- the `return true` that closes `commitPageTask`'s edit callback.

Stryker on the module at `origin/main`, on a loaded box, gave 457 killed, 9 timeout, 25 survived and 2 no-coverage. The `group` mutant timed out there, so the filer reported six, but CI's weekly run had it as a survivor and it was treated as live.

**Why `stopEvent` survived:** every surviving mutant made it return false, and the only test was a key pressed on a control. `page-keys.ts` has its own keydown guard (`!view.hasFocus()`), which already swallows such a key. A paste has no such guard.

**Killed by two tests in `page-tasks.test.tsx`:**
- A paste on a focused checkbox leaves the text as it was, and the same paste in the block's text lands at the caret. The second half shows the event does reach the editor.
- A block is its chevron's `group`: the chevron's at-rest classes are `group-hover` and `group-focus-within`, and `closest('.group')` is its own block. happy-dom loads no CSS, so the class is the observable DOM state. In a real browser, hovering a block also shows the chevron through `data-page-grip-on`, so only focus inside the block depends on the class alone.

**Re-accepted:** `return true` after `markdown = text`. The callback's boolean only becomes what `commitCheckboxState` returns, and `commitPageTask` discards that. The page store's `todo_state`, the undo action and the repeat reload do not read it. The stale entry keyed it as the 8th `return true` in the file. After a shift, that index pointed at the one in `handleDrop`, whose mutant is killed, so it hid nothing. The new entry is the 9th. The neighbouring `if (text === markdown) return true` entry, which had no reason line, now has one.

**Suites:**
- the page-tasks tests (46 of 46);
- typecheck and oxlint;
- each new test shown red against its mutant, with the source restored on exit;
- Stryker on the module after the change: 464 killed, 4 timeout, 23 survived and 2 no-coverage, all matched by accepted entries. The four timeouts are `ignoreMutation`'s, as in the baseline;
- a filer dry run over that report: nothing new.
