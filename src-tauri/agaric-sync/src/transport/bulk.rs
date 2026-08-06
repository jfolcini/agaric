//! Bulk byte transfer over an already-open iroh QUIC bi-stream (#78, plan #3464).
//!
//! # What this replaces, and what disappears with it
//!
//! `SyncConnection::{send,receive}_binary_streaming[_with_progress]` moved
//! attachments and compressed snapshots across the WebSocket transport by cutting
//! the payload into `BINARY_FRAME_CHUNK_SIZE` binary frames, counting frames on
//! the way in, and reassembling. Two of that API's four parameters — `chunk_size`
//! on the send side, the per-frame accounting on both — exist only because a
//! WebSocket carries *messages* and `SyncConnection` caps a message at 10 MB. A
//! file larger than the cap had to be split, so the receiver had to be told how
//! the split worked.
//!
//! A QUIC stream has no message boundary and no length ceiling. It is a
//! reliable, ordered, flow-controlled byte stream, and the flow-control window
//! is exactly the backpressure the chunk loop was hand-rolling. So the chunking
//! layer does not come along: [`send_bulk`] writes the payload as one
//! uninterrupted run of bytes and [`recv_bulk`] reads it as one.
//!
//! # The copy buffer is a progress knob, not a frame size
//!
//! Both directions still copy through a fixed-size buffer, [`BULK_COPY_BYTES`],
//! but nothing on the wire can observe it: a receiver using a different buffer
//! size reads exactly the same bytes. It survives for two reasons, neither of
//! them framing.
//!
//! It bounds memory — the whole point of the streaming API. Peak heap is one
//! buffer regardless of `total_size`, which is what lets a multi-gigabyte
//! attachment move without a multi-gigabyte `Vec<u8>`.
//!
//! And it sets the granularity of `on_progress`. Its value is
//! [`BINARY_FRAME_CHUNK_SIZE`] deliberately: under the old transport the UI
//! ticked once per 5 MB frame, so reusing the constant keeps the shipped tick
//! cadence rather than inventing a new one. Widening it later is a UI-smoothness
//! decision that costs memory; it is not a protocol change and needs no
//! agreement from the peer.
//!
//! # `recv_bulk` bounds before it trusts
//!
//! `total_size` is a number the peer said. The threat model is the user's own
//! paired devices, so "attacker" means "corruption or version skew" — but a
//! wrong number must not become a resource commitment, which is the same
//! discipline [`session`](super::session) applies to an oversized length prefix.
//! [`recv_bulk`] therefore rejects `total_size > max_size` **before** it reads or
//! allocates anything, and the cap is the caller's, because only the caller knows
//! what a plausible payload is: `MAX_SNAPSHOT_SIZE` for a snapshot offer, and for
//! an attachment the DB-authoritative `attachments.size_bytes` that `sync_files`
//! already cross-checks the offer against.
//!
//! The cap bounds what the caller *stores*, not what this module allocates.
//! Nothing here is sized from `total_size`: the copy buffer is
//! [`BULK_COPY_BYTES`] whether the transfer is 1 KB or 8 GB, and no read is ever
//! issued for more than one buffer. That is the property that makes an
//! attachment cap of "whatever this file is" safe to pass.
//!
//! # Exactly `total_size` bytes, in both directions
//!
//! A peer that stops early is an error, never a silently truncated file — the
//! receiver has to distinguish "the stream ended" from "the payload ended", and
//! under QUIC the stream itself no longer tells it which. A peer that keeps
//! sending cannot overrun the writer either, and not by a check after the fact:
//! each read is sized `min(one buffer, bytes still owed)`, so surplus bytes are
//! never requested, never copied, and left in the stream for the session to
//! choke on as the protocol violation they are.
//!
//! # The zero-byte payload loses its wire representation
//!
//! The old API sent one empty binary frame for `total_size == 0`, purely so the
//! receiver's per-frame loop had something to terminate on. With no frames there
//! is nothing to send: an empty payload puts **zero bytes** on the wire. The
//! `on_progress(0)` tick is kept, because callers use it to paint a 0 % state.
//! Note for the cutover: this is not a difference two peers can straddle. It is
//! moot while both ends of a transfer are either WebSocket or QUIC — the
//! transport is chosen per connection, and a peer speaking the old transport
//! never reaches this code. But it means the two paths are not interchangeable
//! *within* one session, so a bulk phase must not be moved across transports
//! independently of the framed messages around it.
//!
//! # It does not open, finish, or close the stream
//!
//! Both functions borrow a stream the session already opened and leave it open.
//! The bulk payload is a phase *inside* a session that continues with framed
//! [`SyncMessage`](crate::sync_protocol::SyncMessage)s on the same bi-stream, so
//! finishing here would end the session; opening a second stream would change
//! protocol sequencing, which this slice deliberately does not touch.

use iroh::endpoint::{RecvStream, SendStream};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use agaric_core::error::AppError;

use crate::sync_constants::BINARY_FRAME_CHUNK_SIZE;

