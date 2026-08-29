# Session 1423 — three parsers, and one that was not worth fuzzing

#4497 named four untrusted-input parsers with no fuzz target. Three of them are here.
The fourth was dropped after reading its body, which is the more useful half of this log.

## The one that was dropped

`sync_protocol::types::decode_persisted_loro_vvs` was the most attractive of the four on
paper: the only `&[u8]` entry point in the batch, fed by persisted sync state and by peers,
and returning `Vec<SpaceVersionVector>` rather than a `Result` — so "what does it do with
garbage" is a question its signature does not answer.

Its body answers it:

```rust
pub fn decode_persisted_loro_vvs(bytes: &[u8]) -> Vec<SpaceVersionVector> {
    serde_json::from_slice(bytes).unwrap_or_default()
}
```

There is no logic to explore. A target here would spend 120 seconds every week fuzzing
`serde_json`, which has its own continuous fuzzing upstream, and would report the empty
vector for everything it found. The issue was written from the signature and the call site;
the signature is exactly what made it look worth doing.

The lane's budget is fixed wall-clock, so a target that cannot find anything is not free —
it is 1/8th of the weekly search taken from the seven that can. Filing the reason rather
than silently shipping four targets, because "the issue said four" is otherwise how a
useless target acquires tenure.

One thing did fall out of reading it: `unwrap_or_default()` turns a corrupt persisted VV
into an empty one, and `src-tauri/agaric-sync/src/sync_protocol/session_state_machine.rs:1507` uses the result
as a sync `floor`.
That is a behaviour question, not a fuzzing one, and it is not this change's to answer.

## The three that landed

| Target | Drives | Why |
|---|---|---|
| `bibliography_parse` | `detect_bibliography_format`, `parse_bibtex`, `parse_csl_json` | a `.bib` or CSL-JSON file the user picked |
| `attachment_path_parse` | `AttachmentFsPath::parse` | the validation boundary #2989 landed on |
| `pagination_cursor_decode` | `Cursor::decode` | a cursor round-tripped through the client |

`bibliography_parse` runs **both** parsers on every input rather than only the one the
sniffer selects. Dispatching on adversarial content is part of the surface: a file that
sniffs as BibTeX and then is not one is a reachable state whenever detection is wrong, and
it is the state least likely to be covered by the example tests.

`attachment_path_parse` is the one with a security argument rather than a robustness one.
#2989 was a path-traversal filename reaching `rename_attachment` because validation did not
reject it. The target asserts only the no-panic contract — *which* inputs get rejected
belongs in the unit tests, where the expected answer is known.

## The duplication the issue asked to guard, removed instead

The target list lived in two places: the `[[bin]]` entries in `src-tauri/fuzz/Cargo.toml`
and a hand-maintained `targets=(...)` array in the workflow. #2945 is what that cost when it
went stale — `fts_strip` and `html_parse` were added to the manifest and not to the
workflow, so for three months they were built and never fuzzed while the lane reported
success.

The issue asked for either "both, or a guard". The array is now derived:

```bash
mapfile -t targets < <(
  cargo metadata --format-version 1 --no-deps \
    | jq -r '.packages[] | select(.name == "agaric-fuzz")
             | .targets[] | select(.kind | index("bin")) | .name' \
    | sort
)
```

