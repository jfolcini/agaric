//! [`Materializer::dispatch_commit`]: what a commit's background tasks take
//! of the bounded channel, and where they go when it is full.
//!
//! The slot counts are read before the first `.await` after the dispatch: on
//! the current-thread test runtime the consumer cannot run inside that
//! window, so the channel holds exactly what the dispatch put there.
use super::*;

const FIRST: &str = "01HZ00000000000000000FAN01";
const SECOND: &str = "01HZ00000000000000000FAN02";
const THIRD: &str = "01HZ00000000000000000FAN03";
const FOURTH: &str = "01HZ00000000000000000FAN04";

fn create_record(block_id: &str) -> OpRecord {
    fake_op_record(
        "create_block",
        &format!(r#"{{"block_id":"{block_id}","block_type":"content","content":"x"}}"#),
    )
}

fn due_date_record(block_id: &str) -> OpRecord {
    fake_op_record(
        "set_property",
        &format!(r#"{{"block_id":"{block_id}","key":"due_date","value_date":"2026-01-20"}}"#),
    )
}

fn unhinted(record: &OpRecord) -> CommitOp<'_> {
    CommitOp {
        record,
        block_type: None,
        move_same_page: None,
    }
}

fn slots_taken(mat: &Materializer) -> usize {
    BACKGROUND_CAPACITY - mat.bg_sender().unwrap().capacity()
}

async fn fts_rows(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM fts_blocks")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// The ordinary write: a commit of one op takes the channel as it did before
/// `dispatch_commit` existed, a slot per task.
#[tokio::test]
async fn a_commit_of_one_op_enqueues_its_tasks_one_at_a_time() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, FIRST, "content", "one").await;
    let mat = Materializer::new(pool.clone());

    let record = create_record(FIRST);
    mat.dispatch_commit(&[unhinted(&record)]);

    assert_eq!(
        slots_taken(&mat),
        4,
        "a content create's UpdateFtsBlock, SetBlockPageId, ReindexBlockLinks and \
         ReindexBlockTagRefs each take a slot"
    );
    mat.flush_background().await.unwrap();
    assert_eq!(fts_rows(&pool).await, 1, "the block is indexed");
    mat.shutdown();
}

/// Two commits, so the consumer unpacks one as the task that woke it and one
/// as a task it found waiting.
#[tokio::test]
async fn a_commit_of_several_ops_takes_one_slot_and_runs_every_task() {
    let (pool, _dir) = test_pool().await;
    for id in [FIRST, SECOND, THIRD, FOURTH] {
        insert_block_direct(&pool, id, "content", "text").await;
    }
    let mat = Materializer::new(pool.clone());

    let first = [create_record(FIRST), create_record(SECOND)];
    mat.dispatch_commit(&[unhinted(&first[0]), unhinted(&first[1])]);
    assert_eq!(
        slots_taken(&mat),
        1,
        "the commit's eight tasks share a slot"
    );
    let second = [create_record(THIRD), create_record(FOURTH)];
    mat.dispatch_commit(&[unhinted(&second[0]), unhinted(&second[1])]);
    assert_eq!(slots_taken(&mat), 2, "a slot per commit");

    mat.flush_background().await.unwrap();
    assert_eq!(fts_rows(&pool).await, 4, "every block is indexed");
    assert_eq!(
        mat.metrics().bg_processed.load(AtomicOrdering::Relaxed),
        17,
        "sixteen tasks and the flush's barrier ran"
    );
    mat.shutdown();
}

/// A commit shed by a full channel persists each task it carried, once, from
/// one writer: the two ops' `RebuildAgendaCache` is one row on its first
/// attempt, not one escalated by its own repeat.
#[tokio::test]
async fn a_shed_commit_persists_each_of_its_tasks_once() {
    let (pool, _dir) = test_pool().await;
    let mat = Materializer::new(pool.clone());
    mat.force_shed_after(0);

    let records = [
        create_record(FIRST),
        create_record(SECOND),
        due_date_record(FIRST),
        due_date_record(SECOND),
    ];
    let ops: Vec<CommitOp<'_>> = records.iter().map(unhinted).collect();
    mat.dispatch_commit(&ops);
    assert_eq!(
        mat.shed_persists.in_flight(),
        1,
        "one future writes the commit's rows: one per row holds the write pool against commands"
    );
    mat.wait_for_pending_shed_persists().await;

    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT task_kind, COUNT(*), MAX(attempts) FROM materializer_retry_queue \
         GROUP BY task_kind ORDER BY task_kind",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("RebuildAgendaCache".to_owned(), 1, 1),
            ("ReindexBlockLinks".to_owned(), 2, 1),
            ("ReindexBlockTagRefs".to_owned(), 2, 1),
            ("SetBlockPageId".to_owned(), 2, 1),
            ("UpdateFtsBlock".to_owned(), 2, 1),
            ("UpdateProjectedAgendaBlock".to_owned(), 2, 1),
        ],
        "one first-attempt row per distinct task of the shed commit"
    );
    assert_eq!(
        (
            mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed),
            mat.metrics()
                .bg_dropped_global
                .load(AtomicOrdering::Relaxed),
        ),
        (11, 1),
        "the counters count the tasks, the agenda rebuild as the one global"
    );
    mat.shutdown();
}

