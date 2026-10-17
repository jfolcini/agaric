# Session 2320 — Review notes from #5664 to #5705

The non-blocking notes from the night's merges, batched; each was checked
against the code before it was acted on.

- **#5671, oracle:**
  - `engine_scalar` copied `PropertyValue::as_legacy_string` line for line.
    The method is now `pub` (it lives in `agaric-engine`; the oracle is in
    the app crate, out of `pub(crate)`'s reach) and the copy is gone.
  - `reconcile_all` read and folded `block_tag_inherited` twice. It now
    folds once and hands both maps to a synchronous provenance diff, with
    output order unchanged. `reconcile` then had only test callers, so it is
    `#[cfg(test)]`.
- **#5673:** `QrScanner`'s header listed a file-upload fallback that does not
  exist, and a comment still said the scanner falls back to manual entry. Both
  are corrected.
- **#5694:** collapsing Turn into left the Callout disclosure open. On reopen,
  the types could sit below the fold, because the scroll-into-view effect did
  not rerun. Collapsing now closes Callout too, with a test.
- **#5696:**
  - A save refused while Preview or Changes showed selected the line in the
    hidden buffer, so the error's line never appeared. It now switches to
    Edit first, with a test.
  - The preview's created-name maps were module-level and grew for the whole
    session. They are now per component, held in state rather than a ref,
    because oxlint refuses a ref read during render.
- **#5697:**
  - Typing over a selection inside a ULID token inserted after the token. It
    is now refused, like typing at a caret inside one, with a test. The
    clamp's collapse branch stays, since a paste at a caret still uses it.
  - Matching Crockford's alphabet only was not done. The save path
    (`cache::PAGE_LINK_RE`, used by `rewrite_inbound_page_links` and
    `collect_inbound_page_link_bodies`) reads any 26-character `[0-9A-Z]`
    body as an id. A narrower editor regex would unlock text the save still
    treats as an id, and would hide its warning.
- **#5701:** `verify-release-build.sh` probed for `.AppImage.tar.gz`,
  `.msi.zip` and `.exe.zip` updater payloads, which the bundler never
  produces with `createUpdaterArtifacts` unset. A signed pre-check would have
  failed on them, so those probes are gone. The macOS `.app.tar.gz` probe
  stays, because `release.yml` signs that file.
- **#5690:** session log 2290 said two bugs were filed without numbers. They
  are #5692 (Mermaid too large under reduced motion) and #5693 (wide math
  clipped while editing on a phone), both fixed in #5704.

Dropped, with reasons:
- #5664's possibly stale announcer timer: no failing test.
- #5666's narration paragraph: merged logs are immutable.
- #5688's no-op icon class on a non-`icon-xs` button: harmless.

**Pitfalls added** to the batch skill:
- **Two green PRs can break main together.** #5696 renamed Save while
  #5697's tests looked it up by the old name; #5705 fixed it.
- **The incremental-compilation crash** in `rustc`, hit twice tonight, is
  cured by deleting that crate's incremental directory.
- **gitleaks flags random-looking fixture tokens.** Build fixtures from a
  repeated character instead.

Gates: vitest (13 files, 480), `npm run typecheck`, oxlint, oxfmt, knip, the
callout, page-source and ULID Playwright specs (28), the reconciliation
nextest (35 + 9), clippy, `SQLX_OFFLINE=true cargo check`, fmt, and `bash -n`
plus shellcheck on the release script.