`--no-deps` reads the manifest only — no dependency resolution, no network, no build.
Adding a `[[bin]]` is now the entire act of enrolling a target in the weekly lane, and the
cmin step downstream already consumed `targets.txt` rather than a third copy (#4496), so
there is one source for all three consumers.

The derivation carries its own guard, and the reason is specific rather than defensive
habit: `mapfile` reading from a **process substitution** cannot see that producer's exit
status — not under `set -e`, not under `pipefail`. A jq filter that stops matching leaves
the loop with nothing to iterate and the step exiting 0: a green fuzz lane that fuzzed
nothing. An empty derivation is therefore an explicit `::error::` and a non-zero exit.

## Seeds, and the newline that would have wasted half of them

Thirty-seven seeds across the three targets, and for two of them the *absence* of a
trailing newline is load-bearing:

- `AttachmentFsPath::parse` rejects control characters **before anything else**, so a
  trailing `\n` collapses every path seed onto that one branch;
- `Cursor::decode` base64-decodes the whole string, so a trailing `\n` fails every cursor
  seed at the first step.

Sixteen of the seeds would have been testing the same rejection. This is the same damage
`end-of-file-fixer` had already done to `snapshot_decode/zstd-magic.seed` before #4496
excluded the corpus directory from that hook — a file whose entire content was meant to be
four magic bytes had five. The exclusion is why these survive; without it the fix would
have been undone by the commit that added them.

## The seeds were checked, not assumed

The claim "these land on distinct branches" is the sort that reads as obviously true and
is routinely false, so it was run. A throwaway probe under `src-tauri/agaric-engine/tests/` — which
reaches all three crates — ran every committed seed through the parser its target drives
and printed the outcome. It was deleted before the commit; the results are here because
the results are the point.

The sixteen `attachment_path_parse` seeds produce all seven rejection messages the parser
can emit — empty, control character, escapes-app-data-dir, drive-or-stream separator,
MS-DOS device, wrong root, no file below the root — plus five accepts that exercise the
canonicalising paths: `attachments\...` folding to `/`, a `./` segment dropped, and
`attachments/photo.png. ` folding its trailing dot and space away. Four seeds share the
escapes-app-data-dir message and reach it by four different routes (`..`, a POSIX root, a
Windows root, and the `.. .` fold-revival), which is the point of having four.

The thirteen `pagination_cursor_decode` seeds cover every arm of the version ladder
(absent → treated as 1, wrong type, not-a-u8, valid-but-unsupported) and each stage of the
decode (bad alphabet, bad final symbol, valid base64 that is not UTF-8, valid UTF-8 that is
not JSON, valid JSON missing `id`), plus three accepts.

The probe corrected one seed. `truncated-json.seed` was base64 truncated by four
characters, which fails at the **base64** step (`Invalid last symbol`) and never reaches
the JSON parser at all — the name described a branch it did not reach. It was renamed
`base64-invalid-last-symbol.seed` (a distinct branch worth keeping) and a real
truncated-JSON seed added: valid base64 whose *payload* is cut short.

## A finding the probe produced

`parse_bibtex` returns `Ok(0 entries, 0 warnings)` for CSL-JSON, for RIS, and for empty
input — a successful, empty parse, with nothing in the parser distinguishing "a `.bib` with
no entries" from "not a `.bib` at all".

`parse_bibliography` guards `content.trim().is_empty()` before dispatching, so the empty
case is unreachable through it. The other two are reachable, and through a `pub` Tauri
command rather than only in theory: `import_bibliography_inner`
(`src-tauri/src/commands/pages/bibliography.rs:269`) sniffs the format only when its `format`
argument is `None`, so `Some("bibtex")` with CSL-JSON content skips detection entirely. The
argument is a raw `Option<String>` fed by MCP tools and scripted imports, per that
function's own comment.

**And here this log was wrong, in the direction that inflates a finding.** Its first
revision said that path "returns a successful import of nothing — no error, no warning".
It does not. The review on #4506 checked the caller, which this session had not: the
empty-entries path at `src-tauri/src/commands/pages/bibliography.rs:293` pushes
`"no importable bibliography entries found"` onto `warnings` and returns it. The import
reports something; what it does not report is that the *format argument* was the mistake,
since that same message is what a legitimately-empty `.bib` produces.

So the parser-level measurement held and the extension to the command layer did not. The
measurement was made — I ran every seed through `parse_bibtex` and read the counts — while
the sentence about what the user sees was inferred from the parser's return value without
opening the caller. Measured at one layer, asserted at the next: the seam is exactly where
the error entered, and it is worth naming because the fix (read the caller too) is cheap and
the failure looked like evidence.

#4505 has been corrected and re-scoped from a silent-failure issue to a
diagnostic-quality one.

## What is verified, and what cannot be

Verified locally: all eight targets compile (`cargo check --bins` in `src-tauri/fuzz`, with
`SQLX_OFFLINE=true` — `DATABASE_URL` is set in this environment and points somewhere the
fuzz workspace cannot open it, which manifests as 151 sqlx macro errors that look nothing
like a database problem); `cargo metadata --no-deps` derives exactly the eight `[[bin]]`
names; `src-tauri/fuzz/Cargo.lock` regenerates to a **one-line** diff adding `agaric-core`
to the `agaric-fuzz` dependency list, with no version churn; every seed's branch, above.

Not verifiable here: the lane needs nightly plus an ASan build, so `cargo +nightly fuzz
build` and a crash-free smoke run are the scheduled lane's to demonstrate, not this
session's.

Two budgets were raised with the target count rather than after a timeout proved them
short: cmin from 20 to 30 minutes (the merge re-executes every corpus input of every
target, so it scales with the count) and the job from 90 to 110. A cmin timeout is a loud
step failure; a *job* timeout is a cancellation, which correctly skips the save and would
therefore surface as a corpus that silently stopped accumulating — the exact failure #4496
exists to remove, reintroduced by growing the lane it protects.

Review then pointed out what that trade actually costs, and it is worth recording as the
shape of the change rather than as a note on it: removing the second target list means
enrolling a target no longer opens this workflow at all, so the reminder to re-check those
budgets now lives in a file the person adding a target never reads. List drift was traded
for budget drift, and budget drift is the quieter of the two. The derivation step now
carries a `BUDGETED_TARGETS` count and warns when the derived list outgrows it — two lines
beside the empty-derivation guard that was already there, in the one place that always runs.

A second review catch in the same area: `cargo metadata` was invoked bare, and rustup
searches upward for a toolchain file. It would have found the repo root's
`rust-toolchain.toml`, which pins 1.95.0 and mandates clippy and rustfmt — a toolchain this
job never installs, since it installs only nightly. A manifest read would have pulled a
full toolchain plus components over the network, inside the step the fuzz budget is measured
against. `cargo +nightly metadata` reuses what the job already has.
