#!/usr/bin/env python3
"""Enforce the tauri-specta 10-argument command ceiling (#1317).

The `tauri-specta` IPC bridge codegen has a HARD 10-argument limit per
`#[tauri::command]`. Tauri `State<'_, T>` params are injected by the
runtime (they don't appear in `bindings.ts`), but they still cost a Rust
signature slot and so count toward the same 10-arg budget. Documented in
`src-tauri/src/commands/AGENTS.md` § "`tauri-specta` 10-argument ceiling"
with the `WriteCtx` bundling solution (#1056) — but until #1317 NOTHING
enforced it: an 11-param `#[tauri::command]` compiles cleanly and fails
only later, at specta-export / IPC time, far from the edit.

This hook converts the documented ceiling into the same enforced-contract
class as its siblings (check-raw-tx, check-dynamic-sql, unsafe-allowlist).
It scans `src-tauri/src/commands/**/*.rs` for every function annotated
`#[tauri::command]` (the attribute may carry args like
`#[tauri::command(rename_all = "...")]` and may be separated from the
`fn` by other attributes / doc-comment lines), parses the parameter list
between the `fn name(` open paren and its MATCHING close paren (params may
span multiple lines and contain nested generics / tuples / closures —
counted with bracket-depth tracking, not a naive `,` split), counts ALL
declared params (INCLUDING `State<...>`, conservative per #1317 since they
share the Rust slot budget), and FAILS listing any command whose count
exceeds 10, with `file:line` and a pointer at the AGENTS.md ceiling
section and the `WriteCtx` / request-struct bundling pattern.

Comment/string handling reuses check-raw-tx.py's battle-tested
`strip_rust_comments` (so a `#[tauri::command]` mentioned in a comment or
string never fires, and commented-out param lines are skipped).

Invocation: prek passes the set of changed files as argv (hook id
`check-command-arity`). Run manually over the whole tree with:

    python3 scripts/check-command-arity.py $(git ls-files 'src-tauri/src/commands/*.rs')

or simply with no args (scans the whole commands tree):

    python3 scripts/check-command-arity.py

Self-test:

    python3 scripts/check-command-arity.py --self-test

Stdlib only — no third-party deps.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
COMMANDS_DIR = REPO_ROOT / "src-tauri" / "src" / "commands"

MAX_ARGS = 10

# Reuse the battle-tested comment-stripper (and its #818 fixes) from the
# raw-tx guard rather than re-deriving it. It blanks line/block comments
# and string bodies while preserving newlines, so line numbers stay exact
# and a `#[tauri::command]` inside a comment or string never fires.
_spec = importlib.util.spec_from_file_location(
    "_check_raw_tx", REPO_ROOT / "scripts" / "check-raw-tx.py"
)
assert _spec and _spec.loader
_crt = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_crt)

strip_rust_comments = _crt.strip_rust_comments

# Matches the `#[tauri::command]` attribute, with or without args, e.g.
# `#[tauri::command]` or `#[tauri::command(rename_all = "snake_case")]`.
# Whitespace inside the brackets is tolerated.
COMMAND_ATTR_RE = re.compile(r"#\[\s*tauri::command\b")

# Finds the start of a function definition and captures its name. Tauri
# commands are `pub async fn name(` (also plain `fn`, `pub(crate) fn`, …).
# We deliberately stop at the name: the optional generic-parameter list
# (`<T: Into<Vec<u8>>>`, `<const N: usize>`, lifetimes, where-bounds) can
# itself contain nested `<...>`, which a flat `<[^>]*>` would mis-balance
# — silently failing to find the `(` and dropping the command entirely
# (a FALSE NEGATIVE). Instead we locate the `(` by depth-scanning past any
# balanced `<...>` generic list (see `find_param_open` below).
FN_START_RE = re.compile(r"\bfn\s+(?P<name>\w+)")

HINT = (
    "    -> #1317: a `#[tauri::command]` may declare at most "
    f"{MAX_ARGS} parameters. The tauri-specta IPC bridge has a hard\n"
    f"       {MAX_ARGS}-argument ceiling per command; `State<'_, T>` "
    "params count toward it (they cost a Rust signature slot even\n"
    "       though they don't appear in bindings.ts). Bundle args to "
    "get back under the ceiling:\n"
    "         * write commands: take ONE `ctx: State<'_, WriteCtx>` "
    "instead of pool + device_id + materializer (#1056);\n"
    "         * user args: collapse related fields into a request "
    "struct with `#[serde(default)]` (SearchFilter, AgendaQuery, …).\n"
    "       See src-tauri/src/commands/AGENTS.md "
    '§ "tauri-specta 10-argument ceiling".'
)

# Bracket pairs tracked with a depth stack. `<`/`>` are tracked as a pair
# too (for generics like `State<'_, T>`), but a `>` is only treated as a
# closer when a matching `<` is actually open — so a stray `>` from a
# `->` return arrow (closures, `Fn(..) -> T`) or a `>=`/`>>` operator
# never decrements depth.
_OPENERS = {"(": ")", "[": "]", "{": "}", "<": ">"}
_CLOSERS = {")": "(", "]": "[", "}": "{", ">": "<"}


def count_params(param_src: str) -> int:
    """Count top-level params in the text BETWEEN a fn's parens.

    Splits on top-level commas only: commas nested inside generics
    (`State<'_, T>`, `HashMap<K, V>`), tuples (`(a, b)`), arrays, or
    closure bodies (`{ ... }`) don't separate params. Trailing comma and
    empty parens are handled. A `>` from a `->` arrow (`Fn(..) -> T`) is
    not treated as a bracket. `param_src` is the inner text only (no
    surrounding parens).
    """
    stack: list[str] = []
    has_token = False
    params = 0
    n = len(param_src)
    for i in range(n):
        ch = param_src[i]
        if ch in _OPENERS:
            stack.append(ch)
            has_token = True
        elif ch in _CLOSERS:
            # Pop only if the matching opener is actually on top. This
            # makes `>` from `->`/`>=`/`>>` (no open `<`) a no-op.
            if stack and stack[-1] == _CLOSERS[ch]:
                stack.pop()
            has_token = True
        elif ch == "," and not stack:
            params += 1
            has_token = False
        elif not ch.isspace():
            has_token = True
    if has_token:
        params += 1
    return params


def find_param_open(text: str, start: int) -> int:
    """Return the index of the `(` that opens the param list.

    `start` is the index just past the function NAME. Between the name and
    the param-list `(` Rust allows only whitespace and an optional
    generic-parameter list `<...>` (which may itself nest, e.g.
    `<T: Into<Vec<u8>>>`, `<const N: usize>`, lifetimes, bounds). We skip
    whitespace, then — if a `<` is present — consume a depth-balanced
    `<...>` block, then expect the `(`. Returns the `(` index, or -1 if the
    next non-whitespace token isn't a `<` or `(` (not actually a fn def).
    """
    n = len(text)
    i = start
    while i < n and text[i].isspace():
        i += 1
    if i < n and text[i] == "<":
        depth = 0
        while i < n:
            ch = text[i]
            if ch == "<":
                depth += 1
            elif ch == ">":
                depth -= 1
                if depth == 0:
                    i += 1
                    break
            i += 1
        else:
            return -1
        while i < n and text[i].isspace():
            i += 1
    if i < n and text[i] == "(":
        return i
    return -1


def matching_paren_end(text: str, open_idx: int) -> int:
    """Return the index of the `)` matching the `(` at `open_idx`.

    Tracks `()[]{}` nesting so a `(` inside a tuple/closure in the param
    list doesn't prematurely close. `<`/`>` are NOT tracked here — the
    param list is delimited by round parens, and tracking angle brackets
    would mis-handle a `->` arrow's `>`. Returns -1 if unbalanced.
    """
    depth = 0
    i = open_idx
    n = len(text)
    paren_openers = {"(", "[", "{"}
    paren_closers = {")", "]", "}"}
    while i < n:
        ch = text[i]
        if ch in paren_openers:
            depth += 1
        elif ch in paren_closers:
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def find_command_arities(text: str) -> list[tuple[str, int, int]]:
    """Find every `#[tauri::command]` fn and its param count.

    Returns a list of `(fn_name, line_number, param_count)` (1-based
    line of the `fn` keyword). Operates on COMMENT-STRIPPED text so
    commented-out attributes / params never fire and line numbers match
    the original file (the stripper preserves newlines).
    """
    results: list[tuple[str, int, int]] = []
    for attr in COMMAND_ATTR_RE.finditer(text):
        # From the attribute, scan forward to the next `fn NAME(` that
        # starts a function. Intervening lines may be other attributes
        # (`#[specta::specta]`), doc comments (already blanked), or
        # visibility/qualifier tokens — all fine; we just need the next
        # `fn` opener. Guard against running into ANOTHER `#[tauri::
        # command]` first (malformed input) by bounding the search.
        rest = text[attr.end():]
        fn_match = FN_START_RE.search(rest)
        if not fn_match:
            continue
        # If another `#[tauri::command]` appears before the fn, this
        # attribute has no fn of its own — skip (defensive).
        next_attr = COMMAND_ATTR_RE.search(rest)
        if next_attr and next_attr.start() < fn_match.start():
            continue
        name = fn_match.group("name")
        # Absolute index just past the fn NAME; from there, skip any
        # (possibly nested) generic-parameter list to the param-list `(`.
        name_end_abs = attr.end() + fn_match.end()
        open_paren_abs = find_param_open(text, name_end_abs)
        if open_paren_abs < 0:
            continue
        close_paren_abs = matching_paren_end(text, open_paren_abs)
        if close_paren_abs < 0:
            continue
        param_src = text[open_paren_abs + 1:close_paren_abs]
        count = count_params(param_src)
        line_no = text.count("\n", 0, attr.end() + fn_match.start("name")) + 1
        results.append((name, line_no, count))
    return results


def all_command_files() -> list[Path]:
    if not COMMANDS_DIR.exists():
        return []
    return sorted(COMMANDS_DIR.rglob("*.rs"))


def check_file(path: Path) -> list[str]:
    """Return violation strings for `path` (commands over the ceiling)."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    stripped = strip_rust_comments(text)
    rel = _rel(path)
    violations: list[str] = []
    for name, line_no, count in find_command_arities(stripped):
        if count > MAX_ARGS:
            violations.append(
                f"{rel}:{line_no}: `{name}` declares {count} params "
                f"(max {MAX_ARGS})"
            )
    return violations


