# Session 1338

## Three checks that reported on nothing

Three unrelated places, one shape: a check that reports a result it never earned. A bypass that
reports success without bypassing, a security dismissal that reports "unreachable" with nothing
watching the fact it rests on, and an error message that names a path the code never looked at.

Issues #3968, #3972, #3970.

### #3968 — a bypass that was inert and said nothing

`scripts/verify-ci-equivalent.sh` built a `SKIP` list from the changed-file categories and then ran
`SKIP="$PHASE_A_SKIP" prek run …`, which **overwrites** whatever `SKIP` the caller exported.
`SKIP=<hook>` is prek's own bypass and reaches the script by ordinary inheritance
(`SKIP=cargo-deny git push` → prek's pre-push stage → this script). Reproduced verbatim before
touching anything, against real prek:

```
$ SKIP=typos bash -c 'SKIP="vitest,cargo-test" prek run typos check-toml --files prek.toml'
check toml...............................................................Passed
typos....................................................................Passed
```

The hook the caller excluded ran, and the run reported success. That is worse than a no-op in both
directions: a pass teaches "the bypass works", a failure teaches "the bypass is broken *for this
hook*".

**Semantics chosen: union, announced — not refusal.** The value arrives here by inheritance; the
caller aimed it at prek, not at this script, so refusing would turn a working prek idiom into a hard
push failure. But this script exists to approximate CI, and a caller skip makes the run inequivalent
by construction — so the union is announced when it actually removes something, and the
non-equivalence is repeated in the **final PASS banner**, which is the line that gets quoted as
"the gate passed". Both decisions are argued in the file, next to the code.

`scripts/push.sh` sets no `SKIP` before calling the verifier (it sets `SKIP_CI_VERIFY` *after*), so
its path is byte-identical to before; that is pinned by a self-test case rather than asserted here.

### #3972 — the reachability argument in the issue was wrong

Dependabot alert #50 (`extract-zip` <= 2.0.1, symlink path traversal, HIGH, **no patched version
exists**) was dismissed as unreachable. The task was to guard the property the dismissal rests on.
Verifying that property first turned out to matter, because **the issue's stated mechanism does not
hold**:

- #3972 says `@wdio/utils/build/node.js` is reached only through the dynamic `import('./node.js')`
  inside `startWebDriver`, so "the vulnerable code is never loaded". It is loaded.
  `@wdio/cli/build/index.js:17` **statically** imports `{ setupDriver, setupBrowser }` from
  `@wdio/utils/node`. Confirmed empirically with a Node module-resolution hook: importing
  `@wdio/cli` pulls in `@wdio/utils/build/node.js` and `@puppeteer/browsers`. (`extract-zip` itself
  is not loaded — but for a different reason: it sits behind a lazy `await import('extract-zip')`
  inside `unpackArchive()`, taken only for a `.zip`.)
- #3972 says the port is the single load-bearing property. There are **two independent gates**, and
  the port is not the one that stops the download. `@wdio/cli`'s launcher calls
  `setupDriver(config, caps)` and `setupBrowser(config, caps)` **unconditionally**; both funnel
  through `mapCapabilities()`, whose filter keeps a capability only when
  `cap.browserName && !definesRemoteDriver(options) && …`. We have no `browserName` **and** we set
  `port: 4444`. Either alone empties the list.

The conclusion (unreachable) survives; the mechanism did not — which is the argument for putting it
in code. `scripts/check-wdio-driver-gate.mjs` checks **both** gates, so losing one cannot leave the
other silently load-bearing. The error message names alert #50, states that no patch exists, and
says explicitly not to delete the guard to get green. The corrected mechanism is written into the
script header, including the correction to #3972.

`wdio.conf.ts` now carries a security note on the `hostname`/`port` lines and on the capability
object, so the next person to tidy them knows what they are.

### #3970 — a message naming a path that was never checked

`path.join(root, '/etc/passwd')` is `<root>/etc/passwd`: the absolute path is neutralised and never
opened. That resolution is the security-relevant part and is **unchanged**. The message was not:
it reported `but /etc/passwd does not exist`, so a reader confirms `/etc/passwd` is right there and
concludes the guard is broken. The three file-on-disk diagnostics (missing, unopenable, directory)
now name the resolved path when it differs from what the author wrote, and keep the short form when
it does not.

### What was verified rather than assumed

Every assertion added here was demonstrated **red** by breaking the production code it covers,
before being trusted:

- The composing helpers were broken four ways (drop the caller's list, drop the required list, stop
  filtering empty fields, report the raw caller value instead of the delta) — each reddens a
  distinct case.
- The call site was reverted to the clobbering assignment, and the PASS-banner line deleted — the
  wiring ratchets caught both. The pure-function cases did **not**, which is the point: the original
  bug lived entirely in the call site.
- The ratchets themselves were defanged (`st_skip_wiring_ok` → `return 0`, `st_clobber_lines` →
  `true`) and the meta-cases caught that too.
- The wdio guard was run red twice against scratch copies of the real `wdio.conf.ts` — once with the
  remote-driver options removed, once with a `browserName` capability added — then green on the real
  file.
- The pin-path message was reverted and the new case went red naming the exact old string.

One assertion was written, found **vacuous**, and rewritten. "No caller SKIP leaves the required
list byte-identical" was described as covering the empty-entry filter; it does not, because
`read -ra` drops a *trailing* empty field by itself. It survives as an identity check (it does
redden when compose stops returning the required list), and a second case now covers the filter with
an interior `a,,b` and a whitespace-only value — the shapes that actually reach it.

### Deliberately not fixed

- **Nothing pins that `@wdio/cli` still calls `setupDriver`/`setupBrowser` the way it does.** The
  guard checks our config, not our dependency. An upstream refactor could move the gate; the guard
  would then be enforcing a property that no longer protects anything, silently. Guarding that needs
  a check against `node_modules`, which does not exist in every checkout — noted, not built.
- **A `browserName` reached through a spread or a variable is invisible to the guard.** It is a
  textual scan, like its siblings. Stated in the header rather than left to be discovered.
- **The pin-path fix is diagnostic only.** The `path.join` neutralisation was left exactly as it is.
- **`verify-ci-equivalent.sh` still cannot refuse a caller skip.** By decision, not oversight — see
  above.
- The `runSelfTest` complexity warning in `check-mutation-harness-clones.mjs` (49 → 60) was already
  over the threshold before this change and is not addressed here.
