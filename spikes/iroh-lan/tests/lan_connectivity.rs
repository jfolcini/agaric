//! Does the LAN-only configuration actually carry a session?
//!
//! The offline guard proves the config does not phone home. On its own that proves
//! nothing useful — an endpoint that cannot connect to anything also never phones home.
//! This file is the other half: two endpoints under the *same* hardened config complete a
//! QUIC handshake and move bytes both ways, with no relay, no discovery service and no
//! name resolution available to either of them.
//!
//! Address exchange here is explicit (`connector.connect(listener.addr(), ..)`), which
//! mirrors how the migration would work: `clear_address_lookup()` removes iroh's
//! discovery, so peer addresses arrive out-of-band — exactly what our existing pairing
//! flow already does, and what `iroh-mdns-address-lookup` would automate later.

use std::{
    net::{Ipv4Addr, SocketAddr, SocketAddrV4},
    time::Duration,
};

use iroh_dns::dns::DnsResolver;
use iroh_lan_spike::{lan_only, RecordingResolver};

const ALPN: &[u8] = b"agaric/spike/echo/0";

fn lan_bind() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
}
const LAN_PREFIX: u8 = 8;

#[tokio::test]
async fn two_lan_only_endpoints_complete_a_session() {
    let listener_recorder = RecordingResolver::new();
    let listener = lan_only(
        lan_bind(),
        LAN_PREFIX,
        DnsResolver::custom(listener_recorder.clone()),
    )
    .alpns(vec![ALPN.to_vec()])
    .bind()
    .await
    .expect("listener binds");

    let listener_addr = listener.addr();

    let accept_task = tokio::spawn({
        let listener = listener.clone();
        async move {
            let incoming = listener.accept().await.expect("an inbound connection");
            let conn = incoming.await.expect("handshake completes");
            let (mut send, mut recv) = conn.accept_bi().await.expect("peer opens a stream");
            let got = recv.read_to_end(64).await.expect("payload arrives");
            send.write_all(&got).await.expect("echo writes");
            send.finish().expect("echo finishes");
            conn.closed().await;
            got
        }
    });

    let connector_recorder = RecordingResolver::new();
    let connector = lan_only(
        lan_bind(),
        LAN_PREFIX,
        DnsResolver::custom(connector_recorder.clone()),
    )
    .bind()
    .await
    .expect("connector binds");

    let conn = tokio::time::timeout(
        Duration::from_secs(10),
        connector.connect(listener_addr, ALPN),
    )
    .await
    .expect("connect does not time out")
    .expect("connect succeeds");

    let (mut send, mut recv) = conn.open_bi().await.expect("stream opens");
    send.write_all(b"agaric").await.expect("write");
    send.finish().expect("finish");
    let echoed = recv.read_to_end(64).await.expect("echo returns");
    conn.close(0u32.into(), b"done");

    let received = tokio::time::timeout(Duration::from_secs(10), accept_task)
        .await
        .expect("accept task finishes")
        .expect("accept task does not panic");

    assert_eq!(&echoed, b"agaric", "payload survives the round trip");
    assert_eq!(&received, b"agaric", "listener saw the payload");

    // The session completed *and* neither side resolved a name to do it. Asserting both
    // in one test is the point: it is the conjunction that the migration needs, and
    // either half alone is satisfiable by a broken configuration.
    let listener_queries = listener_recorder.queries();
    let connector_queries = connector_recorder.queries();

    connector.close().await;
    listener.close().await;

    assert!(
        listener_queries.is_empty() && connector_queries.is_empty(),
        "a session completed but a name was resolved to do it — listener: \
         {listener_queries:?}, connector: {connector_queries:?}"
    );
}
