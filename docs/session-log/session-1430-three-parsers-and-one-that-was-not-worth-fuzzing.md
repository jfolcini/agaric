# Session 1430 — three parsers, and one that was not worth fuzzing

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
That is a behaviour question, not a fuzzing one, and it is not this change's to answer —
filed as #4512, and narrowed twice since. First when a review suggested the empty floor
could cause a missed delta: it cannot, an absent floor ships MORE data, never less, and
the call site says so deliberately. Then when another pointed out the function's own
docblock already states the fallback is intentional. What survives is only that the decode
error is discarded without a log, so a corrupt row is indistinguishable at runtime from a
peer that has never synced.

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
reject it. The target says nothing about *which* inputs get rejected — that belongs in the
unit tests, where the expected answer is known — but it does assert a property of the ones
accepted: parsing is a **fixed point**, so re-parsing an accepted path yields the same
value. `for_storage_id` gates minting on exactly that identity, so a path accepted but not
a fixed point would silently take the digest fallback instead of the readable name.

(An earlier revision of this paragraph said the target "asserts only the no-panic contract".
That was true of the first version, which read the value back through `Display`/`AsRef` and
asserted nothing at all — both hand back the inner `String`, so no input could make them
fail. Review replaced it with the fixed-point property; this sentence did not follow until a
later review caught it, which is the second copy of one fact going stale in a change whose
subject is second copies going stale.)

## The duplication the issue asked to guard, removed instead

The target list lived in two places: the `[[bin]]` entries in `src-tauri/fuzz/Cargo.toml`
and a hand-maintained `targets=(...)` array in the workflow. #2945 is what that cost when it
went stale — `fts_strip` and `html_parse` were added to the manifest and not to the
workflow, so for three months they were built and never fuzzed while the lane reported
success.

The issue asked for either "both, or a guard". The array is now derived:

```bash
derived_targets="$(mktemp)"
if ! cargo +nightly metadata --format-version 1 --no-deps \
  | jq -r '.packages[] | select(.name == "agaric-fuzz")
           | .targets[] | select(.kind | index("bin")) | .name' \
  | sort > "$derived_targets"; then
  rm -f "$derived_targets"
  echo "::error::… TOOLING failure …"; exit 1
fi
mapfile -t targets < "$derived_targets"
rm -f "$derived_targets"
if [ "${#targets[@]}" -eq 0 ]; then
  echo "::error::… the manifest declares no [[bin]] entries …"; exit 1
fi
```

`--no-deps` reads the manifest only — no dependency resolution, no network, no build.
Adding a `[[bin]]` is now the entire act of enrolling a target in the weekly lane, and the
cmin step downstream already consumed `targets.txt` rather than a third copy (#4496), so
there is one source for all three consumers.

**The file is load-bearing, and the first version of this section did not have it.** It
shipped `mapfile -t targets < <(…)` and argued that shape "fails loud on an empty result".
It does — but a process substitution cannot report the producer's exit status either, not
under `set -e` and not under `pipefail`, so *every* failure arrived at one annotation
blaming a `Cargo.toml` that was fine. Redirecting to a file puts the pipeline back under
`pipefail` and separates the two. See "Two guards that could only say one thing" below for
the three-branch verification.

That correction reached the workflow and the PR description before it reached this
paragraph, which sat here for two more review rounds describing the shape the code had
abandoned — in a log whose subject is second copies going stale.

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
target, so it scales with the count) and the job from 90 to 110 — then to 130, once
review showed the build term had been scaled by assumption rather than arithmetic
(five builds at 15-25 min do not become eight at 20-35; linear gives 24-40, putting
the cold-cache worst case at ~98 of 110). A cmin timeout is a loud
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

## Two guards that could only say one thing

The approving review found the same defect twice, in the two guards this change added. Both
were built to detect an absence, and neither could distinguish the absence it was looking
for from its own inability to look.

**The empty-derivation guard blamed the manifest for every failure.** `mapfile` reading a
process substitution cannot see the producer's exit status, which is the reason the guard
exists — but it also meant that a missing nightly toolchain, an absent `jq`, or a path
dependency with an unparseable manifest all arrived at the same place as a genuinely
target-less `Cargo.toml`, and got the same annotation: `no fuzz targets derived from
src-tauri/fuzz/Cargo.toml`, naming a file that was fine. The real cause sat in unannotated
stderr above it.

