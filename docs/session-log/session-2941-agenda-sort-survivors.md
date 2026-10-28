# Session 2941 — agenda-sort's last no-coverage mutant

#3749 held one finding: `src/lib/agenda-sort.ts`, the `?? ''` after `INDEX_CLASS[levels.indexOf(lv)]` in `groupByPriority`, a StringLiteral mutant no test executed. Stryker on the module at `origin/main`: 308 killed, 16 survived (all matched by accepted entries), 1 no-coverage.

**Deleted, not tested:** the fallback cannot run. `classForLevel` is called only with a label built from `PRIORITY_LEVELS` (fixed at three), and `INDEX_CLASS` has three classes, so the lookup is always in range. The `?? ''` existed only to satisfy `noUncheckedIndexedAccess`. `AgendaGroup.className` already takes `undefined` and the renderer passes it through `cn()`, so `classForLevel` now returns `string | undefined` and the fallback and its comment are gone.

**Stale entry deleted:** `mutation-accepted.tsv` held a StringLiteral entry for `return INDEX_CLASS[Math.min(idx, INDEX_CLASS.length - 1)] ?? ''`, a line that no longer exists. It recorded the same fallback in an older shape and had gone inert, which is why the mutant reported again. With the code gone there is nothing left to accept.

**Suites:**
- the agenda-sort tests and `src/components/agenda` (473 of 473);
- typecheck and oxlint;
- Playwright `agenda-sort-group`, `agenda-advanced` and `closed-task-contrast` (28 of 28);
- Stryker on the module after the change: 307 killed, 16 survived (all accepted), 0 no-coverage;
- a filer dry run over that report with no known body: nothing new. The same dry run over the before-report reports `agenda-sort.ts:349:84` as new.
