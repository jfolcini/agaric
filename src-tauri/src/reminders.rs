//! #4554 — desktop task reminders: one OS notification per task on its due
//! date, fired by a [`crate::maintenance::MaintenanceJob`] on the daemon's
//! 60 s tick.
//!
//! Nothing is scheduled ahead of time. Every tick recomputes the answer from
//! the database — open blocks whose `due_date` is today, minus the ones this
//! device already notified — so an edited, completed, deleted or synced-in
//! task needs no bookkeeping: the next tick simply computes a different set.
//! The one thing that persists is the fired ledger, one `app_settings` row per
//! `(block, date)`, which is what makes a tick, a restart, or a DST-repeated
//! hour unable to notify twice. Everything in this module is a local
//! wall-clock decision (`chrono::Local`): a reminder is a user-facing event
//! and must follow the device's clock, not UTC.
//!
//! Delivery is **at most once**. The ledger row is written before the
//! notification is dispatched, so a notification the OS daemon drops (or a
//! process that dies between the two writes) is a reminder lost for that day,
//! never a duplicate; the agenda still shows the task as due. At-least-once
//! would need a retry against a dispatch path that, on Linux, leaves a
//! detached thread parked per attempt (`commands::notifier`), and that is how
//! a recovering daemon delivers a burst of stale copies.
//!
//! Desktop only, and only while the process runs. A closed app fires nothing;
//! a minimised or unfocused one does. The Android arm, lead offsets, a per-task
//! `reminder` property and the catch-up digest are later phases of #4554.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use std::future::Future;
use std::pin::Pin;

use crate::commands::notifier::TaskNotification;
use agaric_core::error::AppError;

/// `app_settings` key: `'1'` when reminders fire, anything else off.
const ENABLED_KEY: &str = "reminders.enabled";
/// `app_settings` key: the local wall-clock time, `HH:MM`, at which a task due
/// today becomes eligible.
const TIME_KEY: &str = "reminders.time";
/// Prefix of the fired-ledger keys: `reminders.fired.<BLOCK_ID>|<YYYY-MM-DD>`.
const LEDGER_PREFIX: &str = "reminders.fired.";
/// Ledger rows older than this are pruned on each fire.
const LEDGER_RETENTION_MS: i64 = 30 * 24 * 3600 * 1000;
/// Reminder time used until the user picks one.
const DEFAULT_TIME: &str = "09:00";
/// Longest notification title, in characters, cut at a word boundary.
const TITLE_MAX_CHARS: usize = 60;

/// The device-local reminder preferences, stored in `app_settings` so the
/// maintenance job can read them without the webview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ReminderSettings {
    /// Master switch. Off by default: a fresh install never notifies until
    /// the user opts in from Settings → Notifications.
    pub enabled: bool,
    /// Local wall-clock time, `HH:MM`, at which a task due today is notified.
    pub time: String,
}

impl Default for ReminderSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            time: DEFAULT_TIME.to_string(),
        }
    }
}

/// Parse an `HH:MM` reminder time, rejecting anything else as
/// [`AppError::Validation`].
fn parse_time(value: &str) -> Result<NaiveTime, AppError> {
    NaiveTime::parse_from_str(value, "%H:%M")
        .map_err(|_| AppError::validation(format!("reminder time must be HH:MM, got {value:?}")))
}

/// Read the reminder settings; absent rows read as [`ReminderSettings::default`].
pub async fn get_settings(pool: &SqlitePool) -> Result<ReminderSettings, AppError> {
    let rows = sqlx::query!(
        "SELECT key, value FROM app_settings WHERE key IN (?, ?)",
        ENABLED_KEY,
        TIME_KEY
    )
    .fetch_all(pool)
    .await?;
    let mut settings = ReminderSettings::default();
    for row in rows {
        if row.key == ENABLED_KEY {
            settings.enabled = row.value == "1";
        } else {
            settings.time = row.value;
        }
    }
    Ok(settings)
}

/// Persist the reminder settings. The time is validated as `HH:MM` so the job
/// never reads a value it cannot parse.
pub async fn set_settings(pool: &SqlitePool, settings: &ReminderSettings) -> Result<(), AppError> {
    parse_time(&settings.time)?;
    let now = crate::db::now_ms();
    let enabled = if settings.enabled { "1" } else { "0" };
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?), (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        ENABLED_KEY,
        enabled,
        now,
        TIME_KEY,
        settings.time,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// One open task due on the day being evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueTask {
    pub id: String,
    pub content: Option<String>,
}

