//! #6811 — a split, a merge and a 300-line paste on a vault pulled from a
//! paired peer, beside the same writes on the vault that wrote the blocks, and
//! on a pulled vault the maintenance optimize ran on while it was empty.
//!
//! The third arm is the issue's condition. The maintenance daemon's first tick
//! after boot runs `maintenance::pragma_optimize`; on a new vault `blocks`
//! holds the rows the bootstrap left. Statistics taken then made SQLite drive
//! a create's dense-rank write from a scan of `blocks`, so every create read
//! the whole vault once per sibling, until the job ran again. The optimize now
//! drops statistics that small (`MIN_ANALYZED_ROWS`), and this arm times what
//! that leaves. An edit and a delete rank nothing, which is why the merge was
//! never slow.
//!
//! No peer is needed for it: the last pair of lines times the first batch a new
//! vault takes, without and after that optimize.
//!
//! Each device opens its vault as `e2e_sync_peer` does and runs the sync
//! daemon; the app-side ones also carry what `boot` wires for the app (a round
//! asked for after each commit, the placement that follows a session). The
//! pull is one real session over loopback.
//!
//! Measurement only: it prints `pulled_vault_writes: <write> @ <arm> = median
//! <ms> [<lowest> – <highest>] n=<samples>` and each arm over the app-written
//! one, and bounds nothing. A write that outlasts `WRITE_BUDGET` is reported as
//! unfinished and its arm stops.

use super::common::*;
use agaric_core::ulid::BlockId;
use agaric_lib::db::{DbPools, init_pools};
use agaric_lib::mcp::view_notify::ViewChangeEmitter;
use agaric_lib::spaces::{SPACE_PERSONAL_ULID, SpacePlacementSink};
use agaric_store::peer_refs;
use agaric_sync::foreground::LifecycleHooks;
use agaric_sync::pairing::{PairingSession, ScannedPeerCandidate};
use agaric_sync::sync_daemon::{SyncDaemon, SyncDaemonContext};
use agaric_sync::sync_events::{SyncEvent, SyncEventSink};
use agaric_sync::sync_scheduler::SyncScheduler;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The issue's vault: a page of this many blocks beside a page of filler.
const PAGE_CHILDREN: usize = 1_100;
const FILLER_CHILDREN: usize = 1_900;
/// `MAX_BATCH_BLOCK_IDS` caps one batch at 1000.
const BATCH: usize = 1_000;
const PASTE_LINES: usize = 300;
const SPLITS: usize = 10;
const PASTES: usize = 3;
/// Under the issue's condition one paste takes minutes.
const WRITE_BUDGET: Duration = Duration::from_secs(60);
const WAIT: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(50);

const WRITTEN: &str = "app-written";
const PULLED: &str = "pulled";
const STALE: &str = "pulled, optimized while empty";

/// A session's failures are the daemon's to retry; nothing here reads them.
struct NoEvents;
impl SyncEventSink for NoEvents {
    fn on_sync_event(&self, _event: SyncEvent) {}
}

struct NoViews;
impl ViewChangeEmitter for NoViews {
    fn emit_blocks_changed(&self, _changed_page_ids: Vec<String>) {}
    fn emit_property_changed(&self, _block_id: String, _changed_keys: Vec<String>) {}
}

#[derive(PartialEq)]
enum Role {
    /// The daemon's defaults, a round asked for after each commit, and the
    /// placement that follows a session, as `boot` wires them.
    App,
    /// `e2e_sync_peer`: it dials only when a pairing asks it to.
    Peer,
}

struct Device {
    pools: DbPools,
    id: String,
    mat: Materializer,
    scheduler: Arc<SyncScheduler>,
    pairing: Mutex<Option<PairingSession>>,
    daemon: SyncDaemon,
    lifecycle: LifecycleHooks,
    _dir: TempDir,
}

