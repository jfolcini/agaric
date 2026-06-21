# Validation — Documentation Analysis (docs.md)

**Verdict tally:** CONFIRMED 5 · CONFIRMED-BUT-RESEVERITY 0 · EXAGGERATED 0 · ALREADY-HANDLED 0 · HALLUCINATED 0

All five findings + both cross-dimension observations check out against code/config. No hallucinated drift; the drifts the raw report describes are all real.

---

### [MEDIUM] FEATURE-MAP cites wrong paths for StaticBlock.tsx / EditableBlock.tsx — CONFIRMED
- **Evidence checked:** `glob **/StaticBlock.tsx` → `src/components/editor/StaticBlock.tsx`; `glob **/EditableBlock.tsx` → `src/components/editor/EditableBlock.tsx`. FEATURE-MAP.md:23 lists `editor/StaticBlock.tsx` and :25 says "Integrated into `EditableBlock.tsx`". Neither bare path under `src/editor/` exists. The :23 row prefaces other components with "(under `src/components/`)" but spells this one `editor/StaticBlock.tsx`, which still resolves to the non-existent `src/components/editor/`... actually it resolves correctly *if* you honor the "under src/components/" prefix — but :25's `EditableBlock.tsx` has no path at all. Minor wrinkle: the :23 case is arguably less wrong than stated (the row's prefix covers it). Net: still a navigation hazard; verdict stands.
- **Severity:** MEDIUM appropriate (discovery doc, broken pointer).

### [MEDIUM] README:181 links non-existent BUILD.md anchor `#android-builds` — CONFIRMED
- **Evidence checked:** README.md:181 `[docs/BUILD.md](docs/BUILD.md#android-builds)`. BUILD.md headers: `### Android` (#android, line 51) and `## Android release signing` (#android-release-signing, line 258). No "Android builds" header → `#android-builds` is dead. Guard gap confirmed: check-md-link-targets.mjs:80 strips fragments (`href.replace(/[#?].*$/, '')`) so only the file path is validated. Real, unguarded dead anchor.
- **Severity:** MEDIUM appropriate.

### [MEDIUM] AGENTS.md:99 pins TipTap 3.22.4; repo on 3.26.0 — CONFIRMED
- **Evidence checked:** AGENTS.md:99 "share one version line (currently `3.22.4`)". package.json:49-74 all `@tiptap/*` core/pm/react/suggestion/extension-* at `^3.26.0`. Drift is real. Correctly flagged as observation-only (AGENTS.md change-controlled; do not edit). Validator note: one outlier `@tiptap/extension-code-block` at `^3.23.6` (package.json:111) is off the main line too — not material to this finding but worth a glance if anyone touches the pins.

### [LOW] README:196 truncated "(shipping with)." + RO-only MCP doc vs existing RW socket — CONFIRMED
- **Evidence checked:** README.md:196 ends "...Agent access toggle (shipping with)." — parenthetical has no object; truncation real. `tools_rw.rs` and `tools_ro.rs` both exist at `src-tauri/src/mcp/`, confirming a real two-socket (RO + RW) design while the README install section documents only the RO socket and `--socket` flag. FEATURE-MAP.md:20 indeed advertises "Read-only and read-write MCP tools". Both halves verified.

### [LOW] AGENTS.md:253 says `inner_*`; code uses `*_inner` — CONFIRMED
- **Evidence checked:** AGENTS.md:253 "Each command has an `inner_*` function". crud.rs:59 `create_block_inner`, :198 `edit_block_inner`, :116 `create_block_inner_with_space` — convention is a `_inner` *suffix*, not `inner_` prefix. AGENTS.md:44 itself says "the `_inner` split", self-contradicting :253. Trivial, observation-only (change-controlled).

---

## Cross-dimension observations — both CONFIRMED (spot-checked)
- AGENTS.md:391 / README class of unguarded-fragment bug is consistent with the verified script behavior at check-md-link-targets.mjs:80.

## Net assessment — file-worthy, ranked
1. **README:181 dead `#android-builds` anchor (MEDIUM)** — user-facing, trivially fixable to `#android` / `#android-release-signing`; consider `include_fragments=true` in lychee.toml to guard the class.
2. **FEATURE-MAP path drift (MEDIUM)** — editable (not change-controlled), quick fix; mild over-statement on the :23 row but still worth fixing.
3. **README:196 truncated sentence + undocumented RW socket (LOW)** — editable, two small wins (finish sentence + note RW socket).
4. TipTap 3.22.4 and `inner_*`/`_inner` drifts (LOW): real but in change-controlled AGENTS.md → maintainer-awareness items, not PRs.
