# Shared Context for Agaric Deep-Analysis Agents

You are one of several Opus 4.8 agents auditing the **Agaric** codebase. Read this
file fully before starting. Your job is to find **genuine, high-value improvements**
in your assigned dimension — not to pad a list.

## What Agaric is
Local-first, block-based note-taking app (Logseq/Org-mode inspired).
- **Frontend**: React 19 + Vite + TipTap + Tailwind 4 + Zustand. `src/`
- **Backend**: Rust + SQLite (sqlx, compile-time checked) via Tauri 2. `src-tauri/src/`
- **Architecture**: event sourcing. Commands append to an append-only, hash-chained
  **op log** AND write primary SQLite state atomically in one `BEGIN IMMEDIATE` tx.
  A background **materializer** rebuilds derived views (FTS5, tag inheritance, page_id,
  agenda projection, link graphs). A per-space **Loro CRDT** is a derived merge index
  for sync. P2P sync over local WiFi (mDNS + TLS WebSocket).
- ~386k LOC TS/TSX, ~297k LOC Rust (both incl. tests). E2E in `e2e/` (Playwright).

## CRITICAL: this is a VERY mature, heavily-audited codebase
There have been 1100+ logged engineering sessions and **dozens of prior "deep review"
passes** (correctness 1-8, be-robustness 1-6, fe-robustness 1-6, perf, sync-security,
data-integrity, etc. — see `docs/session-log/`). Fuzzing (`src-tauri/fuzz/`), proptests
(`src-tauri/proptest-regressions/`), Criterion benches, strict oxlint, axe a11y tests,
and conformance corpora already exist.

**Implication**: low-hanging fruit is mostly gone. Be skeptical of your own findings.
A finding only has value if it is (a) real, (b) not already handled/guarded elsewhere,
(c) not deliberately rejected by the architecture. Quality over quantity. Five solid,
verified findings beat thirty speculative ones.

## Threat model (DO NOT generate noise against this)
Agaric is **single-user, multi-device, local-first, no cloud, NO malicious actor**.
Sync peers are the user's OWN paired devices. The project EXPLICITLY rejects:
- DoS protection / rate limiting against sync peers
- Path-traversal / adversarial-input hardening against sync peers
- Any hardening that assumes an adversary on the network
TLS/mTLS/cert-pinning exist for data integrity & device auth, not anti-MITM.
**Focus security/robustness on DATA INTEGRITY**: corruption, hash-chain consistency,
transaction atomicity, crash safety, resource leaks — NOT attack scenarios.
(Exception: untrusted *imported files* and *rendered external content* are real surfaces.)

## Anti-hallucination rules (MANDATORY)
1. Every finding MUST cite a concrete `file:line` (or tight range) you actually read.
2. Quote or precisely paraphrase the real code. Do not invent function/file names.
3. Before flagging, check for an existing guard (search nearby + callers). If guarded,
   don't flag it.
4. If you're unsure whether something is a real bug, mark Confidence: low and SAY why.
5. Do NOT re-report things the architecture deliberately chose (read AGENTS.md invariants).
6. Prefer reading focused regions over whole giant files. Do not dump 5k-line files.
7. It is OK — even good — to report "no significant issues found in area X".

## Output format (write to your assigned file; see your prompt)
For each finding use EXACTLY this structure:

```
### [SEV] Short title
- **Location**: path/to/file.rs:123 (and related: ...)
- **Evidence**: what the code actually does (concrete)
- **Problem**: why it's wrong/risky/suboptimal
- **Impact**: concrete user/dev consequence
- **Fix**: specific, actionable proposal
- **Confidence**: high | medium | low — and why
- **Effort**: S | M | L
```
`[SEV]` is one of: CRITICAL, HIGH, MEDIUM, LOW.
Sort findings by severity (highest first). At the TOP of your file put a 3-6 line
summary and a count by severity. At the END add a "Areas reviewed / not reviewed"
note so the validator knows your coverage.

## Key invariants (don't flag as bugs — see AGENTS.md for full list)
- Op log strictly append-only. Cursor-based pagination everywhere (documented carve-outs).
- Pagination limits are loud (reject out-of-range, no silent clamp). SafeLimit brand on FE.
- Recursive CTEs over `blocks` bound `depth < 100`.
- Single TipTap roving instance; non-focused blocks are static divs.
- sqlx compile-time queries; `.sqlx/` cache committed.
- ULID uppercase normalization for hash determinism.
- Properties system (`block_properties`) is the extension point; avoid proposing new
  tables/columns/op-types/stores (those need explicit user approval).

## Scope discipline
- Unless you are the TESTING agent, focus on **production code**, not `*.test.ts`,
  `__tests__/`, `tests/`, `*.spec.ts`. You may read tests to understand intent.
- Stay in your assigned dimension and module scope (in your prompt). If you spot a
  glaring issue outside your dimension, note it briefly under "Cross-dimension notes".