impl Device {
    async fn open(role: Role) -> Self {
        let dir = TempDir::new().unwrap();
        let vault = dir.path();
        let pools = init_pools(&vault.join("notes.db")).await.unwrap();
        let id = agaric_sync::device::get_or_create_device_id(&vault.join("device-id")).unwrap();
        let endpoint_secret =
            agaric_sync::transport::get_or_create_endpoint_secret(&vault.join("sync-endpoint.key"))
                .unwrap();
        let mat = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
        agaric_lib::spaces::bootstrap_spaces(&pools.write, &id, &mat)
            .await
            .unwrap();
        let (scheduler, event_sink): (_, Arc<dyn SyncEventSink>) = if role == Role::App {
            let scheduler = Arc::new(SyncScheduler::new());
            mat.on_local_commit({
                let scheduler = Arc::clone(&scheduler);
                move || scheduler.notify_local_edit()
            });
            let sink = SpacePlacementSink::new(
                Arc::new(NoEvents),
                pools.write.clone(),
                pools.read.clone(),
                id.clone(),
                mat.clone(),
                Arc::new(NoViews),
            );
            (scheduler, Arc::new(sink))
        } else {
            let scheduler = SyncScheduler::with_intervals(
                Duration::from_millis(250),
                Duration::from_secs(24 * 60 * 60),
            );
            (Arc::new(scheduler), Arc::new(NoEvents))
        };
        let lifecycle = LifecycleHooks::new();
        let daemon = SyncDaemon::start_if_peers_exist_with_lifecycle(SyncDaemonContext {
            pool: pools.write.clone(),
            device_id: id.clone(),
            materializer: Arc::new(mat.clone()),
            scheduler: Arc::clone(&scheduler),
            endpoint_secret,
            event_sink,
            cancel: Arc::new(AtomicBool::new(false)),
            lifecycle: lifecycle.clone(),
            internet_relay: false,
        })
        .await
        .unwrap();
        Self {
            pools,
            id,
            mat,
            scheduler,
            pairing: Mutex::new(None),
            daemon,
            lifecycle,
            _dir: dir,
        }
    }

    /// The maintenance daemon's first tick, on a vault that holds what the
    /// bootstrap left.
    async fn optimize_while_empty(&self) {
        agaric_lib::maintenance::pragma_optimize(&self.pools.write)
            .await
            .unwrap();
        assert!(
            self.has_been_analysed().await,
            "the optimize ran: it analysed the vault"
        );
    }

