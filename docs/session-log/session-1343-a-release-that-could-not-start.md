# Session 1343 — a release that could not start

A one-bug session. 0.9.7 shipped a boot panic on every platform, and it was found the way
these things usually are: the maintainer tried to open the app.

## The bug

```
PANIC at tracing-subscriber-0.3.23/src/util.rs:94:14:
failed to set global default subscriber: SetLoggerError(())
```

Before any window. Every launch, every platform.

`init_logging` does two things in order. First it calls `init_log_bridge` — #4034's fix for
mdns-sd's `log` records going nowhere — which installs a `LogTracer` at a deliberately capped
max level, so a dependency's `log::trace!` calls short-circuit inside the macro instead of
being formatted once per packet and dropped by the filter. Then it composes the registry and
calls `.init()`.

`SubscriberInitExt::init` is not just "set the global default subscriber". Under the
`tracing-log` feature — on by default, and the reason `tracing-log` is named explicitly in our
`Cargo.toml` — it sets the global default and *then installs its own `LogTracer`*, at the
registry's max level, and `expect()`s on the result. A global `log` logger already existed, so
that install returned `SetLoggerError` and the `expect` aborted the process.

The two halves of #4034 were each correct. Their order was fatal.

## The fix, and why `.ok()` is not a shrug

`.try_init().ok()`. What makes that safe is the ordering *inside* `try_init`:

```rust
dispatcher::set_global_default(self.into()).map_err(TryInitError::new)?;
#[cfg(feature = "tracing-log")]
tracing_log::LogTracer::builder()
    .with_max_level(tracing_core::LevelFilter::current().as_log())
    .init()
    .map_err(TryInitError::new)?;
```

The subscriber goes in first. By the time the bridge install can fail, the thing we actually
needed has already succeeded, and the only error reachable on this path is the redundant
second bridge — the one whose *absence* is the point, because it would overwrite our capped
ceiling with the registry's. Swallowing it keeps the level cap `init_log_bridge` exists to
enforce.

The regression test asserts both halves, and the first assertion is the interesting one:

```rust
assert!(result.is_err(), "guard on the premise: …");
assert!(tracing::dispatcher::has_been_set(), "…");
```

A test that only checked "boot did not panic" would pass just as well if the double-install
stopped happening — and would then be silently guarding nothing while `.ok()` sat in
production swallowing whatever error came next. Asserting the `Err` *is expected* keeps the
tolerated failure pinned to the one we reasoned about.

## What let it through

Nothing ran the binary. The Rust suite is 3550 tests and every one of them passes on a build
that cannot reach its first window, because `init_logging` is only called from Tauri's setup
hook — no test constructs it, and a unit test that did would have been the one place the
double install could show up.

CI is no better placed: the release workflow's Linux and macOS jobs both went **green** while
the artifact they produced was unstartable. A build that compiles and a build that boots are
different claims, and we currently only check the first.

Worth a smoke check that launches the built binary and asserts it survives a few seconds —
filed rather than bolted onto this hotfix.

## Note

0.9.7's published artifacts are broken. This branch fixes the source; the release itself needs
re-cutting once it lands.
