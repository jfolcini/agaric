# Session 4279 — backend validation errors in the user's language

The ask, a follow-up to session 4244's catalogs: backend errors arrive as `AppError { kind, message, code? }` with an English `message`, so a Spanish user read "a tag named 'x' already exists in this space". Translate them by their code.

## What shipped

- **`translatedErrorSentence`** in `src/lib/error-display.ts`, used by `formatErrorForDisplay`, the formatter every toast and inline banner goes through. A coded validation error renders the sentence its code maps to in `VALIDATION_CODE_KEYS: Record<ValidationCode, string | null>`, so `tsc` fails when the backend adds a code without one. A sanitized internal error (`kind: 'internal'`, message ending in `(err: <id>)`) renders `error.internal`, "Something went wrong (err: {{id}})", keeping the correlation code users read back. Debug mode appends the backend's raw message and the code after the sentence.
- **Everything else keeps the backend's message**: uncoded `validation`, `invalid_operation`, `not_found` and `conflict` messages explain one specific failure in a way a generic sentence would lose.
- **`DuplicatePageTitle` maps to `null`.** Only the English message names the clashing title, which a batch move, restore or revert needs; translating it needs the title as structured data from the backend.
- **Five codes reuse sentences the catalogs already had** (`pageBrowser.filter.invalidFilter`, `error.pageNotInCurrentSpace`, `pageHeader.aliasTaken`, `agentAccess.agents.invalidName`, `tags.nameHasWhitespace`). The new `errorCode.*` keys and `error.internal` carry a `// Translators:` note and are translated into Spanish, Portuguese, German and French. The repeat-rule sentence keeps the accepted vocabulary with the syntax literal. French uses "motif", because "modèle" is the glossary's template.
- **Two bypasses now go through the formatter:** `invalidRepeatRuleMessage` (`repeat-utils.ts`) and `reportIpcErrorWithReason` for coded errors. `PageSourceEditor`'s jump-to-line reads the line prefix from the raw message, so a translated refusal still selects its line.
- **Claims that the UI shows the backend's message verbatim** are gone from the `InvalidRepeatRule` doc and `Serialize` comment in `agaric-core/src/error.rs`, from `recurrence/parser.rs` (`REPEAT_RULE_HELP` now points at `errorCode.invalidRepeatRule`, so a grammar change edits both), and from the frontend comments that repeated them. `src/lib/bindings.ts` is regenerated from the doc-comment change.

## Decisions and traps

- The specific repeat-rule hint ("it contains a space, write `++1d`") no longer shows outside debug mode, in English too. The translated help lists everything accepted, which is enough to fix any rule; MCP agents, debug mode and the log still get the hint.
- `errorCode.duplicateAgentName`, `errorCode.requiresRefresh` and `errorCode.unacknowledgedPropertyLoss` cannot reach the formatter today, because each code's only caller handles it itself. They stay so that every code follows the one rule the `Record` enforces, instead of a reachability list that goes stale.
- Still English on purpose: a taken title (above), and the inline regex alert, which keeps the regex engine's position detail. `importErrorReason` can only see `DuplicatePageTitle` among coded errors.

## What ran

- Red first: under Spanish, the coded, internal and debug tests got the backend's English back where the Spanish sentence was expected. The new `PageSourceEditor` coded-line test failed on focus before the fix.
- Falsified in one shell command each (backup, `trap` restore, `cmp`): a code dropped from the map (`npm run typecheck`, TS2741), the coded branch returning null, `DuplicatePageTitle` mapped to a key, the internal branch returning null, the raw message dropped from debug output, a typo in a map key (the map-covers-the-catalog test), each bypass unrouted, and the line fallback removed. Each reddened the test predicted.
- `e2e/backend-error-language.spec.ts` switches to Español, types `repeat:: nope` inline, asserts the Spanish toast and re-queries that nothing was stored. Unrouting `invalidRepeatRuleMessage` reddened it. With `spaces-management`, `history-revert`, `properties-table-and-refusals`, `language-preference` and `tag-name-whitespace`, the e2e runs passed.
- vitest over `src/lib`, `src/hooks`, `src/stores` and the affected component folders: green. `npm run typecheck`, `oxlint --type-aware` and `oxfmt` on the changed files, `npx knip` and `check-import-cycles`: clean. nextest on the bindings test and `recurrence::parser`, `cargo fmt --check` and `cargo clippy -p agaric-engine --all-targets -- -D warnings`: clean.
