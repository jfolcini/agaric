//! Materializer struct, constructors, and public API.

use super::consumer;
use super::metrics::{QueueMetrics, StatusInfo};
use super::{
    MaterializeTask, BACKGROUND_CAPACITY, FOREGROUND_CAPACITY, QUEUE_PRESSURE_DENOMINATOR,
    QUEUE_PRESSURE_NUMERATOR,
};
use crate::error::AppError;
use sqlx::SqlitePool;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Materializer {
    pub(super) fg_tx: Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>,
    pub(super) bg_tx: Arc<Mutex<Option<mpsc::Sender<MaterializeTask>>>>,
    pub(super) shutdown_flag: Arc<AtomicBool>,
    pub(super) metrics: Arc<QueueMetrics>,
    pub(super) reader_pool: SqlitePool,
}

impl Materializer {
    pub fn new(pool: SqlitePool) -> Self {
        let (fg_tx, fg_rx) = mpsc::channel::<MaterializeTask>(FOREGROUND_CAPACITY);
        let (bg_tx, bg_rx) = mpsc::channel::<MaterializeTask>(BACKGROUND_CAPACITY);
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let metrics = Arc::new(QueueMetrics::default());
        let reader_pool = pool.clone();
        {
            let p = pool.clone();
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            Self::spawn_task(consumer::run_foreground(p, fg_rx, s, m));
        }
        {
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            Self::spawn_task(consumer::run_background(pool, bg_rx, s, m, None));
        }
        {
            let p = reader_pool.clone();
            let m = metrics.clone();
            Self::spawn_task(async move {
                if let Ok(count) = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL",
                )
                .fetch_one(&p)
                .await
                {
                    #[allow(clippy::cast_sign_loss)]
                    m.cached_block_count.store(count as u64, Ordering::Relaxed);
                }
            });
        }
        {
            let m = metrics.clone();
            let s = shutdown_flag.clone();
            Self::spawn_task(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                interval.tick().await; // skip immediate first tick
                loop {
                    interval.tick().await;
                    if s.load(std::sync::atomic::Ordering::Acquire) {
                        break;
                    }
                    let fg_processed = m.fg_processed.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_processed = m.bg_processed.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_deduped = m.bg_deduped.load(std::sync::atomic::Ordering::Relaxed);
                    let fg_high_water = m.fg_high_water.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_high_water = m.bg_high_water.load(std::sync::atomic::Ordering::Relaxed);
                    let fg_errors = m.fg_errors.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_errors = m.bg_errors.load(std::sync::atomic::Ordering::Relaxed);
                    tracing::debug!(
                        fg_processed,
                        bg_processed,
                        bg_deduped,
                        fg_high_water,
                        bg_high_water,
                        fg_errors,
                        bg_errors,
                        "materializer metrics snapshot"
                    );
                    // Reset high-water marks after dump
                    m.fg_high_water
                        .store(0, std::sync::atomic::Ordering::Relaxed);
                    m.bg_high_water
                        .store(0, std::sync::atomic::Ordering::Relaxed);
                }
            });
        }
        Self {
            fg_tx: Arc::new(Mutex::new(Some(fg_tx))),
            bg_tx: Arc::new(Mutex::new(Some(bg_tx))),
            shutdown_flag,
            metrics,
            reader_pool,
        }
    }

    pub fn with_read_pool(write_pool: SqlitePool, read_pool: SqlitePool) -> Self {
        let (fg_tx, fg_rx) = mpsc::channel::<MaterializeTask>(FOREGROUND_CAPACITY);
        let (bg_tx, bg_rx) = mpsc::channel::<MaterializeTask>(BACKGROUND_CAPACITY);
        let shutdown_flag = Arc::new(AtomicBool::new(false));
        let metrics = Arc::new(QueueMetrics::default());
        let reader_pool = read_pool.clone();
        {
            let p = write_pool.clone();
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            Self::spawn_task(consumer::run_foreground(p, fg_rx, s, m));
        }
        {
            let s = shutdown_flag.clone();
            let m = metrics.clone();
            Self::spawn_task(consumer::run_background(
                write_pool,
                bg_rx,
                s,
                m,
                Some(read_pool),
            ));
        }
        {
            let p = reader_pool.clone();
            let m = metrics.clone();
            Self::spawn_task(async move {
                if let Ok(count) = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL",
                )
                .fetch_one(&p)
                .await
                {
                    #[allow(clippy::cast_sign_loss)]
                    m.cached_block_count.store(count as u64, Ordering::Relaxed);
                }
            });
        }
        {
            let m = metrics.clone();
            let s = shutdown_flag.clone();
            Self::spawn_task(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                interval.tick().await; // skip immediate first tick
                loop {
                    interval.tick().await;
                    if s.load(std::sync::atomic::Ordering::Acquire) {
                        break;
                    }
                    let fg_processed = m.fg_processed.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_processed = m.bg_processed.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_deduped = m.bg_deduped.load(std::sync::atomic::Ordering::Relaxed);
                    let fg_high_water = m.fg_high_water.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_high_water = m.bg_high_water.load(std::sync::atomic::Ordering::Relaxed);
                    let fg_errors = m.fg_errors.load(std::sync::atomic::Ordering::Relaxed);
                    let bg_errors = m.bg_errors.load(std::sync::atomic::Ordering::Relaxed);
                    tracing::debug!(
                        fg_processed,
                        bg_processed,
                        bg_deduped,
                        fg_high_water,
                        bg_high_water,
                        fg_errors,
                        bg_errors,
                        "materializer metrics snapshot"
                    );
                    // Reset high-water marks after dump
                    m.fg_high_water
                        .store(0, std::sync::atomic::Ordering::Relaxed);
                    m.bg_high_water
                        .store(0, std::sync::atomic::Ordering::Relaxed);
                }
            });
        }
        Self {
            fg_tx: Arc::new(Mutex::new(Some(fg_tx))),
            bg_tx: Arc::new(Mutex::new(Some(bg_tx))),
            shutdown_flag,
            metrics,
            reader_pool,
        }
    }

    fn spawn_task<F>(future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        #[cfg(test)]
        tokio::spawn(future);
        #[cfg(not(test))]
        tauri::async_runtime::spawn(future);
    }

    /// Spawn a lightweight task to refresh the cached block count used for
    /// the adaptive FTS-optimize threshold.
    pub(super) fn refresh_block_count_cache(&self) {
        let pool = self.reader_pool.clone();
        let metrics = self.metrics.clone();
        Self::spawn_task(async move {
            if let Ok(count) =
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM blocks WHERE deleted_at IS NULL")
                    .fetch_one(&pool)
                    .await
            {
                #[allow(clippy::cast_sign_loss)]
                metrics
                    .cached_block_count
                    .store(count as u64, Ordering::Relaxed);
            }
        });
    }

    pub async fn enqueue_foreground(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.fg_sender()?;
        tx.send(task)
            .await
            .map_err(|e| AppError::Channel(format!("foreground queue send failed: {e}")))?;
        let depth = FOREGROUND_CAPACITY - tx.capacity();
        self.metrics
            .fg_high_water
            .fetch_max(depth as u64, Ordering::Relaxed);
        self.check_queue_pressure();
        Ok(())
    }

    pub async fn enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.bg_sender()?;
        tx.send(task)
            .await
            .map_err(|e| AppError::Channel(format!("background queue send failed: {e}")))?;
        let depth = BACKGROUND_CAPACITY - tx.capacity();
        self.metrics
            .bg_high_water
            .fetch_max(depth as u64, Ordering::Relaxed);
        self.check_queue_pressure();
        Ok(())
    }

    pub fn try_enqueue_background(&self, task: MaterializeTask) -> Result<(), AppError> {
        let tx = self.bg_sender()?;
        match tx.try_send(task) {
            Ok(()) => {
                let depth = BACKGROUND_CAPACITY - tx.capacity();
                self.metrics
                    .bg_high_water
                    .fetch_max(depth as u64, Ordering::Relaxed);
                self.check_queue_pressure();
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                tracing::warn!("background queue full, dropping task");
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                Err(AppError::Channel("background queue closed".into()))
            }
        }
    }

    fn check_queue_pressure(&self) {
        let fg_depth = self
            .fg_sender()
            .map(|tx| FOREGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        let bg_depth = self
            .bg_sender()
            .map(|tx| BACKGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        if fg_depth > FOREGROUND_CAPACITY * QUEUE_PRESSURE_NUMERATOR / QUEUE_PRESSURE_DENOMINATOR {
            tracing::warn!(
                depth = fg_depth,
                capacity = FOREGROUND_CAPACITY,
                "foreground queue pressure"
            );
        }
        if bg_depth > BACKGROUND_CAPACITY * QUEUE_PRESSURE_NUMERATOR / QUEUE_PRESSURE_DENOMINATOR {
            tracing::warn!(
                depth = bg_depth,
                capacity = BACKGROUND_CAPACITY,
                "background queue pressure"
            );
        }
    }

    pub fn shutdown(&self) {
        self.shutdown_flag.store(true, Ordering::Release);
        let _ = self
            .fg_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        let _ = self
            .bg_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }

    pub async fn flush_foreground(&self) -> Result<(), AppError> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.enqueue_foreground(MaterializeTask::Barrier(Arc::clone(&notify)))
            .await?;
        notify.notified().await;
        Ok(())
    }

    pub async fn flush_background(&self) -> Result<(), AppError> {
        let notify = Arc::new(tokio::sync::Notify::new());
        self.enqueue_background(MaterializeTask::Barrier(Arc::clone(&notify)))
            .await?;
        notify.notified().await;
        Ok(())
    }

    pub async fn flush(&self) -> Result<(), AppError> {
        self.flush_foreground().await?;
        self.flush_background().await
    }

    pub fn metrics(&self) -> &QueueMetrics {
        &self.metrics
    }

    pub fn status(&self) -> StatusInfo {
        let fg_depth = self
            .fg_sender()
            .map(|tx| FOREGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        let bg_depth = self
            .bg_sender()
            .map(|tx| BACKGROUND_CAPACITY - tx.capacity())
            .unwrap_or(0);
        StatusInfo {
            foreground_queue_depth: fg_depth,
            background_queue_depth: bg_depth,
            total_ops_dispatched: self.metrics.fg_processed.load(Ordering::Relaxed),
            total_background_dispatched: self.metrics.bg_processed.load(Ordering::Relaxed),
            fg_high_water: self.metrics.fg_high_water.load(Ordering::Relaxed),
            bg_high_water: self.metrics.bg_high_water.load(Ordering::Relaxed),
            fg_errors: self.metrics.fg_errors.load(Ordering::Relaxed),
            bg_errors: self.metrics.bg_errors.load(Ordering::Relaxed),
            fg_panics: self.metrics.fg_panics.load(Ordering::Relaxed),
            bg_panics: self.metrics.bg_panics.load(Ordering::Relaxed),
        }
    }
}
