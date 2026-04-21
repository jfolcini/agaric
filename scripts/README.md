# Scripts

Repo-level helper scripts. One entry per file; most are invoked
indirectly (pre-commit hooks, `package.json` scripts, CI workflows).

| Script | What it does | Invoked by |
|--------|--------------|-----------|
| `fix-appimage-icons.sh` | Backfill AppImage icon paths in the bundled Linux artifact. | Release tooling (manual). |
| `patch-android-build.sh` | Tauri Android build post-processing (aarch64 + x86_64 only, 64-bit Rust targets — see AGENTS.md §Android). | Tauri CLI via `tauri.conf.json`. |
| `prepare-external-bins.mjs` | Stage the `agaric-mcp` stub (and any future external sidecars) next to the app bundle under the per-platform suffix `tauri-cli` expects. | Tauri build hook. |
| `test-related-rust.sh` | Run only the Rust tests whose modules touch files staged in the current commit. | `prek` pre-commit hook. |
| `test-related-ts.sh` | Run only the Vitest tests whose files touch files staged in the current commit. | `prek` pre-commit hook. |
| `mcp_smoke.py` | Manual MCP wire-compat smoke test. See below. | Operator, manually. |

## `mcp_smoke.py` — MCP wire-compat smoke test

Manual-run smoke harness. Exercises every v1 MCP read tool (9 of them)
against a running `cargo tauri dev` build of Agaric and asserts each
response matches a minimal inline JSON Schema. The harness is deliberately
run through the same Python MCP SDK that real agents (Claude Desktop,
Cursor, Continue, Devin, …) use, so it validates wire compat end-to-end
rather than just Rust-side parity.

### Prerequisites

- `uv` installed (<https://docs.astral.sh/uv/>). The script's shebang is
  `#!/usr/bin/env -S uv run --script` and declares its Python + PEP-723
  dependencies inline, so `uv` will install them into a cached
  environment on first run — nothing to `pip install` manually.
- A local Agaric dev build running (`cargo tauri dev`) with MCP enabled
  (Settings → Agent access → RO toggle ON). The socket file must exist
  at the resolved path before the script launches.

### Running

```sh
./scripts/mcp_smoke.py
```

Override the socket path (useful when running against an instance that
uses a non-default `AGARIC_MCP_SOCKET`, e.g. a second dev build on the
same machine):

```sh
AGARIC_MCP_SOCKET=/tmp/custom.sock ./scripts/mcp_smoke.py
```

Usage help:

```sh
./scripts/mcp_smoke.py --help
```

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All 9 tools returned schema-valid payloads. |
| 1 | One or more tools failed — structured failure report on stderr. |
| 2 | Argparse / usage error. |

### Not in CI

This script is **never** added to CI and must not be wired into any
`prek` hook. It depends on a live Tauri process and a populated dev
database that no CI runner has. The full contract is enforced by the
Rust-side insta snapshot `snapshot_tool_descriptions` in
`src-tauri/src/mcp/tools_ro.rs` — this script exists to catch the kind
of wire-level regressions that Rust unit tests cannot (e.g. a MCP SDK
version bump changing how `CallToolResult` serialises structured data).