Redirecting the pipeline to a file instead puts it back under `pipefail`, so the two cases
separate. Confirmed by running all three:

```
--- case A: producer fails (simulating missing nightly)
TOOLING-ERROR branch
--- case B: producer succeeds, manifest declares no bins
EMPTY-MANIFEST branch
--- case C: the real manifest
OK branch: 8 targets: attachment_path_parse bibliography_parse deeplink_parse fts_strip
           html_parse import_parse pagination_cursor_decode snapshot_decode
```

**The seedless guard inverted rather than went quiet.** It reads an empty `git ls-files
"corpus/$target"` as "this target has no committed seeds" — and a `git ls-files` that
*fails* is also empty. A `safe.directory` ownership mismatch after a runner or
checkout-action change is the realistic route, and it would have turned one broken
precondition into eight confident false reports about the seeding of eight targets, on a
green run, written to the step summary where they read as findings.

That is the worse failure of the two, because the guard exists precisely to be believed on
a green run. It now asks git once whether it can answer at all, and on failure says exactly
that — one warning naming the skipped check — instead of eight answers it is not entitled
to. Falsified by running the loop outside a git repository: before, two false "no committed
seeds"; after, one "SKIP: git cannot answer — no seeding conclusion drawn".

The rule the pair suggests is worth stating once: **a guard is allowed to say nothing; it
is not allowed to invert.** An absence-detector has to treat "I could not look" as a third
outcome, not fold it into "I looked and found nothing" — otherwise its signal is strongest
exactly where it is least trustworthy.

## The property that would have red-lit the lane

A second review round proposed giving `pagination_cursor_decode` a real
invariant, since it asserts only the no-panic contract while its sibling got a
load-bearing one. The suggestion was a re-encode fixed point:

```rust
if let Ok(e) = parsed.encode() {
    assert_eq!(Cursor::decode(&e).ok().as_ref(), Some(&parsed))
}
```

with the right caveat attached — validate it against generated inputs first,
because a false invariant reds the lane on its first scheduled run.

**It is false.** Probed against 300,000 generated cursor-shaped blobs, of which
24,882 decoded:

```
PROBE checked=300000 decoded_ok=24882 encode_failed=0 violations=1138
PROBE violation: {"id":"","rank":123456789.123456789}
  -> Cursor { rank: Some(123456789.12345679) }
  -> Ok(Cursor { rank: Some(123456789.1234568) })
```

4.6% of decodable cursors violate it, every one of them through `rank`.

## Whose fault, exactly

Not the cursor codec's. Narrowed to three lines:

```
PROBE text            = 123456789.12345679
PROBE std   parse bits = 419d6f34547e6b75
PROBE serde_json bits  = 419d6f34547e6b76
```

`serde_json` is not correctly rounded on parse. Rust's own `str::parse::<f64>`
returns the nearest representable double; `serde_json::from_str` returns its
neighbour, one ULP away. Serialization is fine — ryu emits the shortest form
that round-trips — so the loss is entirely on the way in, and it is a known and
documented trade: `serde_json`'s `float_roundtrip` feature exists precisely to
buy correct rounding back, at roughly 2x parse cost, and this repo does not
enable it.

So `encode` writes `123456789.12345679`, and `decode` reads it back as a
different double. The codec is a faithful messenger for a parser that is not.

## Does it matter, and the honest answer

At that magnitude the drift is **1.49e-8**, which is larger than the `1e-9`
epsilon the FTS keyset compares ranks with (`ABS(rank - cursor_rank) < 1e-9`) —
so a cursor at that scale would fail to match its own row and pagination would
skip or repeat.

It does not happen, for a reason that is luck rather than design: SQLite's bm25
returns ranks of order 1, where one ULP is `2.2e-16` — seven orders of magnitude
below the epsilon. The epsilon absorbs the parser's error only because the
values are small. Nothing in the cursor type says they must be, and nothing
would notice if a future rank-bearing query used a differently-scaled score.
Filed as #4519 rather than fixed here; this PR adds fuzz targets and is not
the place to change a workspace-wide serde feature.

