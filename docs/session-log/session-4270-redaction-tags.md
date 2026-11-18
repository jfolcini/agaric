# Session 4270 — a redacted value in a bug report carries a tag

Follow-up to #6764 and #6880. The issue body showed `"peer_id":"[REDACTED]"` on twenty warnings, so nobody could tell one peer from several. The reporter's own AI-made redaction used `<IPV4_LAN_1>` / `<IPV4_LAN_2>` and kept the one fact that mattered: two different addresses. Our redactor erased it.

A value the deny-list hides now becomes `[REDACTED:<8 hex>]`, the first 8 hex digits of a blake3 keyed hash of the value. Equal values share a tag and different ones do not. The key is 32 random bytes drawn once per process. Per process, because the issue body and the ZIP are two IPC calls and must agree. Keyed, because a plain hash of a first name would let anyone confirm a guess from a public issue. The depth-capped subtree keeps the plain marker, since it replaces a whole subtree, not one value. The needle markers (`[REDACTED_DEVICE_ID]`, `[REDACTED:PEER_DEVICE_ID]`, `[EMAIL]`) are unchanged.

## Trades, not defects

- A tag only links hidden values. Where a value already leaks in clear text (a legacy text line, the OTel skeleton allowance), a reader who matches that occurrence to its tag learns where else it is hidden. That needs the earlier leak.
- Two reports filed from one app session share tags, so they can be linked. Both come from the same user.
- No test pins that the key is random: a constant key passes every test. Only an unkeyed hash is caught.
- `&hash.to_hex()[..8]` would save an allocation but trips the crate's denied `clippy::string_slice`, so the tag takes `chars().take(8)`.

## What ran

- Red first: the four new tests failed before the change, each on its "a tag is present" assertion.
- `cargo nextest run -p agaric --lib -E 'test(/bug_report/)'`: 111 passed. That is 106 existing bug_report tests, the 4 new ones, and the log-dir contract test.
- Builder and reviewer, separately, falsified a constant tag, an unkeyed hash, a key drawn per call, and each OTel marker site reverted to the plain marker. Each reddened the test written for it.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check`: clean.
- Seventeen existing assertions on the literal `[REDACTED]` now match the tagged shape. The three negative ones check `!contains("[REDACTED")`, which also catches a tag or a needle marker.
