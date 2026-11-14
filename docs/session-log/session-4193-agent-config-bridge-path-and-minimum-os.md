# Session 4193 — the copied agent config names the bridge by its path; minimum macOS and Windows declared (#6736, #6737)

Two packaging issues found while checking the README against the 0.23.0 artifacts, in one PR.

## What shipped

- **#6736.** `McpStatus` carries `bridge_command` and `bridge_args`, and *Copy Claude Desktop config* / *Copy Claude Code command* run them instead of a bare `agaric-mcp`. `mcp::bridge_invocation` resolves the bridge beside `current_exe()`: tauri-bundler installs every cargo `[[bin]]` in one folder (`/usr/bin`, `Agaric.app/Contents/MacOS`, the Windows install folder, `usr/bin` in an AppImage), which is why there is no `externalBin` in `tauri.conf.json`. An AppImage's mount path changes every launch, so there the config runs `$APPIMAGE agaric-mcp …`, and `main` hands an `agaric-mcp` first argument over to the bridge beside it (`exec_bridge_if_asked`, Linux only). The two copy buttons are disabled while the status has not loaded. README § Using Agaric with MCP clients loses its "put its full path in the config's `command`" sentence.
- **#6737.** `bundle.macOS.minimumSystemVersion` is `13.0`. README's Install table names macOS 13 Ventura and Windows 10 or 11; docs/BUILD.md § Minimum OS versions gives the evidence.

## Decisions and traps

- **Tauri already wrote `LSMinimumSystemVersion` 10.13** when nothing was set (its config default, which also sets `MACOSX_DEPLOYMENT_TARGET`), so #6737's "absence" was a floor of 10.13 nobody had checked.
- **The macOS floor is WebKit's.** Read from a production `vite build`: the app's CSS (Tailwind 4) and regex lookbehind need Safari 16.4; pdf.js 6 touches the `Iterator` global at module load and calls `Promise.withResolvers`, which needs Safari 18.4. Safari 18 runs on macOS 13 and later, so 13 is the oldest system where the whole app can work. The Rust targets allow older (10.12 Intel, 11 Apple Silicon).
- **Windows has no install-time gate.** Tauri's NSIS and WiX templates take no OS version; the floor is Rust's tier-1 MSVC target (Windows 10) and WebView2's support list. No build number was pinned, since nothing evidenced one.
- **Quoting stays double quotes** for both paths in the Claude Code command: bash, zsh, PowerShell and Command Prompt read them the same way for a path with spaces. Git Bash would turn the pipe path's leading `\\` into `\`, as it did before this change.
- **On macOS a config copied while the app runs from the disk image, or translocated from Downloads, points at a path that goes away.** The README says to copy it once Agaric runs from Applications.

## What ran

Rust: the new `bridge_*` and `status_*` tests (`cargo nextest run --workspace`), clippy over the workspace. vitest: `agent-config.test.ts`, `AgentList.test.tsx`, `AgentAccessTab.test.tsx`, `tauri-mock.test.ts`, `conformance-coverage.test.ts`. Each new test shown red against the old behaviour. Nothing ran on macOS, Windows or a built AppImage; those checks are lines on #6514 and #6515.