/// Size of the fixed copy buffer, and therefore the granularity of the
/// `on_progress` callback.
///
/// Not a frame size — see the module docs. It is [`BINARY_FRAME_CHUNK_SIZE`] so
/// that progress ticks land at the same cadence they did under the WebSocket
/// transport, where this constant *was* the frame size.
pub const BULK_COPY_BYTES: usize = BINARY_FRAME_CHUNK_SIZE;

fn bulk_err(msg: impl Into<String>) -> AppError {
    AppError::InvalidOperation(format!("[transport::bulk] {}", msg.into()))
}

/// Which end of a copy is the untrusted one, so a failure names the right party.
///
/// The two directions run the same loop but fail for opposite reasons, and the
/// distinction is operationally load-bearing: "reader exhausted" means a local
/// file shrank between the size we advertised and the send (the sender's own
/// bug or a concurrent edit), while "peer stopped sending" means the remote
/// device went away mid-transfer. Collapsing them into one message would send
/// whoever reads the log looking at the wrong machine.
#[derive(Clone, Copy)]
enum Origin {
    /// The local [`AsyncRead`] handed to [`send_bulk`]; the peer is downstream.
    LocalReader,
    /// The peer's half of the bi-stream; the local writer is downstream.
    Peer,
}

impl Origin {
    /// The source went to EOF with `moved` of `total_size` bytes delivered.
    fn exhausted(self, moved: u64, total_size: u64) -> AppError {
        match self {
            Self::LocalReader => bulk_err(format!(
                "bulk send: reader exhausted at {moved} bytes, expected {total_size}"
            )),
            Self::Peer => bulk_err(format!(
                "bulk receive: peer stopped sending at {moved} bytes, expected {total_size}"
            )),
        }
    }

    fn read_failed(self, e: &std::io::Error) -> AppError {
        match self {
            Self::LocalReader => bulk_err(format!("read for bulk send: {e}")),
            Self::Peer => bulk_err(format!("read for bulk receive: {e}")),
        }
    }

    fn write_failed(self, e: &std::io::Error) -> AppError {
        match self {
            Self::LocalReader => bulk_err(format!("write for bulk send: {e}")),
            Self::Peer => bulk_err(format!("write for bulk receive: {e}")),
        }
    }
}

/// Copy exactly `total_size` bytes from `reader` to `writer`, ticking
/// `on_progress` with the cumulative total after each buffer lands.
///
/// Generic over both ends on purpose. [`send_bulk`] and [`recv_bulk`] take the
/// concrete QUIC stream types, which makes every property below testable only
/// against a live endpoint — and "the writer never receives more than
/// `total_size` bytes" is not a property a live peer will volunteer to
/// demonstrate. Against a trait it is one assertion. This mirrors why
/// [`session::read_body`](super::session) is generic over its reader.
///
/// # Errors
///
/// If either end fails, or if `reader` reaches EOF before `total_size` bytes
/// have been copied.
async fn copy_exact<R, W, F>(
    mut reader: R,
    writer: &mut W,
    total_size: u64,
    origin: Origin,
    mut on_progress: F,
) -> Result<(), AppError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64),
{
    if total_size == 0 {
        // No frames means nothing to send for an empty payload — the old
        // transport's empty sentinel frame has no counterpart here. The tick
        // survives because callers paint a 0 % state from it.
        on_progress(0);
        return Ok(());
    }

    // The one allocation, and it is the same size for every transfer.
    let mut buf = vec![0u8; BULK_COPY_BYTES];
    let mut moved: u64 = 0;
    while moved < total_size {
        // Never ask for more than is still owed. This is what makes overrun
        // structurally impossible rather than merely detected: a peer with more
        // bytes to give is never given a buffer to put them in.
        //
        // Sized from `buf.len()` rather than from `BULK_COPY_BYTES` directly,
        // which is not a stylistic choice. It is what makes the buffer's size
        // observable: a regression that sized the allocation from `total_size`
        // would keep passing a constant-bounded read, and no reader could tell.
        // Deriving the request from the buffer that receives it turns an
        // over-sized allocation into an over-sized request, which
        // `the_copy_buffer_does_not_grow_with_total_size` can see.
        let want = remaining_this_pass(total_size - moved, buf.len());

        // Fill the buffer completely before writing. A single `read` may return
        // short — from a QUIC stream that is the common case, not the edge one —
        // and ticking progress per partial read would turn the callback's
        // documented per-buffer cadence into an unbounded event rate on a path
        // whose callers emit a Tauri event per tick.
        let mut filled = 0usize;
        while filled < want {
            let n = reader
                .read(&mut buf[filled..want])
                .await
                .map_err(|e| origin.read_failed(&e))?;
            if n == 0 {
                // EOF with bytes still owed. Reporting the partially-filled
                // buffer in the count (rather than `moved`) says how far the
                // source actually got, which is the number that identifies a
                // truncated file.
                let short = moved.saturating_add(as_u64(filled));
                return Err(origin.exhausted(short, total_size));
            }
            filled += n;
        }

        writer
            .write_all(&buf[..filled])
            .await
            .map_err(|e| origin.write_failed(&e))?;
        moved += as_u64(filled);
        on_progress(moved);
    }

    // The old API never flushed: its writer contract was one `write_all` per
    // frame with the caller committing afterwards. Flushing here costs nothing
    // for the writers in use today (a `tokio::fs::File`, a QUIC `SendStream`)
    // and makes "exactly `total_size` bytes reached the writer" true for a
    // buffered one too, so a future caller wrapping a `BufWriter` does not lose
    // the tail. It is a flush, not a shutdown: the stream stays open.
    writer.flush().await.map_err(|e| origin.write_failed(&e))?;
    Ok(())
}