/// Open tasks due on `today` that this device has not yet notified for that
/// date. "Open" is the agenda's reading — live, and not `DONE` or
/// `CANCELLED`; a block with a due date and no `todo_state` counts, because
/// the agenda lists it too.
pub async fn due_tasks(pool: &SqlitePool, today: NaiveDate) -> Result<Vec<DueTask>, AppError> {
    let today = today.format("%Y-%m-%d").to_string();
    let rows = sqlx::query!(
        "SELECT id, content FROM blocks
         WHERE deleted_at IS NULL
           AND due_date = ?1
           AND (todo_state IS NULL OR todo_state NOT IN ('DONE', 'CANCELLED'))
           AND NOT EXISTS (
               SELECT 1 FROM app_settings
               WHERE key = ?2 || blocks.id || '|' || ?1
           )
         ORDER BY id",
        today,
        LEDGER_PREFIX,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| DueTask {
            id: row.id,
            content: row.content,
        })
        .collect())
}

/// Notification title for a task: its first line, cut to
/// `TITLE_MAX_CHARS` at a word boundary, or `Untitled task`.
pub fn notification_title(content: Option<&str>) -> String {
    let first_line = content
        .and_then(|c| c.lines().next())
        .map(str::trim)
        .unwrap_or_default();
    if first_line.is_empty() {
        return "Untitled task".to_string();
    }
    if first_line.chars().count() <= TITLE_MAX_CHARS {
        return first_line.to_string();
    }
    let head: String = first_line.chars().take(TITLE_MAX_CHARS).collect();
    let cut = head.rfind(char::is_whitespace).unwrap_or(head.len());
    format!("{}…", head[..cut].trim_end())
}

/// A notification dispatcher: the job hands it what would be sent, so a test
/// can capture the payloads without Tauri or an OS notification daemon.
pub type NotifyFn = dyn Fn(TaskNotification) -> Pin<Box<dyn Future<Output = Result<(), AppError>> + Send>>
    + Send
    + Sync;

/// The tick body against an explicit local wall-clock `now`, so the time gate
/// and the calendar day are testable. Returns how many reminders were
/// dispatched.
pub async fn fire_due_reminders(
    pool: &SqlitePool,
    now: NaiveDateTime,
    notify: &NotifyFn,
) -> Result<usize, AppError> {
    let settings = get_settings(pool).await?;
    if !settings.enabled || now.time() < parse_time(&settings.time)? {
        return Ok(0);
    }
    let today = now.date();
    let tasks = due_tasks(pool, today).await?;
    let mut fired = 0;
    for task in tasks {
        let key = format!("{LEDGER_PREFIX}{}|{}", task.id, today.format("%Y-%m-%d"));
        let now_ms = crate::db::now_ms();
        sqlx::query!(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?, '1', ?)",
            key,
            now_ms
        )
        .execute(pool)
        .await?;
        let notification = TaskNotification {
            title: notification_title(task.content.as_deref()),
            body: Some("Due today".to_string()),
            block_id: Some(task.id.clone()),
        };
        match notify(notification).await {
            Ok(()) => fired += 1,
            Err(e) => tracing::warn!(
                block_id = %task.id,
                error = %e,
                "reminder notification failed to dispatch; not retried (at most once)"
            ),
        }
    }
    if fired > 0 {
        prune_ledger(pool).await?;
    }
    Ok(fired)
}