    /// Whether any `ANALYZE` has run on the vault (it creates `sqlite_stat1`).
    async fn has_been_analysed(&self) -> bool {
        sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1')",
        )
        .fetch_one(&self.pools.read)
        .await
        .unwrap()
    }

    async fn settle(&self) {
        self.mat.flush_foreground().await.unwrap();
        self.mat.flush_background().await.unwrap();
    }

    async fn create_page(&self, title: &str) -> String {
        create_block_inner_with_space(
            &self.pools.write,
            &self.id,
            &self.mat,
            "page".into(),
            title.into(),
            None,
            None,
            &SpaceScope::Active(SpaceId::from_trusted(SPACE_PERSONAL_ULID)),
            None,
        )
        .await
        .unwrap()
        .id
        .into_string()
    }

    /// One `create_blocks_batch` of `count` blocks appended to `parent`, or
    /// `None` when it outlasted [`WRITE_BUDGET`] and was rolled back.
    async fn append(&self, parent: &str, count: usize) -> Option<Duration> {
        let specs = (0..count)
            .map(|i| CreateBlockSpec {
                block_type: "content".into(),
                content: format!("line {i} lorem ipsum"),
                parent_id: Some(BlockId::from_trusted(parent)),
                parent_index: None,
                block_id: None,
                position: None,
                properties: std::collections::HashMap::new(),
                typed_properties: std::collections::HashMap::new(),
            })
            .collect();
        let started = Instant::now();
        tokio::time::timeout(
            WRITE_BUDGET,
            create_blocks_batch_inner(&self.pools.write, &self.id, &self.mat, specs),
        )
        .await
        .ok()
        .map(|created| {
            created.expect("create_blocks_batch");
            started.elapsed()
        })
    }

    /// Write the issue's vault. Returns the measured page and how long its
    /// first batch took.
    async fn write_vault(&self) -> (String, Duration) {
        let page = self.create_page("measured").await;
        let first_batch = self.append(&page, BATCH).await.expect("the first batch");
        self.append(&page, PAGE_CHILDREN - BATCH)
            .await
            .expect("the page's last blocks");
        let filler = self.create_page("filler").await;
        let mut left = FILLER_CHILDREN;
        while left > 0 {
            let take = left.min(BATCH);
            self.append(&filler, take).await.expect("filler");
            left -= take;
        }
        self.settle().await;
        (page, first_batch)
    }

    async fn live_children(&self, page: &str) -> usize {
        let children: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blocks WHERE parent_id = ? AND deleted_at IS NULL",
        )
        .bind(page)
        .fetch_one(&self.pools.read)
        .await
        .unwrap();
        usize::try_from(children).unwrap()
    }

    /// Enter in the middle of the text of the page's middle block, then
    /// Backspace at the start of the block it split off.
    async fn split_then_merge(&self, page: &str) -> (Duration, Duration) {
        let middle = i64::try_from(self.live_children(page).await / 2).unwrap();
        let (id, content): (String, String) = sqlx::query_as(
            "SELECT id, content FROM blocks WHERE parent_id = ? AND deleted_at IS NULL \
             ORDER BY position, id LIMIT 1 OFFSET ?",
        )
        .bind(page)
        .bind(middle)
        .fetch_one(&self.pools.read)
        .await
        .unwrap();
        let (before, after) = content
            .split_at_checked(content.len() / 2)
            .expect("the seeded text is ASCII");
        let request = SplitBlockRequest {
            block_id: BlockId::from_trusted(&id),
            before: before.to_owned(),
            after: after.to_owned(),
            new_block_id: BlockId::new(),
            base_text: Some(content.clone()),
        };
        let started = Instant::now();
        let split = split_block_inner(&self.pools.write, &self.id, &self.mat, request)
            .await
            .expect("split_block");
        let split_took = started.elapsed();

        let request = MergeBlocksRequest {
            block_id: split.created.id,
            into_id: split.block.id,
            base_text: Some(before.to_owned()),
            merged_text: content.clone(),
        };
        let started = Instant::now();
        merge_blocks_inner(&self.pools.write, &self.id, &self.mat, request)
            .await
            .expect("merge_blocks");
        (split_took, started.elapsed())
    }

    fn shutdown(&self) {
        self.daemon.shutdown();
        self.mat.shutdown();
    }
}

async fn wait_for(what: &str, mut done: impl AsyncFnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done().await {
        assert!(Instant::now() < deadline, "waited {WAIT:?} for {what}");
        tokio::time::sleep(POLL).await;
    }
}

