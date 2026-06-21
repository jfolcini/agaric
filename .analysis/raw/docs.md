# Documentation Analysis — Agaric

**Summary:** Reviewed README.md, AGENTS.md, docs/ARCHITECTURE.md, docs/FEATURE-MAP.md,
docs/BUILD.md, and skimmed docs/architecture/* + docs/features/*. Most concrete claims
verified against code/config hold up (pool 2W+4R, ENGINE_FORMAT_VERSION=2, 90-day
trash/tombstone purge, 7 Pages sort modes, agaric_commands! macro, attachment commands).
Found a small number of genuine drifts that escape the existing link/version guards:
a stale TipTap version pin in a coupled-stack note, two wrong file paths in FEATURE-MAP,
a dead internal anchor into BUILD.md, and a truncated sentence in the README MCP section.
Note: AGENTS.md is change-controlled, so AGENTS-only staleness is logged as observations,
not actionable findings.

**Counts:** HIGH 0 · MEDIUM 3 · LOW 2

---

### [MEDIUM] FEATURE-MAP.md cites wrong paths for StaticBlock.tsx and EditableBlock.tsx
- **Location**: docs/FEATURE-MAP.md:23 and :25 (and related: actual files at
  `src/components/editor/StaticBlock.tsx`, `src/components/editor/EditableBlock.tsx`)
- **Evidence**: The "Media & attachments" row lists component `src/editor/StaticBlock.tsx`;
  the "Draft autosave" row says "Integrated into `EditableBlock.tsx`". Neither path exists.
  `find src -name StaticBlock.tsx` → `src/components/editor/StaticBlock.tsx`;
  `EditableBlock.tsx` → `src/components/editor/EditableBlock.tsx`. (Verified the draft hook
  is genuinely used: `useDraftAutosave`/`liveContent` both appear in
  `src/components/editor/EditableBlock.tsx`.)
- **Problem**: The FEATURE-MAP is explicitly "for discovery and review" (AGENTS.md:36). A
  contributor following the `src/editor/StaticBlock.tsx` pointer hits a missing file. The
  files were likely moved from `src/editor/` to `src/components/editor/` and these two refs
  weren't updated (other rows in the same table, e.g. EmojiPicker paths, are correct).
- **Impact**: Wasted navigation; erodes trust in the map other rows are relied upon for.
- **Fix**: Change `src/editor/StaticBlock.tsx` → `src/components/editor/StaticBlock.tsx`
  (line 23) and `EditableBlock.tsx` → `src/components/editor/EditableBlock.tsx` (line 25).
- **Confidence**: high — paths verified absent at cited locations and present elsewhere.
- **Effort**: S

### [MEDIUM] README links to non-existent BUILD.md anchor `#android-builds`
- **Location**: README.md:181 (`docs/BUILD.md#android-builds`) — also referenced in the
  "Android" dev section. Related guard gaps: scripts/check-md-link-targets.mjs:80,
  lychee.toml (no `include_fragments`).
- **Evidence**: README §Android says "See [docs/BUILD.md](docs/BUILD.md#android-builds)".
  BUILD.md has no "Android builds" header. Its headers are `### Android` (#android),
  `## Android release signing` (#android-release-signing). The anchor `#android-builds`
  resolves to nothing.
- **Problem**: Dead in-repo anchor. Crucially it is *unguarded*: `check-md-link-targets.mjs`
  strips the fragment before checking (`href.replace(/[#?].*$/, '')`, line 80) so it only
  validates the file path, and `lychee.toml` does not set `include_fragments`, so lychee
  skips fragment validation by default. Both the README author's assumption ("lychee handles
  fragments separately", per the script comment) and CI miss this class of bug.
- **Impact**: Reader clicking the link lands at the top of BUILD.md, not the Android section.
- **Fix**: Point at an existing anchor — `docs/BUILD.md#android` for prerequisites or
  `docs/BUILD.md#android-release-signing` for signing (whichever the sentence means; the
  signing context suggests `#android-release-signing`). Optionally enable
  `include_fragments = true` in lychee.toml so future anchor drift is caught.
- **Confidence**: high — header list enumerated; guard behavior read in source.
- **Effort**: S

### [MEDIUM] AGENTS.md coupled-stack note pins TipTap at 3.22.4; repo is on 3.26.0
- **Location**: AGENTS.md:99 ("share one version line (currently `3.22.4`)") vs
  package.json:49-74 (every `@tiptap/*` at `^3.26.0`).
- **Evidence**: package.json shows `@tiptap/core`, `pm`, `react`, `suggestion`, and all
  `extension-*` at `^3.26.0`. AGENTS.md states the current version is `3.22.4`.
- **Problem**: Version drift in the "Coupled Dependency Updates" guidance. The note's
  *rule* (bump all `@tiptap/*` atomically) is still correct; only the cited "currently"
  number is stale, so this is informational drift rather than a broken invariant.
- **Impact**: Low operational risk, but a maintainer cross-checking the pin against the
  manifest sees a contradiction and may distrust the section.
- **Fix**: This claim lives in AGENTS.md, which is change-controlled ("No changes to this
  file without explicit user approval"). Flagging for the maintainer to update `3.22.4` →
  `3.26.x` next time AGENTS.md is touched, rather than editing directly. Consider whether
  the version number belongs in the doc at all (the manifest is the source of truth) — a
  phrase like "share one version line; bump atomically" without a literal avoids future drift.
- **Confidence**: high — both numbers read directly.
- **Effort**: S (but gated on AGENTS approval)

### [LOW] README MCP section ends a sentence mid-phrase: "...toggle (shipping with)."
- **Location**: README.md:196
- **Evidence**: "The read-only socket is gated by a Settings → Agent access toggle
  (shipping with)." The parenthetical is truncated — "(shipping with)" has no object.
- **Problem**: Looks like a half-edited sentence (cf. similar dangling fragments elsewhere
  in AGENTS.md — "split out from navigation in", "the root cause of." — which are out of
  scope here). It also undersells reality: there are now TWO MCP sockets, read-only AND
  read-write (`src-tauri/src/mcp/mod.rs:264,324`; `tools_ro.rs`/`tools_rw.rs`), but the
  README install table only documents the RO socket and the `--socket` flag.
- **Impact**: Reader confusion; RW capability is undocumented in the install section even
  though FEATURE-MAP.md:20 advertises "Read-only and read-write MCP tools".
- **Fix**: Complete the sentence (e.g. "gated by a Settings → Agent access toggle, off by
  default"). Optionally note the separate RW socket and its independent toggle.
- **Confidence**: high — sentence is visibly truncated; two-socket design verified in code.
- **Effort**: S

### [LOW] AGENTS.md naming convention says `inner_*`; code uses `*_inner`
- **Location**: AGENTS.md:253 ("Each command has an `inner_*` function taking
  `&SqlitePool`") vs e.g. src-tauri/src/commands/blocks/crud.rs:59
  (`create_block_inner`), :198 (`edit_block_inner`).
- **Evidence**: The actual convention is a `_inner` *suffix* (`create_block_inner`,
  `edit_block_inner`, `get_active_block_inner`, …), not an `inner_` prefix. AGENTS.md:44
  itself elsewhere refers to "the `_inner` split", contradicting line 253.
- **Problem**: Minor internal inconsistency in the convention name. Change-controlled file,
  so logged as an observation for maintainer awareness rather than an edit.
- **Impact**: Trivial; the example in the same doc disambiguates.
- **Confidence**: high.
- **Effort**: S (gated on AGENTS approval)

---

## Cross-dimension / observations (not primary findings)

- **AGENTS.md:77 stale cross-ref** — invariant #10 cites "`docs/ARCHITECTURE.md §5 —
  Pagination limits`", but ARCHITECTURE.md has no §5 / no "Pagination limits" section
  (it has 4 top-level `##` sections and was split into `docs/architecture/`). The
  pagination-cap detail now lives in `docs/architecture/queries.md` (the 100/200/500
  caps) and `docs/architecture/data-and-events.md`. Stale anchor, but in change-controlled
  AGENTS.md — note for maintainer; consider re-pointing to `architecture/queries.md`.
- **AGENTS.md:391** links `docs/BUILD.md#installing-on-emulator`; BUILD.md has no
  "Installing on emulator" header (same unguarded-fragment class as the README finding).
  Change-controlled — observation only.

## Areas reviewed / not reviewed

- **Reviewed (claims verified against code/config):** README.md (full), AGENTS.md (full),
  docs/ARCHITECTURE.md (full), docs/FEATURE-MAP.md (full), docs/BUILD.md (headers/anchors +
  release/android sections), prek.toml link hook, lychee.toml, package.json scripts+deps,
  src-tauri/Cargo.toml (specta/tauri-specta pins — match AGENTS), db/pool.rs (pool sizes),
  maintenance.rs (tombstone/op-log retention), loro/engine (format version),
  usePageBrowserSort.ts (sort-mode count), mcp/mod.rs + mcp/AGENTS.md (RO/RW sockets),
  several FEATURE-MAP component paths.
- **Not deeply reviewed:** docs/UX.md, docs/UI-MAP.md, docs/TROUBLESHOOTING.md,
  docs/SEARCH.md / docs/PAGES.md bodies, the full prose of every docs/architecture/* and
  docs/features/* file (skimmed map + targeted greps only), session-log/* (excluded by
  scope). Build-artifact size claims (~9 MB AppImage, ~24 MB APK) not verified — would
  require a build; left unflagged per anti-hallucination rule.
