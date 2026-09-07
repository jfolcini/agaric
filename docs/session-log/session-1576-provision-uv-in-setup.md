# Session 1576 — install `uv` in setup-hooks.sh so zizmor can install at all

Follow-up to #4808, which swapped `scripts/setup-hooks.sh`'s zizmor fast path
from `pip install --user` to `uv tool install`. That PR shipped with a known
gap, recorded in session-1563 and raised on the PR: the branch is gated on
`have uv`, nothing provisions `uv`, and the session log described the
consequence as zizmor falling back to "the multi-minute `cargo install` the
branch was added to avoid". Measured here, that description was too kind — the
correction this log exists to record.

Reproduced on a Claude Code on the web sandbox, which is the environment in
question (`api.github.com/graphql` answers 403 through the proxy, the #2535
symptom):

- `cargo binstall -y zizmor@1.28.0` — its GitHub GraphQL lookup is 403'd, so it
  falls back to a source build, which dies in 8.8 s: `tree-sitter-iter@1.30.0
  requires rustc 1.97.0`, and `rust-toolchain.toml` pins 1.95.0.
- `cargo install --locked zizmor@1.28.0` — same MSRV failure in 5.0 s.
- `uv tool install --reinstall "zizmor==1.28.0"` — exits 0 in 0.6 s, and
  `zizmor --version` reports `zizmor 1.28.0`.

So the PyPI wheel path is not a fast path, it is the only path: driving
`cargo_get_pinned zizmor 1.28.0` from a clean state with `uv` on PATH lands the
pin in 6 s, and the same call with `uv` hidden from PATH installs nothing and
warns `could not install zizmor@1.28.0 — run: cargo install --locked
zizmor@1.28.0` — advice that is itself the command that just failed. Without
`uv`, a fresh clone gets no zizmor and the push hook quietly loses its workflow
audit.

That settles the choice session-1563 left to the maintainer. "Delete the branch
and let binstall → `cargo install` carry it" is off the table: on this repo's
pinned toolchain neither cargo path can install this zizmor. So `ensure_uv`
installs it, best-effort, from a pinned release tarball with a pinned digest,
before the `cargo_get_pinned zizmor` call it exists for.

## Two things the first draft got wrong

Both were caught in review of #4811 and are recorded here because the reasoning,
not just the diff, was wrong.

**It fetched and ran upstream's install script.** The first draft used
`retry curl -fsSL https://astral.sh/uv/<ver>/install.sh -o <tmp>` and then
`sh <tmp>`, arguing it was the same shape as the `nvm.sh` fetch in `setup.sh`.
`scripts/setup-hooks.sh` already documents why that is the wrong precedent to
copy: Scorecard's Pinned-Dependencies flags a `curl | bash` *or* a
curl-to-temp-then-run "regardless of any hash check, because the static check
only cares that a downloaded file reaches a shell interpreter" (#215). Trading
one Pinned-Dependencies finding for another is not a fix. `ensure_uv` now
mirrors `ensure_cargo_binstall` exactly — pinned release tarball, pinned
SHA-256 verified before extraction, `install` the binaries, nothing handed to
an interpreter. The two digests match the `<tarball>.sha256` files upstream
publishes beside each artifact. `uvx` is installed alongside `uv` because it is
the binary `.mcp.json` names.

**It lived in `setup.sh`.** `just install-hooks` and a direct
`scripts/setup-hooks.sh` run never reach `setup.sh`, and those are exactly the
paths `setup.sh`'s own remedy line and `docs/BUILD.md` point a developer at
when a tool is missing — so following the documented advice would have
reinstalled every other tool and still left zizmor absent. Moving `ensure_uv`
into `setup-hooks.sh` closes all three entry points (`setup.sh` calls it) and
drops the ordering constraint the `setup.sh` version had to assert in a
comment.

**And then it sat inside the cargo gate.** The first `setup-hooks.sh` draft put
the call in the `else` of `if ! have cargo`, next to `ensure_cargo_binstall`.
uv needs no cargo, and this PR's own `docs/BUILD.md` edit tells a reader that
`setup-hooks.sh` installs the uv that `.mcp.json`'s code-review-graph runs on —
so on a Rust-less box that reader would have got "Skipping the cargo-based
tools" and no uv, for a reason unrelated to what they wanted it for. The call
is now above the gate. It also installs into `~/.local/bin`, uv's own default
and already exported onto PATH by this script, rather than `~/.cargo/bin`:
`ensure_cargo_binstall` uses the latter because it installs a cargo tool, and
copying that for uv would have fabricated a `~/.cargo` on a machine with no
Rust.

## Verification

Four paths run rather than reasoned about, each against a throwaway `$HOME`
with `uv` removed from `PATH`:

1. `uv` already present — `✓ uv (already installed)`, no network.
2. `uv` absent, real digests, and no cargo anywhere on `PATH` — 1.7 s, `✓ uv
   0.8.17 (prebuilt, x86_64-unknown-linux-musl)`, `uv` and `uvx` both in
   `$HOME/.local/bin` and both reporting 0.8.17, with no `~/.cargo` created.
