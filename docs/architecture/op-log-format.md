# Op-Log Format & Hash Preimage

This is the format reference for the `op_log` table and the per-op
`blake3` hash: the per-device integrity format and the rules for locally
verifying a row's hash chain. It is precise enough that a non-Rust
implementation can recompute hashes byte-identically and verify a row it
holds.

**Scope note (#2473, #2481).** This document does **not** describe the
production *state* interchange — that is Loro CRDT bytes, specified in
[sync-protocol-spec.md](./sync-protocol-spec.md); implement *that* doc to
build an interoperable client, not this one. **State** flows only through
Loro: for state-rebuild purposes the `op_log` is device-local (a full-log
replay reconstructs only *locally-authored* content — #2504), and inbound
Loro sync lands remote state via CRDT import + SQL projection, never as
op_log rows.

Since **#2481 phase 1** the op_log is *not* strictly device-local, though:
the audit-only replication sub-flow (`SyncMessage::OpLogBatch`, streamed
after the `LoroSync` deltas) now inserts **foreign** devices' op records
here as append-only, hash-verified **audit metadata** — stored with
`is_replicated = 1` and **never applied to state** (the boot-replay walk,
materializer, and undo path all filter `is_replicated = 0`). This is the
production caller the ingest machinery below (`dag::insert_replicated_op`,
the **Audit** profile) was built for. So the op log is now
**globally-replicated for audit/History/attribution but device-local for
state**. The "Validity rules" section below describes that real path (the
`Strict` profile's `insert_remote_op` remains test-only).

For the higher-level narrative (what the op log *is*, the op-type catalog,
the materializer, drafts) see [data-and-events.md](./data-and-events.md#op-log).
This document is the low-level companion: it does not re-list the op types.

The canonical source is `src-tauri/agaric-core/src/hash.rs` (`compute_op_hash`,
`verify_op_record`, `verify_op_hash`), the append path in
`src-tauri/src/op_log/append.rs` (`append_local_op_in_tx`) and
`src-tauri/src/op_log/payload.rs` (`serialize_inner_payload`),
the remote-ingest / merge path in `src-tauri/src/dag.rs`
(`insert_remote_op`, `append_merge_op`), and the payload types in
`src-tauri/src/op.rs`. Where any detail here is ambiguous, those functions
are authoritative.

## `op_log` table schema

The current shape is defined by migration `0001_initial.sql` and rebuilt
(promoted to `STRICT`, `created_at` retyped to INTEGER) in
`0079_op_log_created_at_ms.sql`. Additive columns came from `0030`
(`block_id`), `0033` (`origin`), and `0064` (`attachment_id`).

| Column | Type | Hash? | Notes |
| --- | --- | --- | --- |
| `device_id` | `TEXT NOT NULL` | yes | Originating device UUID. Part of the PK and the preimage. |
| `seq` | `INTEGER NOT NULL` | yes | Per-device monotonic counter (`COALESCE(MAX(seq), 0) + 1 WHERE device_id = ?`). Part of the PK and the preimage. |
| `parent_seqs` | `TEXT` (nullable) | yes | JSON array of `[device_id, seq]` parent pointers, or `NULL` for the genesis op (`seq = 1`). |
| `hash` | `TEXT NOT NULL` | n/a | The 64-char lowercase-hex `blake3` digest of the preimage. Self-referential, so it is *not* itself an input. |
| `op_type` | `TEXT NOT NULL` | yes | snake_case op-type tag (e.g. `create_block`). |
| `payload` | `TEXT NOT NULL` | yes | Canonical JSON of the op-specific fields (the `op_type` tag is stored in its own column, **not** in this JSON). |
| `created_at` | `INTEGER NOT NULL CHECK (created_at >= 0)` | no | Epoch milliseconds (UTC), from `crate::db::now_ms()`. Used only for "find prior op" ordering. |
| `block_id` | `TEXT` (nullable) | no | Denormalized index column (`0030`). Derivable from `payload`; `NULL` for `delete_attachment`. |
| `origin` | `TEXT NOT NULL DEFAULT 'user'` | no | Local attribution: `user` or `agent:<name>`. Deliberately excluded from the preimage. |
| `attachment_id` | `TEXT` (nullable) | no | Denormalized index column (`0064`); set only for `add_attachment` / `delete_attachment`. |

Primary key: `(device_id, seq)`.

**Load-bearing for the hash** are exactly five fields, in this order:
`device_id`, `seq`, `parent_seqs`, `op_type`, `payload`. Everything else
(`hash` itself, `created_at`, `block_id`, `origin`, `attachment_id`) is
either the output or local-only / derivable metadata and **must not**
enter the preimage. In particular, `origin` is excluded so the same
logical op tagged `user` on one device and `agent:claude` on another still
hash-matches during sync.

### Append-only enforcement

`op_log` is strictly append-only. Migration `0036_op_log_immutability_triggers.sql`
installs `BEFORE UPDATE` / `BEFORE DELETE` triggers that `RAISE(ABORT)`
unless a sentinel row exists in `_op_log_mutation_allowed` (only the
compaction path inserts that sentinel, inside its own transaction). An
external client writing to a replica must respect the same invariant:
never mutate or delete a landed row.

## Preimage construction

The hash is computed by `compute_op_hash` over a single byte string built
by concatenating the five load-bearing fields with a single `0x00`
(null) byte between each. There is no length prefix, no trailing
delimiter, and no enclosing structure — just:

```text
device_id  0x00  seq  0x00  parent_seqs  0x00  op_type  0x00  payload
```

That byte string is fed to `blake3` (256-bit) and the digest is rendered
as **lowercase hex, exactly 64 characters**. That hex string is what goes
in the `hash` column.

### Field encoding

Each field is encoded to bytes as follows before concatenation:

- **`device_id`** — its UTF-8 bytes, verbatim. (Today a UUID, always ASCII.)
- **`seq`** — the signed decimal ASCII representation of the `i64`
  (e.g. `42`, `-1`), no padding, no thousands separators. This is the
  plain base-10 rendering of the integer.
- **`parent_seqs`** — the raw JSON string exactly as stored in the column
  (see below for its canonical form). For the genesis op the column is
  `NULL`; in that case the **empty string** (zero bytes) is used in the
  preimage. Note this means a genesis op (`NULL`) and an op with an empty
  array (`"[]"`) produce *different* hashes — `NULL` is not `[]`.
- **`op_type`** — the snake_case tag bytes (UTF-8 / ASCII), e.g.
  `edit_block`.
- **`payload`** — the canonical JSON string bytes (see "Payload
  canonicalization").

**Null-byte invariant.** Because `0x00` is the field separator, no field
may itself contain a raw `0x00` byte. `compute_op_hash` checks this with a
`debug_assert!` (dev-time only) for all four non-payload positions and for
the payload; in **release** builds those assertions are compiled out, so the
function never panics on a raw NUL — it simply hashes the (ambiguous) bytes
it was given. The graceful runtime rejection lives at the ingest gate: the
`\0`-rejection check at the top of `dag::insert_remote_op` returns
`AppError::InvalidOperation` *before* the bytes reach `compute_op_hash`, so
untrusted/remote ops carrying a raw NUL are refused gracefully rather than
panicking.
`serde_json` escapes an in-string NUL as `\u0000`, so a well-formed
payload never carries a raw NUL. A cross-platform client must likewise
escape NUL in JSON and reject any field containing a raw NUL.

### Payload canonicalization

The `payload` column stores **only the op-specific fields** — the
`op_type` discriminant lives in its own column and is *not* present in
the payload JSON. The Rust writer (`serialize_inner_payload`) round-trips
each payload struct through `serde_json::Value` (a `BTreeMap`) so that
**object keys are emitted in ascending lexicographic (byte) order**. A
client must produce the identical canonical form:

- Object keys sorted ascending; no insignificant whitespace
  (`serde_json` compact form — no spaces after `:` or `,`).
- Optional fields that are present serialize as JSON `null` *unless* the
  field is declared omit-when-absent. Two such cases exist in `op.rs`
  (see the `skip_serializing_if = "Option::is_none"` attributes):
  `create_block.position` / `create_block.index` and `move_block.new_index`
  are **omitted entirely** when `None` (the post-#400 sibling-slot
  fields), whereas e.g. `set_property.value_*` fields serialize as
  explicit `null`. Backwards-compat: a missing `value_bool`
  (`set_property`) or missing `fs_path` (`delete_attachment`) deserializes
  to `None` / `""` respectively.
- **All ULID fields must be uppercase Crockford Base32** before
  serialization. The local writer calls `OpPayload::normalize_block_ids()`
  (a no-op marker today, because `BlockId` auto-uppercases on construction
  and deserialization). The hash is byte-stable only if every `block_id`,
  `parent_id`, `tag_id`, `attachment_id`, and `value_ref` is uppercase.
- Numbers follow `serde_json`'s default rendering (e.g. integers without a
  decimal point; `f64` such as `42.5` rendered as-is). `set_property`
  rejects non-finite `value_num` (`NaN`/`Inf`) at the command layer, so
  those never reach the payload.
- `edit_block.prev_edit` serializes as a two-element JSON array
  `[device_id, seq]`, or `null` when absent.

Because the exact field set per op type matters for the bytes, the
authoritative field list is the payload structs in `src-tauri/src/op.rs`
(`CreateBlockPayload`, `EditBlockPayload`, …). Snapshot tests in that file
(`snapshot_all_payload_json_serialization`) pin the exact JSON shape of
every variant.

### Golden vector

`hash.rs` pins a known-answer test that an external implementation can use
to validate its preimage construction end to end:

```text
device_id   = "device-123"
seq         = 42
parent_seqs = [["dev-1",41]]          (raw JSON string: [["dev-1",41]])
op_type     = "edit_block"
payload     = {"block_id":"AB","to_text":"hello"}

blake3 hex  = 4ba8948410b19f80a9fd01a3d8820965f72bcef7ceadb798360206e9ec015d3c
```

The preimage bytes are
`device-123\0` + `42\0` + `[["dev-1",41]]\0` + `edit_block\0` +
`{"block_id":"AB","to_text":"hello"}`.

## Chain linking

`parent_seqs` is the ordering / lineage link, expressed as **positions,
not hashes**:

- **Genesis op** (`seq = 1` on a device): `parent_seqs` is `NULL`
  (encoded as the empty string in the preimage).
- **Linear local op** (current single-device implementation,
  `append_local_op_in_tx`): `parent_seqs` is a single-element array
  pointing at the immediately preceding op from the *same* device:
  `[[device_id, seq - 1]]`. It is produced via `serde_json::to_string`,
  giving compact JSON like `[["<device>",4]]`.
- **Merge op** (multi-parent, `append_merge_op` in `dag.rs`):
  `parent_seqs` lists one `[device_id, seq]` entry per merged branch
  (at least two distinct entries). The writer **sorts the entries
  lexicographically by `(device_id, seq)` and dedups** before serializing,
  so the JSON byte string — and therefore the hash — is deterministic
  regardless of input order.

The link is **positional, not Merkle**: `parent_seqs` carries parent
*positions*, not parent *hashes*, so a child's hash does not transitively
depend on ancestor content. The chain is a deterministic per-op
fingerprint protecting ordering and payload integrity; it is not a
cryptographic commitment over history. This is intentional under the
single-user threat model (see [threat-model.md](./threat-model.md));
tamper-resistance comes from the per-row hash check plus the immutability
triggers and the `(device_id, seq)` primary key, not from re-deriving a
chain root. See `hash.rs` (the "Positional, not Merkle" doc comment) for
the rationale.

## Validity rules

These are the checks the remote-op ingest core (`dag::insert_remote_op`)
runs on an op record before landing it (mirrored by `verify_op_record`
for the hash-only check). There are **two ingest profiles** sharing this
verification recipe (#2481 phase 1):

- **Strict** (`dag::insert_remote_op`) — the dormant Wave 1B remote-merge
  path; unresolved parents are a hard error. No production caller today;
  exercised only by tests (`dag/tests.rs`, `op_log/tests/origin.rs`).
- **Audit** (`dag::insert_replicated_op`) — the #2481 audit-only
  replication ingest; identical hash / NUL / payload / idempotency checks,
  but the parent-gap relaxation in rule 2 below applies, the row is stamped
  `is_replicated = 1`, and the transfer-carried `origin` attribution is
  preserved. Audit rows are **never applied to state** and are kept out of
  boot replay / the materializer by the `is_replicated = 0` filter
  (migration 0099).

The rules:

1. **Hash matches.** Recompute the preimage from
   `(device_id, seq, parent_seqs, op_type, payload)` exactly as above and
   confirm `blake3` hex equals the stored `hash`. The Rust side compares
   in constant time (`constant_time_eq`); equality of the 64-char hex
   strings is what matters. A mismatch means corruption or tampering and
   the op is rejected (`"hash mismatch on remote op"`). Because
   `parent_seqs` is hashed verbatim, any reordering or edit of that JSON
   breaks the hash — readers do **not** separately re-validate that
   `parent_seqs` is in canonical sorted order.

2. **Parents resolve — profile-dependent (audit-mode relaxation, #2481).**
   Every `[device_id, seq]` entry in `parent_seqs` must already exist as a
   row in `op_log` before this row is landed. The genesis op has no
   parents.
   - Under the **Strict** profile (`insert_remote_op`) a dangling pointer
     is rejected with `"dag.parent_seqs.unresolved"`.
   - Under the **Audit** profile (`insert_replicated_op`) an unresolved
     parent caused by the *peer's own* compaction of its early history
     **lands with a `warn!` breadcrumb instead of being rejected**, since
     the replicated log is audit-only and never load-bearing for state, and
     per-device ordered delivery (records are shipped and ingested in `seq`
     order) makes such a gap attributable to compaction only. This is the
     implemented audit-mode validity profile as of #2481 phase 1.

3. **Idempotent insert.** Insertion is keyed on the `(device_id, seq)`
   primary key with `INSERT OR IGNORE`, so duplicate delivery of the same
   op is a no-op rather than an error.

4. **Payload is structurally valid.** The `payload` JSON must deserialize
   into the `OpPayload` variant named by `op_type` (unknown `op_type`
   tags and missing required fields are rejected by serde). The
   `op_type`-vs-payload tagging means the column and the payload's variant
   must agree.

5. **Domain invariants are the writer's job.** Structural deserialization
   does not enforce domain rules (e.g. `set_property` must have exactly
   one non-null value field — `validate_set_property`). Those are enforced
   at the command layer before append, not re-checked on the read side.

Note that `created_at`, `origin`, `block_id`, and `attachment_id` are
**not** part of validity in the hash sense: two replicas may legitimately
hold different `origin` values (or repopulate the denormalized
`block_id` / `attachment_id` index columns locally) for the same op, and
the op still verifies.