/// How many bytes this pass may request: the smaller of the copy buffer and
/// what is still owed.
///
/// `buffer_len` is passed in rather than read from [`BULK_COPY_BYTES`] so that
/// the request length is a fact about the buffer that will receive the bytes —
/// see the call site.
///
/// Split out so the `u64`/`usize` narrowing has one home. Both conversions are
/// infallible by construction — the result is bounded by `buffer_len`, which is
/// already a `usize` — but they are written as conversions rather than casts so
/// that a future change to either type fails loudly instead of truncating a
/// length silently.
fn remaining_this_pass(owed: u64, buffer_len: usize) -> usize {
    let buffer = u64::try_from(buffer_len).unwrap_or(u64::MAX);
    usize::try_from(owed.min(buffer)).unwrap_or(buffer_len)
}

/// Widen a buffer length to the transfer counter's type. Infallible: a `usize`
/// that fits in memory fits in a `u64` on every target we build for.
fn as_u64(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

/// Stream exactly `total_size` bytes from `reader` onto an already-open
/// bi-stream, invoking `on_progress` with the cumulative byte count.
///
/// `total_size` is the caller's contract, as it was under the old transport: it
/// must match the reader's true length (`metadata().len()` for a
/// [`tokio::fs::File`]). A reader that ends early is an error, because the peer
/// has already been told how many bytes to expect and cannot be told otherwise
/// on a stream with no framing.
///
/// Peak heap is one [`BULK_COPY_BYTES`] buffer regardless of `total_size`.
///
/// The stream is left open — see the module docs.
///
/// # Errors
///
/// If `reader` fails or reaches EOF before `total_size` bytes, or if the stream
/// is closed or reset by the peer.
pub async fn send_bulk<R, F>(
    send: &mut SendStream,
    reader: R,
    total_size: u64,
    on_progress: F,
) -> Result<(), AppError>
where
    R: AsyncRead + Unpin,
    F: FnMut(u64),
{
    // `SendStream` implements `tokio::io::AsyncWrite` (quinn 0.11
    // `send_stream.rs`, outside the `futures-io` cfg) and iroh re-exports the
    // type, so the generic core drives the real stream with no adapter.
    copy_exact(reader, send, total_size, Origin::LocalReader, on_progress).await
}

/// Read exactly `total_size` bytes from an already-open bi-stream into `writer`,
/// invoking `on_progress` with the cumulative byte count.
///
/// `total_size` came from the peer, so it is bounded by the caller's `max_size`
/// **before** the first read — see the module docs for why the cap belongs to
/// the caller and why nothing here is sized from `total_size` regardless.
///
/// Peak heap is one [`BULK_COPY_BYTES`] buffer, so `max_size` bounds only what
/// the caller is about to store.
///
/// # Errors
///
/// If `total_size` exceeds `max_size`, if the peer stops sending before
/// `total_size` bytes arrive, or if `writer` fails.
pub async fn recv_bulk<W, F>(
    recv: &mut RecvStream,
    writer: &mut W,
    total_size: u64,
    max_size: u64,
    on_progress: F,
) -> Result<(), AppError>
where
    W: AsyncWrite + Unpin,
    F: FnMut(u64),
{
    // `RecvStream` implements `tokio::io::AsyncRead` (quinn 0.11
    // `recv_stream.rs`, outside the `futures-io` cfg).
    recv_bulk_from(recv, writer, total_size, max_size, on_progress).await
}

/// The body of [`recv_bulk`], generic over the source.
///
/// The bound check lives here rather than in the public wrapper so that "refused
/// before any read" is assertable against a reader that records what it was
/// asked for. Against a real [`RecvStream`] the only observable is that the call
/// returns without the peer having sent anything, which a test can only express
/// as a timeout — and a timeout cannot tell "checked first" apart from "read
/// something that happened to be there".
async fn recv_bulk_from<R, W, F>(
    recv: &mut R,
    writer: &mut W,
    total_size: u64,
    max_size: u64,
    on_progress: F,
) -> Result<(), AppError>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64),
{
    // Bound BEFORE reading. Deliberately worded like `session`'s prefix cap so
    // one grep finds both refusals.
    if total_size > max_size {
        return Err(bulk_err(format!(
            "peer announced a {total_size}-byte payload (max {max_size}); refusing to receive"
        )));
    }
    copy_exact(recv, writer, total_size, Origin::Peer, on_progress).await
}

