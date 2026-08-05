//! #78 spike — is "LAN-only iroh" a posture we can *enforce*, or only one we can *intend*?
//!
//! The 2026-07-12 revival comment on #78 specified the LAN-only config as
//! `RelayMode::Disabled` + mDNS discovery. Reading iroh 1.0.3's source shows that
//! is **not sufficient**: see [`DIAL_HOME_ANYWAY`] below.
//!
//! This crate builds the configuration that *is* sufficient, and — more importantly —
//! the observation apparatus that can prove it, so a future iroh upgrade cannot
//! silently reintroduce an outbound path.

use std::{
    net::{Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
};

use iroh::{
    Endpoint, RelayMode,
    endpoint::{BindOpts, Builder, presets},
};
use iroh_dns::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};
use n0_error::e;
use n0_future::boxed::BoxFuture;

/// The trap this spike exists to document.
///
/// iroh ships a preset named [`presets::N0DisableRelay`] whose name reads exactly like
/// the #78 plan's "LAN-only" config. It is not. Its implementation is:
///
/// ```text
/// N0.apply(builder).relay_mode(RelayMode::Disabled)
/// ```
///
/// and `N0` installs `PkarrPublisher::n0_dns()`, `PkarrResolver::n0_dns()` and
/// `DnsAddressLookup::n0_dns()`. Disabling relays leaves **all three address-lookup
/// services active**, so the endpoint still publishes its IP addresses to, and resolves
/// them from, n0.computer's DNS server (`iroh.link`) on every start.
///
/// `RelayMode::Disabled` alone — the literal wording of the #78 plan — is therefore an
/// endpoint that still phones home. The relay carries no traffic, but the address-lookup
/// services announce this device's existence and addresses to a third party.
pub const DIAL_HOME_ANYWAY: () = ();

/// A [`Resolver`] that answers nothing and records every question it was asked.
///
/// This is the load-bearing piece of the offline guard. Every path by which iroh could
/// reach n0's infrastructure — pkarr publish, pkarr resolve, DNS address lookup, relay
/// URL resolution — begins with a name lookup. Injecting this via
/// [`Builder::dns_resolver`] means an endpoint cannot resolve a hostname without leaving
/// a record here, whatever future iroh versions decide to add.
///
/// It deliberately fails every query rather than forwarding: a guard that lets the
/// lookup succeed would be observing a leak it also permitted.
#[derive(Debug, Clone, Default)]
pub struct RecordingResolver {
    queries: Arc<Mutex<Vec<String>>>,
}

impl RecordingResolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every hostname iroh attempted to resolve, in order.
    pub fn queries(&self) -> Vec<String> {
        self.queries
            .lock()
            .expect("resolver mutex poisoned")
            .clone()
    }

    fn record(&self, host: &str) {
        self.queries
            .lock()
            .expect("resolver mutex poisoned")
            .push(host.to_string());
    }
}

impl Resolver for RecordingResolver {
    fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
        self.record(&host);
        Box::pin(async move { Err(e!(DnsError::NoResponse)) })
    }

    fn lookup_ipv6(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv6Addr>, DnsError>> {
        self.record(&host);
        Box::pin(async move { Err(e!(DnsError::NoResponse)) })
    }

    fn lookup_txt(&self, host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
        self.record(&host);
        Box::pin(async move { Err(e!(DnsError::NoResponse)) })
    }

    fn clear_cache(&self) {}

    fn reset(&self) -> Box<dyn Resolver> {
        // Share the same recording buffer across resets, so a network-change-triggered
        // rebuild cannot launder a query out of the record.
        Box::new(self.clone())
    }
}

/// The LAN-only endpoint configuration this spike proposes.
///
/// Three independent layers, each of which must hold on its own:
///
/// 1. **No relay transport at all** — `clear_relay_transports()` removes the transport,
///    which is strictly stronger than `RelayMode::Disabled` (that only empties the relay
///    map; the transport remains constructed).
/// 2. **No address-lookup services** — built from [`presets::Minimal`], which sets *only*
///    the mandatory crypto provider, rather than from `N0`/`N0DisableRelay`. Nothing is
///    published to or resolved from n0. See [`DIAL_HOME_ANYWAY`].
/// 3. **Egress structurally confined to the LAN subnet** — the socket is bound with an
///    explicit `prefix_len` and `is_default_route(false)`. iroh routes outgoing datagrams
///    by longest-prefix match over bound sockets (`IpConfig::is_valid_send_addr`), falling
///    back to the default-route socket. With no default route and only a LAN subnet bound,
///    an off-subnet destination matches nothing and there is no socket to send it on.
///
/// Layer 3 is what makes this enforcement rather than configuration: it does not depend on
/// iroh choosing not to talk to a public address, but on there being no route by which it
/// could.
///
/// # `clear_ip_transports()` is load-bearing, and no test will tell you so
///
/// The builder installs default wildcard (`0.0.0.0/0`) IP transports. Those are
/// default-route sockets by definition, so leaving them in place gives every off-subnet
/// destination a socket to leave by and layer 3 collapses entirely — while all four
/// guards in `tests/offline_guard.rs` stay green, because the guards observe *name
/// resolution* and this leak needs none.
///
/// It is removed before the subnet-scoped socket is added. Do not drop the call as
/// redundant.
///
/// # What the guard cannot see
///
/// The offline guard observes DNS. That covers every route to n0 that iroh currently
/// uses, because relay selection and pkarr both start from a hostname. It would **not**
/// catch a future iroh dialling a hardcoded bootstrap IP address, which needs no
/// resolution. Layer 3 is the backstop for that case — which is the other reason
/// `clear_ip_transports()` matters.
pub fn lan_only(bind: SocketAddr, prefix_len: u8, resolver: DnsResolver) -> Builder {
    Endpoint::builder(presets::Minimal)
        .relay_mode(RelayMode::Disabled)
        .clear_relay_transports()
        .clear_address_lookup()
        .clear_ip_transports()
        .dns_resolver(resolver)
        .bind_addr_with_opts(
            bind,
            BindOpts::default()
                .set_prefix_len(prefix_len)
                .set_is_default_route(false),
        )
        .expect("bind address is valid")
}

/// The permissive configuration, used **only** as the negative control in the guard tests.
///
/// If a test asserting "the LAN-only endpoint does not phone home" cannot be made to fail,
/// it is not evidence. This builder is the thing that makes it fail: same test body, same
/// assertions, internet-facing config. Any guard here that stays green against *this* is
/// a guard that cannot fire.
pub fn permissive(resolver: DnsResolver) -> Builder {
    Endpoint::builder(presets::N0DisableRelay).dns_resolver(resolver)
}

/// Is this address one that could be reached from the public internet?
///
/// Used by the offline guard to classify what an endpoint publishes. Extracted here
/// (rather than living in the test file) so it can be unit-tested against addresses whose
/// class is unambiguous — the integration assertion that uses it cannot fail on a NAT'd
/// host, but this can.
pub fn is_publicly_routable(addr: &SocketAddr) -> bool {
    match addr.ip() {
        std::net::IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // 100.64.0.0/10 CGNAT — not `is_private()`, but not internet-routable
                // either, and it is what CGNAT'd mobile networks hand out.
                || (o[0] == 100 && (64..128).contains(&o[1])))
        }
        std::net::IpAddr::V6(v6) => {
            !(v6.is_loopback()
                || v6.is_unspecified()
                // fe80::/10 link-local and fc00::/7 unique-local
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xfe00) == 0xfc00)
        }
    }
}
