# Session 1492 — A `test-util` feature for the app crate (#4499 phase 0d, step 1)

Phase 0d of #4499 evicts `src/commands/tests/`, `src/command_integration_tests/` and the crate-root
`*_app_tests.rs` files — 48 files, ~91K lines, 1,445 test functions — into a handful of integration-test
binaries. Nothing there moves for free: an integration binary links the lib as an *external* crate, so it
never sees `cfg(test)` and cannot name a `pub(crate)` item. This session is step 1 alone, the enabling
change: widen what a future test binary must reach, move no test file, change no behaviour.

Two classes of item needed work. The first is plain visibility — the 22 `commands::*` domain submodules,
the agenda `_on_the_fly` and `_with_today` pinned-clock readers, and the materializer counter accessor
`sql_only_fallback_count` were `pub(crate)`; they are compiled into release today and only their *names*
were crate-private, so widening them to `pub` changes name resolution and nothing else. Its sibling
`descendant_fanout_dropped_count` stays `pub(crate)`: no test that moves reaches it, and the one caller that
does is `lib.rs`. The second class is the three seams that vanish entirely when the lib is built without
`cfg(test)`: the attachment GC pass `cleanup_orphaned_attachments`, the spaces `bootstrap_spaces_for_test`
shim, and the recovery once-guard `reset_recovery_guard`, joined by the `write_fault` attachment fault
injector. Those are re-gated `#[cfg(any(test, feature = "test-util"))] pub`, behind a new `test-util` cargo
feature on the app crate — the same shape `agaric-core`, `-store`, `-engine` and `-sync` already carry. `write_fault` deliberately did **not** become unconditionally `pub`: its own doc comment
says no release binary may contain the markers or the stat that looks for them, so the gate stays and its
production call site moved to the same `any(test, feature = ...)` condition, otherwise the injector would
compile without the site that fires it.

Turning the feature on for this crate's own tests without turning it on for `cargo build` is done with a
self dev-dependency, `agaric = { path = ".", features = ["test-util"] }`. Cargo accepts the dev-dependency
cycle on the current package, and with the 2024 edition's resolver the feature is unified into the lib
whenever a test target is built and absent otherwise — so `cargo nextest run` and `cargo check --all-targets`
see the seams and `cargo check --lib` (the release surface) does not. That is checked both ways rather than
assumed, and `cargo tree -e features` versus `-e features,no-dev` is the direct evidence. The new requirement in
`src-tauri/Cargo.toml` is a *dev*-dependency, and the fuzz workspace does not resolve the dev-dependencies of
a path dep, so `src-tauri/fuzz/Cargo.lock` is not invalidated — checked with `cargo metadata` there rather
than assumed from the `verify-lockfiles` rule, which is about normal requirements.

Falsification here is the absence of a behaviour change, so the proof is the negative one: the diff touches
only visibility, `cfg` predicates, comments and the manifests; no test file moved; the crate compiles with
and without the feature; and the workspace suite is unchanged and green.

The one cost the feature carries: a bench is a dev target, so the self dev-dependency turns `test-util` on for
`attachment_bench` too, and every write there now pays `write_fault::apply`'s two marker stats on a bench whose
empty buffer was chosen to keep the filesystem portion small. Keeping the two `write_fault` callers in-crate
would avoid it, and was rejected: Phase 0d's premise is that no command test stays in the app crate, and a
carve-out for two would be re-litigated by every phase after this one. The cost is constant per iteration, so
the weekly trend still reads; the absolute number stepped once. Noted at the bench's own comment, where the
"filesystem portion minimal" line would otherwise mislead.

Verified: `cargo nextest run --workspace`, 6,283 passed and 11 skipped, no failures; `cargo check -p agaric
--lib` and `cargo check -p agaric --lib --features test-util` both clean, as is `--all-targets` (which is
what compiles the benches); `agaric feature "test-util"` appears once in `cargo tree -p agaric -e features`
and not at all in `-e features,no-dev` (grep the exact string: tokio has a `test-util` of its own that a
bare match picks up), which is the feature being dev-only stated as evidence rather than as a claim about
the resolver; `cargo machete` clean, so the self dev-dependency needs no allowlist entry; `cargo metadata` in
`src-tauri/fuzz` leaves that lock untouched — a dev-dependency on a path dep is not resolved by the fuzz
workspace — and `src-tauri/Cargo.lock` gains exactly one line. No `.sqlx` cache moved: no SQL changed.
