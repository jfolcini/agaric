# Session 1172 — Convert the 5th MCP accept/backoff arm to the level-triggered wake (#2824 follow-up)

## Scope

Follow-up to #2824 / PR #2855. The agaric-reviewer flagged (CHANGES_REQUESTED,
after #2855 had already merged) that only **4 of the 5** accept/backoff `select!`
arms were converted to the level-triggered `shutdown_requested(...)` wake. The
5th — the `serve_pipe` **successor-pipe-creation backoff** arm
(`src-tauri/src/mcp/server.rs`, `#[cfg(windows)]`, reached only on a transient
`CreateNamedPipe` failure) — still awaited the edge-triggered
`disconnect_signal.notified()`, the exact missed-wakeup anti-pattern #2824
removes. Because the arm is Windows-only, Linux CI, the local test suite, and the
Linux-run deep review couldn't exercise or compile it, so it slipped through.

## Change

Replaced that arm's `let notify = lc.disconnect_signal.clone(); … () = async move
{ notify.notified().await } => {}` with
`() = shutdown_requested(lc.shutdown_signal.subscribe()) => {}` — a verbatim
mirror of the already-verified `serve_unix` / `serve_pipe` backoff arms. Now all
five accept/backoff races observe the level-triggered shutdown, so a disable
during successor-pipe back-off tears the loop down promptly even mid-FFI.

## Verification

The arm is `#[cfg(windows)]`; it cannot be compiled on the Linux dev host (the
`x86_64-pc-windows-msvc` cross-build fails building the native `aws-lc-sys` C
dependency, unrelated to this change). The edit is a character-level mirror of
the verified non-successor arms (`lc` in scope from `Some(lc) =>`,
`shutdown_requested`/`lc.shutdown_signal` used identically in 4 sibling arms), so
CI's Windows build leg is the authoritative compile check. Main checkout verified
clean (no edit leak).

Refs #2824. Completes PR #2855.
