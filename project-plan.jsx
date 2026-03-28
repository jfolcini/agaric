import { useState } from 'react'

const PHASES = [
  {
    id: 'p1',
    label: 'Phase 1',
    title: 'Foundation',
    estimate: '6–8 weeks',
    color: '#6366f1',
    dim: '#818cf8',
    bg: 'rgba(99,102,241,0.08)',
    border: 'rgba(99,102,241,0.25)',
    description:
      'Data model lock, op log, materializer skeleton, CI gates. Nothing ships until this is bulletproof.',
    adrs: ['ADR-04', 'ADR-05', 'ADR-06', 'ADR-07', 'ADR-08', 'ADR-13'],
    groups: [
      {
        title: 'Repo & Tooling',
        icon: '⚙️',
        tasks: [
          {
            id: 'p1-t1',
            title: 'Init Tauri 2.0 workspace',
            tags: ['infra'],
            note: 'Cargo workspace with src-tauri + frontend packages. Commit the skeleton before any logic.',
          },
          {
            id: 'p1-t2',
            title: 'Vite + React 18 frontend scaffold',
            tags: ['infra', 'frontend'],
            note: 'vite.config.ts with path aliases, strict TS config.',
          },
          {
            id: 'p1-t3',
            title: 'Biome — non-negotiable day one',
            tags: ['dx'],
            critical: true,
            note: 'biome.json, lint + format scripts, pre-commit hook. Retrofitting later = whole-repo churn.',
          },
          {
            id: 'p1-t4',
            title: 'GitHub Actions CI skeleton',
            tags: ['infra', 'dx'],
            note: 'cargo test, cargo fmt --check, biome check, cargo sqlx prepare --check. Gates open immediately.',
          },
          {
            id: 'p1-t5',
            title: 'Device UUID generation + persistence',
            tags: ['backend'],
            note: 'UUID v4 on first launch, stored in config file outside the DB. Never regenerated.',
          },
        ],
      },
      {
        title: 'Database & Schema',
        icon: '🗄️',
        tasks: [
          {
            id: 'p1-t6',
            title: 'sqlx + sqlx-cli bootstrap',
            tags: ['backend', 'dx'],
            critical: true,
            note: 'DATABASE_URL env, sqlx::Pool, WAL mode pragma, single write connection. Read pool from Phase 1.',
          },
          {
            id: 'p1-t7',
            title: '0001_initial.sql migration',
            tags: ['backend'],
            critical: true,
            note: 'Full schema: blocks, block_tags, block_properties, block_links, attachments, op_log, block_drafts, log_snapshots, peer_refs, all cache tables. All indexes. One migration, correctly ordered.',
          },
          {
            id: 'p1-t8',
            title: '.sqlx offline cache + CI check',
            tags: ['dx', 'infra'],
            note: 'cargo sqlx prepare committed. CI gate active immediately — stale cache = build failure.',
          },
          {
            id: 'p1-t9',
            title: 'thiserror + anyhow error types',
            tags: ['backend'],
            note: 'AppError enum covering DB, IO, parse, ULID errors. Consistent Tauri command error serialisation.',
          },
          {
            id: 'p1-t10',
            title: 'ULID generation utility (Rust)',
            tags: ['backend'],
            note: 'Newtype wrapper. ulid crate. Used for all IDs from day one.',
          },
        ],
      },
      {
        title: 'Op Log Core',
        icon: '📋',
        tasks: [
          {
            id: 'p1-t11',
            title: 'Op log writer — local ops',
            tags: ['backend'],
            critical: true,
            note: 'Composite PK (device_id, seq). seq via MAX+1 serialised on write conn. parent_seqs written as null or single-entry array from day one — no migration needed at Phase 4.',
          },
          {
            id: 'p1-t12',
            title: 'blake3 hash computation',
            tags: ['backend'],
            note: 'Hash fn: blake3(device_id || seq || parent_seqs_canonical || op_type || payload_canonical). parent_seqs sorted lexicographically for determinism.',
          },
          {
            id: 'p1-t13',
            title: 'Op payload types — serde structs',
            tags: ['backend'],
            note: 'Rust structs for all op_type payloads (ADR-07). Exhaustive match — no catch-all arms.',
          },
          {
            id: 'p1-t14',
            title: 'Block draft writer (2s autosave)',
            tags: ['backend'],
            note: 'INSERT OR REPLACE into block_drafts. Tauri command. Delete on flush.',
          },
          {
            id: 'p1-t15',
            title: 'Crash recovery at boot',
            tags: ['backend'],
            critical: true,
            note: 'Delete pending log_snapshots. Walk block_drafts, compare to op_log created_at, emit synthetic edit_block ops. Log warning per recovered draft.',
          },
        ],
      },
      {
        title: 'Materializer Skeleton',
        icon: '⚡',
        tasks: [
          {
            id: 'p1-t16',
            title: 'Foreground queue (tokio mpsc)',
            tags: ['backend'],
            critical: true,
            note: 'Viewport block reads. Low-latency. Single write conn serialises materializer ops.',
          },
          {
            id: 'p1-t17',
            title: 'Background queue',
            tags: ['backend'],
            note: 'tags_cache, pages_cache, agenda_cache, block_links index, FTS5 bootstrap. Stale-while-revalidate from day one — never block on cold boot.',
          },
          {
            id: 'p1-t18',
            title: 'tags_cache rebuild trigger + query',
            tags: ['backend'],
            note: 'LEFT JOIN from blocks to capture zero-usage tags. Staleness threshold: 5s. Used for #[ulid] autocomplete.',
          },
          {
            id: 'p1-t19',
            title: 'pages_cache rebuild trigger + query',
            tags: ['backend'],
            note: 'Rebuild on create/delete/restore/edit of page blocks. 5s threshold.',
          },
          {
            id: 'p1-t20',
            title: 'agenda_cache materializer',
            tags: ['backend'],
            note: 'Triggers: set_property (value_date), add_tag / remove_tag (date/YYYY-MM-DD pattern). Full recompute, 2s threshold.',
          },
          {
            id: 'p1-t21',
            title: 'block_links index materializer',
            tags: ['backend'],
            note: 'Trigger: edit_block. Parse [[ULID]] via regex. Diff against prior index. Delete removed, insert new. Pure read cache — drop+rebuild always safe.',
          },
          {
            id: 'p1-t22',
            title: 'Pagination — cursor-based on ALL list queries',
            tags: ['backend'],
            critical: true,
            note: 'Zero exceptions. Enforced from Phase 1. Offset pagination is banned. Cursor/keyset only.',
          },
          {
            id: 'p1-t23',
            title: 'Soft-delete cascade (recursive CTE)',
            tags: ['backend'],
            note: 'delete_block with cascade:true. Single op covers subtree. Materializer walks descendants and sets deleted_at to same timestamp.',
          },
        ],
      },
      {
        title: 'Tauri Commands (minimal set)',
        icon: '🔗',
        tasks: [
          {
            id: 'p1-t24',
            title: 'Tauri command: create_block',
            tags: ['backend'],
            note: 'Writes create_block op. Returns new block. Validates parent_id exists if provided.',
          },
          {
            id: 'p1-t25',
            title: 'Tauri command: edit_block',
            tags: ['backend'],
            note: 'Writes edit_block op with to_text + prev_edit. Triggers materializer.',
          },
          {
            id: 'p1-t26',
            title: 'Tauri command: delete_block / restore_block / purge_block',
            tags: ['backend'],
            note: 'cascade:true always. restore checks deleted_at_ref timestamp matching.',
          },
          {
            id: 'p1-t27',
            title: 'Tauri command: list_blocks (paginated)',
            tags: ['backend'],
            note: 'Keyset pagination. Accepts parent_id filter, block_type filter, deleted_at IS NULL by default.',
          },
          {
            id: 'p1-t28',
            title: 'Boot state machine (Zustand)',
            tags: ['frontend'],
            note: 'States: booting → recovering → ready | error. Blocks UI during crash recovery. No skeleton flash on clean boot.',
          },
        ],
      },
      {
        title: 'Testing & CI',
        icon: '✅',
        tasks: [
          {
            id: 'p1-t29',
            title: 'cargo test suite for op log + materializer',
            tags: ['testing'],
            critical: true,
            note: 'Test: op ordering, hash chains, crash recovery simulation, cascade delete, position compaction.',
          },
          {
            id: 'p1-t30',
            title: 'Vitest project config',
            tags: ['dx', 'testing'],
            note: 'jsdom environment, coverage with v8. Path aliases mirrored from vite.config.',
          },
          {
            id: 'p1-t31',
            title: 'sqlx compile-time query validation in CI',
            tags: ['dx', 'infra'],
            note: 'All query! macros validated at compile time. Offline cache keeps CI fast without a live DB.',
          },
        ],
      },
    ],
  },
  {
    id: 'p15',
    label: 'Phase 1.5',
    title: 'Daily Driver',
    estimate: '4–6 weeks + 4–8 weeks real use',
    color: '#8b5cf6',
    dim: '#a78bfa',
    bg: 'rgba(139,92,246,0.08)',
    border: 'rgba(139,92,246,0.25)',
    description:
      "The editor you'll actually use every day. Serializer must ship and pass tests before any other task in this phase begins.",
    adrs: ['ADR-01', 'ADR-20'],
    groups: [
      {
        title: 'Markdown Serializer — MUST SHIP FIRST',
        icon: '🔐',
        tasks: [
          {
            id: 'p15-t1',
            title: 'markdown-serializer.ts — standalone module',
            tags: ['frontend'],
            critical: true,
            note: 'src/editor/markdown-serializer.ts. Zero deps on tiptap-markdown or any Markdown library. ~150 lines. Only schema: bold/italic/code/tag_ref/block_link.',
          },
          {
            id: 'p15-t2',
            title: 'Serializer: parse() — Markdown → ProseMirror doc',
            tags: ['frontend'],
            critical: true,
            note: 'Single-pass hand-rolled parser. Regex for token ID only. Mark stack — unclosed marks become plain text, never error.',
          },
          {
            id: 'p15-t3',
            title: 'Serializer: serialize() — ProseMirror doc → Markdown',
            tags: ['frontend'],
            critical: true,
            note: 'hardBreak → \\n. paragraph wrapper → content only. Unknown nodes stripped + warn. Never emits \\n\\n.',
          },
          {
            id: 'p15-t4',
            title: 'Serializer escape rules',
            tags: ['frontend'],
            note: '\\* for literal asterisk, \\` for literal backtick. #[ without valid 26-char ULID passes through unescaped.',
          },
          {
            id: 'p15-t5',
            title: 'Serializer test suite (Vitest)',
            tags: ['testing'],
            critical: true,
            note: 'Round-trip identity. Mark nesting (bold-in-italic, code adjacent to bold). Token at string boundaries. hardBreak / paragraph paste normalization. Empty + whitespace-only strings. NO exceptions before Phase 2.',
          },
        ],
      },
      {
        title: 'TipTap + Roving Instance',
        icon: '✏️',
        tasks: [
          {
            id: 'p15-t6',
            title: 'TipTap extension: tag_ref inline node',
            tags: ['frontend'],
            note: 'atom:true, inline:true. Attr: id (ULID). Renders chip from tags_cache. Never shows raw ULID.',
          },
          {
            id: 'p15-t7',
            title: 'TipTap extension: block_link inline node',
            tags: ['frontend'],
            note: 'Same as tag_ref. Attr: id. Reads from pages_cache. Chip renders resolved page title.',
          },
          {
            id: 'p15-t8',
            title: 'Roving TipTap instance — mount/unmount lifecycle',
            tags: ['frontend'],
            critical: true,
            note: 'Exactly ONE instance at all times. Mount on focus (parse → setContent). Unmount on blur (serialize → compare → flush if dirty → clearHistory). Static div for all non-focused blocks.',
          },
          {
            id: 'p15-t9',
            title: 'useBlockKeyboard hook',
            tags: ['frontend'],
            note: 'ArrowUp/Left at pos 0 → prev block. ArrowDown/Right at end → next block. Backspace on empty → delete+focus prev. Enter → \\n. Tab → indent. Shift+Tab → dedent.',
          },
          {
            id: 'p15-t10',
            title: 'Auto-split on blur',
            tags: ['frontend'],
            critical: true,
            note: 'Serialized string contains \\n → splitOnNewlines(). First segment: edit_block. Subsequent: create_block in order. Tags/props on first segment only. Same path as cross-block paste.',
          },
          {
            id: 'p15-t11',
            title: '# picker extension (tag autocomplete)',
            tags: ['frontend'],
            note: 'Intercept # keystroke → fuzzy search tags_cache. Select → insert tag_ref node with ULID. Never writes #tagname to storage.',
          },
          {
            id: 'p15-t12',
            title: '[[ picker extension (page/block link)',
            tags: ['frontend'],
            note: 'Intercept [[ → fuzzy search pages_cache. Select → insert block_link node with ULID.',
          },
          {
            id: 'p15-t13',
            title: 'Viewport Intersection Observer',
            tags: ['frontend'],
            note: 'Off-screen blocks: static div with known height. Intersection Observer drives visible window. Zero per-block TipTap overhead for off-screen blocks.',
          },
        ],
      },
      {
        title: 'Block CRUD UI',
        icon: '🧱',
        tasks: [
          {
            id: 'p15-t14',
            title: 'Block tree renderer (static)',
            tags: ['frontend'],
            note: 'Recursive render of block tree. Placeholder heights for unmeasured off-screen blocks.',
          },
          {
            id: 'p15-t15',
            title: 'Block creation — Enter to create below',
            tags: ['frontend'],
            note: 'Calls create_block. Focuses new block immediately.',
          },
          {
            id: 'p15-t16',
            title: 'Block deletion — Backspace on empty',
            tags: ['frontend'],
            note: 'Calls delete_block(cascade:true). Focus previous. Graceful on first block.',
          },
          {
            id: 'p15-t17',
            title: 'Indent / dedent (Tab / Shift+Tab)',
            tags: ['frontend'],
            note: 'Flush first. Calls move_block. Emits batch move_block ops for position compaction.',
          },
          {
            id: 'p15-t18',
            title: 'Flat tag panel',
            tags: ['frontend'],
            note: 'Apply/remove tags from a block. Reads tags_cache. Calls add_tag / remove_tag ops.',
          },
          {
            id: 'p15-t19',
            title: 'Create tag block UI',
            tags: ['frontend'],
            note: "Calls create_block(block_type:'tag'). Immediately available in tags_cache after materializer.",
          },
        ],
      },
      {
        title: 'Journal View',
        icon: '📅',
        tasks: [
          {
            id: 'p15-t20',
            title: "Journal page — today's blocks",
            tags: ['frontend'],
            note: 'Query: agenda_cache WHERE date = today. Paginated. Reads from foreground materializer queue.',
          },
          {
            id: 'p15-t21',
            title: 'Date navigation',
            tags: ['frontend'],
            note: 'Previous / next day. agenda_cache WHERE date BETWEEN ? AND ?. Skeleton on load (stale-while-revalidate).',
          },
          {
            id: 'p15-t22',
            title: 'Page browser — all pages',
            tags: ['frontend'],
            note: "WHERE block_type = 'page' AND deleted_at IS NULL. Default sort: reverse ULID (creation time desc). User pref settable.",
          },
        ],
      },
      {
        title: 'Trash + Restore',
        icon: '🗑️',
        tasks: [
          {
            id: 'p15-t23',
            title: 'Trash view',
            tags: ['frontend'],
            note: 'WHERE deleted_at IS NOT NULL AND is_conflict = 0. Paginated. Shows block content + deleted_at.',
          },
          {
            id: 'p15-t24',
            title: 'Restore flow',
            tags: ['frontend'],
            note: 'Calls restore_block op. deleted_at_ref in payload. Only descendants with matching timestamp are restored.',
          },
          {
            id: 'p15-t25',
            title: 'Permanent delete (purge)',
            tags: ['frontend'],
            note: 'Explicit UI confirm. Calls purge_block op. Irreversible. Also triggered auto after 30 days.',
          },
        ],
      },
      {
        title: 'Android Spike — Gate Before Phase 2',
        icon: '📱',
        tasks: [
          {
            id: 'p15-t26',
            title: 'Throwaway Tauri Android app',
            tags: ['infra', 'testing'],
            critical: true,
            note: 'Minimal: single roving TipTap + serializer + IME composition (CJK). NOT production code.',
          },
          {
            id: 'p15-t27',
            title: 'Validate: IME composition + virtual keyboard',
            tags: ['testing'],
            critical: true,
            note: 'ProseMirror composition events. Virtual keyboard must not break layout. Mount/unmount on focus/blur.',
          },
          {
            id: 'p15-t28',
            title: 'Validate: Markdown round-trip under Android WebView',
            tags: ['testing'],
            critical: true,
            note: 'serialize(parse(s)) === s on Android. ProseMirror output may differ from desktop. Must pass before Phase 2.',
          },
          {
            id: 'p15-t29',
            title: 'Spike decision — proceed or mitigate',
            tags: ['infra'],
            critical: true,
            note: 'If spike fails: choose mitigation before Phase 2. Document in new ADR. Phase 2 is blocked on this.',
          },
        ],
      },
    ],
  },
  {
    id: 'p2',
    label: 'Phase 2',
    title: 'Full Editor',
    estimate: '8–12 weeks',
    color: '#06b6d4',
    dim: '#22d3ee',
    bg: 'rgba(6,182,212,0.08)',
    border: 'rgba(6,182,212,0.25)',
    description:
      'Block links, history, move/merge, conflict UI. specta enters. E2E testing begins.',
    adrs: ['ADR-02', 'ADR-06', 'ADR-09', 'ADR-13'],
    groups: [
      {
        title: 'specta + tauri-specta',
        icon: '🔷',
        tasks: [
          {
            id: 'p2-t1',
            title: 'specta type export setup',
            tags: ['dx', 'backend'],
            note: 'Generate TypeScript types from all Tauri command signatures. CI gate: specta diff check fails on dirty types.',
          },
          {
            id: 'p2-t2',
            title: 'Annotate all Tauri commands with specta',
            tags: ['backend', 'dx'],
            note: 'Replace manual TS interfaces everywhere. Frontend consumes generated types only.',
          },
        ],
      },
      {
        title: 'Block Links + Backlinks',
        icon: '🔗',
        tasks: [
          {
            id: 'p2-t3',
            title: 'Backlinks panel — per-block',
            tags: ['frontend'],
            note: 'Query: block_links WHERE target_id = ? JOIN blocks. Paginated. Reads materializer-maintained cache.',
          },
          {
            id: 'p2-t4',
            title: '[[link]] chip navigation',
            tags: ['frontend'],
            note: 'Click chip → navigate to linked block/page. Scroll into view + focus.',
          },
          {
            id: 'p2-t5',
            title: 'Broken link decoration',
            tags: ['frontend'],
            note: "block_link node whose target is deleted → render as 'deleted block' chip, distinct visual style.",
          },
        ],
      },
      {
        title: 'History Panel',
        icon: '🕰️',
        tasks: [
          {
            id: 'p2-t6',
            title: 'Per-block edit chain query',
            tags: ['backend'],
            note: "op_log WHERE block_id = ? AND op_type IN ('create_block','edit_block') ORDER BY seq. Uses prev_edit pointers for chain traversal.",
          },
          {
            id: 'p2-t7',
            title: 'History panel UI',
            tags: ['frontend'],
            note: 'List of to_text snapshots per block. Diff view (current vs selected). Manual restore → new edit_block op.',
          },
          {
            id: 'p2-t8',
            title: 'Non-text op history (tags, properties, moves)',
            tags: ['frontend'],
            note: 'Filtered op_log view for block. Display-only. No automatic revert for these ops.',
          },
        ],
      },
      {
        title: 'Move, Merge, Indent',
        icon: '↕️',
        tasks: [
          {
            id: 'p2-t9',
            title: 'Drag-to-reorder blocks',
            tags: ['frontend'],
            note: 'Emits batch move_block ops for position compaction. Materializer compacts siblings to 1..n after conflict.',
          },
          {
            id: 'p2-t10',
            title: 'Move block to different parent',
            tags: ['frontend'],
            note: 'Calls move_block op. UI: drag to nested position or command palette.',
          },
          {
            id: 'p2-t11',
            title: 'Block merge (Backspace at start of non-empty block)',
            tags: ['frontend'],
            note: 'Append content of current block to previous. delete_block current. edit_block previous.',
          },
        ],
      },
      {
        title: 'Conflict Resolution UI',
        icon: '⚠️',
        tasks: [
          {
            id: 'p2-t12',
            title: 'Conflict copy display',
            tags: ['frontend'],
            note: 'WHERE is_conflict = 1 AND deleted_at IS NULL. Show inline beside original block. Visual distinction.',
          },
          {
            id: 'p2-t13',
            title: 'Conflict resolution actions',
            tags: ['frontend'],
            note: 'Choose version → edit_block on original. Discard copy → delete_block conflict. Both actions clear is_conflict state.',
          },
          {
            id: 'p2-t14',
            title: "'Deleted tag' token decoration",
            tags: ['frontend'],
            note: 'tag_ref node whose tag_id is deleted → render as greyed chip with tooltip. Not an error.',
          },
        ],
      },
      {
        title: 'Status View',
        icon: '📊',
        tasks: [
          {
            id: 'p2-t15',
            title: 'In-memory status struct (Rust)',
            tags: ['backend'],
            note: 'Materializer queue depths, cache staleness timestamps, FTS5 last optimize, orphan GC last run. Zero DB queries.',
          },
          {
            id: 'p2-t16',
            title: 'Status panel UI',
            tags: ['frontend'],
            note: 'Settings panel or persistent indicator. Reads status struct via Tauri event or poll. Useful during dev too.',
          },
          {
            id: 'p2-t17',
            title: 'Property conflict audit list',
            tags: ['backend', 'frontend'],
            note: 'In-memory list of auto-resolved property conflicts (LWW). Count + per-block detail in Status View.',
          },
        ],
      },
      {
        title: 'E2E Testing',
        icon: '🎭',
        tasks: [
          {
            id: 'p2-t18',
            title: 'Playwright + tauri-driver setup',
            tags: ['dx', 'testing'],
            note: 'E2E from Phase 2. Test: block creation, edit, split, delete, restore. Tauri test mode.',
          },
          {
            id: 'p2-t19',
            title: 'E2E: editor lifecycle (focus, edit, blur, flush)',
            tags: ['testing'],
            note: 'Critical path. Verify roving instance mounts/unmounts correctly. Draft recovery on crash sim.',
          },
          {
            id: 'p2-t20',
            title: 'insta snapshot tests',
            tags: ['testing', 'dx'],
            note: 'Wait until schema is stable (it is now). Snapshot materializer output, serializer output, op log structure.',
          },
        ],
      },
    ],
  },
  {
    id: 'p3',
    label: 'Phase 3',
    title: 'Search',
    estimate: '3–4 weeks',
    color: '#10b981',
    dim: '#34d399',
    bg: 'rgba(16,185,129,0.08)',
    border: 'rgba(16,185,129,0.25)',
    description:
      'FTS5, boolean tag queries, scheduled index maintenance. cargo-nextest enters. CJK limitations documented and explicit.',
    adrs: ['ADR-08', 'ADR-12', 'ADR-19'],
    groups: [
      {
        title: 'FTS5 Integration',
        icon: '🔍',
        tasks: [
          {
            id: 'p3-t1',
            title: 'FTS5 virtual table definition',
            tags: ['backend'],
            note: 'fts_blocks over blocks.content. unicode61 tokenizer. Include in 0001_initial or new migration.',
          },
          {
            id: 'p3-t2',
            title: 'FTS5 strip pass in materializer',
            tags: ['backend'],
            critical: true,
            note: 'Remove **, *, ` delimiters. Replace #[ULID] → tag name, [[ULID]] → page title. Insert into FTS5 on edit_block. Non-lossy: source content unchanged.',
          },
          {
            id: 'p3-t3',
            title: 'FTS5 scheduled optimize',
            tags: ['backend'],
            note: "After 500 edit_block ops OR 60min active use: INSERT INTO fts_blocks VALUES('optimize'). Run immediately post-RESET.",
          },
          {
            id: 'p3-t4',
            title: 'Full-text search Tauri command',
            tags: ['backend'],
            note: 'FTS5 MATCH query. Returns paginated block_ids. Materializer enriches with block content for display.',
          },
          {
            id: 'p3-t5',
            title: 'Search UI — input + results',
            tags: ['frontend'],
            note: 'Debounced input. Paginated results. Highlight matching tokens. Skeleton on stale-while-revalidate.',
          },
          {
            id: 'p3-t6',
            title: 'CJK limitation notice in UI',
            tags: ['frontend'],
            note: "If user input contains CJK codepoints: non-blocking notice 'CJK search is limited in v1.' Not an error.",
          },
        ],
      },
      {
        title: 'Tag Queries',
        icon: '🏷️',
        tasks: [
          {
            id: 'p3-t7',
            title: 'TagExpr tree + FxHashSet (Rust)',
            tags: ['backend'],
            note: 'Boolean tag queries: AND, OR, NOT. FxHashSet for set operations on block_ids. LIKE for prefix queries.',
          },
          {
            id: 'p3-t8',
            title: 'Prefix-aware tag search (#work/ → all sub-tags)',
            tags: ['backend'],
            note: "LIKE 'work/%' on tags_cache.name. No graph traversal. This is the org-mode use case (ADR-18).",
          },
          {
            id: 'p3-t9',
            title: 'Tag filter panel in UI',
            tags: ['frontend'],
            note: 'Combine multiple tag filters. AND/OR toggle. Results paginated. Reads tag query materializer.',
          },
        ],
      },
      {
        title: 'Performance & Tooling',
        icon: '🚀',
        tasks: [
          {
            id: 'p3-t10',
            title: 'cargo-nextest migration',
            tags: ['dx'],
            note: 'Suite is large enough now. nextest run. Parallel test execution, better output, instant rerun of failed tests.',
          },
          {
            id: 'p3-t11',
            title: 'FTS5 perf benchmark',
            tags: ['testing'],
            note: "Seed DB with 10k / 100k blocks. Measure search latency. Verify segment count doesn't degrade after optimize.",
          },
          {
            id: 'p3-t12',
            title: 'Materializer queue depth monitoring',
            tags: ['dx', 'backend'],
            note: 'Log queue depths at high watermarks. Feeds Status View. Alert if background queue grows unbounded.',
          },
        ],
      },
    ],
  },
  {
    id: 'p4',
    label: 'Phase 4',
    title: 'Sync + Android',
    estimate: '12–16 weeks',
    color: '#f59e0b',
    dim: '#fbbf24',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.25)',
    description:
      'The most complex phase. DAG log, diffy merge, mDNS pairing, snapshot protocol, full Android. XState + TanStack Query enter.',
    adrs: ['ADR-09', 'ADR-10', 'ADR-07', 'ADR-02'],
    groups: [
      {
        title: 'State Management Upgrade',
        icon: '🧠',
        tasks: [
          {
            id: 'p4-t1',
            title: 'TanStack Query — server state layer',
            tags: ['frontend', 'dx'],
            note: 'Replace manual Tauri invoke + useState patterns. Invalidated by Tauri events. Enables stale-while-revalidate in frontend.',
          },
          {
            id: 'p4-t2',
            title: 'XState — sync state machine only',
            tags: ['frontend', 'backend'],
            note: 'Scope: sync lifecycle states only. Not the whole app. States: idle → discovering → pairing → streaming → merging → done | error | reset_required.',
          },
        ],
      },
      {
        title: 'DAG Op Log',
        icon: '🕸️',
        tasks: [
          {
            id: 'p4-t3',
            title: 'Multi-entry parent_seqs on merge ops',
            tags: ['backend'],
            critical: true,
            note: 'Schema already supports this from Phase 1. Only write + read logic changes. Merge op parent_seqs = one entry per syncing device.',
          },
          {
            id: 'p4-t4',
            title: 'LCA algorithm — per-block edit chain',
            tags: ['backend'],
            critical: true,
            note: 'find_lca(op_a, op_b): walk prev_edit pointers. O(chain depth). Returns ancestor text_at(). No graph library needed.',
          },
          {
            id: 'p4-t5',
            title: 'text_at() helper',
            tags: ['backend'],
            note: "op_type='edit_block' → payload.to_text. op_type='create_block' → payload.content. Edge: no prior edit → create_block content.",
          },
        ],
      },
      {
        title: 'diffy Integration',
        icon: '🔀',
        tasks: [
          {
            id: 'p4-t6',
            title: 'diffy::merge() integration',
            tags: ['backend'],
            critical: true,
            note: 'Call: diffy::merge(ancestor_text, ours, theirs). Ok(String) → new edit_block op. Err(MergeConflict) → conflict copy path.',
          },
          {
            id: 'p4-t7',
            title: 'Conflict copy creation on merge failure',
            tags: ['backend'],
            note: 'New block: is_conflict=1, conflict_source=original_block_id, content=conflicting version. Original retains ancestor content.',
          },
          {
            id: 'p4-t8',
            title: 'Property conflict LWW resolution',
            tags: ['backend'],
            note: 'Concurrent set_property for same (block_id, key): last-writer-wins on created_at, device_id as tiebreaker. Log to audit list.',
          },
          {
            id: 'p4-t9',
            title: 'diffy integration tests',
            tags: ['testing'],
            critical: true,
            note: 'Test: clean merge (non-overlapping edits), conflict (overlapping), ULID token handling, Markdown mark boundaries.',
          },
        ],
      },
      {
        title: 'mDNS Discovery + Pairing',
        icon: '📡',
        tasks: [
          {
            id: 'p4-t10',
            title: 'mDNS peer discovery',
            tags: ['backend'],
            note: 'Local network only. Announce on launch, scan for peers. Tauri event on discovery.',
          },
          {
            id: 'p4-t11',
            title: '4-word EFF passphrase generation',
            tags: ['backend'],
            note: '~51 bits entropy. Ephemeral — discarded after pairing or 5-minute timeout. Host generates per session.',
          },
          {
            id: 'p4-t12',
            title: 'QR code display (passphrase + host address)',
            tags: ['frontend'],
            note: 'Both QR and 4-word text paths derive identical session keys. QR: encode passphrase + address.',
          },
          {
            id: 'p4-t13',
            title: 'tokio-tungstenite + rustls transport',
            tags: ['backend'],
            note: 'WebSocket over TLS. Session key derived from passphrase. No persistent shared key.',
          },
        ],
      },
      {
        title: 'Sync Protocol',
        icon: '🔄',
        tasks: [
          {
            id: 'p4-t14',
            title: 'Head exchange + divergence walk',
            tags: ['backend'],
            critical: true,
            note: 'Exchange latest (device_id, seq, hash) per device. Walk parent_seqs DAG to find common ancestor. Determine diverging ops.',
          },
          {
            id: 'p4-t15',
            title: 'Op streaming (sender + receiver)',
            tags: ['backend'],
            note: 'Stream diverging ops. Receiver: INSERT OR IGNORE on composite PK — duplicate delivery is idempotent.',
          },
          {
            id: 'p4-t16',
            title: 'RESET_REQUIRED detection + protocol',
            tags: ['backend'],
            critical: true,
            note: "Peer's last known op predates oldest retained op AND no snapshot covers it → RESET_REQUIRED. Never silent — explicit user confirm.",
          },
          {
            id: 'p4-t17',
            title: 'peer_refs maintenance (atomic)',
            tags: ['backend'],
            note: 'last_hash, last_sent_hash, synced_at updated atomically at end of successful sync only. Failure = no update = safe restart.',
          },
          {
            id: 'p4-t18',
            title: 'Sync UI — pairing, progress, conflicts',
            tags: ['frontend'],
            note: 'XState machine drives UI states. RESET_REQUIRED: explicit confirm dialog. Never a silent replace.',
          },
        ],
      },
      {
        title: 'Snapshot + Compaction',
        icon: '📦',
        tasks: [
          {
            id: 'p4-t19',
            title: 'zstd + ciborium snapshot encoding',
            tags: ['backend'],
            note: 'CBOR document: schema_version, snapshot_device_id, up_to_seqs frontier, all core table rows. No cache tables.',
          },
          {
            id: 'p4-t20',
            title: 'Snapshot write sequence (crash-safe)',
            tags: ['backend'],
            critical: true,
            note: "1) INSERT status='pending'. 2) Compress+write data. 3) UPDATE status='complete'. Boot cleanup deletes pending rows.",
          },
          {
            id: 'p4-t21',
            title: 'Snapshot apply (RESET path)',
            tags: ['backend'],
            note: 'Wipe core tables. Decode CBOR. Insert rows. Replay tail ops. Trigger background cache rebuilds + FTS5 optimize.',
          },
          {
            id: 'p4-t22',
            title: '90-day op log compaction scheduler',
            tags: ['backend'],
            note: "Background task. Runs when op_log rows older than 90 days exist. Produces log_snapshot. Purges old ops after snapshot status='complete'.",
          },
        ],
      },
      {
        title: 'Full Android',
        icon: '📱',
        tasks: [
          {
            id: 'p4-t23',
            title: 'Full Android build pipeline',
            tags: ['infra'],
            note: 'Tauri 2.0 Android target. CI: cross-compile Rust, APK build. Not throwaway spike — production target.',
          },
          {
            id: 'p4-t24',
            title: 'Android layout: virtual keyboard + safe areas',
            tags: ['frontend'],
            note: 'WindowInsets. Keyboard avoid. Tailwind rtl: variants active. Noto Sans rendering validated.',
          },
          {
            id: 'p4-t25',
            title: 'Android: mDNS + sync UI',
            tags: ['frontend'],
            note: 'Same sync flow as Linux. QR scan for pairing on Android. Platform-specific camera permission.',
          },
        ],
      },
    ],
  },
  {
    id: 'p5',
    label: 'Phase 5',
    title: 'Polish',
    estimate: '6–8 weeks',
    color: '#f43f5e',
    dim: '#fb7185',
    bg: 'rgba(244,63,94,0.08)',
    border: 'rgba(244,63,94,0.25)',
    description:
      'i18n, CJK search, export, auto-updates, graph view. The difference between a great tool and a shipped product.',
    adrs: ['ADR-12', 'ADR-17', 'ADR-19', 'ADR-20'],
    groups: [
      {
        title: 'i18n',
        icon: '🌍',
        tasks: [
          {
            id: 'p5-t1',
            title: 'i18n framework selection + string extraction',
            tags: ['frontend', 'dx'],
            note: 'Extract all UI strings. RTL layout: Tailwind rtl: variants already prepared. Noto Sans covers CJK + Arabic.',
          },
          {
            id: 'p5-t2',
            title: 'RTL layout validation',
            tags: ['frontend', 'testing'],
            note: 'Block tree, pickers, journal, history panel. rtl: Tailwind variants. Noto Sans rendering on Android confirmed.',
          },
        ],
      },
      {
        title: 'CJK Search — Tantivy + lindera',
        icon: '🔤',
        tasks: [
          {
            id: 'p5-t3',
            title: 'Tantivy index — disk, alongside SQLite',
            tags: ['backend'],
            note: 'Background materializer queue maintains Tantivy. Source of truth = op log + blocks. Tantivy is derived.',
          },
          {
            id: 'p5-t4',
            title: 'lindera integration (Japanese, Chinese, Korean)',
            tags: ['backend'],
            note: "会議室 → ['会議', '室']. IPAdic + CC-CEDICT as priority. IPADIC-NEologd optional/off by default.",
          },
          {
            id: 'p5-t5',
            title: 'Optional dictionary download flow',
            tags: ['frontend'],
            note: "First CJK search → 'Better search available. Download ~18MB?' Stored in app-private storage. Non-blocking.",
          },
          {
            id: 'p5-t6',
            title: 'FTS5 + Tantivy parallel index window',
            tags: ['backend'],
            note: 'Both maintained during transition. FTS5 for non-CJK. Tantivy for CJK queries once dictionary available.',
          },
        ],
      },
      {
        title: 'Export',
        icon: '📤',
        tasks: [
          {
            id: 'p5-t7',
            title: 'Export serializer — ULID → human names',
            tags: ['backend'],
            note: '#[ULID] → #tagname (tags_cache). [[ULID]] → [[Page Title]] (pages_cache). Output: standard Markdown + Obsidian wikilinks.',
          },
          {
            id: 'p5-t8',
            title: 'Export UI — per-page and full vault',
            tags: ['frontend'],
            note: 'File picker for destination. Progress indicator. Lossy by design — documented. Round-trip import deferred.',
          },
          {
            id: 'p5-t9',
            title: 'Frontmatter YAML for properties',
            tags: ['backend'],
            note: 'block_properties → frontmatter on export. value_date, value_text, value_num, value_ref (as page title).',
          },
        ],
      },
      {
        title: 'Auto-updates',
        icon: '🔁',
        tasks: [
          {
            id: 'p5-t10',
            title: 'Tauri updater setup',
            tags: ['infra'],
            note: 'GitHub Releases as update server. Sign binaries. Linux: AppImage or .deb. Android: sideload or F-Droid track.',
          },
        ],
      },
      {
        title: 'Graph View',
        icon: '🕸️',
        tasks: [
          {
            id: 'p5-t11',
            title: 'Graph data query',
            tags: ['backend'],
            note: 'block_links JOIN blocks. Tag relationships via block_tags. Data already in schema — this is visualisation only.',
          },
          {
            id: 'p5-t12',
            title: 'react-force-graph on WebGL canvas',
            tags: ['frontend'],
            note: 'ADR-17: D3 and Cytoscape rejected. react-force-graph chosen if graph view is built. Deferred to Phase 5.',
          },
        ],
      },
    ],
  },
]

