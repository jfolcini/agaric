# Session 1346 — the fixes that were wrong about themselves (2026-08-18)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-18 |
| **Subagents** | 6 build + 4 review |
| **Items closed** | `#3289` (partial — re-scoped), `#4056`, `#4057`, `#4115`, `#3974`, `#3961`, `#3282`, `#3975`, `#3246` |
| **Items filed** | `#4126` |
| **PRs** | #4122, #4123 (merged), #4124, #4125, + this one |

**Summary:** A light-gate batch, chosen so the maintainer could keep using the
machine. What it produced worth recording is not the issue count — it is that
four separate items turned out to be wrong *about themselves*, and each was
caught by something other than a passing test.

## An issue whose worked example could not fail

#4057 reported that `compareTagRows` sorts by UTF-16 code units where SQLite's
BINARY collation sorts by UTF-8 bytes, and offered `🎯x` vs `豆` as the pair that
diverges. It does not. 豆 is U+8C46; 🎯's leading surrogate is 0xD83C. In UTF-16
`35910 < 55356` puts 豆 first, and in UTF-8 its lead byte `0xE8 < 0xF0` puts 豆
first as well. A test built on the issue's own example would have gone green
against the unfixed comparator — the vacuous-assertion failure mode, arriving
pre-packaged in the bug report.

A real divergence needs a BMP character *above* the surrogate range but still
three bytes in UTF-8: `Ａ` (U+FF21) sorts after 🎯 by code unit (`0xD83C <
0xFF21`) and before it by byte (`0xEF < 0xF0`). Builder and reviewer derived that
independently before it was used.

## An issue that prescribed a deletion that would have broken the file

#3289 listed `UNTITLED_PLACEHOLDER` in `jex-import.ts` as dead alongside a
genuinely duplicated `sanitizeNoteTitleToFilename`. The function was dead; the
constant has a live caller in `parseJex`, for an unrelated empty-title fallback.
Following the issue literally would not have compiled.

The same issue's other two findings were only half-fixable within a hygiene PR —
the SafeLimit drift needs a specta change and a maintainer decision on the root
`AGENTS.md`, and the dispatch-reset trap needs a change to the registration
contract. So the PR says `Refs`, not `Closes`, and the issue carries a comment
naming exactly what is left. Two of four is not four.

## A correction that committed the error it was correcting

Three documents still claimed two-device pairing had never been observed on
hardware, which session 1345 disproved. The first draft of that correction
updated `sync-and-network.md:78` to say an Android phone had paired over QUIC —
and left `:159`, in the same file, asserting that "QUIC/UDP on Android and on
restrictive WiFi is unverified" and release-gating. One file, two contradictory
claims, in the PR whose entire purpose was retiring a stale claim.

It also asserted a date, 2026-08-17, that the repo's only record contradicts:
session 1345 is dated the 18th and places the pair inside itself. The fix was to
stop asserting a date at all and cite the session log, which is checkable.

The narrow framing survived review intact and is worth keeping: the run proves
pairing and the first inbound session. It does not prove a two-way sync — #4083's
initiator-side `parent_id` abort was fixed *after* it — and it does not prove
anything about a hostile network, since it needed a VPN and a host firewall
cleared before it worked at all.

## A fix whose mechanism was wrong in a way tests did not reach

#3282 asked for `resolve_url`'s hand-rolled body to be replaced with
`Url::parse(base).and_then(|b| b.join(href))`, plus `strip_userinfo` applied
uniformly so credential-stripping stops depending on which branch fired. The swap
was right. The strip was hand-rolled string surgery on the serialized URL, keyed
on `joined.find("://")` — which is not anchored to the scheme.

`Url::join` resolves a cannot-be-a-base href to itself, so for `data:` and
`mailto:` the first `://` sits inside the opaque payload and the authority-shaped
strip ran over path and query bytes:

    resolve_url("https://example.com/", "data:text/plain,http://u@h/x")
      -> "data:text/plain,http://h/x"

`<link rel="icon" href=…>` is attacker-controlled HTML and the result is
persisted to `link_metadata.favicon_url`, so it is reachable. The impact is a
corrupted cached string rather than a leak, but the mechanism is the same class
as the truncation-marker spoof #3975 exists downstream of: trusting the shape of
a string an attacker can partly write.

Replaced with `set_username("")` / `set_password(None)`, which address the
authority structurally and return `Err` — the no-op we want — for exactly those
schemes. The cases that motivated the review are now pinned: IPv6 literal with a
port, `@` in a path, `@` in a query, and the two cannot-be-a-base payloads.

## The eighth cache entry

Deleting the expired personal-to-work migration orphaned `.sqlx` entries across
the root, engine and sync caches. The builders removed seven. `prepare --check`
still exited 0 while warning about "potentially unused queries" — the shape of a
green check that has not checked the thing. Regenerating all four caches found an
eighth in the root cache, the last `query!` site inside a deleted test.

The standing trap is worth restating because it has now cost three attempts
across two sessions: the drift guard judges only what is **staged**, and the
workspace has four caches, not one.

## Also

`#3975`'s forgery was demonstrated before it was fixed, per its own acceptance
criterion: an unsanitized span attribute containing a newline produced three
record lines where one was due. The reviewer then broke each half separately —
name only, attributes only — and confirmed both redden, so the test is not a
half-covered pair.

`#3974` asked for the apt bound to be demonstrated rather than asserted. Static
checks cannot show that a nested `||`-chained retry survives Actions' default
`bash -eo pipefail`; running the exact shape with the apt call swapped for
`timeout 2 sleep 30` shows it bounding at 4s rather than 30, `set -e` not firing
before the retry, and the flaky path still reaching the install line. What it does
not show is a real runner against a real hung mirror, and the PR says so.

`#4126` was filed for the reason the dead `block_ops.rs` citation survived every
commit since the #882 crate split: the doc-citation guard is markdown-only, so a
stale code path inside a `.ts` or `.rs` comment is structurally invisible to it —
which is precisely where cross-language citations concentrate.
