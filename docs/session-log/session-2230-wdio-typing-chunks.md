# Session 2230 — The real-backend typing helper stops losing keys

The real-backend WebdriverIO lane's slowest typing specs spent most of their
time waiting out read-back budgets. A CI survey timed `pages-most-linked` at
about 24 s and `search-bm25-order` at about 21 s.

**Cause.** One `browser.keys` call presses every key down before it releases
any, and WebKitGTK's driver loses a key pressed again while it is still held.
So `[[` arrived as `[`, `::` as `:`, and every space after the first in a
call was lost (`zap of ink` arrived as `zap ofink`). The first attempt then
sat on the wrong text for its whole 3 s budget, or 10 s in
`search-bm25-order`, before the slow one-key-at-a-time retry. In CI run
38909854600 ten first attempts failed this way across six specs. The helper's
doc blamed a janky first render; the log shows the driver.

**What changed** (`e2e-tauri/helpers.ts`):
- `distinctKeyChunks` splits the text into runs in which no character
  repeats, and the first attempt sends each run as its own call.
- An attempt ends once the read-back has stopped changing for 400 ms, with
  3 s still the bound. The retry still types one key at a time.
- The `readBackTimeout` parameter went with the 10 s budget it carried.

**Tests.** `e2e-tauri/helpers.test.ts` pins the chunks for `[[wdio-rival` and
`zap of ink`, and a fast-check property checks that the chunks join back to
the text with no character twice in a chunk. Splitting only at adjacent
repeats turns three red, the space case among them.

**Not run locally:** the WebdriverIO lane needs a native build. The PR's
e2e-tauri run is the check: the typing-heavy specs should drop, and
`import-vault-adopts-link-target`, which types nothing through the helper,
should not move.