/// `host` shows a pairing QR and `joiner` scans it, as the app and
/// `e2e_sync_peer` do in the real-backend lane; `host` is then told where
/// `joiner` listens, as the lane types it into the app.
async fn pair(host: &Device, joiner: &Device) {
    let info =
        start_pairing_armed_inner(&host.pools.write, &host.pairing, &host.scheduler, &host.id)
            .await
            .unwrap();
    let advert = host
        .scheduler
        .await_local_endpoint(WAIT)
        .await
        .expect("the host's daemon binds its endpoint");
    confirm_pairing_inner(
        &joiner.pools.write,
        &joiner.pairing,
        &joiner.scheduler,
        info.passphrase,
        Some(ScannedPeerCandidate {
            device_id: host.id.clone(),
            endpoint_id: advert.endpoint_id,
            addrs: advert.addrs.iter().map(ToString::to_string).collect(),
        }),
    )
    .await
    .unwrap();
    wait_for("the joiner's first pull from the host", async || {
        peer_refs::get_peer_ref(&joiner.pools.read, &host.id)
            .await
            .unwrap()
            .is_some_and(|row| row.endpoint_id.is_some())
    })
    .await;
    wait_for("the host's row for the joiner", async || {
        peer_refs::get_peer_ref(&host.pools.read, &joiner.id)
            .await
            .unwrap()
            .is_some()
    })
    .await;
    let address = joiner
        .scheduler
        .await_local_endpoint(WAIT)
        .await
        .and_then(|advert| advert.addrs.into_iter().find(std::net::SocketAddr::is_ipv4))
        .expect("the joiner's daemon binds an IPv4 address");
    set_peer_address_inner(&host.pools.write, joiner.id.clone(), address.to_string())
        .await
        .unwrap();
    // No periodic round until `pull`: that pull is then the vault's one.
    host.lifecycle.mark_backgrounded();
}

/// A press on Sync on `app`. Returns how long it took `app` to hold `block`,
/// the last one `peer` wrote, with the session over and the materializer idle.
async fn pull(app: &Device, peer: &Device, block: &str) -> Duration {
    let started = Instant::now();
    app.lifecycle.mark_foreground();
    let mut pressed: Option<Instant> = None;
    wait_for("the pull to bring the peer's last block", async || {
        let held: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM blocks WHERE id = ?)")
            .bind(block)
            .fetch_one(&app.pools.read)
            .await
            .unwrap();
        // Pressed again only once a round has had time to start: each press
        // restarts the scheduler's debounce.
        let due = pressed.is_none_or(|at| at.elapsed() > Duration::from_secs(2));
        if !held && due && !app.scheduler.has_active_session() {
            // Refused while a session with the peer runs, which is a pull too.
            let _ = start_sync_inner(
                &app.pools.read,
                &app.scheduler,
                &app.id,
                peer.id.clone(),
                true,
            )
            .await;
            pressed = Some(Instant::now());
        }
        held
    })
    .await;
    wait_for("the session to end", async || {
        !app.scheduler.has_active_session()
    })
    .await;
    app.settle().await;
    started.elapsed()
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

fn median(mut values: Vec<f64>) -> (f64, f64, f64) {
    values.sort_by(f64::total_cmp);
    (
        values[values.len() / 2],
        values[0],
        values[values.len() - 1],
    )
}

/// One arm's timings of one write, and the line that reports them.
fn report(write: &str, arm: &str, samples: &[Duration], unfinished: bool) {
    if !samples.is_empty() {
        let (median, min, max) = median(samples.iter().copied().map(millis).collect());
        println!(
            "pulled_vault_writes: {write} @ {arm} = median {median:.0} ms [{min:.0} – {max:.0}] n={}",
            samples.len()
        );
    }
    if unfinished {
        println!("pulled_vault_writes: {write} @ {arm} = unfinished after {WRITE_BUDGET:?}");
    }
}

/// `arm` over the app-written arm, sample by sample.
fn report_ratio(write: &str, arm: &str, samples: &[Duration], written: &[Duration]) {
    let ratios: Vec<f64> = samples
        .iter()
        .zip(written)
        .map(|(sample, written)| sample.as_secs_f64() / written.as_secs_f64())
        .collect();
    if !ratios.is_empty() {
        let (median, min, max) = median(ratios);
        println!(
            "pulled_vault_writes: {write} {arm} / {WRITTEN} = median {median:.2} [{min:.2} – {max:.2}]"
        );
    }
}

#[derive(Default)]
struct Timings {
    split: Vec<Duration>,
    merge: Vec<Duration>,
    paste: Vec<Duration>,
    paste_unfinished: bool,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "measurement: minutes in a debug build"]
