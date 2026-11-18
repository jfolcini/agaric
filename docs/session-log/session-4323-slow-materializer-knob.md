# Session 4323: a slow-materializer knob for bridge specs

Stage 0, gap G3 of #6926 (#6529).

**Gap:** two WebdriverIO specs, `agenda-count-after-write` and `pages-list-local-write`, run their app with every background materializer batch a second late (`SPECS_WITH_A_SLOW_MATERIALIZER` in `wdio.conf.ts`). That way a view cannot re-read before its cache rebuild has run, which is what these specs test. Specs on the bridge had no way to ask for the same thing.

**Knob:** `slowMaterializerMs`, a worker-scoped Playwright option in `e2e/helpers.ts`. A spec sets `test.use({ slowMaterializerMs: 1000 })` at its top level and gets its own worker. That worker's bridge starts with `AGARIC_E2E_BACKGROUND_DELAY_MS`, the engine's existing debug-build seam. It has no effect on the mock.

**Shown working:** a throwaway bridge spec, not committed, created a block and timed until `search_blocks` found it. FTS is a background rebuild.
- Default: found after 4 ms.
- With the knob at 1000: found after 944 ms.
- With the env line removed from `startBridge`, the knob-on assertion went red with "Expected: >= 900, Received: 6".
