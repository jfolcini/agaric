# Session 2545 — three flaky tests fixed at their cause, and the #5833 review notes

**Set out to:** fix three vitest flakes that only showed under load, and apply
the four non-blocking notes from #5833's review (voice notes on Linux).

**Flakes.** Each was reproduced on a loaded machine: CPU burners plus eight
vitest processes at once. None was slow work. Two were races that a slow test
loses, and one was a focus check made once.

- **`TaggedItemsSection.test.tsx`** failed 3 of 40 loaded runs. The timing was
  bimodal: a test took about 200 ms or ran out the full 8 s, which marks a hang,
  not slow work. When "has no a11y violations with a block expanded" failed,
  its DOM held the "Child 0…" rows from "says how many descendants…", two tests
  earlier. Cause: `BacklinkGroupRenderer` rows start a page-subtree prefetch on
  `mouseenter`/`focus` after a 120 ms dwell. The prefetch is parked for 8 s in
  `prefetch-page-subtree.ts`'s module-level map. A test that stays on a HOME row
  longer than the dwell (only under load) parks HOME's outline. The next test to
  expand a HOME row consumes it as the store's first load (`generation === 1`).
  Evidence: logging the map size at each test's start, the two failing runs out
  of 24 were exactly the two where the failing test started with a parked entry.
  A 200 ms pause at the end of the earlier test reproduces the failure every
  time. Fix: `_resetPrefetchPageSubtreeForTest()` in the file's `beforeEach`,
  as the PageBrowser and JournalPage suites already do. After the fix: 90 of 90
  loaded runs green, and the pause stays green. Production is unaffected: the
  handoff is the designed one, and only the stubbed outline changes between
  tests.
- **`QrScanner.test.tsx`**, "moves focus to Retry camera". The diagnosis holds.
  The Retry button commits with the error, and a passive effect focuses it
  afterwards. `findByRole` can resolve in between, and `toHaveFocus()` was
  checked once. Repeating the test 300 times in each of 8 loaded processes, the
  button was not yet focused when found in 13 of 2408 samples. Fix: `waitFor`
  the focus. The fixed test passed 2400 repeats under load, and goes red when
  the focus effect is removed.
- **`UnlinkedReferences.countIntegrity.test.tsx`**, "'Link it' under an active
  filter". Under load the test took 1.2–2.6 s, with no step near 8 s, so slow
  work was ruled out. The add-filter row's appearance has a fixed 300 ms floor:
  React's Suspense fallback throttle on the lazy row. It is the same quiet and
  loaded. The timeout is a race. Since #4967, `handleLinkIt` calls
  `recordGraphStructureChange()`, which refetches the panel 150 ms later. The
  stub answered that refetch with the pre-link four rows, and the comment still
  said nothing refetches. So `waitFor(rows === 3)` passed only if it saw the
  optimistic state inside that window. A 300 ms pause after the click turns it
  into the 8 s timeout every time ("expected 4 to be 3", 9.1 s). Fix: the stub
  answers with each linked row gone (`mockedEditBlock.mock.calls.length`), as
  the backend would. The optimistic and refetched states now agree. The pause
  stays green, and dropping the optimistic `filtered_count` decrement in
  `UnlinkedReferences.tsx` still reddens "the number the panel asserts is the
  number of rows it shows". Combined loop of the three files: 30 of 30 green
  under load.

**#5833 notes.**
- The fake `AudioEncoder.flush` emitted nothing, so finishing the Ogg file
  before `flush()` resolved passed every test. It now hands over
  `FLUSHED_PACKET` after an `await`, as a real flush delivers output before it
  resolves. The recorder test and the dialog's Opus-route test expect that
  packet in the file. Mutating `stop()` to finish before the drain resolves
  reddens both byte-equality assertions.
- `e2e/voice-note-record.spec.ts` takes 4.5 s as its duration upper bound, as
  the e2e-tauri spec does. The real recording measures 3.3 s: lowering the bound
  to 2.6 fails with "Received: 3.3".
- `e2e-tauri/voice-note-record.e2e.ts` parses the timer and waits for three
  seconds or more, instead of waiting for the text `0:03`, which shows for only
  one second. This lane is type-checked here and runs in CI.
- The comment on `RECORDING_BITS_PER_SECOND` no longer quotes figures. #5833
  measured the encoder at about 25.5 MB an hour, not the 15 MB the comment
  claimed.

**#5831 notes.**
- **`page-mode.property.test.ts` was slow.** Each call site was timed over
  150 runs (936 steps), and the worker was CPU-profiled.
  - Per run, quiet: the real-time `setTimeout(0)` after every step cost
    7.3 ms; `apply` (the editor steps) 5.8 ms; `openPage` (a new TipTap editor)
    2.9 ms; `peerChange` 1.4 ms; the checks 0.7 ms; commits and saves under
    1 ms each.
  - The timer is idle time with a 1 ms floor, and under load each one also
    waits for the OS to wake the worker. Without a yield the property fails (a
    `#name` resolves after the checks), so it is load-bearing. Its chain is
    promises only, which `setImmediate` settles without a timer: 1.2 ms per run.
    The test fell from 3.4 to 2.0–2.3 s quiet. Under 14 CPU burners and 8
    concurrent runs, interleaved, the medians went from 10.2 and 11.4 s to 9.5
    and 9.2 s, with ranges overlapping (9.0–12.5 against 7.2–11.0 s).
  - Under saturation the rest is CPU, and the profile puts it in the editor
    itself. TipTap's setup inside `openPage` is 23% of the body (`createView`,
    `ExtensionManager`); typing and pasting are most of `apply`. The fixture adds
    nothing measurable: `idsOf` without serializing changed nothing outside the
    noise, so it was left alone. Reusing one editor across runs is the remaining
    lever, at the cost of a fresh editor per run, and was not taken.
  - Fewer, longer runs cost more, not less. Under fast-check's default size,
    `maxLength: 14` never generates more than 12 steps (6.4 on average);
    `size: 'medium'` reaches 28, but steps grow dearer as the document grows:
    75 runs × 14 steps took 2.9 s against 2.05 s for 150 × 6.4.
  - The mutation `addedInlineProperties(before.slice(0, 0), markdown)` in
    `commitPageProperties` reddened 1 of 12 runs both before and after the
    change: the generator rarely reaches a key held as text. Its shrunk
    counterexample is pinned as a third example (a `key:: value` line kept as
    text in a block a peer deleted, then a task marker typed there), and the
    mutation now reddens every run at that example. The other two examples
    stay green.
- `e2e-tauri/helpers.ts`: `expectAbsent`'s comment no longer names a reverse
  `waitForExist`, which the helper does not use.
- `page-lists.ts`: `Pick<FlatBlock, 'id' | 'depth'>`, written five times, is the
  local `OutlineItem`.

**Ran:** the three flaky files looped under load (counts above);
`npx vitest run src/components --maxWorkers=4`; `npm run typecheck`,
`typecheck:e2e`, `typecheck:e2e-tauri` and `lint`; Playwright
`e2e/voice-note-record.spec.ts` on a private port, one worker.
