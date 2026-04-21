#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "mcp>=1.0",
#     "jsonschema>=4.20",
# ]
# ///
"""Manual MCP wire-compat smoke test for the v1 read-only tool surface.

Exercises every v1 MCP read tool (9 of them) against a running
``cargo tauri dev`` build of Agaric, using the same Python MCP SDK that
real agents (Claude Desktop, Cursor, Continue, …) use — so the harness
validates wire compat, not just Rust unit-test parity.

Discovery:

    1. ``$AGARIC_MCP_SOCKET`` env var, if set.
    2. Platform default (matches ``src-tauri/src/bin/agaric-mcp.rs``):

       - Linux:   ``~/.local/share/com.agaric.app/mcp-ro.sock``
       - macOS:   ``~/Library/Application Support/com.agaric.app/mcp-ro.sock``
       - Windows: ``\\\\.\\pipe\\agaric-mcp-ro``

The script launches the ``agaric-mcp`` stdio bridge as a subprocess (via
``mcp.client.stdio.stdio_client``) and runs every tool once with a
representative argument set. Each response is validated against a small
inline JSON Schema — required fields and types only — so accidental
wire-shape changes break the harness while churn in optional fields does
not.

Exit codes:

    0   All 9 tools succeeded and returned schema-valid payloads.
    1   One or more tool calls failed (structured report on stderr).
    2   Argparse / usage error.

Never add this to CI — it depends on a live Tauri process.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import json
import os
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, ValidationError
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

SOCKET_ENV = "AGARIC_MCP_SOCKET"
APP_ID = "com.agaric.app"
MCP_RO_FILENAME = "mcp-ro.sock"
WINDOWS_PIPE_PATH = r"\\.\pipe\agaric-mcp-ro"

# Exact tool surface v1 — order is part of the wire contract, mirror of
# `src-tauri/src/mcp/tools_ro.rs::ReadOnlyTools::list_tools()`.
EXPECTED_TOOLS: tuple[str, ...] = (
    "list_pages",
    "get_page",
    "search",
    "get_block",
    "list_backlinks",
    "list_tags",
    "list_property_defs",
    "get_agenda",
    "journal_for_date",
)


# ---------------------------------------------------------------------------
# Socket-path resolution (mirror of agaric-mcp.rs)
# ---------------------------------------------------------------------------


def default_socket_path() -> Path:
    """Resolve the platform-appropriate default MCP socket path."""
    if sys.platform == "win32":
        return Path(WINDOWS_PIPE_PATH)
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_DATA_HOME")
        base = Path(xdg) if xdg else (Path.home() / ".local" / "share")
    return base / APP_ID / MCP_RO_FILENAME


def resolve_socket_path() -> Path:
    env = os.environ.get(SOCKET_ENV)
    if env:
        return Path(env)
    return default_socket_path()


# ---------------------------------------------------------------------------
# Minimal per-tool JSON schemas
#
# These match the ACTUAL wire shapes returned by `tools_ro.rs` handlers
# (e.g. `PageResponse<BlockRow>` is `{items, has_more, next_cursor}`,
# grouped backlinks are `{groups, has_more, next_cursor}`, list-style
# tools return bare arrays). A full contract is already enforced by the
# `snapshot_tool_descriptions` insta snapshot on the Rust side — here we
# only pin "response is shaped as expected by the call site" so that
# schema drift in optional fields does not break the smoke run.
# ---------------------------------------------------------------------------


BLOCK_ROW_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["id", "block_type"],
    "properties": {
        "id": {"type": "string"},
        "block_type": {"type": "string"},
        "content": {"type": ["string", "null"]},
    },
}

PAGE_RESPONSE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["items", "has_more"],
    "properties": {
        "items": {"type": "array", "items": BLOCK_ROW_SCHEMA},
        "has_more": {"type": "boolean"},
        "next_cursor": {"type": ["string", "null"]},
    },
}

GROUPED_BACKLINK_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["groups", "has_more"],
    "properties": {
        "groups": {"type": "array"},
        "has_more": {"type": "boolean"},
        "next_cursor": {"type": ["string", "null"]},
    },
}

PAGE_SUBTREE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["page", "children", "has_more"],
    "properties": {
        "page": BLOCK_ROW_SCHEMA,
        "children": {"type": "array", "items": BLOCK_ROW_SCHEMA},
        "has_more": {"type": "boolean"},
        "next_cursor": {"type": ["string", "null"]},
    },
}

PROPERTY_DEF_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["key", "value_type"],
    "properties": {
        "key": {"type": "string"},
        "value_type": {"type": "string"},
    },
}

TOOL_SCHEMAS: dict[str, dict[str, Any]] = {
    "list_pages": PAGE_RESPONSE_SCHEMA,
    "get_page": PAGE_SUBTREE_SCHEMA,
    "search": PAGE_RESPONSE_SCHEMA,
    "get_block": BLOCK_ROW_SCHEMA,
    "list_backlinks": GROUPED_BACKLINK_SCHEMA,
    "list_tags": {"type": "array"},
    "list_property_defs": {"type": "array", "items": PROPERTY_DEF_SCHEMA},
    "get_agenda": {"type": "array"},
    "journal_for_date": BLOCK_ROW_SCHEMA,
}


# ---------------------------------------------------------------------------
# CallToolResult payload extraction
# ---------------------------------------------------------------------------


def extract_payload(result: Any) -> Any:
    """Extract the structured JSON payload from a CallToolResult.

    MCP 1.x permits two transport shapes for structured tool output:

    1. ``structuredContent`` — native dict/list on the result (new in the
       2025-06-18 protocol revision).
    2. A single ``text`` content block whose ``text`` field is a
       JSON-encoded string.

    Try structuredContent first, then fall back to text-block parsing.
    Anything else (binary, embedded resource, no content at all) is a
    protocol mismatch for the v1 read surface and raises.
    """
    structured = getattr(result, "structuredContent", None)
    if structured is not None:
        return structured

    content = getattr(result, "content", None) or []
    if not content:
        raise ValueError(
            "tool result has no `content` blocks and no `structuredContent`"
        )

    text_parts: list[str] = []
    for block in content:
        btype = getattr(block, "type", None)
        text = getattr(block, "text", None)
        if btype == "text" and text is not None:
            text_parts.append(text)
        else:
            raise ValueError(
                f"unexpected content-block type {btype!r} "
                f"(v1 tools return JSON-encoded text only)"
            )
    joined = "".join(text_parts)
    try:
        return json.loads(joined)
    except json.JSONDecodeError as e:
        raise ValueError(f"content text is not valid JSON: {e}; raw={joined!r}") from e


def validate_payload(tool: str, payload: Any) -> None:
    schema = TOOL_SCHEMAS[tool]
    validator = Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.absolute_path))
    if errors:
        parts = []
        for err in errors:
            path = "/".join(str(p) for p in err.absolute_path) or "<root>"
            parts.append(f"{path}: {err.message}")
        raise ValidationError("; ".join(parts))


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------


# (tool_name, reason, request_args, response_repr)
Failure = tuple[str, str, dict[str, Any], str]


async def call_and_validate(
    session: ClientSession,
    tool: str,
    args: dict[str, Any],
    failures: list[Failure],
) -> Any:
    """Call one tool and validate its payload.

    On any failure (RPC error, protocol mismatch, schema violation) append
    a structured record to ``failures`` and return ``None`` so chained
    callers can short-circuit their seed lookups.
    """
    try:
        result = await session.call_tool(tool, args)
    except Exception as e:  # noqa: BLE001 — we want ANY failure surfaced
        failures.append(
            (tool, f"call_tool raised {type(e).__name__}: {e}", args, "<no response>")
        )
        return None

    if getattr(result, "isError", False):
        payload_repr = "<error result>"
        try:
            payload_repr = repr(extract_payload(result))[:500]
        except Exception as inner:  # noqa: BLE001
            payload_repr = f"<error result; extract failed: {inner}>"
        failures.append((tool, "server returned isError=true", args, payload_repr))
        return None

    try:
        payload = extract_payload(result)
    except Exception as e:  # noqa: BLE001
        failures.append(
            (tool, f"could not extract payload: {e}", args, repr(result)[:500])
        )
        return None

    try:
        validate_payload(tool, payload)
    except ValidationError as e:
        failures.append(
            (tool, f"schema mismatch: {e.message}", args, repr(payload)[:500])
        )
        return None

    return payload


def _first_page_id(pages_payload: Any) -> str | None:
    if not isinstance(pages_payload, dict):
        return None
    items = pages_payload.get("items")
    if not isinstance(items, list) or not items:
        return None
    first = items[0]
    if not isinstance(first, dict):
        return None
    first_id = first.get("id")
    return first_id if isinstance(first_id, str) else None


async def run_smoke(socket_path: Path) -> int:
    env = dict(os.environ)
    env[SOCKET_ENV] = str(socket_path)

    server_params = StdioServerParameters(
        command="agaric-mcp",
        args=[],
        env=env,
    )

    failures: list[Failure] = []

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # Advertised tool surface --------------------------------------
            tools_result = await session.list_tools()
            advertised = [t.name for t in tools_result.tools]
            if len(advertised) != 9:
                failures.append(
                    (
                        "list_tools",
                        f"expected exactly 9 tools, got {len(advertised)}",
                        {},
                        repr(advertised),
                    )
                )
            missing = [t for t in EXPECTED_TOOLS if t not in advertised]
            if missing:
                failures.append(
                    (
                        "list_tools",
                        f"expected tools missing from list_tools(): {missing!r}",
                        {},
                        repr(advertised),
                    )
                )
            unexpected = [t for t in advertised if t not in EXPECTED_TOOLS]
            if unexpected:
                failures.append(
                    (
                        "list_tools",
                        f"unexpected tools in list_tools(): {unexpected!r}",
                        {},
                        repr(advertised),
                    )
                )

            today = datetime.date.today().isoformat()

            # Seed --------------------------------------------------------
            # Strategy: prefer the real `list_pages` result as seed (matches
            # the "assume a dev build with data" spec). On a fresh DB with
            # no pages, fall back to `journal_for_date` which idempotently
            # creates a page for today and is therefore always available
            # as a source of a valid block id.

            pages_payload = await call_and_validate(
                session, "list_pages", {"limit": 10}, failures
            )
            seed_id = _first_page_id(pages_payload)

            if seed_id is None:
                journal_payload = await call_and_validate(
                    session, "journal_for_date", {"date": today}, failures
                )
                if isinstance(journal_payload, dict):
                    jid = journal_payload.get("id")
                    if isinstance(jid, str):
                        seed_id = jid
                journal_called = True
            else:
                journal_called = False

            # Dependent calls --------------------------------------------
            if seed_id is not None:
                await call_and_validate(
                    session, "get_page", {"page_id": seed_id}, failures
                )
                await call_and_validate(
                    session, "get_block", {"block_id": seed_id}, failures
                )
                await call_and_validate(
                    session,
                    "list_backlinks",
                    {"block_id": seed_id, "limit": 10},
                    failures,
                )
            else:
                for dep in ("get_page", "get_block", "list_backlinks"):
                    failures.append(
                        (
                            dep,
                            "no seed block id available "
                            "(list_pages + journal_for_date both failed to produce one)",
                            {},
                            "",
                        )
                    )

            # Remaining tools --------------------------------------------
            await call_and_validate(
                session, "search", {"query": "a", "limit": 10}, failures
            )
            await call_and_validate(session, "list_tags", {"limit": 10}, failures)
            await call_and_validate(session, "list_property_defs", {}, failures)
            await call_and_validate(
                session,
                "get_agenda",
                {"start_date": today, "end_date": today},
                failures,
            )
            if not journal_called:
                await call_and_validate(
                    session, "journal_for_date", {"date": today}, failures
                )

    return _report(failures)


def _report(failures: list[Failure]) -> int:
    if not failures:
        print("[ok] 9/9 tools passed")
        return 0

    # De-dup on (tool, reason) so a single missing seed does not noisy-spam
    # stderr; keep the first occurrence of each.
    seen: set[tuple[str, str]] = set()
    uniq: list[Failure] = []
    for f in failures:
        key = (f[0], f[1])
        if key in seen:
            continue
        seen.add(key)
        uniq.append(f)

    print(f"[FAIL] {len(uniq)} failure(s):", file=sys.stderr)
    for tool, reason, args, response in uniq:
        print(f"[FAIL] {tool}: {reason}", file=sys.stderr)
        print(f"  request: {args}", file=sys.stderr)
        print(f"  response: {response}", file=sys.stderr)
    return 1


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mcp_smoke.py",
        description=(
            "Manual MCP wire-compat smoke test. Exercises every v1 MCP read "
            "tool against a running `cargo tauri dev` build of Agaric."
        ),
        epilog=(
            "Environment:\n"
            f"  {SOCKET_ENV}   Override the MCP socket / pipe path (default:\n"
            "                        platform-appropriate path under "
            f"com.agaric.app).\n"
            "\n"
            "Exit codes:\n"
            "  0  all 9 tools passed\n"
            "  1  one or more tools failed (see stderr)\n"
            "  2  argparse / usage error\n"
            "\n"
            "Never run this in CI — it requires a live Tauri process."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    return parser


def main() -> int:
    build_arg_parser().parse_args()
    socket_path = resolve_socket_path()

    try:
        return asyncio.run(run_smoke(socket_path))
    except FileNotFoundError as e:
        # Most likely `agaric-mcp` not on PATH or socket missing.
        print(
            f"[FAIL] could not launch agaric-mcp / reach socket at {socket_path}: {e}",
            file=sys.stderr,
        )
        return 1
    except KeyboardInterrupt:
        print("[FAIL] interrupted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