const TAG_COLORS = {
  backend: { bg: '#1e1b4b', border: '#4338ca', text: '#a5b4fc' },
  frontend: { bg: '#0c1a2e', border: '#0369a1', text: '#7dd3fc' },
  dx: { bg: '#052e16', border: '#15803d', text: '#86efac' },
  testing: { bg: '#2d1b00', border: '#b45309', text: '#fcd34d' },
  infra: { bg: '#1c1917', border: '#57534e', text: '#d6d3d1' },
}

const SUMMARY = {
  total: '12–18 months at ~10 h/week',
  dailyDriver: 'Month 3–4',
  criticalPath: [
    'Markdown serializer + tests',
    'Composite op log PK + hash chain',
    'Materializer CQRS split',
    'Cursor-based pagination from day one',
    'Android spike gate before Phase 2',
    'Crash-safe snapshot write sequence',
  ],
  nonNegotiable: [
    'Op log append-only invariant',
    'Materializer CQRS split',
    'Three-way merge for sync',
    'Pagination on all list queries',
  ],
}

function Tag({ t }) {
  const c = TAG_COLORS[t] || TAG_COLORS.infra
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '2px 7px',
        borderRadius: 4,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.text,
      }}
    >
      {t}
    </span>
  )
}

function Task({ task, phaseColor }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      onClick={() => setOpen((o) => !o)}
      style={{
        background: open ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.015)',
        border: `1px solid ${task.critical ? `${phaseColor}55` : 'rgba(255,255,255,0.07)'}`,
        borderLeft: task.critical ? `3px solid ${phaseColor}` : '1px solid rgba(255,255,255,0.07)',
        borderRadius: 8,
        padding: '10px 14px',
        cursor: 'pointer',
        transition: 'background 0.15s',
        marginBottom: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 13,
            color: task.critical ? '#f9fafb' : '#d1d5db',
            fontWeight: task.critical ? 600 : 400,
            flex: 1,
            minWidth: 180,
          }}
        >
          {task.critical && (
            <span style={{ color: phaseColor, marginRight: 6, fontSize: 11 }}>●</span>
          )}
          {task.title}
        </span>
        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
          {task.tags.map((t) => (
            <Tag key={t} t={t} />
          ))}
        </div>
        <span style={{ color: '#6b7280', fontSize: 12 }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && task.note && (
        <div
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid rgba(255,255,255,0.06)',
            fontSize: 12.5,
            color: '#9ca3af',
            lineHeight: 1.65,
          }}
        >
          {task.note}
        </div>
      )}
    </div>
  )
}