/// Drop ledger rows older than [`LEDGER_RETENTION_MS`].
async fn prune_ledger(pool: &SqlitePool) -> Result<(), AppError> {
    let cutoff = crate::db::now_ms().saturating_sub(LEDGER_RETENTION_MS);
    let pattern = format!("{LEDGER_PREFIX}%");
    sqlx::query!(
        "DELETE FROM app_settings WHERE key LIKE ? AND updated_at < ?",
        pattern,
        cutoff
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// The maintenance-job body: [`fire_due_reminders`] at the local wall clock.
pub async fn reminders_tick(pool: &SqlitePool, notify: &NotifyFn) -> Result<(), AppError> {
    let fired = fire_due_reminders(pool, chrono::Local::now().naive_local(), notify).await?;
    if fired > 0 {
        tracing::info!(fired, "reminders_tick dispatched due-today notifications");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let pool = crate::db::init_pool(&dir.path().join("test.db"))
            .await
            .unwrap();
        (pool, dir)
    }

    async fn insert_task(
        pool: &SqlitePool,
        id: &str,
        content: &str,
        due: &str,
        todo_state: Option<&str>,
        deleted: bool,
    ) {
        let deleted_at: Option<i64> = deleted.then_some(1);
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, position, due_date, todo_state, deleted_at)
             VALUES (?, 'content', ?, 1, ?, ?, ?)",
        )
        .bind(id)
        .bind(content)
        .bind(due)
        .bind(todo_state)
        .bind(deleted_at)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn enable(pool: &SqlitePool, time: &str) {
        set_settings(
            pool,
            &ReminderSettings {
                enabled: true,
                time: time.to_string(),
            },
        )
        .await
        .unwrap();
    }

    async fn ledger_count(pool: &SqlitePool) -> i64 {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM app_settings WHERE key LIKE 'reminders.fired.%'",
        )
        .fetch_one(pool)
        .await
        .unwrap()
    }

    type Sent = Arc<Mutex<Vec<TaskNotification>>>;
    type NotifyFuture = Pin<Box<dyn Future<Output = Result<(), AppError>> + Send>>;

    fn boxed(fut: impl Future<Output = Result<(), AppError>> + Send + 'static) -> NotifyFuture {
        Box::pin(fut)
    }

    /// A sink that records every payload and answers `Ok`.
    fn recording_sink(sent: &Sent) -> Box<NotifyFn> {
        let sent = Arc::clone(sent);
        Box::new(move |n| {
            let sent = Arc::clone(&sent);
            boxed(async move {
                sent.lock().unwrap().push(n);
                Ok(())
            })
        })
    }

    fn day(date: &str, time: &str) -> NaiveDateTime {
        NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .unwrap()
            .and_time(NaiveTime::parse_from_str(time, "%H:%M").unwrap())
    }

    const TODAY: &str = "2026-09-07";

    #[tokio::test]
    async fn due_tasks_selects_open_tasks_due_today_not_yet_notified() {
        let (pool, _dir) = test_pool().await;
        insert_task(&pool, "01OPEN", "Open TODO", TODAY, Some("TODO"), false).await;
        insert_task(&pool, "01NOSTATE", "Dated, no state", TODAY, None, false).await;
        insert_task(&pool, "01DONE", "Done", TODAY, Some("DONE"), false).await;
        insert_task(
            &pool,
            "01CANCEL",
            "Cancelled",
            TODAY,
            Some("CANCELLED"),
            false,
        )
        .await;
        insert_task(
            &pool,
            "01TOMORROW",
            "Tomorrow",
            "2026-09-08",
            Some("TODO"),
            false,
        )
        .await;
        insert_task(&pool, "01TRASHED", "Trashed", TODAY, Some("TODO"), true).await;
        insert_task(
            &pool,
            "01FIRED",
            "Already fired",
            TODAY,
            Some("TODO"),
            false,
        )
        .await;
        sqlx::query(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES ('reminders.fired.01FIRED|2026-09-07', '1', 0)",
        )
        .execute(&pool)
        .await
        .unwrap();

        let tasks = due_tasks(&pool, NaiveDate::parse_from_str(TODAY, "%Y-%m-%d").unwrap())
            .await
            .unwrap();
        let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["01NOSTATE", "01OPEN"],
            "only live, open, due-today, not-yet-notified tasks are selected"
        );
    }

    #[tokio::test]
    async fn fires_exactly_once_across_two_ticks() {
        let (pool, _dir) = test_pool().await;
        enable(&pool, "09:00").await;
        insert_task(
            &pool,
            "01TASK",
            "Write the release notes",
            TODAY,
            Some("TODO"),
            false,
        )
        .await;
        let sent: Sent = Arc::default();
        let sink = recording_sink(&sent);

        let first = fire_due_reminders(&pool, day(TODAY, "09:00"), &*sink)
            .await
            .unwrap();
        let second = fire_due_reminders(&pool, day(TODAY, "09:01"), &*sink)
            .await
            .unwrap();

        assert_eq!(first, 1, "the first tick past the reminder time fires");
        assert_eq!(second, 0, "the next tick must not fire the same task again");
        assert_eq!(ledger_count(&pool).await, 1, "one ledger row per fire");
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 1, "exactly one notification was dispatched");
        assert_eq!(sent[0].title, "Write the release notes");
        assert_eq!(sent[0].body.as_deref(), Some("Due today"));
        assert_eq!(sent[0].block_id.as_deref(), Some("01TASK"));
    }

    #[tokio::test]
    async fn does_not_fire_before_the_reminder_time() {
        let (pool, _dir) = test_pool().await;
        enable(&pool, "09:00").await;
        insert_task(&pool, "01TASK", "Task", TODAY, Some("TODO"), false).await;
        let sent: Sent = Arc::default();
        let sink = recording_sink(&sent);

        let early = fire_due_reminders(&pool, day(TODAY, "08:59"), &*sink)
            .await
            .unwrap();
        assert_eq!(early, 0, "08:59 is before a 09:00 reminder time");
        assert_eq!(
            ledger_count(&pool).await,
            0,
            "nothing claimed before the time"
        );

        let on_time = fire_due_reminders(&pool, day(TODAY, "09:00"), &*sink)
            .await
            .unwrap();
        assert_eq!(on_time, 1, "09:00 fires");
        assert_eq!(sent.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn disabled_settings_fire_nothing() {
        let (pool, _dir) = test_pool().await;
        insert_task(&pool, "01TASK", "Task", TODAY, Some("TODO"), false).await;
        let sent: Sent = Arc::default();
        let sink = recording_sink(&sent);

        let fired = fire_due_reminders(&pool, day(TODAY, "23:00"), &*sink)
            .await
            .unwrap();
        assert_eq!(fired, 0, "reminders are off by default");
        assert_eq!(sent.lock().unwrap().len(), 0);
        assert_eq!(
            ledger_count(&pool).await,
            0,
            "a disabled job claims nothing"
        );
    }

    #[tokio::test]
    async fn a_failed_dispatch_is_not_retried() {
        let (pool, _dir) = test_pool().await;
        enable(&pool, "09:00").await;
        insert_task(&pool, "01TASK", "Task", TODAY, Some("TODO"), false).await;
        let calls = Arc::new(Mutex::new(0usize));
        let sink: Box<NotifyFn> = {
            let calls = Arc::clone(&calls);
            Box::new(move |_| {
                *calls.lock().unwrap() += 1;
                boxed(async {
                    Err(AppError::InvalidOperation(
                        "notification daemon unresponsive".into(),
                    ))
                })
            })
        };

        let first = fire_due_reminders(&pool, day(TODAY, "09:00"), &*sink)
            .await
            .unwrap();
        let second = fire_due_reminders(&pool, day(TODAY, "09:01"), &*sink)
            .await
            .unwrap();
        assert_eq!(
            (first, second),
            (0, 0),
            "a failed dispatch counts as not fired"
        );
        assert_eq!(
            *calls.lock().unwrap(),
            1,
            "the ledger claims the task before dispatch, so the failure is not retried"
        );
    }

    #[tokio::test]
    async fn a_fire_prunes_ledger_rows_older_than_thirty_days() {
        let (pool, _dir) = test_pool().await;
        enable(&pool, "09:00").await;
        insert_task(&pool, "01TASK", "Task", TODAY, Some("TODO"), false).await;
        let stale = crate::db::now_ms() - LEDGER_RETENTION_MS - 1;
        let fresh = crate::db::now_ms() - LEDGER_RETENTION_MS + 60_000;
        sqlx::query(
            "INSERT INTO app_settings (key, value, updated_at) VALUES
             ('reminders.fired.01OLD|2026-08-01', '1', ?),
             ('reminders.fired.01RECENT|2026-08-08', '1', ?)",
        )
        .bind(stale)
        .bind(fresh)
        .execute(&pool)
        .await
        .unwrap();
        let sent: Sent = Arc::default();
        let sink = recording_sink(&sent);

        fire_due_reminders(&pool, day(TODAY, "09:00"), &*sink)
            .await
            .unwrap();

        assert_eq!(
            ledger_count(&pool).await,
            2,
            "the stale row is pruned; the fresh row and today's fire remain"
        );
        let old: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'reminders.fired.01OLD|2026-08-01'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(old, 0, "the row older than 30 days is gone");
    }

    #[tokio::test]
    async fn settings_round_trip_and_reject_a_malformed_time() {
        let (pool, _dir) = test_pool().await;
        assert_eq!(
            get_settings(&pool).await.unwrap(),
            ReminderSettings::default(),
            "absent rows read as the defaults"
        );

        let wanted = ReminderSettings {
            enabled: true,
            time: "18:30".to_string(),
        };
        set_settings(&pool, &wanted).await.unwrap();
        assert_eq!(get_settings(&pool).await.unwrap(), wanted, "round trip");

        let off = ReminderSettings {
            enabled: false,
            time: "07:15".to_string(),
        };
        set_settings(&pool, &off).await.unwrap();
        assert_eq!(get_settings(&pool).await.unwrap(), off, "upsert overwrites");

        let err = set_settings(
            &pool,
            &ReminderSettings {
                enabled: true,
                time: "9am".to_string(),
            },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, AppError::Validation { .. }), "got {err:?}");
        assert_eq!(
            get_settings(&pool).await.unwrap(),
            off,
            "a rejected write leaves the stored settings untouched"
        );
    }

    #[test]
    fn notification_title_uses_first_line_and_cuts_at_a_word_boundary() {
        assert_eq!(notification_title(None), "Untitled task");
        assert_eq!(notification_title(Some("   \n")), "Untitled task");
        assert_eq!(
            notification_title(Some("  Renew the domain \nsecond")),
            "Renew the domain"
        );
        let long = "Write the release notes for the September build and post them to the forum";
        assert_eq!(
            notification_title(Some(long)),
            "Write the release notes for the September build and post…"
        );
        let unbroken = "x".repeat(70);
        assert_eq!(
            notification_title(Some(&unbroken)),
            format!("{}…", "x".repeat(60))
        );
    }
}
