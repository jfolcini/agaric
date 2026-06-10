# Session 996 — Full backend + frontend multi-agent review (2026-06-10)

## What happened

Deep multi-agent review of the entire Rust backend (~253K lines incl. tests), 12 domain
scopes × 2 model passes (Opus 4.8, then redone on Fable 5 1M) + 5 adversarial
verification agents that re-checked every finding against the working tree and the
open-issue tracker.

## Output

- **106 new issues filed: #602–#707** (1 CRITICAL, ~10 HIGH, ~28 MEDIUM, rest LOW/cleanup),
  every one adversarially verified with file:line evidence before filing.
- **8 existing issues updated** with cross-references: #87 (sync findings index),
  #126 (G2 release gate), #139, #142, #113, #587, #129, #589.
- **6 candidate findings refuted** during verification (not filed as bugs):
  gcal `access_type=offline` "first-connect breaks" (Google installed-app flow always
  returns refresh tokens), description-cap CJK overflow (limit is chars not bytes),
  retry-queue `is_global`/`from_str` omissions (arms exist), `normalize_ulid_arg`
  looseness (documented design), dag step-cap unreachability (arm is reachable).

## Headline confirmed findings

- **#602 CRITICAL** — `check_reset_required` op-log head lookup: two devices that both
  edited can never sync again under the loro-vv protocol (test suite masks it by
  hand-seeding the responder's op_log).
- **#603 HIGH** — every create/move is engine-applied twice; the post-commit
  `merge::engine_apply` path ignores `index` (#400 drift) → sibling order corrupts on
  boot replay and is reprojected into SQL.
- **#604 HIGH** — `apply_reverse_in_tx` still writes reserved keys into
  `block_properties`; undo of task-state ops aborts on the 0088 CHECK or silently
  no-ops. Companion to #534/#589.
- **#605 HIGH** — recovery `set_property('space')` lacks the FK existence guard →
  dangling space ref = permanent boot failure.
- **#606 HIGH** — blocks rebuild migrations cascade-wiped `page_aliases`/`block_drafts`
  (authoritative, unrecoverable); 0085's safety header is false.
- **#607 HIGH** — snapshot RESET leaves `loro_doc_state`/inbox/cursor stale; the
  "caller restarts" doc claim is false; exit-save persists the stale engines.
- **#608 HIGH** — gcal FEAT-3p9 M1 migration clears the legacy keyring entry production
  still reads → silent disconnect on upgrade (release-gates #126).

## Architecture follow-ups (everything-is-a-block discussion)

- **#708** — first-class `spaces` registry table (`blocks.space_id` → FK to `spaces(id)`);
  structurally supersedes #612, collapses #681. Small, recommended soon.
- **#709 (plan)** — re-key tags by normalized name instead of ULID-identified tag blocks;
  Phase 1 (name-keyed LoroMap) IS the #622 fix, Phase 2 retires the #626 class at source.
  Gated on #622's timing. Pages stay on the unified block model (deliberate decision).

## Branch note

`refactor/589-reserved-key-single-source` WIP was itself flagged by the review
(documented drift tests don't exist yet; constants unconsumed) — must be completed
(drift test + wiring into `reserved_key_blocks_column`/`is_builtin_property_key`/
`history.rs` routing) before it ships. See comment on #589.

## Frontend round (same session, Fable 5 throughout)

12 domain scopes over src/ (~109K prod lines + ~200K test lines) + 4 adversarial
verifiers. **54 issues filed: #710–#763** (13 HIGH, ~30 MEDIUM; clusters for the LOW
tier), 5 existing issues updated (#532 round-trip evidence, #408 phone-DnD-absent,
#155 harness gaps, #90 design-system items, #134 App-Link blocker).

Headline HIGHs: editor round-trip corruption family + zero-edit canonicalization
(#710/#711 — evidence for #532); zoom×DnD ejection (#712); journal N-times listener
execution (#713); six stale-snapshot store mutators (#714); per-keystroke flushDraft
write-lock (#715); Android back exits app (#716); tag:/path: search filter drops
(#717/#718); agenda label-sort/AND-filters/truncation (#719–#721); rules-of-hooks
unlinted (#722); keyboard rebinding partially fake (#723/#724).

Verification corrections worth noting: sidebar IS error-boundary-wrapped; pure-tag:
queries return empty (mixed queries are the bug); esbuild devDep not vestigial;
tw-animate-css absence CONFIRMED against the built CSS (all overlay animations dead);
WCAG failures independently recomputed (4.090:1); the "missing agenda-virtualization
e2e" claim was mooted — PR #592 merged, this branch predates it.

## Model comparison (Opus 4.8 vs Fable 5, same prompts, batches A+B redone)

Fable 5 found ~85 findings vs Opus ~45 on identical scopes; Fable's fully-refuted rate
was ~1% vs Opus ~11% (Opus hallucinated two nonexistent code omissions and one
false-HIGH from wrong external API knowledge). Unique-to-Fable headline finds: #602,
#604-at-HIGH, #606, #608, plus the glob-mojibake and tags_cache flip-flop. Both models
independently found #603/#605/#607. Fable used ~1.5–2.5× the tokens and 2–3× the
wall-clock per agent. Adversarial verification was load-bearing for both.