async fn writes_on_a_pulled_vault_6811() {
    let written = Device::open(Role::App).await;
    let pulled = Device::open(Role::App).await;
    let stale = Device::open(Role::App).await;
    let new_stale = Device::open(Role::App).await;
    let peer = Device::open(Role::Peer).await;
    stale.optimize_while_empty().await;
    new_stale.optimize_while_empty().await;

    // The first batch a new vault takes, with no peer anywhere.
    let new_stale_page = new_stale.create_page("measured").await;
    let stale_first_batch = new_stale.append(&new_stale_page, BATCH).await;
    let (written_page, written_first_batch) = written.write_vault().await;

    pair(&pulled, &peer).await;
    pair(&stale, &peer).await;
    let (page, _) = peer.write_vault().await;
    let last: String = sqlx::query_scalar(
        "SELECT id FROM blocks WHERE parent_id = ? ORDER BY position DESC, id DESC LIMIT 1",
    )
    .bind(&page)
    .fetch_one(&peer.pools.read)
    .await
    .unwrap();
    let pulled_in = pull(&pulled, &peer, &last).await;
    let stale_in = pull(&stale, &peer, &last).await;
    // The lane stopped or froze its peer too. Left running, it would carry one
    // arm's writes to the other.
    peer.daemon.shutdown();

    let arms = [
        (WRITTEN, &written, written_page.as_str()),
        (PULLED, &pulled, page.as_str()),
        (STALE, &stale, page.as_str()),
    ];
    // Shape probe: every arm holds the page, and only the third arm was
    // optimized.
    for (arm, device, page) in arms {
        assert_eq!(
            device.live_children(page).await,
            PAGE_CHILDREN,
            "{arm}: the page holds every block written to it"
        );
        assert_eq!(
            device.has_been_analysed().await,
            arm == STALE,
            "{arm}: optimized only where the arm asks for it"
        );
    }

    let mut timings: [Timings; 3] = Default::default();
    for _round in 0..SPLITS {
        for ((_, device, page), timings) in arms.iter().zip(&mut timings) {
            let (split, merge) = device.split_then_merge(page).await;
            timings.split.push(split);
            timings.merge.push(merge);
        }
    }
    for _round in 0..PASTES {
        for ((_, device, page), timings) in arms.iter().zip(&mut timings) {
            if timings.paste_unfinished {
                continue;
            }
            match device.append(page, PASTE_LINES).await {
                Some(paste) => timings.paste.push(paste),
                None => timings.paste_unfinished = true,
            }
        }
    }

    for ((arm, _, _), timings) in arms.iter().zip(&timings) {
        report("split", arm, &timings.split, false);
        report("merge", arm, &timings.merge, false);
        report("paste", arm, &timings.paste, timings.paste_unfinished);
    }
    for ((arm, _, _), arm_timings) in arms.iter().zip(&timings).skip(1) {
        report_ratio("split", arm, &arm_timings.split, &timings[0].split);
        report_ratio("merge", arm, &arm_timings.merge, &timings[0].merge);
        report_ratio("paste", arm, &arm_timings.paste, &timings[0].paste);
    }
    println!(
        "pulled_vault_writes: first pull @ {PULLED} = {:.0} ms",
        millis(pulled_in)
    );
    println!(
        "pulled_vault_writes: first pull @ {STALE} = {:.0} ms",
        millis(stale_in)
    );
    report("first batch", "new vault", &[written_first_batch], false);
    report(
        "first batch",
        "new vault, optimized while empty",
        stale_first_batch.as_slice(),
        stale_first_batch.is_none(),
    );

    // Durable growth, after the timed loops: each split was merged back, and
    // every paste that finished is on the page.
    for ((arm, device, page), timings) in arms.iter().zip(&timings) {
        assert_eq!(
            device.live_children(page).await,
            PAGE_CHILDREN + PASTE_LINES * timings.paste.len(),
            "{arm}: the page grew by its finished pastes"
        );
    }

    for device in [&written, &pulled, &stale, &new_stale, &peer] {
        device.shutdown();
    }
}