3. `uv` absent, digest corrupted to zeros — warns, installs nothing, leaves no
   temp dir. This is the falsification for `verify_sha256`: without it, case 2
   and case 3 would be indistinguishable.
4. An unsupported platform (`OS` forced to `Darwin-ppc`, and `Windows_NT`) —
   warns that zizmor will be missing and returns.

Each of the four `case` arms was also driven with a stubbed fetch to confirm it
pairs the right triple with the right digest; a swapped pair would fail closed
in `verify_sha256` and silently cost that platform its zizmor.

End-to-end with the musl binary case 2 produced as the only `uv` on `PATH`:
`cargo_get_pinned zizmor 1.28.0` prints `✓ zizmor 1.28.0 (uv tool, linked into
~/.cargo/bin)`, the ~5 s binstall failure included.

Both digests were checked against the `<tarball>.sha256` Astral publishes
beside each artifact, x86_64 and aarch64 alike; only the x86_64 one is
exercised by a run here, same as the existing binstall pins.

`ensure_uv` fetches from `github.com`, which this script's header (#2535)
warns can be 403'd — so the run above was checked to be on the restricted
sandbox rather than an unrestricted box, and the phrase in that header turns
out to cover two hosts of which only one is blocked here:

| URL | result |
|-----|--------|
| `api.github.com/graphql` (what binstall resolves through) | 403 |
| `github.com/astral-sh/uv/releases/download/0.8.17/uv-*.tar.gz` | 200, 21,269,346 bytes (x86_64) / 19,553,086 (aarch64) |
| `releases.astral.sh/github/uv/releases/download/0.8.17/uv-*.tar.gz` | 200, byte-identical sizes |

So `ensure_uv` needs no second host on the environment it exists for, which is
why it has none — `install_lychee`'s GitHub tarball fetch works here for the
same reason. A sandbox where the release-download host is *also* 403'd would
want the `releases.astral.sh` mirror as a fallback, digest-verified either way;
that one is not written, because it is not one this session could reproduce.

`shellcheck --severity=warning scripts/setup-hooks.sh` is clean, as it was
before the change; at default severity it reports only the six pre-existing
SC1091/SC2016 info notes, none of them in the new function.

## macOS, which the first draft got wrong

Review caught it: the `case` covered Linux only, copying
`ensure_cargo_binstall`'s matrix, and the fallthrough said "zizmor falls back to
cargo". That precedent does not carry. binstall's Linux-only matrix is fine
because its `cargo install --locked` fallback genuinely works; zizmor's does
not, and the reason — `rust-toolchain.toml`'s pin against zizmor's dependency
tree — is the same on every arch. So an Apple Silicon contributor running `just
install-hooks` got no zizmor and a message implying a working path. Both Darwin
arms are now present, and the fallthrough says the truth: zizmor will be
missing. Their digests were fetched and computed here, matching upstream's
sidecars — `aarch64-apple-darwin` first try, `x86_64-apple-darwin` only after a
504 truncated the transfer and produced the SHA of empty input, which is worth
recording as the way this check fails misleadingly if a digest is pasted
without recomputing it.

## Two corrections review made to this session's own wording

The macOS fix above overcorrected. "zizmor will be MISSING; its cargo fallback
cannot build it on the pinned toolchain" reads as unconditional and is not: the
MSRV wall only bites once binstall has been pushed into its *source-build*
fallback. On a box whose `api.github.com` is reachable, `cargo binstall -y
zizmor@1.28.0` fetches the prebuilt and succeeds — so on an arch outside the uv
matrix with working egress, that message announced a missing tool and then
watched it install. Both warnings now say *may* be missing, and name what it
rests on. Going from "falls back to cargo" (too optimistic) to "will be
MISSING" (too pessimistic) in consecutive rounds is worth recording as its own
small lesson: the accurate claim was conditional, and both absolutes were
cheaper to write than the condition.

The comment above `ensure_uv` was also cut from 22 lines to 13. Most of what
went was comparison with its two neighbours — the kind of thing AGENTS.md
§ Say it once puts in a session log, which is where it already was.

## Not changed

The `cargo install --locked ${crate}@${version}` remedy `cargo_get_pinned`
prints on failure is dead advice for zizmor while the MSRV gap holds.
Special-casing one crate's warning in a generic function buys a better message
in the doubly-degraded case (no `uv` *and* a failed tarball fetch) at the cost
of a crate-specific branch that stops being true the moment `rust-toolchain.toml`
moves past 1.97.0.

A `fetch_pinned_tarball` helper was raised three times in review, on the
grounds that `ensure_uv` is the third copy of mktemp-guard → curl →
`verify_sha256` → tar → `install`. It is the second. `install_lychee` only
looks like the third: it fetches `releases/latest` (unpinned), pipes
`curl | tar` with no `-o` and no digest at all, so there is nothing for a
verifying helper to verify. Extracting across all three would mean either
giving lychee a pinned digest — a policy change well outside this PR — or an
optional-verification mode, which discards the property that makes the helper
worth extracting. Two genuine copies is not yet the threshold.