/// A flush is a barrier and leaves a shed task in the retry queue for the
/// sweeper; a settle runs it. Quit and boot flush, and must not wait on a
/// backlog; the integrity check settles, and must not report it.
#[tokio::test]
async fn a_settle_runs_the_tasks_a_full_queue_shed_and_a_flush_does_not() {
    let (pool, _dir) = test_pool().await;
    insert_block_direct(&pool, FIRST, "content", "one").await;
    let mat = Materializer::new(pool.clone());
    mat.force_shed_after(0);
    let outcome = mat
        .try_enqueue_background(MaterializeTask::UpdateFtsBlock {
            block_id: StdArc::from(FIRST),
        })
        .unwrap();
    assert_eq!(outcome, BackgroundEnqueueOutcome::Shed, "the fixture sheds");
    mat.force_shed_after(-1);
    let retry_rows = || async {
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM materializer_retry_queue")
            .fetch_one(&pool)
            .await
            .unwrap()
    };

    mat.flush_background().await.unwrap();
    mat.wait_for_pending_shed_persists().await;
    assert_eq!(
        (fts_rows(&pool).await, retry_rows().await),
        (0, 1),
        "a flush leaves the shed task where the sweeper will find it"
    );

    mat.settle_background().await.unwrap();
    assert_eq!(
        (fts_rows(&pool).await, retry_rows().await),
        (1, 0),
        "a settle ran the shed task, and its retry row is gone"
    );
    mat.shutdown();
}

/// A background task queued behind a writer waits for it. The writer here
/// holds the lock for several times the consumer's whole in-memory retry
/// schedule at this pool's 50 ms busy timeout, after which the task used to
/// be counted failed and sent to the retry queue.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_background_task_waits_out_a_busy_writer() {
    let (setup, dir) = test_pool().await;
    insert_block_direct(&setup, FIRST, "content", "one").await;
    let impatient = agaric_store::db::base_connect_options(&dir.path().join("test.db"))
        .busy_timeout(Duration::from_millis(50));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(2)
        .connect_with(impatient)
        .await
        .unwrap();
    let mat = Materializer::new(pool.clone());

    let writer = setup.begin_with("BEGIN IMMEDIATE").await.unwrap();
    mat.try_enqueue_background(MaterializeTask::UpdateFtsBlock {
        block_id: StdArc::from(FIRST),
    })
    .unwrap();
    tokio::time::sleep(Duration::from_secs(3)).await;
    drop(writer);

    mat.flush_background().await.unwrap();

    let retry_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM materializer_retry_queue")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        (
            fts_rows(&pool).await,
            retry_rows,
            mat.metrics().bg_errors.load(AtomicOrdering::Relaxed),
        ),
        (1, 0, 0),
        "the task ran once the writer let go, and was never counted failed"
    );
    mat.shutdown();
}

