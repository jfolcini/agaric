<!-- markdownlint-disable MD060 -->
# Rejected Alternatives

Why Agaric isn't built on the obvious off-the-shelf parts. Each entry exists to prevent a returning contributor from re-litigating the choice.

Adjacent rejections that already have homes:

- **No CRDT for in-editor cursors / operational-transform live merge.** Editor architecture rule, lives in [`editor-and-content.md § FE/BE authority boundary`](editor-and-content.md).
- **No conflict-merge model**. The Loro CRDT engine is now the sole convergence path. See [`crdt-and-recovery.md § CRDT convergence`](crdt-and-recovery.md).
- **No tag-to-tag inheritance.** Data-model rule, lives in [`data-and-events.md § Tags & inheritance`](data-and-events.md).
- **No fractional `TEXT` indexing.** Tree-shape rule, same file.
- **No SQLCipher** (encryption at rest delegated to OS). Security rule, lives in [`tooling.md § Security § Storage`](tooling.md).

## Frameworks & shells

- **Electron** — bundle size and memory footprint. Tauri 2 + native webview produces a fraction of the package and a fraction of the RAM at runtime.
- **TanStack Router** — store-driven navigation works better here. There's no URL we care about preserving; deep links are handled at the Rust layer and dispatched into Zustand.
- **TanStack Query for Tauri IPC** — over-engineered for the call shape. Specta-generated typed wrappers + per-feature Zustand stores cover refetch / invalidation. Adding TanStack Query would mean another cache to invalidate on every materializer event.

## Editor & content

- **CodeMirror** — line-cell model doesn't fit a block outliner. ProseMirror via TipTap models a tree natively.
- **`prosemirror-markdown`** — doesn't round-trip the locked-mark set (inline `[[ULID]]` / `#[ULID]` / `((ULID))` nodes, custom callouts). The custom serializer is FE-only, property-tested for round-trip identity and idempotence.
- **Radix Popover for the suggestion popup** — Floating-UI gives us viewport-aware positioning + middleware (`flip / shift / offset / size`) that we'd rebuild on top of Radix.

## Data model & storage

- **Diesel** — sync-only API; `sqlx` async is non-negotiable for the Tauri runtime.
- **Offset pagination** anywhere user-facing — silently returns inconsistent results under concurrent mutation. Cursor pagination is the canonical pattern.
- **Lazy hash computation** in the op log — would let two devices believe they agreed on history when they didn't. Hashes are computed at op-insertion time.
- **`bincode` / `rkyv` for op-log wire format** — `serde_json` keeps debug-printable on the wire; debugging an op-log issue with raw `bincode` bytes would be miserable. Snapshots use CBOR + zstd because they're machine-only.
- **Client-side backlink filtering** — fan-out + post-filter at the FE was too slow at scale. Every filter dimension is now pushed into the backend query (`BacklinkFilter` enum).
- **Destructuring Zustand stores** — `const { a, b } = useStore()` re-renders on every state change. The convention is individual selectors (`useStore(s => s.a)`).

## Sync & networking

- **iroh / iroh-blobs** (historical) — initially evaluated and rejected for size/scope. Now under reconsideration: an approved adoption plan would replace the current mDNS + WebSocket + TLS + TOFU stack. The earlier rejection is no longer current.
- **magic-wormhole** — over-specified for a same-LAN pairing flow. 4-word EFF-wordlist passphrase + ephemeral mTLS is the right shape.
- **`webpki` cert verification** — Agaric pins by SHA-256 hash, not by CA chain. `webpki` is the wrong abstraction for self-signed pinned certs.
- **Persistent shared passphrase** — passphrase theft becomes forever access. Pairing-session passphrases are 5-minute ephemeral.
- **SPAKE2** for the pairing key derivation — no well-maintained Rust impl; complexity not worth the marginal threat-model upgrade.
- **Application-layer crypto wrapping** of pairing messages — removed once mTLS replaced it. The TLS session is the only cryptographic envelope.

## Recurrence & scheduling

- **`rrule` crate** — RFC 5545 RRULE has more knobs than the user-facing model needs. The org-mode-style mini-language (`+1w`, `.+3d`, `++1w`) is fully covered by `src-tauri/src/recurrence/`, which we own end-to-end.
- **`apalis` / `faktory` job queues** — overkill for the materializer's task graph. The in-process bounded-channel queue with per-task dedup and a persistent retry table covers it.

## State machines

- **`statig` for sync state machine** — typed-enum dispatch is enough; the extra crate's lifetime + trait gymnastics paid off only at much higher state counts.

## Visualisations

- **`react-flow` / Cytoscape** for the graph view — both overshot scope (full graph-editing UX). `d3-force` in a Web Worker covers the simulation; we own the renderer.

## Frontend platform

- **Inline event handlers** in JSX (`onClick={() => doStuff()}`) — re-created every render → breaks memoisation downstream. The convention is `useCallback` or component-level functions.
- **Manual dropdown / dialog implementations** — Radix primitives handle focus trap + Escape + ARIA correctly; rolling our own loses the a11y story. `ConfirmDialog` is the unified wrapper.

## Process & ops

- **ESLint + Prettier** — Biome is one tool, faster, fewer config files.