#[cfg(test)]
mod tests {
    //! # What these prove, and how each was forced red
    //!
    //! The properties split cleanly in two, and so do the tests.
    //!
    //! Three tests run over two real LAN-only iroh endpoints, because "the copy
    //! survives the transport it was written for" is not a claim a fake can
    //! make: they cover the multi-buffer path, the sub-buffer path, and the
    //! empty payload that no longer has a wire representation.
    //!
    //! The rest drive [`copy_exact`] and [`recv_bulk_from`] through fakes, for
    //! properties a cooperating peer will not demonstrate on request: a peer
    //! that overruns, a peer that truncates, a cap that must fire before the
    //! first read, and a buffer that must not grow with an 8 GB announcement.
    //!
    //! Two traps shaped the fakes. A reader that ignores its buffer, or an
    //! assertion on a length that came from anywhere but bytes actually copied,
    //! yields a test that passes with the read deleted — so
    //! [`PatternReader`] writes a position-dependent pattern and
    //! [`RecordingWriter`] accumulates only what it was handed. And the pattern
    //! period is 251, not 256: a power-of-two period aliases with
    //! [`BULK_COPY_BYTES`]-sized steps, making a duplicated or transposed buffer
    //! indistinguishable from the right one.

    use std::io;
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;

    use iroh::endpoint::Builder;
    use iroh_dns::dns::DnsResolver;
    use tokio::io::ReadBuf;

    use super::*;
    use crate::transport::endpoint::{RecordingResolver, lan_only};
    // The canonical constant, not a copy of its value. A local copy would let a
    // bump to `service::SYNC_ALPN` leave every test here green: both ends of
    // each test would agree with each other while disagreeing with production.
    use crate::transport::service::SYNC_ALPN;

