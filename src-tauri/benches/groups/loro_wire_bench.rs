//! #5761 — a Loro payload's trip across the sync wire, at 100K blocks.
//!
//! The responder writes one `SyncMessage::LoroSync` with
//! `transport::session::send_sync_message` and the initiator reads it with
//! `recv_sync_message`, over a real loopback QUIC pair. Two payloads:
//!
//! - `snapshot_send_receive` — a space's full snapshot of `BLOCKS` blocks (a
//!   page per 100 blocks), what pairing and a snapshot catch-up ship;
//! - `update_send_receive` — the delta of one edit to that space, what a
//!   steady-state sync ships.
//!
//! Each case also prints `loro_wire_bench: <case> peak heap @ <BLOCKS> = …`: the
//! most heap the two sides held at once, above where they started, over one
//! untimed send and receive, read by the counting allocator below. A realloc
//! counts as holding both blocks for an instant, the cost of a move.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::{Duration, Instant};

use agaric_engine::loro::engine::LoroEngine;
use agaric_store::space::SpaceId;
use agaric_sync::sync_protocol::SyncMessage;
use agaric_sync::sync_protocol::loro_sync_types::{LORO_SYNC_PROTOCOL_VERSION, LoroSyncMessage};
use agaric_sync::transport::session::{recv_sync_message, send_sync_message};
use agaric_sync::transport::test_support::{QuicPair, quic_pair};
use criterion::{BenchmarkId, Criterion, SamplingMode, criterion_group};
use tokio::runtime::Runtime;

const BENCH_DEVICE: &str = "01LOROWIREBENCHDEVICE00001";
const SPACE: &str = "01LOROWIREBENCHSPACE000001";
/// One page per this many blocks; the rest are its children.
const BLOCKS_PER_PAGE: usize = 100;
const BLOCKS: usize = 100_000;
/// Each snapshot sample moves the whole space, so keep the count low.
const SAMPLE_SIZE: usize = 10;

/// The binary's one global allocator. It forwards to `System` and, while
/// `TRACKING` is set, keeps the live and peak byte counts; every other group
/// in the binary pays one relaxed load per allocation.
struct CountingAlloc;

static TRACKING: AtomicBool = AtomicBool::new(false);
static LIVE: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);

fn grew(bytes: usize) {
    if TRACKING.load(Ordering::Relaxed) {
        let live = LIVE.fetch_add(as_isize(bytes), Ordering::Relaxed) + as_isize(bytes);
        PEAK.fetch_max(live, Ordering::Relaxed);
    }
}

fn shrank(bytes: usize) {
    if TRACKING.load(Ordering::Relaxed) {
        LIVE.fetch_sub(as_isize(bytes), Ordering::Relaxed);
    }
}

fn as_isize(bytes: usize) -> isize {
    isize::try_from(bytes).unwrap_or(isize::MAX)
}

// SAFETY: every call forwards to `System` with the caller's own arguments.
#[allow(unsafe_code)] // `GlobalAlloc` is an unsafe trait.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        shrank(layout.size());
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        grew(new_size);
        shrank(layout.size());
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc;

fn block_id(i: usize) -> String {
    format!("01LOROWIREBENCH{i:011}")
}

/// A snapshot of `n` blocks, and the update one edit to it exports.
fn seed_payloads(n: usize) -> (LoroSyncMessage, LoroSyncMessage) {
    let mut engine = LoroEngine::with_peer_id(BENCH_DEVICE).expect("engine");
    let ids: Vec<String> = (0..n).map(block_id).collect();
    for (i, id) in ids.iter().enumerate() {
        let slot = i % BLOCKS_PER_PAGE;
        if slot == 0 {
            engine
                .apply_create_block_at(id, "page", "page", None, i / BLOCKS_PER_PAGE)
                .expect("seed page");
        } else {
            let page = &ids[i - slot];
            engine
                .apply_create_block_at(id, "content", "block content", Some(page), slot - 1)
                .expect("seed block");
        }
    }
    let space_id = SpaceId::from_trusted(SPACE);
    let snapshot = LoroSyncMessage::Snapshot {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id: space_id.clone(),
        bytes: engine.export_snapshot().expect("export snapshot"),
    };
    let from_vv = engine.version_vector();
    engine
        .apply_edit_content(&ids[n / 2], 0, 0, "edited ")
        .expect("edit one block");
    let update = LoroSyncMessage::Update {
        protocol_version: LORO_SYNC_PROTOCOL_VERSION,
        space_id,
        bytes: engine.export_update_since(&from_vv).expect("export update"),
        from_vv,
    };
    (snapshot, update)
}

/// The responder sends `msg`; the initiator reads it.
async fn send_and_receive(pair: &mut QuicPair, msg: &SyncMessage) -> SyncMessage {
    let (sent, received) = tokio::join!(
        send_sync_message(&mut pair.server.send, msg),
        recv_sync_message(&mut pair.client.recv),
    );
    sent.expect("send");
    received.expect("receive")
}

/// The most heap held at once during one send and receive of `msg`.
fn peak_heap(rt: &Runtime, pair: &mut QuicPair, msg: &SyncMessage) -> isize {
    LIVE.store(0, Ordering::Relaxed);
    PEAK.store(0, Ordering::Relaxed);
    TRACKING.store(true, Ordering::Relaxed);
    let received = rt.block_on(send_and_receive(pair, msg));
    TRACKING.store(false, Ordering::Relaxed);
    drop(received);
    PEAK.load(Ordering::Relaxed)
}

fn payload_len(msg: &LoroSyncMessage) -> usize {
    match msg {
        LoroSyncMessage::Snapshot { bytes, .. } | LoroSyncMessage::Update { bytes, .. } => {
            bytes.len()
        }
    }
}

fn bench_case(
    c: &mut Criterion,
    rt: &Runtime,
    pair: &mut QuicPair,
    case: &str,
    payload: LoroSyncMessage,
) {
    let bytes = payload_len(&payload);
    let msg = SyncMessage::LoroSync {
        msg: payload,
        is_last: true,
    };
    // Shape probe: what arrives is what was sent.
    let received = rt.block_on(send_and_receive(pair, &msg));
    assert!(
        received == msg,
        "{case}: the received message differs from the sent one"
    );
    drop(received);
    let peak = peak_heap(rt, pair, &msg);
    println!("loro_wire_bench: {case} peak heap @ {BLOCKS} = {peak} bytes (payload {bytes} bytes)");

    let mut group = c.benchmark_group("loro_wire");
    group.sample_size(SAMPLE_SIZE);
    group.sampling_mode(SamplingMode::Flat);
    group.bench_function(BenchmarkId::new(case, BLOCKS), |b| {
        b.iter_custom(|iters| {
            rt.block_on(async {
                let mut total = Duration::ZERO;
                for _ in 0..iters {
                    let start = Instant::now();
                    std::hint::black_box(send_and_receive(pair, &msg).await);
                    total += start.elapsed();
                }
                total
            })
        });
    });
    group.finish();
}

fn bench_loro_wire(c: &mut Criterion) {
    let rt = Runtime::new().expect("tokio runtime");
    let (snapshot, update) = seed_payloads(BLOCKS);
    let mut pair = rt.block_on(quic_pair());
    bench_case(c, &rt, &mut pair, "snapshot_send_receive", snapshot);
    bench_case(c, &rt, &mut pair, "update_send_receive", update);
}

criterion_group!(benches, bench_loro_wire);
