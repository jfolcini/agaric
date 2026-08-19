# Session 1359 — Log-injection escape made structural, and the dead `agaric.log` branch corrected (2026-08-20)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-20 |
| **Subagents** | orchestrator-only (adversarial review of an inherited diff) |
| **Items closed** | `#4127`, `#4128` |
| **Items modified** | — |
| **Tests added** | +0 (frontend) / +7 (backend) |
| **Files touched** | 3 |

**Summary:** Adversarially reviewed an inherited, uncommitted diff claiming to fix #4127
(`recent_errors_from_log_dir`'s unreachable plain-`agaric.log` branch plus a comment
describing logrotate rather than `tracing-appender`) and #4128 (attribute KEYS written raw
by `format_log_record` / `format_span`, so a `\n` in a key forges a second
legitimate-looking record). Both claims verified against primary sources — the vendored
`tracing-appender` 0.2.5 `RollingWriter::join_date` match arms, and every line-writer in
`agaric-observability` — and both fixes are correct. The review found the #4128 fix under-
tested rather than wrong: it demonstrated only the newline, on a format with **two**
separators, so the escape was widened in coverage (not in behaviour) to pin field-count as
well as record-count, plus escape injectivity and the one field deliberately exempt from
`sanitize_inline`.

**Files touched (this session):**
- `src-tauri/agaric-observability/src/exporter.rs` (+441/−12)
- `src-tauri/src/commands/bug_report.rs` (+97/−12)
- `src-tauri/src/lib.rs` (+6/−4)

**What the review established**

*#4127 — verified on the primary source, not the summary.* `tracing-appender` 0.2.5's
`RollingWriter::join_date` matches `(_, Some(filename), None) => format!("{}.{}", filename,
date)`; the bare-prefix arm is guarded by `Rotation::NEVER`. `build_log_file_appender` uses
`Rotation::DAILY` + `filename_prefix("agaric.log")` + no suffix, so the live file is
`agaric.log.YYYY-MM-DD` from creation. Both sides derive the date in UTC
(`OffsetDateTime::now_utc` vs `chrono::Utc::now`), so the two names agree. Checked the
deployment-regression question the reordering raises: the appender's history only ever ran
`rolling::daily(dir, "agaric.log")`, which is `RollingFileAppender::new` → the same
prefix+date path — **no released build ever wrote a plain `agaric.log`**, so no user's log
dir holds one that the new ordering could newly shadow. The diff keeps the plain name as an
explicitly-documented tolerance rather than deleting it, which the issue permits.

*#4128 — attacked the sanitizer rather than re-checking the newline.* `sanitize_inline`
escapes `\\` first, then `\n`/`\r`/`\t`. Attacks run against an attribute key, both writers:
a **tab** (forges an extra FIELD, not an extra record — invisible to a record-count
assertion, and `bug_report::redact_kv_line`'s skeleton allowance is POSITIONAL, so a shifted
field is the interesting attack) — escaped; **CR alone** and **CRLF** — escaped; **U+2028 /
U+2029** — not escaped, and correctly so: the only reader is `bug_report`, whose `redact_log`
splits records with `split_inclusive('\n')` and whose `redact_kv_line` splits fields with
`split('\t')`; neither, nor `str::lines()`, treats a Unicode separator as a break; **literal
`=` in the key**, **empty key**, **all-whitespace key**, **16 KiB key**, **bare backslash** —
all leave record count and field count exact. **Escape ambiguity:** because `\\` is replaced
first the mapping is injective, so a literal backslash-`n` in the input cannot impersonate an
escaped newline to a reader that unescapes; pinned by a round-trip test over a corpus.

*Every write site.* Enumerated all four line-writers in the crate — `exporter::format_span`,
`exporter::format_log_record`, `ingest::write_frontend_span`, and `metrics_exporter`'s
`write_attrs`/sum/histogram writers (all funnel through `RollingFileSink::write_buf`; `otlp.rs`
is protobuf-over-HTTP, not a line format). `ingest` and `metrics_exporter` already sanitized
both key and value; the diff closes the two that did not. **No raw write site remains.** The
one string-bearing field still exempt is `format_span`'s `status={status:?}`, which is safe
because `Status::Error`'s derived `Debug` escapes through `str`'s `Debug` — a property of the
formatter, not of the caller set, so it is now pinned by its own test rather than left as an
unstated assumption.

**Changes made on top of the inherited diff**
- `exporter.rs`: `sanitize_inline_is_an_injective_escape_over_every_framing_byte` — escape
  table plus an unescape round trip, so the `\\`-first ordering is load-bearing and pinned.
- `exporter.rs`: `format_span_attribute_key_cannot_forge_a_field_or_a_record` and
  `format_log_record_attribute_key_cannot_forge_a_field_or_a_record` — an 11-case hostile-key
  table (shared const, each case annotated with what it is trying to do) plus a 16 KiB key,
  asserting exact record count AND exact field count (8 and 7 respectively) for every case.
- `exporter.rs`: `format_span_status_description_cannot_split_a_record` — pins the one
  deliberately-unsanitized field.
- `exporter.rs`: `sanitize_inline`'s doc now states the injectivity requirement (why `\\`
  must stay first) and records U+2028/U+2029 as a considered, documented non-escape.
- `lib.rs`: the #3246 test's doc comment still said the read side "tries [the plain
  `agaric.log`] first" — stale the moment #4127 landed; re-pointed.

**Vacuity check — each new test verified to redden against a real production change:**
- Reverting key sanitization in both writers → the 2 inherited key tests + both new
  field-count tests FAIL (4 failures); injectivity and status tests correctly stay green.
- Moving `sanitize_inline`'s `\\` replacement last (non-injective) → the injectivity test
  FAILS, along with 3 escape-shape assertions.
- Rendering `Status::Error`'s description without `Debug` → **exactly** the status test FAILS
  (1 failure), nothing else.
- Restoring the pre-fix `plain-first` ordering in `recent_errors_from_log_dir` → the #4127
  test FAILS with `got: ["2020-01-01 ERROR [agaric] STALE_MARKER"]` — i.e. for precisely the
  stated reason, confirming the inherited test's "write BOTH files with distinct markers"
  reasoning was sound; a single-file test would have passed pre-fix via the old fallback.

**Verification:**
- `cd src-tauri && cargo nextest run --workspace` — 5928 tests run, 5928 passed, 7 skipped.
  (Bare form without `--workspace` is package-scoped to `agaric` only and silently skips every
  `agaric-engine`/`agaric-store`/`agaric-sync`/etc. test — #3212.)
- `cargo fmt --check` — clean.
- `cargo check --all-targets` — clean.

**Process notes:** The escape ordering in `sanitize_inline` was the only genuinely load-
bearing line with no test behind it — three `.replace` calls whose correctness depends
entirely on which one runs first, and reordering them compiles, passes review by eye, and
silently reintroduces the forgery one layer down in whatever tool unescapes the bundle.

**Lessons learned (for future sessions):** For a delimiter-injection fix, the record
separator is only half the format. Assert the FIELD count too — a tab in a key shifts every
later field's position, which is exactly what a positional allowlist (`redact_kv_line`'s
skeleton) keys off, and a record-count assertion cannot see it.

**Commit plan:** not pushed (working tree left for the caller to stage and commit).