#[derive(Clone, Default)]
struct LogBuf(StdArc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for LogBuf {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

impl LogBuf {
    /// Capture this thread's `warn` and above; the current-thread test
    /// runtime runs the spawned shed persists on it too.
    fn capture_warnings(&self) -> tracing::subscriber::DefaultGuard {
        use tracing_subscriber::layer::SubscriberExt;
        tracing::subscriber::set_default(
            tracing_subscriber::registry()
                .with(tracing_subscriber::EnvFilter::new("warn"))
                .with(
                    tracing_subscriber::fmt::layer()
                        .with_writer(self.clone())
                        .with_ansi(false),
                ),
        )
    }

    fn lines_with(&self, needle: &str) -> Vec<String> {
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .filter(|line| line.contains(needle))
            .map(str::to_owned)
            .collect()
    }
}

/// A burst of sheds warns once, and the next enqueue under the pressure
/// threshold ends the episode with one line carrying the count. The shed
/// persists stay off the warn log: the summary covers them.
#[tokio::test]
async fn a_shed_burst_warns_once_and_summarises_its_count() {
    let (pool, _dir) = test_pool().await;
    let log = LogBuf::default();
    let _guard = log.capture_warnings();
    let mat = Materializer::new(pool.clone());

    mat.force_shed_after(0);
    let records = [
        create_record(FIRST),
        create_record(SECOND),
        due_date_record(FIRST),
        due_date_record(SECOND),
    ];
    let ops: Vec<CommitOp<'_>> = records.iter().map(unhinted).collect();
    mat.dispatch_commit(&ops);
    for _ in 0..2 {
        let outcome = mat
            .try_enqueue_background(MaterializeTask::RebuildTagsCache)
            .unwrap();
        assert_eq!(outcome, BackgroundEnqueueOutcome::Shed, "the fixture sheds");
    }
    mat.wait_for_pending_shed_persists().await;
    mat.force_shed_after(-1);
    let outcome = mat
        .try_enqueue_background(MaterializeTask::RebuildTagsCache)
        .unwrap();
    assert_eq!(
        outcome,
        BackgroundEnqueueOutcome::Enqueued,
        "the hook is off"
    );

    assert_eq!(
        log.lines_with("background queue full, dropping task").len(),
        1,
        "one warn when the shedding starts"
    );
    let summary = log.lines_with("background queue shedding ended");
    assert_eq!(summary.len(), 1, "one summary when it ends");
    assert!(
        summary[0].contains("shed=13"),
        "the summary counts the shed tasks, the commit's eleven and two singles: {summary:?}"
    );
    assert_eq!(
        log.lines_with("persisted failed background task to retry queue"),
        Vec::<String>::new(),
        "a shed's persist is not a warn"
    );
    assert_eq!(
        mat.metrics().bg_dropped.load(AtomicOrdering::Relaxed),
        13,
        "the drop counter still counts every shed task"
    );
    mat.shutdown();
}

/// Pressure warns once per episode: once on crossing the threshold, not on
/// every enqueue above it, and again only after the queue has dropped back
/// under it.
#[tokio::test]
async fn background_pressure_warns_once_per_episode() {
    let (pool, _dir) = test_pool().await;
    let log = LogBuf::default();
    let _guard = log.capture_warnings();
    let mat = Materializer::new(pool.clone());
    let past_threshold =
        BACKGROUND_CAPACITY * QUEUE_PRESSURE_NUMERATOR / QUEUE_PRESSURE_DENOMINATOR + 10;
    let fill = || {
        for _ in 0..past_threshold {
            mat.try_enqueue_background(MaterializeTask::RebuildTagsCache)
                .unwrap();
        }
    };

    fill();
    assert_eq!(
        log.lines_with("background queue pressure").len(),
        1,
        "one warn for ten enqueues past the threshold"
    );
    mat.flush_background().await.unwrap();
    fill();
    assert_eq!(
        log.lines_with("background queue pressure").len(),
        2,
        "a drained queue that fills again is a new episode"
    );
    mat.shutdown();
}

/// The foreground queue follows the same rule as the background one.
#[tokio::test]
async fn foreground_pressure_warns_once_per_episode() {
    let (pool, _dir) = test_pool().await;
    let log = LogBuf::default();
    let _guard = log.capture_warnings();
    let mat = Materializer::new(pool.clone());
    let past_threshold =
        FOREGROUND_CAPACITY * QUEUE_PRESSURE_NUMERATOR / QUEUE_PRESSURE_DENOMINATOR + 10;
    let fill = async || {
        for _ in 0..past_threshold {
            mat.enqueue_foreground(MaterializeTask::BatchApplyOps(StdArc::new(Vec::new())))
                .await
                .unwrap();
        }
    };

    fill().await;
    assert_eq!(
        log.lines_with("foreground queue pressure").len(),
        1,
        "one warn for ten enqueues past the threshold"
    );
    mat.flush_foreground().await.unwrap();
    fill().await;
    assert_eq!(
        log.lines_with("foreground queue pressure").len(),
        2,
        "a drained queue that fills again is a new episode"
    );
    mat.shutdown();
}
