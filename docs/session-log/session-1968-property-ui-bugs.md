# Session 1968 — property chips show values; select definitions can be created (#5449)

Bugs found by the #5365 property e2e work.

- Text and select chips showed `[[xxxxxxxx...]]`: the chip ran every value
  through `resolveBlockTitle`, whose miss returns a placeholder. Ref values
  never reach the chip (`useExtraBlockProperties` drops `value_ref`), so the
  resolve is gone and chips show the value.
- Creating a select definition always failed (the backend requires options):
  both create forms ask for comma-separated options and keep Create disabled
  until one is entered (`selectOptionsJson` in `src/lib/property-utils.ts`).
- Refusing to delete an in-use definition now shows the backend's reason
  (`reportIpcErrorWithReason`); the mock's refusal text matches the backend.
- The property-picker "commit on blur" test now really blurs (clicks another
  block) and checks the stored properties before reopening the page.

Verified: each change falsified on copies (main's chip code, null options
from each screen, each disabled guard, the helper's arms, the generic toast,
the blur save skipped), all red, restored and `cmp`-checked. Targeted vitest
1,548 passed; Playwright 32 passed (one known flake on retry); typecheck,
oxlint, oxfmt clean. Full vitest had 5 failures in TrashView and
PageSourceEditor under load ~53, neither touching changed modules (both pass
alone).
