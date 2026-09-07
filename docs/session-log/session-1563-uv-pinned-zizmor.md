# Session 1563 — pin the zizmor wheel install with uv

Code-scanning alert #273 (Scorecard `Pinned-Dependencies`, the only actionable
one of the four open alerts) flagged `scripts/setup-hooks.sh:352`, the PyPI
fast path `python3 -m pip install --user "zizmor==${version}"`. Its message is
exact: *"pipCommand not pinned by hash"*. The version pin was never the
problem — `==` is already an exact pin — the finding is that Scorecard's
detector matches `pip install` invocations and wants `--require-hashes`, which
means a requirements file carrying a hash per artifact, for a tool whose
version already has a single source of truth in `scripts/zizmor-hook.sh`.

Swapped it for `uv tool install --reinstall "zizmor==${version}"`. That closes
the alert because it is not a pip command, and it is a real improvement on two
counts: the tool lands in its own isolated environment rather than the user
site-packages shared with every other `pip --user` install, and `--reinstall`
makes a differing cached build lose to the requested pin.

What it does **not** change, stated because the first draft of this log claimed
otherwise: the binary's location. `uv tool dir --bin` defaults to
`~/.local/bin` — the same already-on-`$PATH` directory `pip install --user`
wrote to. The symlink into `~/.cargo/bin` and the `--version` assertion that
follows are unchanged, and that assertion remains the only thing that proves
which binary actually landed (#3476).

Verified live at the current pin: `uv tool install` exits 0 and
`~/.local/bin/zizmor --version` reports `zizmor 1.28.0`, matching
`ZIZMOR_PINNED_VERSION`. `shellcheck scripts/setup-hooks.sh` reports only the
two pre-existing info notes (SC1091, SC2016).

Known gap, raised on the PR rather than fixed here: the fast path is gated on
`have uv`, and `uv` is not provisioned by `scripts/setup.sh`. On the
egress-restricted sandbox this branch exists for (#2535, where binstall's
GitHub lookup is 403'd) `python3` is present but `uv` is not, so zizmor now
takes the multi-minute `cargo install` the branch was added to avoid. Closing
that means provisioning `uv` in `setup.sh` — already a documented soft prereq
for `scripts/mcp_smoke.py` and for `.mcp.json`'s `code-review-graph` — which is
a change to the project's setup contract and a maintainer call, not something
to guess at from the network assumptions of one machine.

The other three open alerts were dismissed rather than fixed: #275 and #276
(`rust/cleartext-logging`) point at `assert!` failure messages inside
`loro_sync_tests.rs`, a `#[cfg(test)]` module with no log sink; #274
(`rust/non-https-url`) is the deliberate `http` arm of `validate_url_target`,
whose control is the #2661 SSRF guard, not scheme enforcement.
