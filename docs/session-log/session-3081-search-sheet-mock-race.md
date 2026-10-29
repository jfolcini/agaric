# Session 3081 — SearchSheet.test.tsx: one set of spies however often the mock factory runs

The tests session reported `SearchSheet.test.tsx` as flaky on main after #6184 moved vitest to `vmForks`.

**Cause:**
- vitest 5.0.5 caches an async `vi.mock` factory's result only after its promise settles. The cache is set in `ManualMockedModule.resolve` in `@vitest/mocker`.
- `callFunctionMock` checks the cache before it awaits.
- `SearchSheet.tsx` preloads the command palette when the module loads. The palette reaches `@/lib/ipc-helpers` while the test's own import is still awaiting `importOriginal`.
- So the factory runs twice, and the palette holds a second set of `vi.fn()`s that nothing stubs. Four tests then failed on `searchBlocksPartitioned(...).then`.
- It shows only when the two imports overlap, which happens in a multi-file run under load.

**Changed:**
- The spies are created once in `vi.hoisted` and returned by the factory, so every run of the factory hands out the same ones.
- The file leaves `VM_INCOMPATIBLE` and runs in `vmForks` again.
- No assertion changed.

**Red first:** the wide run (`src/components/common`, `src/components/mobile` and `App.test.tsx`) ran under three CPU burners. With the old test in `vmForks`, 6 of 10 runs failed, each on the same four tests with the predicted `TypeError`. With the fix, 15 of 15 runs were clean for SearchSheet. The reviewer confirmed the cause in vitest's own source.

**Found, not changed:** `App.test.tsx > switches to Pages view` failed once in those 15 loaded runs (`expected null not to be null`, at 8.6 s). It never failed in the red runs. It is noted for the next flake pass.

**Suites:** vitest over `src/components/mobile`, `src/components/common` and `App.test.tsx` (553 tests); typecheck and lint.
