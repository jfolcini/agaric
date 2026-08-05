# Session 1267 — a Dependabot group edited a manifest it was scoped away from

## What #3432 actually was

The PR was titled `chore(cargo): bump the fuzz group across 1 directory with 2 updates`, and `.github/dependabot.yml` scopes that group to `/src-tauri/fuzz`. It changed two files:

```
src-tauri/Cargo.toml      +1/-1     <-- not in /src-tauri/fuzz
src-tauri/fuzz/Cargo.lock +9/-8
```

The one-line manifest change moved `rmcp` from `^2.0` to `^3.0` — a major version, in the **shared** app manifest, with no source migration and no regeneration of `src-tauri/Cargo.lock`. That lock still pinned `rmcp 2.2.0`, which does not satisfy `^3.0`, so `--locked` builds break and unlocked builds silently rewrite the committed lockfile that `cargo audit`, `deny.toml`, and the release build all read.

Six checks were failing, `validate / mcp-tests` among them — the job covering exactly the surface rmcp 3.0 breaks.

## Why a fuzz-scoped group can edit the app manifest

`src-tauri/fuzz` is a genuinely independent workspace, which is what the config comment asserts. But the fuzz crate takes `agaric` as a **path** dependency, so Dependabot fetches the parent manifest as part of resolving that directory — and will edit it when a bump requires it.

Which bumps require it is decided by `versioning-strategy`, and cargo's default is `increase-if-necessary`. That is the whole mechanism:

| dep | declared | new version | satisfies? | result |
|---|---|---|---|---|
| `mdns-sd` | `"0.20"` (`Cargo.toml:334`) | 0.20.3 | yes | lockfile only |
| `rmcp` | `^2.0` | 3.0 | **no** | **manifest rewritten** |

So this was not a one-off. Every future major from that group would land the same split, under a title claiming the change is confined to `/src-tauri/fuzz`.

## The fix

`versioning-strategy: lockfile-only` on the `/src-tauri/fuzz` entry. Chosen against the schema and dependabot-core's source rather than by guessing, and two alternatives were rejected on evidence:

- **`allow: [dependency-type: indirect]`** does not work. `mdns-sd` is declared in a manifest Dependabot fetched, so it is classified **direct** — an `indirect` filter would exclude the very bumps the entry exists for. The PR's own behaviour disproves the theory.
- **An explicit `allow` name-list** would work but rots silently. The fuzz crate's only versioned direct dep is `libfuzzer-sys`; everything else is a path dep, so a name-list would also have killed the lockfile refreshes this entry is for.

`cargo/lib/dependabot/cargo/update_checker.rb` gates on `requirements_unlocked_or_can_be?` returning `!requirements_update_strategy.lockfile_only?`, and `requirements_updater.rb` short-circuits with `return requirements if update_strategy.lockfile_only?`. Cargo enforces it by refusing to unlock requirements at all, so it *cannot* emit a manifest edit.

**Trade-off accepted and documented in the config:** a `libfuzzer-sys` major would now be skipped. Those are coupled to the cargo-fuzz CLI version and need a hand-written migration regardless.

## The safe half, landed

`mdns-sd` 0.20.2 → 0.20.3 fixes a real panic in `write_utf8` on labels longer than 63 bytes. Main's lock was already at 0.20.3; only the fuzz lock lagged. Regenerated with `cargo update -p mdns-sd --precise 0.20.3`, not hand-edited.

The re-resolve produced 16 changed lines rather than 2, which was checked rather than accepted:

```
packages before: 793  after: 793
removed: [('agaric', '0.9.2'), ('mdns-sd', '0.20.2')]
added:   [('agaric', '0.9.3'), ('mdns-sd', '0.20.3')]
```

The package-version set is otherwise byte-identical. The other 14 lines re-point 11 `cfg(windows)` edges among versions already present, because `errno 0.3.14` and `rustix 1.1.4` both declare `windows-sys = ">=0.52, <0.62"` and `winapi-util 0.1.11` declares `">=0.48.0, <=0.61.*"` — any re-resolve re-decides their unification. Confirmed not attributable to mdns-sd: its two manifests differ only in the `version` line, and a re-resolve with no dep bump produces a 1-line diff. The `agaric 0.9.2 → 0.9.3` line is the path dep catching up to the release bump, which the fuzz lock was also stale on.

## Verification

```
src-tauri       -> exit 0    # cargo metadata --locked
src-tauri/fuzz  -> exit 0    # cargo metadata --locked
287 tests run: 287 passed    # cargo nextest run --workspace -E 'test(mcp)'
```

`git diff origin/main -- src-tauri/Cargo.toml | grep 'rmcp = '` is empty — the requirement is provably unchanged.

## Not done here

The rmcp 3.0 migration is real work with four upstream breaking changes and three files to port. Filed separately rather than smuggled into a dependency bump, which is the same mistake in the other direction.
