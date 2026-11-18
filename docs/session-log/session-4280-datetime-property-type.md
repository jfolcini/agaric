# Session 4280 — A date-and-time property type (#6758)

A batch sub-session took #6758 (the `datetime` type) and #6755 (writable tag pages and classes) as design issues. Neither had comments, so it posted a design note with numbered decisions on each and waited; the maintainer's answers, relayed by the orchestrator, are recorded on the issues. This PR builds #6758.

**What the maintainer decided.**
- A new `datetime` type beside `date`. The built-in dates stay dates, so the Agenda, reminders and the Tasks fields are unchanged.
- An instant in UTC, `YYYY-MM-DDTHH:MMZ`. The design note had proposed local wall-clock time; the maintainer chose UTC shown in the device's zone.
- Files carry local time with its offset.
- A day alone never becomes a time on its own. Convert offers "Set all N to [time]", pre-filled with 00:00.
- A day operand on a datetime key is the device's local day.

**The premise that was off.** The issue said the type changes the engine format because it is a typed scalar. It doesn't: Loro holds a date as a plain string, and a datetime the same way. The bump is forced by the definition: `property_definitions.value_type` has a CHECK, so an older build cannot project a `datetime` definition. That makes it migration 0134 plus engine format 8.

**Traps found on the way.**
- `agenda_cache` projects every `value_date`, so a datetime would have become an agenda date. The derivation now takes only ten-character values.
- `date` and `datetime` share `value_date`, so the old "did the column change" test for re-projecting on a retype missed them. That test is now `retype_moves_str_values`.
- The pure filter compilers know no definitions. Search, the query engine and the Pages view read a datetime key's operand first, with one definition lookup. The References panel's filter and the legacy `{{query property:…}}` / `query_by_property` paths still compare the stored text.
- The Rust and TS readers must accept the same inputs. The review caught TS refusing `+0100`.
- `CONFORMANCE_UPDATE=1` re-serializes every fixture. Restore the untouched ones and oxfmt the new one.
- #6879 merged mid-build, so the new keys carry es/pt/de/fr translations.

**What ran.**
- Rust: workspace nextest in both partitions, clippy `-D warnings`, `sqlx prepare --check` and the conformance fixture `property_datetime.json`, on the branch before `main` was merged in. The merge re-ran `cargo check` and the touched filters.
- Frontend: vitest across `src/`, typecheck and oxlint.
- e2e: Playwright `e2e/property-datetime.spec.ts` (Berlin time zone) and the property specs.
- The new tests were shown red, either written first or by a mutation run in one command.
- Not run: the e2e-tauri lane and Android.