    /// Whole-transfer budget for the network tests. An 11 MB loopback transfer
    /// measures in tens of milliseconds; 30 s is a hang detector, not a
    /// performance bound, so a deadlocked copy fails the test instead of
    /// wedging CI.
    const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);

    fn lan_builder() -> Builder {
        lan_only(
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)),
            8,
            DnsResolver::custom(RecordingResolver::new()),
        )
        .expect("a loopback /8 is a valid LAN bind")
    }

    /// The synthetic stream every test moves: byte `i` is `i % 251`.
    ///
    /// 251 is prime, so it shares no factor with [`BULK_COPY_BYTES`] and every
    /// offset in a multi-buffer transfer gets its own phase. Under `% 256` a
    /// buffer written twice, or two buffers swapped, would compare equal.
    fn stream_byte(offset: usize) -> u8 {
        u8::try_from(offset % 251).expect("a value below 251 fits in u8")
    }

    fn synthetic(len: usize) -> Vec<u8> {
        (0..len).map(stream_byte).collect()
    }

    /// Assert `got` is exactly the first `len` bytes of the synthetic stream,
    /// reporting the first divergence rather than dumping megabytes.
    fn assert_is_the_delivered_stream(got: &[u8], len: usize) {
        assert_eq!(
            got.len(),
            len,
            "the copy must move exactly total_size bytes"
        );
        let expected = synthetic(len);
        let divergence = got.iter().zip(&expected).position(|(a, b)| a != b);
        assert!(
            divergence.is_none(),
            "the copy diverges from the delivered stream at offset {:?}: got {:?}, want {:?}",
            divergence,
            divergence.map(|i| got[i]),
            divergence.map(|i| expected[i]),
        );
    }

    /// An [`AsyncRead`] that hands out the synthetic stream in bounded slices
    /// and records every request.
    ///
    /// Three things here are load-bearing. It **writes** the position-dependent
    /// pattern, so the bytes that reach the writer encode where in the stream
    /// they came from. It **records** the length of every buffer it was handed,
    /// so "never asked for more than it was owed" is assertable rather than
    /// inferred. And `max_per_read` lets it return **short**, which is how a
    /// real QUIC stream behaves and the only way the inner fill loop is
    /// exercised at all.
    struct PatternReader {
        /// Total bytes it will produce before reporting EOF. Set below
        /// `total_size` to model a truncating peer, above it to model an
        /// overrunning one.
        available: usize,
        /// How far into the synthetic stream it has already gone.
        delivered: usize,
        /// Ceiling on a single `poll_read`, to force short reads.
        max_per_read: usize,
        /// The length of every buffer it was handed, in order.
        requests: Vec<usize>,
    }

    impl PatternReader {
        fn new(available: usize, max_per_read: usize) -> Self {
            Self {
                available,
                delivered: 0,
                max_per_read,
                requests: Vec::new(),
            }
        }
    }

    impl AsyncRead for PatternReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let me = &mut *self;
            // Recorded before the EOF check, so a request that should never
            // have been issued is still visible after the failure.
            me.requests.push(buf.remaining());
            let owed = me.available.saturating_sub(me.delivered);
            if owed == 0 {
                // Filling nothing is how `AsyncRead` spells EOF.
                return Poll::Ready(Ok(()));
            }
            let n = buf.remaining().min(me.max_per_read).min(owed);
            let chunk: Vec<u8> = (0..n).map(|i| stream_byte(me.delivered + i)).collect();
            buf.put_slice(&chunk);
            me.delivered += n;
            Poll::Ready(Ok(()))
        }
    }

    /// An [`AsyncWrite`] whose length can only come from bytes it was actually
    /// handed — no `resize`, no `with_capacity`.
    #[derive(Default)]
    struct RecordingWriter {
        bytes: Vec<u8>,
        writes: Vec<usize>,
        flushes: usize,
        shutdowns: usize,
    }

    impl AsyncWrite for RecordingWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<io::Result<usize>> {
            let me = &mut *self;
            me.writes.push(buf.len());
            me.bytes.extend_from_slice(buf);
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            self.flushes += 1;
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            self.shutdowns += 1;
            Poll::Ready(Ok(()))
        }
    }

    /// Collects the progress ticks so the callback's contract is asserted on
    /// values, not on a count.
    #[derive(Default)]
    struct Ticks(std::sync::Arc<std::sync::Mutex<Vec<u64>>>);

    impl Ticks {
        fn recorder(&self) -> impl FnMut(u64) + use<> {
            let sink = self.0.clone();
            move |n| sink.lock().expect("ticks mutex is not poisoned").push(n)
        }

        fn seen(&self) -> Vec<u64> {
            self.0.lock().expect("ticks mutex is not poisoned").clone()
        }
    }

    // -- Over a real QUIC bi-stream -----------------------------------------

    /// Drive `send_bulk` on one endpoint and `recv_bulk` on the other over a
    /// single bi-stream, returning what the receiver wrote and what each side's
    /// progress callback saw.
    ///
    /// The receiver's cap is `total_size` itself: the tightest bound a caller
    /// can pass, and the shape `sync_files` uses (the offer's size must equal
    /// the DB row's). If the cap were checked with `>=` inverted, or applied
    /// after the read, every round trip below would fail.
    async fn round_trip(payload_len: usize) -> (Vec<u8>, Vec<u64>, Vec<u64>) {
        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        let total_size = as_u64(payload_len);
        let recv_ticks = Ticks::default();
        let recv_sink = recv_ticks.recorder();

        let receiver = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("an inbound connection")
                    .await
                    .expect("QUIC handshake completes");
                let (_send, mut recv) = conn.accept_bi().await.expect("peer opens bi-stream");
                let mut writer = RecordingWriter::default();
                recv_bulk(&mut recv, &mut writer, total_size, total_size, recv_sink)
                    .await
                    .expect("the payload arrives in full");
                // The stream must still be usable: the session continues on it.
                // A trailing marker proves the copy consumed neither more nor
                // fewer bytes than the payload — in particular that an empty
                // payload consumed nothing at all.
                let mut marker = [0u8; 4];
                recv.read_exact(&mut marker)
                    .await
                    .expect("the marker follows the payload on the same stream");
                assert_eq!(&marker, b"MARK", "the copy left the stream misaligned");
                (writer.bytes, conn)
            }
        });

        let send_ticks = Ticks::default();
        let conn = connector
            .connect(listener_addr, SYNC_ALPN)
            .await
            .expect("initiator connects to the LAN endpoint");
        let (mut send, _recv) = conn.open_bi().await.expect("initiator opens bi-stream");
        let payload = synthetic(payload_len);
        send_bulk(
            &mut send,
            io::Cursor::new(payload),
            total_size,
            send_ticks.recorder(),
        )
        .await
        .expect("the payload goes out over QUIC");
        send.write_all(b"MARK").await.expect("the marker writes");
        send.finish().expect("the sender's stream finishes");

        let (received, peer_conn) = tokio::time::timeout(TRANSFER_TIMEOUT, receiver)
            .await
            .expect("the transfer finishes within budget")
            .expect("the receiver task does not panic");

        conn.close(0u32.into(), b"done");
        drop(peer_conn);
        listener.close().await;
        connector.close().await;

        (received, send_ticks.seen(), recv_ticks.seen())
    }

    /// The multi-buffer path: more than two full buffers plus an inexact tail,
    /// so both the loop and the final short pass are exercised, and the
    /// position-dependent pattern would catch a buffer written twice or out of
    /// order.
    ///
    /// Falsified by making `remaining_this_pass` always return a whole buffer:
    /// the sender over-reads its cursor and the send fails with `the payload
    /// goes out over QUIC: InvalidOperation("[transport::bulk] bulk send:
    /// reader exhausted at 10001234 bytes, expected 10001234")`. Falsified
    /// again by dropping the tail pass (`while moved + as_u64(BULK_COPY_BYTES)
    /// <= total_size`): "the copy must move exactly total_size bytes: left:
    /// 10000000, right: 10001234".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_multi_buffer_payload_survives_a_real_quic_round_trip() {
        let len = BULK_COPY_BYTES * 2 + 1234;
        let (received, sent_ticks, recv_ticks) = round_trip(len).await;

        assert_is_the_delivered_stream(&received, len);
        let expected_ticks = vec![
            as_u64(BULK_COPY_BYTES),
            as_u64(BULK_COPY_BYTES * 2),
            as_u64(len),
        ];
        assert_eq!(
            sent_ticks, expected_ticks,
            "the sender must tick cumulative totals once per buffer"
        );
        assert_eq!(
            recv_ticks, expected_ticks,
            "the receiver must tick cumulative totals once per buffer"
        );
    }

    /// A payload smaller than one buffer: one pass, one tick, and the tick is
    /// the payload size rather than the buffer size.
    ///
    /// Falsified by ticking `as_u64(BULK_COPY_BYTES)` instead of `moved`: "the
    /// whole payload is one tick of its own length: left: [5000000], right:
    /// [1234]".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_sub_buffer_payload_survives_a_real_quic_round_trip() {
        let len = 1234;
        let (received, sent_ticks, recv_ticks) = round_trip(len).await;

        assert_is_the_delivered_stream(&received, len);
        assert_eq!(
            sent_ticks,
            vec![as_u64(len)],
            "the whole payload is one tick of its own length"
        );
        assert_eq!(recv_ticks, vec![as_u64(len)]);
    }

    /// An empty payload puts nothing on the wire, yet still ticks once with 0.
    ///
    /// The marker read inside [`round_trip`] is what makes this more than a
    /// tautology: it fails if either side writes or consumes a zero-length
    /// sentinel, which is exactly what the old transport did and what the
    /// cutover drops.
    ///
    /// Falsified by having `send_bulk` write an empty frame's worth of sentinel
    /// (`send.write_all(b"\0")`) on the zero path: "the copy left the stream
    /// misaligned: left: [0, 77, 65, 82], right: [77, 65, 82, 75]".
    /// Falsified again by dropping the `on_progress(0)` tick: "an empty payload
    /// still reports one 0 tick: left: [], right: [0]".
    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_payload_moves_no_bytes_and_still_ticks_zero() {
        let (received, sent_ticks, recv_ticks) = round_trip(0).await;

        assert!(
            received.is_empty(),
            "an empty payload produced {} bytes",
            received.len()
        );
        assert_eq!(
            sent_ticks,
            vec![0],
            "an empty payload still reports one 0 tick"
        );
        assert_eq!(
            recv_ticks,
            vec![0],
            "an empty payload still reports one 0 tick"
        );
    }

    /// A peer that announces a size, sends less, and finishes must produce an
    /// error — a short file written to disk and hash-verified later is the
    /// failure mode this prevents, and under QUIC nothing else distinguishes
    /// "the stream ended" from "the payload ended".
    ///
    /// Falsified by returning `Ok(())` on EOF instead of the error: "a
    /// truncated stream must not succeed: ()". Falsified again by writing the
    /// half-filled buffer before returning that error, which turns the failure
    /// into the short write this test is named after: "a truncated transfer
    /// must not leave a partial buffer in the writer: left: 100, right: 0".
    #[tokio::test(flavor = "multi_thread")]
    async fn a_truncated_quic_stream_is_an_error_not_a_short_write() {
        let listener = lan_builder()
            .alpns(vec![SYNC_ALPN.to_vec()])
            .bind()
            .await
            .expect("listener binds");
        let listener_addr = listener.addr();
        let connector = lan_builder().bind().await.expect("connector binds");

        let receiver = tokio::spawn({
            let listener = listener.clone();
            async move {
                let conn = listener
                    .accept()
                    .await
                    .expect("an inbound connection")
                    .await
                    .expect("QUIC handshake completes");
                let (_send, mut recv) = conn.accept_bi().await.expect("bi-stream");
                let mut writer = RecordingWriter::default();
                let outcome = recv_bulk(&mut recv, &mut writer, 4096, 4096, |_| {}).await;
                (outcome, writer.bytes.len())
            }
        });

        let conn = connector
            .connect(listener_addr, SYNC_ALPN)
            .await
            .expect("connects");
        let (mut send, _recv) = conn.open_bi().await.expect("bi-stream");
        // Announce 4096, deliver 100, then FIN: the shape a crashed peer or a
        // file that shrank mid-send produces.
        send.write_all(&synthetic(100))
            .await
            .expect("the stub payload writes");
        send.finish().expect("stream finishes");
        conn.closed().await;

        let (outcome, written) = tokio::time::timeout(TRANSFER_TIMEOUT, receiver)
            .await
            .expect("a truncated stream must fail rather than hang")
            .expect("the receiver task does not panic");
        let err = outcome.expect_err("a truncated stream must not succeed");
        let text = err.to_string();
        assert!(
            text.contains("peer stopped sending at 100 bytes, expected 4096"),
            "expected a short-stream failure naming the peer, got: {text}"
        );
        assert_eq!(
            written, 0,
            "a truncated transfer must not leave a partial buffer in the writer"
        );

        listener.close().await;
        connector.close().await;
    }

    // -- Against fakes ------------------------------------------------------

    /// The cap must fire before the reader is touched at all. Reading first and
    /// checking afterwards is precisely the bug.
    ///
    /// This is the strong form of `session`'s over-cap test: there, the
    /// assertion is only that the call returns without a body having been sent,
    /// which a timeout expresses badly. Here the reader records requests, so
    /// "no read was issued" is a direct assertion.
    ///
    /// Falsified by moving the `total_size > max_size` check below the
    /// `copy_exact` call — the error still surfaces, so only this assertion
    /// notices: "an over-cap payload must be refused before any read; it asked
    /// for [4096]".
    #[tokio::test]
    async fn a_total_size_over_max_size_is_refused_before_any_read() {
        let mut reader = PatternReader::new(usize::MAX, BULK_COPY_BYTES);
        let mut writer = RecordingWriter::default();
        let ticks = Ticks::default();

        let err = recv_bulk_from(&mut reader, &mut writer, 4096, 4095, ticks.recorder())
            .await
            .expect_err("a payload above the cap must be refused");

        let text = err.to_string();
        assert!(
            text.contains("refusing to receive"),
            "expected the pre-read cap to fire, got: {text}"
        );
        assert!(
            reader.requests.is_empty(),
            "an over-cap payload must be refused before any read; it asked for {:?}",
            reader.requests
        );
        assert!(
            writer.bytes.is_empty(),
            "an over-cap payload must not reach the writer"
        );
        assert!(
            ticks.seen().is_empty(),
            "a refused payload must not report progress"
        );
    }

    /// Exactly at the cap is accepted: the bound is `>`, not `>=`.
    ///
    /// Without this, tightening the comparison to `>=` would break every
    /// caller that passes the DB-authoritative size as its own cap — which is
    /// what `sync_files` does — and no other test here would notice.
    ///
    /// Falsified by changing the guard to `total_size >= max_size`: `a payload
    /// exactly at the cap is legal: InvalidOperation("[transport::bulk] peer
    /// announced a 4096-byte payload (max 4096); refusing to receive")`. That
    /// break takes 8 of the 11 tests here with it, which is the point: an
    /// inclusive cap is not a corner case, it is every caller.
    #[tokio::test]
    async fn a_total_size_exactly_at_max_size_is_accepted() {
        let mut reader = PatternReader::new(4096, BULK_COPY_BYTES);
        let mut writer = RecordingWriter::default();

        recv_bulk_from(&mut reader, &mut writer, 4096, 4096, |_| {})
            .await
            .expect("a payload exactly at the cap is legal");

        assert_is_the_delivered_stream(&writer.bytes, 4096);
    }

    /// A peer with more bytes than it announced must not be able to write past
    /// `total_size` — and not by a check after the fact: the surplus is never
    /// requested, so it is never copied.
    ///
    /// Falsified by sizing each read at the whole buffer instead of
    /// `min(buffer, owed)`: the copy drains the surplus and then runs the
    /// reader dry, failing with `the announced bytes arrive:
    /// InvalidOperation("[transport::bulk] bulk receive: peer stopped sending
    /// at 49380 bytes, expected 12345")` — 49,380 being all four copies of the
    /// payload the reader had. Falsified again by ticking a constant instead of
    /// `moved`: "progress must report the announced total, not what the peer
    /// offered: left: [5000000], right: [12345]".
    #[tokio::test]
    async fn a_peer_sending_more_than_total_size_cannot_overrun_the_writer() {
        let total = 12_345usize;
        // Four times the announced size, in short reads: the reader will hand
        // over as much as it is asked for, every time it is asked.
        let mut reader = PatternReader::new(total * 4, 4_000);
        let mut writer = RecordingWriter::default();
        let ticks = Ticks::default();

        recv_bulk_from(
            &mut reader,
            &mut writer,
            as_u64(total),
            as_u64(total),
            ticks.recorder(),
        )
        .await
        .expect("the announced bytes arrive");

        assert_eq!(
            writer.bytes.len(),
            total,
            "a surplus-bearing peer overran the writer"
        );
        assert_is_the_delivered_stream(&writer.bytes, total);
        // The shrinking sequence is the assertion: the first request is the
        // announced total (never one whole buffer), and each subsequent one is
        // exactly what the previous short read left owed. A reader offered a
        // buffer larger than the remainder would show up here immediately.
        assert_eq!(
            reader.requests,
            vec![12_345, 8_345, 4_345, 345],
            "the reader must never be offered more than it is owed"
        );
        assert_eq!(
            reader.delivered, total,
            "the surplus must be left in the stream, not consumed"
        );
        assert_eq!(
            ticks.seen(),
            vec![as_u64(total)],
            "progress must report the announced total, not what the peer offered"
        );
    }

    /// A source that stops mid-buffer is an error, and the writer keeps only
    /// whole buffers that completed — never the half-filled one.
    ///
    /// This is the generic twin of the QUIC truncation test, and it adds what
    /// that one cannot see: that the partially-filled buffer is discarded
    /// rather than written, and that the error names how far the source got.
    ///
    /// Falsified by writing `&buf[..filled]` before returning the EOF error: "a
    /// half-filled buffer must never reach the writer: left: 5000123, right:
    /// 5000000".
    #[tokio::test]
    async fn a_truncated_source_is_an_error_not_a_short_write() {
        let total = BULK_COPY_BYTES * 2;
        // One full buffer, then 123 bytes, then EOF.
        let mut reader = PatternReader::new(BULK_COPY_BYTES + 123, BULK_COPY_BYTES);
        let mut writer = RecordingWriter::default();

        let err = recv_bulk_from(
            &mut reader,
            &mut writer,
            as_u64(total),
            as_u64(total),
            |_| {},
        )
        .await
        .expect_err("a truncated source must fail");

        let text = err.to_string();
        assert!(
            text.contains("peer stopped sending at 5000123 bytes, expected 10000000"),
            "the error must say how far the source got, got: {text}"
        );
        assert_eq!(
            writer.bytes.len(),
            BULK_COPY_BYTES,
            "a half-filled buffer must never reach the writer"
        );
        assert_is_the_delivered_stream(&writer.bytes, BULK_COPY_BYTES);
    }

    /// The same truncation on the send path names the local reader, not the
    /// peer. Whoever reads the log has to be sent to the right machine.
    ///
    /// Falsified by giving both `Origin` variants the peer's wording: "a short
    /// local file must not be blamed on the peer, got: Invalid operation:
    /// [transport::bulk] bulk receive: peer stopped sending at 100 bytes,
    /// expected 4096".
    #[tokio::test]
    async fn a_short_local_reader_is_blamed_on_the_reader_not_the_peer() {
        let mut writer = RecordingWriter::default();
        let err = copy_exact(
            PatternReader::new(100, BULK_COPY_BYTES),
            &mut writer,
            4096,
            Origin::LocalReader,
            |_| {},
        )
        .await
        .expect_err("a reader shorter than its advertised size must fail");

        let text = err.to_string();
        assert!(
            text.contains("bulk send: reader exhausted at 100 bytes, expected 4096"),
            "a short local file must not be blamed on the peer, got: {text}"
        );
    }

    /// Nothing is sized from `total_size`. An 8 GB announcement under a 16 GB
    /// cap must still issue a one-buffer read.
    ///
    /// The assertion is on the *request length*, not on peak memory: a
    /// `vec![0u8; total_size]` regression is invisible to a memory probe on an
    /// overcommitting kernel (`alloc_zeroed` hands back lazily-mapped pages),
    /// but it is unmissable in what the reader was handed — provided the
    /// request is derived from the buffer rather than from the constant. This
    /// test is the reason [`remaining_this_pass`] takes `buffer_len`: with the
    /// request sized `BULK_COPY_BYTES` directly, an 8 GB allocation left every
    /// test here green. This is the property that makes it safe for
    /// `sync_files` to pass a multi-gigabyte attachment size as its own cap.
    ///
    /// Falsified by sizing the buffer `vec![0u8; total_size as usize]` and
    /// reading into all of it: "a read must be sized by the buffer, never by
    /// the announced total: left: [8589934592], right: [5000000]".
    #[tokio::test]
    async fn the_copy_buffer_does_not_grow_with_total_size() {
        let announced: u64 = 8 * 1024 * 1024 * 1024;
        // EOF on the first read: the point is what was *asked for*, and this
        // keeps the test from moving 8 GB to find out.
        let mut reader = PatternReader::new(0, BULK_COPY_BYTES);
        let mut writer = RecordingWriter::default();

        let err = recv_bulk_from(&mut reader, &mut writer, announced, announced * 2, |_| {})
            .await
            .expect_err("a source that delivers nothing must fail");
        assert!(
            err.to_string().contains("peer stopped sending at 0 bytes"),
            "expected a short-stream failure, got: {err}"
        );

        assert_eq!(
            reader.requests,
            vec![BULK_COPY_BYTES],
            "a read must be sized by the buffer, never by the announced total"
        );
    }

    /// Short reads are gathered until the buffer is full, so the callback fires
    /// once per buffer rather than once per `poll_read`.
    ///
    /// The cadence is not cosmetic: `sync_files` and `snapshot_transfer` emit a
    /// Tauri event from this callback, and a QUIC stream delivering 64 KB at a
    /// time would turn one 5 MB buffer into ~80 events.
    ///
    /// Falsified by ticking inside the fill loop (`on_progress(moved +
    /// as_u64(filled))` after each read): "progress must tick once per buffer,
    /// not once per read: left: 82, right: 3". Falsified again by dropping the
    /// final `writer.flush()`: "the writer is flushed once, at the end, and
    /// never shut down: left: 0, right: 1".
    #[tokio::test]
    async fn progress_ticks_once_per_buffer_and_totals_the_payload() {
        let total = BULK_COPY_BYTES * 2 + 1234;
        // ~40 reads per buffer, so a per-read tick is unmissable.
        let mut reader = PatternReader::new(total, 128 * 1024);
        let mut writer = RecordingWriter::default();
        let ticks = Ticks::default();

        recv_bulk_from(
            &mut reader,
            &mut writer,
            as_u64(total),
            as_u64(total),
            ticks.recorder(),
        )
        .await
        .expect("the payload arrives");

        let seen = ticks.seen();
        assert_eq!(
            seen.len(),
            3,
            "progress must tick once per buffer, not once per read"
        );
        assert_eq!(
            seen,
            vec![
                as_u64(BULK_COPY_BYTES),
                as_u64(BULK_COPY_BYTES * 2),
                as_u64(total)
            ],
            "progress must be cumulative, matching the old API's contract"
        );
        assert_eq!(
            *seen.last().expect("three ticks"),
            as_u64(total),
            "the final tick must equal the payload size"
        );
        assert_is_the_delivered_stream(&writer.bytes, total);
        assert_eq!(
            writer.flushes, 1,
            "the writer is flushed once, at the end, and never shut down"
        );
        assert_eq!(
            writer.shutdowns, 0,
            "the stream stays open for the rest of the session"
        );
    }
}