def _rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def run_self_test() -> int:
    """Assert the parser flags an 11-param command and accepts a 10-param one.

    Drives `find_command_arities` against synthetic fixtures covering the
    edge cases the real parser must survive: multiline signatures, nested
    generics / tuples in a single param (must NOT inflate the count), an
    attribute with args, an intervening `#[specta::specta]` line, a
    commented-out `#[tauri::command]` (must NOT fire), and the exact
    10-vs-11 boundary.
    """
    failures: list[str] = []

    def arity_of(src: str, fn_name: str) -> int | None:
        stripped = strip_rust_comments(src)
        for name, _line, count in find_command_arities(stripped):
            if name == fn_name:
                return count
        return None

    def expect(name: str, src: str, fn: str, want: int) -> None:
        got = arity_of(src, fn)
        if got != want:
            failures.append(f"{name}: expected {want} params, got {got!r}")

    def expect_absent(name: str, src: str, fn: str) -> None:
        got = arity_of(src, fn)
        if got is not None:
            failures.append(
                f"{name}: expected no `#[tauri::command]` detection for "
                f"`{fn}`, got {got}"
            )

    # 11 params on a multiline signature including a State and nested
    # generics — must be flagged (count 11, > 10).
    eleven = """
#[tauri::command]
#[specta::specta]
pub async fn over_ceiling(
    ctx: tauri::State<'_, WriteCtx>,
    a: String,
    b: Option<i64>,
    c: Vec<u8>,
    d: HashMap<String, i64>,
    e: (String, i64),
    f: bool,
    g: u32,
    h: f64,
    i: String,
    j: Option<String>,
) -> Result<(), AppError> { unimplemented!() }
"""
    expect("11-param flagged", eleven, "over_ceiling", 11)
    if (n := arity_of(eleven, "over_ceiling")) is None or n <= MAX_ARGS:
        failures.append("11-param command was NOT over the ceiling")

    # Exactly 10 params — must be accepted (count 10, not > 10).
    ten = """
#[tauri::command]
pub async fn at_ceiling(
    a: String, b: String, c: String, d: String, e: String,
    f: String, g: String, h: String, i: String, j: String,
) -> Result<(), AppError> { todo!() }
"""
    expect("10-param accepted", ten, "at_ceiling", 10)
    if (n := arity_of(ten, "at_ceiling")) is not None and n > MAX_ARGS:
        failures.append("10-param command was incorrectly over the ceiling")

    # Attribute WITH args, single line of params with nested commas that
    # must NOT inflate the count: 2 params.
    with_args = """
#[tauri::command(rename_all = "snake_case")]
pub fn two_params(map: HashMap<String, Vec<(u8, u8)>>, flag: bool) -> () {}
"""
    expect("nested generics not split", with_args, "two_params", 2)

    # Zero-param command.
    zero = """
#[tauri::command]
pub async fn no_params() -> Result<String, AppError> { todo!() }
"""
    expect("zero params", zero, "no_params", 0)

    # Commented-out attribute must NOT be detected.
    commented = """
// #[tauri::command]
pub async fn not_a_command(a: String, b: String) -> () {}
"""
    expect_absent("commented attribute ignored", commented, "not_a_command")

    # A closure param body with commas inside braces must not split.
    closure = """
#[tauri::command]
pub fn with_closure(cb: impl Fn(i32, i32) -> i32, x: i32) -> i32 { x }
"""
    expect("closure arg not split", closure, "with_closure", 2)

    # A NESTED generic in the fn's own generic-parameter list
    # (`<T: Into<Vec<u8>>>`) must not derail name/paren location — the
    # command (11 params) MUST still be detected and flagged. A flat
    # `<[^>]*>` match would stop at the first `>` and silently drop it.
    nested_generic = """
#[tauri::command]
pub async fn nested_generic<T: Into<Vec<u8>>>(
    a: i32, b: i32, c: i32, d: i32, e: i32, f: i32,
    g: i32, h: i32, i: i32, j: i32, k: T,
) -> i32 { 0 }
"""
    expect("nested generic bound detected", nested_generic, "nested_generic", 11)
    if (n := arity_of(nested_generic, "nested_generic")) is None or n <= MAX_ARGS:
        failures.append("nested-generic 11-param command was NOT over the ceiling")

    if failures:
        print("check-command-arity self-test FAILED:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print("check-command-arity self-test passed (8 cases).")
    return 0


def main(argv: list[str]) -> int:
    if "--self-test" in argv:
        return run_self_test()

    # Determine targets. prek passes changed files; a manual no-arg run
    # scans the whole commands tree. Either way, only police
    # `src-tauri/src/commands/**/*.rs`.
    file_args = [a for a in argv if not a.startswith("-")]
    if file_args:
        targets: list[Path] = []
        for arg in file_args:
            p = Path(arg)
            if p.suffix != ".rs":
                continue
            rel = _rel(p)
            if not rel.startswith("src-tauri/src/commands/"):
                continue
            if not p.is_file():
                continue
            targets.append(p)
    else:
        targets = all_command_files()

    violations: list[str] = []
    for p in targets:
        violations.extend(check_file(p))

    if violations:
        print(
            "tauri-specta arity guard (#1317) — `#[tauri::command]`(s) "
            f"over the {MAX_ARGS}-argument ceiling:\n",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        print("", file=sys.stderr)
        print(HINT, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
