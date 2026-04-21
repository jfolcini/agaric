//! Activity ring buffer + Tauri event emitter for the MCP read-only server.
//!
//! FEAT-4d ships the in-memory rolling log of the last 100 tool calls plus
//! the `mcp:activity` Tauri event surface. The frontend (FEAT-4e) subscribes
//! to the event stream and maintains its own 100-entry render buffer — the
//! ring lives here only so late subscribers / diagnostics can inspect the
//! recent history without a pull-query surface.
//!
//! Design notes:
//!
//! - **No persistence.** The ring is pure in-memory state. FEAT-4 explicitly
//!   rejected a new table + retention policy.
//! - **Privacy.** `summary` strings are built by each tool handler (FEAT-4c)
//!   and must never include block content, page titles, or property values.
//!   `agent_name` is serialized into Tauri events but redacted in `Debug`
//!   output so it cannot leak into tracing spans.
//! - **Decoupled emitter.** `ActivityEmitter` is a trait object so the
//!   server module stays free of any direct Tauri runtime generics.
//!   Production wraps [`tauri::AppHandle`] in [`TauriRuntimeEmitter`]; tests
//!   use [`RecordingEmitter`] (or [`NoopEmitter`] when they only care about
//!   the ring).
//! - **Thread safety.** The ring is always accessed through
//!   `Arc<Mutex<ActivityRing>>`. Lock poisoning is tolerated
//!   (`unwrap_or_else(std::sync::PoisonError::into_inner)`) — a panic in
//!   one tool call must not take down every subsequent activity push.

use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::Serialize;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Hard cap for the activity ring — FEAT-4 agreed on a rolling 100-entry log.
pub const ACTIVITY_RING_CAPACITY: usize = 100;

/// Tauri event name emitted for each completed tool call. The frontend
/// activity feed listens on this channel.
pub const MCP_ACTIVITY_EVENT: &str = "mcp:activity";

// ---------------------------------------------------------------------------
// Entry types
// ---------------------------------------------------------------------------

/// Discriminates the caller kind on an activity entry without carrying any
/// identifying name in Debug output. Agent identifiers (when present) live
/// on [`ActivityEntry::agent_name`] and are redacted from the `Debug` impl.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActorKind {
    /// Tool call originated from a user action in the UI (today this never
    /// happens for the RO server; reserved for FEAT-4h's RW tools).
    User,
    /// Tool call originated from an external agent connected via the MCP
    /// socket.
    Agent,
}

/// Outcome of a tool call. `Err` carries a short, user-friendly message —
/// never the full `AppError` chain — because the summary is rendered in the
/// Settings activity feed.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "snake_case")]
pub enum ActivityResult {
    /// The tool call completed successfully.
    Ok,
    /// The tool call failed. `String` is a short error description (e.g.
    /// `"block not found"`), not a serialized `AppError`.
    Err(String),
}

// Manual Debug — keeps the discriminant readable but avoids `{self:?}`
// leaking over-long error chains into spans.
impl fmt::Debug for ActivityResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ActivityResult::Ok => f.write_str("Ok"),
            ActivityResult::Err(msg) => f.debug_tuple("Err").field(msg).finish(),
        }
    }
}

/// A single entry in the activity ring. One entry is appended per
/// `tools/call` completion (success or failure) and emitted on the
/// `mcp:activity` Tauri event bus.
///
/// Serialization uses `camelCase` to match the rest of the app's event
/// payloads. `agent_name` is skipped when `None` so the wire payload
/// stays compact for user-initiated entries.
///
/// The `Debug` impl is handwritten to redact `agent_name` — never rely on
/// `{entry:?}` producing the agent identifier in tracing spans. If an
/// auditor needs the real name, read it via `entry.agent_name` explicitly.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// MCP tool name (e.g. `"search"`, `"get_block"`).
    pub tool_name: String,
    /// Tool-specific short summary built by the handler (e.g.
    /// `"searched for '...' (12 results)"`). Must never include block
    /// content / page titles / property values — see module docs.
    pub summary: String,
    /// UTC timestamp of the completion.
    pub timestamp: DateTime<Utc>,
    /// Discriminant of the calling actor.
    pub actor_kind: ActorKind,
    /// Agent identifier, present iff `actor_kind == Agent`. Serialized
    /// into the `mcp:activity` event; **redacted** in `Debug` output.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// Success / failure outcome of the tool invocation.
    pub result: ActivityResult,
}