function Group({ group, phaseColor }) {
  const [open, setOpen] = useState(true)
  return (
    <div style={{ marginBottom: 18 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: '#e5e7eb',
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: '0.02em',
          marginBottom: 10,
          padding: 0,
        }}
      >
        <span>{group.icon}</span>
        <span>{group.title}</span>
        <span style={{ color: '#4b5563', fontSize: 11, marginLeft: 4 }}>
          {group.tasks.filter((t) => t.critical).length > 0 && (
            <span style={{ color: phaseColor, opacity: 0.8 }}>
              {group.tasks.filter((t) => t.critical).length} critical
            </span>
          )}
        </span>
        <span style={{ color: '#4b5563', fontSize: 11, marginLeft: 'auto' }}>
          {open ? '−' : '+'}
        </span>
      </button>
      {open && group.tasks.map((t) => <Task key={t.id} task={t} phaseColor={phaseColor} />)}
    </div>
  )
}

function PhaseCard({ phase }) {
  const [open, setOpen] = useState(false)
  const allTasks = phase.groups.flatMap((g) => g.tasks)
  const criticalCount = allTasks.filter((t) => t.critical).length

  return (
    <div
      style={{
        border: `1px solid ${phase.border}`,
        borderRadius: 14,
        background: phase.bg,
        marginBottom: 20,
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          width: '100%',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '20px 24px',
          textAlign: 'left',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
          <div
            style={{
              background: phase.color,
              color: '#fff',
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              padding: '4px 10px',
              borderRadius: 6,
              flexShrink: 0,
              marginTop: 2,
            }}
          >
            {phase.label}
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#f9fafb', marginBottom: 4 }}>
              {phase.title}
            </div>
            <div style={{ fontSize: 12.5, color: '#9ca3af', lineHeight: 1.5 }}>
              {phase.description}
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 12, color: phase.dim, fontWeight: 600 }}>{phase.estimate}</div>
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
              {allTasks.length} tasks · {criticalCount} critical
            </div>
          </div>
          <span style={{ color: '#4b5563', fontSize: 16, marginTop: 4 }}>{open ? '▲' : '▼'}</span>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          {phase.adrs.map((a) => (
            <span
              key={a}
              style={{
                fontSize: 10,
                fontWeight: 600,
                letterSpacing: '0.05em',
                color: phase.dim,
                background: `${phase.color}18`,
                border: `1px solid ${phase.color}33`,
                borderRadius: 4,
                padding: '2px 7px',
              }}
            >
              {a}
            </span>
          ))}
        </div>
      </button>

      {open && (
        <div style={{ padding: '0 24px 24px', borderTop: `1px solid ${phase.border}` }}>
          <div style={{ height: 20 }} />
          {phase.groups.map((g) => (
            <Group key={g.title} group={g} phaseColor={phase.color} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [tab, setTab] = useState('plan')

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#080c12',
        color: '#e5e7eb',
        fontFamily: "'DM Sans', 'IBM Plex Sans', system-ui, sans-serif",
        padding: '32px 20px',
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        button:hover { opacity: 0.88; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
      `}</style>

      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 32 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              color: '#6366f1',
              marginBottom: 8,
            }}
          >
            Project Plan
          </div>
          <h1
            style={{
              fontSize: 32,
              fontWeight: 800,
              color: '#f9fafb',
              margin: 0,
              letterSpacing: '-0.02em',
            }}
          >
            Block Notes App
          </h1>
          <p style={{ color: '#6b7280', marginTop: 8, fontSize: 14, lineHeight: 1.6 }}>
            Local-first · Linux + Android · Journal-first · No cloud
          </p>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 28,
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 10,
            padding: 4,
            width: 'fit-content',
          }}
        >
          {[
            ['plan', '📋 Phase Plan'],
            ['critical', '🔴 Critical Path'],
            ['nonneg', '⚠️ Non-Negotiables'],
            ['stack', '🔧 Stack'],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                background: tab === id ? '#1e293b' : 'none',
                border: tab === id ? '1px solid rgba(255,255,255,0.12)' : '1px solid transparent',
                borderRadius: 7,
                padding: '7px 14px',
                color: tab === id ? '#f9fafb' : '#6b7280',
                fontSize: 13,
                fontWeight: tab === id ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Plan tab */}
        {tab === 'plan' && (
          <div>
            {/* Timeline bar */}
            <div
              style={{
                display: 'flex',
                gap: 4,
                marginBottom: 28,
                borderRadius: 10,
                overflow: 'hidden',
                height: 8,
              }}
            >
              {PHASES.map((p, i) => {
                const widths = [18, 14, 20, 10, 38] // rough proportional widths
                return (
                  <div key={p.id} style={{ flex: widths[i], background: p.color, opacity: 0.7 }} />
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 28, flexWrap: 'wrap' }}>
              {PHASES.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                    color: '#9ca3af',
                  }}
                >
                  <div style={{ width: 10, height: 10, borderRadius: 2, background: p.color }} />
                  {p.label}: {p.estimate}
                </div>
              ))}
            </div>
            <div
              style={{
                background: 'rgba(99,102,241,0.08)',
                border: '1px solid rgba(99,102,241,0.2)',
                borderRadius: 10,
                padding: '12px 16px',
                marginBottom: 28,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span style={{ fontSize: 18 }}>⏱️</span>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#a5b4fc' }}>
                  Total at ~10h/week:{' '}
                </span>
                <span style={{ fontSize: 13, color: '#c7d2fe' }}>{SUMMARY.total}</span>
                <span style={{ fontSize: 12, color: '#6366f1', marginLeft: 16 }}>
                  Daily driver: {SUMMARY.dailyDriver}
                </span>
              </div>
            </div>
            {PHASES.map((p) => (
              <PhaseCard key={p.id} phase={p} />
            ))}
          </div>
        )}

        {/* Critical path tab */}
        {tab === 'critical' && (
          <div>
            <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
              These tasks block everything downstream. Ship them before moving on. Each one is
              marked with a <span style={{ color: '#6366f1' }}>●</span> in the phase plan.
            </p>
            {PHASES.map((phase) => {
              const criticals = phase.groups.flatMap((g) =>
                g.tasks.filter((t) => t.critical).map((t) => ({ ...t, group: g.title })),
              )
              if (!criticals.length) return null
              return (
                <div key={phase.id} style={{ marginBottom: 28 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                    <div
                      style={{ width: 4, height: 20, background: phase.color, borderRadius: 2 }}
                    />
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#f9fafb' }}>
                      {phase.label} — {phase.title}
                    </span>
                    <span style={{ fontSize: 12, color: '#4b5563' }}>
                      {criticals.length} critical tasks
                    </span>
                  </div>
                  {criticals.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        background: 'rgba(255,255,255,0.02)',
                        border: `1px solid ${phase.color}44`,
                        borderLeft: `3px solid ${phase.color}`,
                        borderRadius: 8,
                        padding: '12px 16px',
                        marginBottom: 8,
                      }}
                    >
                      <div
                        style={{ fontSize: 13, fontWeight: 600, color: '#f9fafb', marginBottom: 4 }}
                      >
                        {t.title}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 8 }}>
                        {t.group}
                      </div>
                      <div style={{ fontSize: 12.5, color: '#9ca3af', lineHeight: 1.65 }}>
                        {t.note}
                      </div>
                      <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
                        {t.tags.map((tag) => (
                          <Tag key={tag} t={tag} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {/* Non-negotiables tab */}
        {tab === 'nonneg' && (
          <div>
            <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
              These are the architectural load-bearing walls. Violating them means rewriting the
              project, not refactoring it.
            </p>
            {[
              {
                rule: 'Op log is strictly append-only',
                why: 'Every sync, history, and recovery mechanism depends on this. A mutable log invalidates hash chains, makes LCA impossible, and breaks INSERT OR IGNORE idempotency on sync.',
                adrs: ['ADR-07'],
                color: '#6366f1',
              },
              {
                rule: 'Materializer CQRS split',
                why: 'Commands write ops. Materializer reads ops and writes derived state. These never merge. If a command writes directly to blocks, you lose the ability to replay, snapshot, or sync without corruption.',
                adrs: ['ADR-08'],
                color: '#8b5cf6',
              },
              {
                rule: 'Three-way merge for text (diffy)',
                why: 'Last-write-wins for text fields is correctness debt that compounds every time two devices edit the same block. Retrofitting three-way merge post-sync means auditing every existing conflict — catastrophic.',
                adrs: ['ADR-10'],
                color: '#06b6d4',
              },
              {
                rule: 'Cursor-based pagination on all list queries',
                why: 'Offset pagination reads N rows from the beginning every time. On 100k blocks, a single page-10 query touches 9,000+ rows. This is the most common performance mistake in notes apps at scale.',
                adrs: ['ADR-08'],
                color: '#10b981',
              },
              {
                rule: 'Serializer complete and tested before Phase 1.5 work begins',
                why: 'Every other Phase 1.5 task depends on correct round-trip identity. A serializer bug found in Phase 2 means content corruption in real data. Treat it as a Phase 1 deliverable.',
                adrs: ['ADR-20'],
                color: '#f59e0b',
              },
              {
                rule: 'Single TipTap instance — never more than one',
                why: 'N instances = N ProseMirror state machines competing for focus and history. The entire keyboard boundary, auto-split, and flush model collapses. Static divs for everything else is not optional.',
                adrs: ['ADR-01'],
                color: '#f43f5e',
              },
            ].map((item) => (
              <div
                key={item.rule}
                style={{
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${item.color}33`,
                  borderLeft: `3px solid ${item.color}`,
                  borderRadius: 10,
                  padding: '18px 20px',
                  marginBottom: 14,
                }}
              >
                <div
                  style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 10 }}
                >
                  <span style={{ color: item.color, fontSize: 18, marginTop: 2, flexShrink: 0 }}>
                    ⛔
                  </span>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#f9fafb' }}>{item.rule}</div>
                </div>
                <p
                  style={{
                    color: '#9ca3af',
                    fontSize: 13,
                    lineHeight: 1.7,
                    margin: '0 0 12px 30px',
                  }}
                >
                  {item.why}
                </p>
                <div style={{ marginLeft: 30, display: 'flex', gap: 6 }}>
                  {item.adrs.map((a) => (
                    <span
                      key={a}
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        color: item.color,
                        background: `${item.color}15`,
                        border: `1px solid ${item.color}33`,
                        borderRadius: 4,
                        padding: '2px 8px',
                      }}
                    >
                      {a}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Stack tab */}
        {tab === 'stack' && (
          <div>
            <p style={{ color: '#9ca3af', fontSize: 14, marginBottom: 24, lineHeight: 1.6 }}>
              Full dependency manifest by phase. Phase-locked entries do not enter earlier — each
              addition should be the minimum needed at the time it's introduced.
            </p>
            {[
              {
                phase: 'Day One / Phase 1',
                color: '#6366f1',
                items: [
                  {
                    name: 'Tauri 2.0',
                    side: 'infra',
                    note: 'Shell + IPC. Android target proven in spike.',
                  },
                  {
                    name: 'React 18 + Vite',
                    side: 'frontend',
                    note: 'Fast HMR. Strict TS from day one.',
                  },
                  {
                    name: 'Biome',
                    side: 'dx',
                    note: 'Replaces ESLint + Prettier. Non-negotiable day one.',
                  },
                  {
                    name: 'sqlx + sqlx-cli',
                    side: 'backend',
                    note: 'Async SQLite, compile-time query macros, migrations.',
                  },
                  {
                    name: 'thiserror + anyhow',
                    side: 'backend',
                    note: 'Typed errors + ergonomic propagation.',
                  },
                  { name: 'blake3', side: 'backend', note: 'Op log hash chaining.' },
                  {
                    name: 'FxHashMap',
                    side: 'backend',
                    note: 'Hot-path hash maps. FxHashSet for tag queries.',
                  },
                  {
                    name: 'Zustand',
                    side: 'frontend',
                    note: 'Boot + editor state enums only. Minimal.',
                  },
                  {
                    name: 'shadcn/ui + Tailwind',
                    side: 'frontend',
                    note: 'Copy-paste, owned, no lock-in. Noto Sans bundled.',
                  },
                  {
                    name: 'Vitest',
                    side: 'dx',
                    note: 'Frontend unit tests. Serializer test suite lives here.',
                  },
                  {
                    name: 'GitHub Actions + tauri-action',
                    side: 'infra',
                    note: 'CI before features.',
                  },
                ],
              },
              {
                phase: 'Phase 1.5',
                color: '#8b5cf6',
                items: [
                  {
                    name: 'TipTap 2',
                    side: 'frontend',
                    note: 'ProseMirror wrapper. Single roving instance.',
                  },
                  {
                    name: 'markdown-serializer.ts (custom)',
                    side: 'frontend',
                    note: 'Own code. No tiptap-markdown. ~150 lines.',
                  },
                ],
              },
              {
                phase: 'Phase 2',
                color: '#06b6d4',
                items: [
                  {
                    name: 'specta + tauri-specta',
                    side: 'dx',
                    note: 'TypeScript type generation from Tauri commands. Deferred until command surface stabilises.',
                  },
                  { name: 'Playwright + tauri-driver', side: 'dx', note: 'E2E tests.' },
                  { name: 'insta', side: 'dx', note: 'Snapshot tests once schema is stable.' },
                ],
              },
              {
                phase: 'Phase 3',
                color: '#10b981',
                items: [
                  {
                    name: 'cargo-nextest',
                    side: 'dx',
                    note: 'Suite large enough to feel slow. Parallel execution.',
                  },
                ],
              },
              {
                phase: 'Phase 4',
                color: '#f59e0b',
                items: [
                  {
                    name: 'diffy',
                    side: 'backend',
                    note: 'Word-level three-way merge. The reason text sync works.',
                  },
                  { name: 'zstd', side: 'backend', note: 'Snapshot compression.' },
                  { name: 'ciborium', side: 'backend', note: 'CBOR for snapshot encoding.' },
                  { name: 'tokio-tungstenite + rustls', side: 'backend', note: 'Sync transport.' },
                  {
                    name: 'TanStack Query',
                    side: 'frontend',
                    note: 'Server state, invalidated by Tauri events.',
                  },
                  {
                    name: 'XState (sync machine only)',
                    side: 'frontend',
                    note: 'Scope: sync state machine. Not the whole app.',
                  },
                ],
              },
              {
                phase: 'Phase 5',
                color: '#f43f5e',
                items: [
                  {
                    name: 'Tantivy',
                    side: 'backend',
                    note: 'CJK full-text search. FTS5 retained in parallel.',
                  },
                  {
                    name: 'lindera',
                    side: 'backend',
                    note: 'Morphological analyser. Dictionaries are optional downloads.',
                  },
                  {
                    name: 'react-force-graph',
                    side: 'frontend',
                    note: 'Graph view. WebGL canvas. Deferred to Phase 5.',
                  },
                ],
              },
            ].map((section) => (
              <div key={section.phase} style={{ marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <div
                    style={{ width: 4, height: 18, background: section.color, borderRadius: 2 }}
                  />
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#f9fafb' }}>
                    {section.phase}
                  </span>
                </div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {section.items.map((item) => (
                    <div
                      key={item.name}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '160px 70px 1fr',
                        alignItems: 'center',
                        gap: 12,
                        background: 'rgba(255,255,255,0.02)',
                        border: '1px solid rgba(255,255,255,0.07)',
                        borderRadius: 8,
                        padding: '9px 14px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 600,
                          color: '#e5e7eb',
                          fontFamily: "'DM Mono', monospace",
                        }}
                      >
                        {item.name}
                      </span>
                      <Tag t={item.side} />
                      <span style={{ fontSize: 12, color: '#6b7280' }}>{item.note}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