The target keeps the no-panic contract it shipped with, and its header now says
why the obvious stronger assertion is not there — which is more useful than
either adding a false one or leaving the omission unexplained.

**The general point is the one the review made and I want to keep:** the
suggestion was good, the caveat attached to it was the load-bearing part, and
following the caveat is what turned a plausible invariant into a latent
precision bug. "Validate before asserting" caught something neither of us
expected to find.

## A header that described a contract instead of an assertion

Third review round. The most useful of its notes is about
`attachment_path_parse`'s module header, which said the contract worth stressing
was "never panics, and rejects anything it should not accept".

The first half is asserted. The second is not, and cannot be: a rejection is the
correct outcome for almost every arbitrary byte string, so there is nothing for a
fuzz target to check there — pinning the accept/reject split belongs in the unit
tests, where the expected answer is known. Meanwhile the assertion that *can*
redden the lane, idempotence, was not in the header at all. So the header named
one thing the target does, one thing it does not, and omitted the one most likely
to fail.

The body comment made it worse by ending "the header used to claim only the
first" — a back-reference to a revision that no longer existed, describing a
header that by then claimed something else. Two copies of one fact, drifting
apart, in a change whose whole subject is second copies drifting apart. That is
the third time in this PR.

The header now separates the **motivation** (this is the validation boundary,
#2989 was a traversal filename reaching `rename_attachment`, adversarial bytes
are what it must survive) from the **assertions**, which are enumerated as
exactly two and described as the whole of it. A reader deciding whether a red
lane is real needs the second list, not the first.

The remaining notes were mine and mechanical: the "git ls-files, NOT find"
rationale had ended up duplicated inside the same loop body, with the second copy
back-referencing a comment about a different concern; the `mktemp` leaked on the
producer-failure path; and the loop I guarded last round sat at the enclosing
indent, so its two stacked `fi`s did not pair by eye. All three were introduced
by my own previous round of review fixes, which is worth noticing on its own —
each fix was correct and each left the file slightly harder to read than it found
it.

## The list this PR forgot to stop enumerating

Fourth review round found the best find of the four: `AGENTS.md` still named the
fuzz workspace's path dependencies as "`agaric`, `agaric-store`, `agaric-sync`
and `agaric-engine`". This PR adds `agaric-core` as a fifth.

That sentence is a hand-maintained second copy of a manifest list — the exact
shape this change exists to remove. #4497 deleted one such copy from the
workflow and another from `src-tauri/fuzz/README.md`, wrote a paragraph in each
about why a fourth copy would undo the point, and then walked past a fifth in
the file that sets the repo's conventions. Adding `agaric-core` to it would have
been the wrong fix, and the reviewer said so: *update or reword to stop
enumerating*.

Reworded. The sentence's actual subject is that the fuzz lock resolves the
parent manifests' requirements, which is true whichever parents those are; the
names were never load-bearing. It now points at `src-tauri/fuzz/Cargo.toml` and
says why it declines to list them, citing the drift #2945 cost this lane.

**The thing worth keeping from this is not "check AGENTS.md too".** It is that a
change whose entire subject is second copies going stale produced, across four
review rounds: a stale target table in the README (found before review), two
stale copies of one budget number, a stale claim in a target header, a stale
PR-description snippet, and this. Every one of them was written *by the person
holding the argument for why they are dangerous*. Knowing the failure mode is
apparently no protection against it at all — the only thing that caught any of
them was someone else reading the diff.

## What the PR description said the code does

The same round found the description's derivation snippet still showing
`mapfile -t targets < <(...)`, with the surrounding text arguing that shape
"fails loud on an empty result". The shipped code uses a temp file plus an
explicit exit-status branch — precisely because process substitution is what
*cannot* report producer failure. The description was arguing for the shape the
code had already abandoned, in a section about why the new shape is better.

That is the third time in this session that a PR body has been left behind the
code it describes (twice on #4517, once here). The mechanism is always the same:
the code, the comments and the session log get updated because they are files in
the diff, and the description is treated as narration rather than as one more
copy of the same facts. It is a copy, and it drifts like every other copy.