impl fmt::Debug for ActivityEntry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Redact `agent_name` so a stray `tracing::debug!(?entry, ...)` in
        // downstream code cannot leak the agent identifier. We still show
        // whether a name was present so the shape of the entry is debuggable.
        let redacted: &dyn fmt::Debug = match self.agent_name {
            Some(_) => &"<REDACTED>",
            None => &Option::<&str>::None,
        };
        f.debug_struct("ActivityEntry")
            .field("tool_name", &self.tool_name)
            .field("summary", &self.summary)
            .field("timestamp", &self.timestamp)
            .field("actor_kind", &self.actor_kind)
            .field("agent_name", redacted)
            .field("result", &self.result)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// Ring buffer
// ---------------------------------------------------------------------------

/// In-memory rolling buffer of the last `cap` activity entries. Oldest
/// entries are evicted on overflow. Designed to be held inside
/// `Arc<Mutex<ActivityRing>>` so it can be shared across connection-handler
/// tasks.
#[derive(Debug)]
pub struct ActivityRing {
    entries: VecDeque<ActivityEntry>,
    cap: usize,
}

impl ActivityRing {
    /// Build a ring with the default [`ACTIVITY_RING_CAPACITY`].
    pub fn new() -> Self {
        Self::with_capacity(ACTIVITY_RING_CAPACITY)
    }

    /// Build a ring with a custom capacity. Primarily for tests that want
    /// to exercise overflow without allocating 100 synthetic entries.
    pub fn with_capacity(cap: usize) -> Self {
        debug_assert!(cap > 0, "ActivityRing capacity must be > 0");
        Self {
            entries: VecDeque::with_capacity(cap),
            cap,
        }
    }

