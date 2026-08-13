# Session 1299 — guards that stopped pointing at anything (2026-08-13)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-13 |
| **Subagents** | 1 discovery, 5 build, 5 review |
| **Items advanced** | `#3296`, `#3345`, `#3816`, `#3814`, `#3792`, `#3786`, `#3812`, `#3795`, `#3821`, `#3845`, `#3847` |
| **Items filed** | `#3833`-`#3835`, `#3837`-`#3839`, `#3841`-`#3843`, `#3845`, `#3847`, `#3850` |
| **PRs merged** | 8 |

**Summary:** A long batch day that turned into one theme. A maintainer-reported Android crash — the app aborting on opening the sync dialog — was diagnosed from a live logcat capture, fixed, and then produced a chain of follow-ups because the guards that should have caught it had all quietly stopped applying. Four separate instances of the same failure mode surfaced, three of them found while fixing the previous one.

**Process notes:**

**The crash: a documented error path that could not run.** `ndk_context::android_context()` is `ANDROID_CONTEXT.expect(…)`, and nothing in the process ever called `initialize_android_context` — Tauri does not, contrary to a `SAFETY` comment asserting it did. `MulticastLock::acquire` carried a `NoAndroidContext` variant whose own docstring named "`ndk_context` was not initialized" as a case it covered. It could not: the panic is one line above the check, and `ndk-context 0.1.1` exposes no non-panicking accessor. The handler for the exact condition was unreachable by construction.

Reproduced live on the device rather than inferred, and the crash buffer held two earlier instances of the same abort.

**A guard on our side would not have been a fix.** The filed issue claimed only our code aborts and that `hickory-resolver` degrades to fallback nameservers. That is true only for unwinding builds; `iroh-dns` documents an abort on first DNS lookup under `panic = "abort"`, which is what ships. Our multicast lock never owned the crash — it lost a race with `DnsResolver::default()`. Guarding `acquire()` would have moved the abort a few lines down with a worse message. The correction changed the fix, which is the argument for reviewers re-deriving a diagnosis rather than accepting it.

**Then the guards, in order of discovery.**

The `unsafe-allowlist` entry for the multicast shim had been dangling since the #2621 crate split — it named the pre-split path, and the hook only walked `src-tauri/src/`, so six member crates were unaudited and the one real `unsafe` in `agaric-sync` was invisible to it.

`ci.yml`'s `android_re` was stale the same way, so a PR touching only the Android shim skipped `android-build` entirely. The Android fix tripped the trigger only because it also touched `src-tauri/src/lib.rs`; confined to `agaric-sync/`, it would have merged with no Android build run against it.

The allowlist checker could not detect a dangling entry at all — it walked discovered files and asked "is this one allowed?", never "does this entry still name a file?". That is precisely how the first instance survived.

And the repair of `android_re` was **itself incomplete in the same way**: it verified only the alternatives it added and left `db` (whose successor `agaric-store/src/db/mod.rs` carries two real android gates and matched nothing) and `orchestrator` (deleted outright) pointing at nothing — while its PR description claimed every entry had been checked. Caught by review. The fix that followed guards the class instead: a check that every literal path in the regex exists, falsified against the original bug.

Then a fourth: the `unsafe-allowlist` hook's own `files` trigger was still scoped to `src-tauri/src/`, so widening the walk had not widened what runs it.

**The shared shape is worth naming.** A path-keyed guard whose subject moves does not fail — it matches nothing, reports nothing, and the thing it protected silently stops being protected. Every instance here was found by someone tripping over a symptom, never by the guard. Existence checks are the cheap structural answer, and they are what the last two fixes add.

**Two tests deleted for being unable to fail.** A component-level assertion that the badge renders a scheduled date was labelled as covering the `??`/`||` fix; mutation showed it passes against that exact bug (the fixture uses `null`, where `??` and `||` agree) and dies only when the fallback is removed outright. Kept, but re-labelled with both mutant results recorded. A second, asserting a translated group header, passed with its fix reverted and was deleted rather than kept as decoration — the decision it covered is not observable under a single locale, so the helper was exported and unit-tested directly instead.

**A fix whose stated cost was the wrong cost.** Making the in-page-find fold paths agree cured a silent miss and, per its own comment and characterization test, cost only a symmetric false positive. Review found it also introduced a **new** silent miss, in the more common direction: text in natural Greek orthography ending in `ς`. The tree asserted the absence of the bug it had. Canonicalising the two sigma forms removes both misses; the surviving ς/σ conflation is pinned by a pair of tests so neither direction can regress alone.

**On the local gate.** It was killed mid-compile repeatedly, so several PRs were pushed with `SKIP_CI_VERIFY` and a recorded reason, with CI named as the authority in each description. Every one came back green, including the Android change whose full workspace suite had not run locally — but the practice is only defensible because the reason was written down each time and the disclosure was in the PR rather than in a commit nobody reads.

**Cadence note.** Three zizmor baseline re-anchors in one day, every one caused by an unrelated comment edit high in `ci.yml` drifting line-anchored suppressions into four `high` failures. The documented procedure works and was followed each time (re-derive with the ignore list emptied, confirm same count and same step types) — but a line number is a poor key for "this specific step", which is #3737.
