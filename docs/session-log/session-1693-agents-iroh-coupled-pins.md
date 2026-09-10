# Session 1693 — the iroh stack joins § Coupled Dependency Updates

One `AGENTS.md` bullet, approved by the maintainer on 2026-09-10 while closing
#3464. `iroh`, `iroh-base` and `iroh-dns` share one exact `=` pin across
`agaric-sync` and `agaric-store`; `iroh-mdns-address-lookup` (#4944) is a caret
range that resolves against that pin and compiles only against one `iroh`
line. `agaric-sync/Cargo.toml` already pointed at this section for the rule;
the section now states it.

A second sentence proposed in #4944 (the lookup is added to the bound endpoint
after `clear_address_lookup()`, never in the builder) was not added: the
`lan_only_*` guard tests already fail on that mistake, so the sentence would say
twice what a test says once.

## Verified

- Docs-only change; no tests run locally. CI carries `docs-lint`.