    /// Append `entry`, evicting the oldest entry if the ring is full.
    pub fn push(&mut self, entry: ActivityEntry) {
        if self.entries.len() == self.cap {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    /// Read-only view of the stored entries, oldest first.
    pub fn entries(&self) -> &VecDeque<ActivityEntry> {
        &self.entries
    }

    /// Number of stored entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// `true` iff no entries have been pushed yet.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Configured capacity (fixed at construction time).
    pub fn capacity(&self) -> usize {
        self.cap
    }
}

impl Default for ActivityRing {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Emitter abstraction
// ---------------------------------------------------------------------------

/// Trait-object seam between the MCP server module and the Tauri event bus.
/// Production wiring uses [`TauriRuntimeEmitter`]; tests use
/// [`RecordingEmitter`] or [`NoopEmitter`].
///
/// Implementations MUST be infallible from the caller's perspective —
/// transient bus failures (no listener, shutting down, etc.) are logged via
/// `tracing::warn!` but never propagated, so a missing frontend does not
/// block tool dispatch.
pub trait ActivityEmitter: Send + Sync {
    fn emit(&self, entry: &ActivityEntry);
}

/// Blanket impl so `Arc<dyn ActivityEmitter>` and `Arc<T>` both satisfy the
/// trait — keeps call sites ergonomic when threading an emitter through the
/// handler pipeline.
impl<T: ActivityEmitter + ?Sized> ActivityEmitter for Arc<T> {
    fn emit(&self, entry: &ActivityEntry) {
        (**self).emit(entry)
    }
}

/// Drop-in emitter that discards every entry. Used by the test harness
/// (where no Tauri AppHandle exists) and by the `agaric-mcp` stub binary
/// (where events have no subscriber).
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopEmitter;

impl ActivityEmitter for NoopEmitter {
    fn emit(&self, _entry: &ActivityEntry) {}
}

/// Production emitter — forwards each entry to the Tauri event bus on the
/// [`MCP_ACTIVITY_EVENT`] channel. Emission failures are logged at
/// `warn` level but do not propagate.
pub struct TauriRuntimeEmitter<R: tauri::Runtime> {
    handle: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriRuntimeEmitter<R> {
    /// Wrap a cloned `AppHandle` to emit `mcp:activity` events.
    pub fn new(handle: tauri::AppHandle<R>) -> Self {
        Self { handle }
    }
}

impl<R: tauri::Runtime> fmt::Debug for TauriRuntimeEmitter<R> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TauriRuntimeEmitter").finish()
    }
}

impl<R: tauri::Runtime> ActivityEmitter for TauriRuntimeEmitter<R> {
    fn emit(&self, entry: &ActivityEntry) {
        use tauri::Emitter;
        if let Err(e) = self.handle.emit(MCP_ACTIVITY_EVENT, entry) {
            tracing::warn!(
                target: "mcp",
                error = %e,
                tool = %entry.tool_name,
                "failed to emit mcp:activity event",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Activity context bundle
// ---------------------------------------------------------------------------

/// Bundle of the shared ring handle + the event emitter, threaded through
/// [`super::server::handle_connection`] so later sub-items (FEAT-4c) can
/// push activity entries from the `tools/call` dispatch path.
///
/// `ActivityContext` is cheap to clone — both fields are `Arc`-backed — and
/// each connection handler receives its own clone so the ring / emitter
/// survive the handler's lifetime without extra lifetime gymnastics.
#[derive(Clone)]
pub struct ActivityContext {
    pub ring: Arc<Mutex<ActivityRing>>,
    pub emitter: Arc<dyn ActivityEmitter>,
}

impl ActivityContext {
    /// Convenience constructor.
    pub fn new(ring: Arc<Mutex<ActivityRing>>, emitter: Arc<dyn ActivityEmitter>) -> Self {
        Self { ring, emitter }
    }

    /// Build a production context from a Tauri `AppHandle`. Shorthand for
    /// `ActivityContext::new(Arc::new(Mutex::new(ActivityRing::new())), ...)`.
    pub fn from_app_handle<R: tauri::Runtime>(handle: tauri::AppHandle<R>) -> Self {
        Self::new(
            Arc::new(Mutex::new(ActivityRing::new())),
            Arc::new(TauriRuntimeEmitter::new(handle)),
        )
    }
}

impl fmt::Debug for ActivityContext {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Do not include the emitter or ring contents — the ring is guarded
        // by a mutex we would have to lock, and the emitter is an opaque
        // trait object. A short shape tag is enough for span context.
        f.debug_struct("ActivityContext").finish()
    }
}

// ---------------------------------------------------------------------------
// Push + emit helper
// ---------------------------------------------------------------------------

/// Append `entry` to `ring` (dropping the oldest if full) and emit it on
/// the configured Tauri event bus. Emission errors are logged but never
/// propagated — a transient bus failure must not cancel the ring push.
///
/// The ring is updated *before* the event is emitted so any listener that
/// queries the ring in reaction to the event sees a consistent state.
pub fn emit_activity(
    ring: &Arc<Mutex<ActivityRing>>,
    emitter: &dyn ActivityEmitter,
    entry: ActivityEntry,
) {
    // Clone the entry for the bus — serde borrows immutably, but serialization
    // happens after the mutex is released so the lock-hold window stays
    // minimal.
    let for_bus = entry.clone();
    {
        let mut guard = ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.push(entry);
    }
    emitter.emit(&for_bus);
}

/// Convenience wrapper that builds an [`ActivityEntry`] with `Utc::now()`
/// and dispatches it through [`emit_activity`]. Exposed as the stable
/// integration point FEAT-4c will call from the `tools/call` success and
/// failure branches.
pub fn emit_tool_completion(
    ctx: &ActivityContext,
    tool_name: impl Into<String>,
    summary: impl Into<String>,
    actor_kind: ActorKind,
    agent_name: Option<String>,
    result: ActivityResult,
) {
    let entry = ActivityEntry {
        tool_name: tool_name.into(),
        summary: summary.into(),
        timestamp: Utc::now(),
        actor_kind,
        agent_name,
        result,
    };
    emit_activity(&ctx.ring, ctx.emitter.as_ref(), entry);
}

// ---------------------------------------------------------------------------
// Test-only recording emitter
// ---------------------------------------------------------------------------

/// Test-only emitter that stores every emitted entry in a `Mutex<Vec<...>>`
/// for later assertion. Modeled on [`crate::sync_events::RecordingEventSink`].
#[cfg(test)]
#[derive(Debug, Default)]
pub struct RecordingEmitter(pub Mutex<Vec<ActivityEntry>>);

#[cfg(test)]
impl RecordingEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot of all recorded entries, oldest first.
    pub fn entries(&self) -> Vec<ActivityEntry> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Total number of emissions recorded so far.
    pub fn len(&self) -> usize {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len()
    }

    #[allow(dead_code)] // kept symmetrical with `len`; useful in future tests.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
impl ActivityEmitter for RecordingEmitter {
    fn emit(&self, entry: &ActivityEntry) {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(entry.clone());
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(tag: &str) -> ActivityEntry {
        ActivityEntry {
            tool_name: tag.to_string(),
            summary: format!("summary for {tag}"),
            timestamp: Utc::now(),
            actor_kind: ActorKind::Agent,
            agent_name: Some(format!("agent-{tag}")),
            result: ActivityResult::Ok,
        }
    }

    // ---- ring buffer ----

    #[test]
    fn ring_new_is_empty_with_default_capacity() {
        let r = ActivityRing::new();
        assert_eq!(r.len(), 0);
        assert!(r.is_empty());
        assert_eq!(r.capacity(), ACTIVITY_RING_CAPACITY);
    }

    #[test]
    fn ring_push_under_cap_retains_all_entries() {
        let mut r = ActivityRing::with_capacity(4);
        r.push(make_entry("a"));
        r.push(make_entry("b"));
        r.push(make_entry("c"));
        assert_eq!(r.len(), 3);
        let names: Vec<&str> = r.entries().iter().map(|e| e.tool_name.as_str()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);
    }

    #[test]
    fn ring_push_at_cap_drops_oldest() {
        // Spec verification: push CAPACITY+1 entries, assert len == CAPACITY,
        // entry 0 (oldest) was dropped, entry 1 is now at head, entry N is tail.
        let cap = ACTIVITY_RING_CAPACITY;
        let mut r = ActivityRing::new();
        for i in 0..=cap {
            let mut entry = make_entry("t");
            entry.summary = format!("#{i}");
            r.push(entry);
        }
        assert_eq!(r.len(), cap, "ring stays at capacity");

        let entries = r.entries();
        // Oldest survivor is the second-pushed entry (#1), because #0 was evicted.
        assert_eq!(
            entries.front().map(|e| e.summary.as_str()),
            Some("#1"),
            "oldest (#0) must be evicted on overflow",
        );
        // Tail is the most recently pushed entry (#cap).
        assert_eq!(
            entries.back().map(|e| e.summary.as_str()),
            Some(format!("#{cap}").as_str()),
            "newest push is at the tail",
        );
        // Every intermediate index is in order, no duplicates, no gaps.
        for (pos, entry) in entries.iter().enumerate() {
            assert_eq!(entry.summary, format!("#{}", pos + 1));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn ring_concurrent_push_preserves_total_count() {
        // Four tasks each pushing 25 entries → exactly 100 in the ring,
        // no lost pushes, no entries at cap +1.
        let ring = Arc::new(Mutex::new(ActivityRing::with_capacity(100)));

        let mut handles = Vec::new();
        for task in 0..4 {
            let r = ring.clone();
            handles.push(tokio::spawn(async move {
                for i in 0..25 {
                    let mut e = make_entry("c");
                    e.summary = format!("task{task}-#{i}");
                    let mut g = r.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    g.push(e);
                }
            }));
        }
        for h in handles {
            h.await.expect("task joined");
        }

        let guard = ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(
            guard.len(),
            100,
            "4 tasks * 25 pushes = 100 entries at exactly the capacity",
        );

        // Every (task, index) pair appears exactly once — no lost updates.
        let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
        for entry in guard.entries() {
            assert!(
                seen.insert(entry.summary.clone()),
                "duplicate push detected: {}",
                entry.summary,
            );
        }
        assert_eq!(seen.len(), 100);
    }

    // ---- emit_activity / emit_tool_completion ----

    #[test]
    fn emit_activity_pushes_and_emits_exactly_once() {
        let ring = Arc::new(Mutex::new(ActivityRing::new()));
        let emitter = Arc::new(RecordingEmitter::new());

        emit_activity(&ring, emitter.as_ref(), make_entry("one"));

        assert_eq!(
            ring.lock().unwrap().len(),
            1,
            "ring must contain exactly one entry after a single emit",
        );
        assert_eq!(
            emitter.len(),
            1,
            "emitter must receive exactly one event per emit_activity call",
        );
        let recorded = emitter.entries();
        assert_eq!(recorded[0].tool_name, "one");
    }

    #[test]
    fn emit_tool_completion_builds_entry_with_now_and_dispatches() {
        let ring = Arc::new(Mutex::new(ActivityRing::new()));
        let emitter: Arc<dyn ActivityEmitter> = Arc::new(RecordingEmitter::new());
        let ctx = ActivityContext::new(ring.clone(), emitter.clone());

        let before = Utc::now();
        emit_tool_completion(
            &ctx,
            "search",
            "searched for '…' (0 results)",
            ActorKind::Agent,
            Some("claude-desktop".to_string()),
            ActivityResult::Ok,
        );
        let after = Utc::now();

        let guard = ring.lock().unwrap();
        assert_eq!(guard.len(), 1);
        let entry = guard.entries().front().expect("one entry");
        assert_eq!(entry.tool_name, "search");
        assert_eq!(entry.summary, "searched for '…' (0 results)");
        assert_eq!(entry.actor_kind, ActorKind::Agent);
        assert_eq!(entry.agent_name.as_deref(), Some("claude-desktop"));
        assert!(matches!(entry.result, ActivityResult::Ok));
        assert!(
            entry.timestamp >= before && entry.timestamp <= after,
            "timestamp must be bounded by (before, after) around the call",
        );
    }

    #[test]
    fn emit_activity_survives_poisoned_lock() {
        // Simulate a poisoned mutex — after a panic inside a critical
        // section, subsequent `emit_activity` calls must still push.
        let ring = Arc::new(Mutex::new(ActivityRing::new()));
        let ring_for_poison = ring.clone();
        let _ = std::thread::spawn(move || {
            let _g = ring_for_poison.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        assert!(ring.is_poisoned(), "mutex must be poisoned before test");

        let emitter = Arc::new(RecordingEmitter::new());
        emit_activity(&ring, emitter.as_ref(), make_entry("post-poison"));
        // Re-acquire via the same helper so poisoning is tolerated again.
        let guard = ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(guard.len(), 1);
        assert_eq!(emitter.len(), 1);
    }

    // ---- Privacy: Debug redaction ----

    #[test]
    fn debug_impl_redacts_agent_name_field() {
        let entry = ActivityEntry {
            tool_name: "search".to_string(),
            summary: "summary".to_string(),
            timestamp: Utc::now(),
            actor_kind: ActorKind::Agent,
            agent_name: Some("sensitive-agent-identifier".to_string()),
            result: ActivityResult::Ok,
        };
        let rendered = format!("{entry:?}");
        assert!(
            !rendered.contains("sensitive-agent-identifier"),
            "Debug output must not leak agent_name contents; got {rendered}",
        );
        assert!(
            rendered.contains("<REDACTED>"),
            "Debug output must include a redaction marker; got {rendered}",
        );
    }

    #[test]
    fn debug_impl_for_none_agent_name_shows_none() {
        let entry = ActivityEntry {
            tool_name: "search".to_string(),
            summary: "summary".to_string(),
            timestamp: Utc::now(),
            actor_kind: ActorKind::User,
            agent_name: None,
            result: ActivityResult::Ok,
        };
        let rendered = format!("{entry:?}");
        assert!(
            rendered.contains("agent_name: None"),
            "Debug output for None agent_name should render `None`; got {rendered}",
        );
        assert!(!rendered.contains("<REDACTED>"));
    }

    #[test]
    fn activity_result_serializes_with_kind_message_shape() {
        // Frontend contract check — the event payload shape is stable.
        let ok = serde_json::to_value(ActivityResult::Ok).unwrap();
        assert_eq!(ok, serde_json::json!({ "kind": "ok" }));
        let err = serde_json::to_value(ActivityResult::Err("boom".into())).unwrap();
        assert_eq!(err, serde_json::json!({ "kind": "err", "message": "boom" }),);
    }

    #[test]
    fn activity_entry_serializes_camel_case_with_optional_agent_name() {
        let entry = ActivityEntry {
            tool_name: "get_block".to_string(),
            summary: "got block".to_string(),
            timestamp: DateTime::parse_from_rfc3339("2025-01-02T03:04:05Z")
                .unwrap()
                .with_timezone(&Utc),
            actor_kind: ActorKind::Agent,
            agent_name: Some("claude".to_string()),
            result: ActivityResult::Ok,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["toolName"], "get_block");
        assert_eq!(v["summary"], "got block");
        assert_eq!(v["actorKind"], "agent");
        assert_eq!(v["agentName"], "claude");
        assert_eq!(v["result"]["kind"], "ok");
    }

    #[test]
    fn activity_entry_serializes_without_agent_name_when_none() {
        let entry = ActivityEntry {
            tool_name: "search".to_string(),
            summary: "".to_string(),
            timestamp: Utc::now(),
            actor_kind: ActorKind::User,
            agent_name: None,
            result: ActivityResult::Ok,
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert!(
            v.get("agentName").is_none(),
            "agentName should be omitted when None; got {v}",
        );
    }

    #[test]
    fn noop_emitter_is_harmless() {
        let ring = Arc::new(Mutex::new(ActivityRing::new()));
        emit_activity(&ring, &NoopEmitter, make_entry("x"));
        // Ring still received the entry; emitter was a no-op.
        assert_eq!(ring.lock().unwrap().len(), 1);
    }
}
