//! Link metadata fetching and caching.
//!
//! Fetches `<title>`, favicon URL, and description from external URLs,
//! stores them in a local SQLite cache (`link_metadata` table) that is
//! NOT synced between devices. Each device fetches independently.
//!
//! Module layout:
//! - `html_parser` — pure HTML parsing + URL helpers (no I/O, no DB)
//! - this file (`mod.rs`) — HTTP client, DB operations, and the
//!   `LinkMetadata` type. Re-exports the public parsing API from
//!   `html_parser` to preserve the original single-file API surface.
//!
//! DB access here uses runtime `sqlx::query`/`query_as` (not the
//! compile-time `query!` macros) by design: the `link_metadata` table is
//! a device-local, regenerable cache (never synced), and its STRICT +
//! CHECK column affinity already enforces row shape at write time. The
//! runtime form keeps this isolated helper free of an offline-`.sqlx`
//! dependency; it is an intentional choice, not an oversight — do not
//! convert these to macros.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;

use crate::db::now_ms;
use agaric_core::error::AppError;

mod html_parser;

#[cfg(test)]
mod tests;

// Re-export the public parsing API so callers keep using
// `crate::link_metadata::parse_title`, `parse_favicon`, etc.
pub use html_parser::{detect_auth_required, parse_description, parse_favicon, parse_title};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Type)]
pub struct LinkMetadata {
    pub url: String,
    pub title: Option<String>,
    pub favicon_url: Option<String>,
    pub description: Option<String>,
    /// Milliseconds since the UNIX epoch (UTC) — see `crate::db::now_ms`.
    /// Exposed to the frontend as a `number` (#109 Phase 2; was an RFC 3339
    /// string before the INTEGER-ms timestamp migration).
    pub fetched_at: i64,
    pub auth_required: bool,
    /// (follow-up): `true` when the most recent
    /// fetch saw a terminal "this resource is gone" status (HTTP 404 or
    /// 410). Distinct from `auth_required` (401/403, transient
    /// sign-in) and from "transient" (5xx — both flags false plus
    /// `title.is_none()`). The frontend uses this to render a "(not
    /// found)" tag and suppress the favicon.
    ///
    /// `#[serde(default)]` so any legacy serialized blob — e.g. a
    /// cached snapshot deserialized before this field existed — keeps
    /// deserializing cleanly as `false`.
    #[serde(default)]
    pub not_found: bool,
}

// ---------------------------------------------------------------------------
// SSRF protection (#2661)
// ---------------------------------------------------------------------------
//
// `fetch_metadata` issues an HTTP GET to a caller-supplied URL that fires
// automatically on link hover — including links inside synced / pasted
// content the user never authored. Without guards this beacons the user's
// IP + a "note viewed now" read-receipt to an arbitrary host AND lets a
// crafted URL (or a redirect chain) probe loopback / LAN / cloud-metadata
// services from the desktop process (e.g. http://127.0.0.1,
// http://169.254.169.254, http://192.168.x.x). That contradicts the threat
// model's "no third-party data flow" posture.
//
// Defense in depth:
//   1. Scheme allow-list — only `http` / `https` are ever dispatched.
//   2. Up-front literal-IP host reject — a URL whose host is a literal IP
//      in a blocked range fails before any socket is opened.
//   3. `SsrfGuardResolver` — a custom `reqwest::dns::Resolve` that resolves
//      every DOMAIN host at CONNECT time (initial request AND every redirect
//      hop) and drops any address that is not globally routable. Because
//      resolution happens right before the socket is opened this also
//      defeats DNS-rebinding (a TOCTOU where the name resolves to a public
//      IP at validation time but a private IP at connect time).
//   4. A redirect policy that re-validates each hop's scheme + literal-IP
//      host. This is required because hyper-util's connector parses a
//      literal-IP host directly and NEVER calls the custom resolver
//      (hyper-util `connect/http.rs`: `SocketAddrs::try_parse` short-circuits
//      before `resolve(...)`), so a redirect to `http://127.0.0.1/` would
//      otherwise bypass `SsrfGuardResolver`. Domain hosts on redirects still
//      flow through the resolver, so DNS-rebinding stays covered.

/// Return `true` when `ip` must NOT be connected to — i.e. it is not a
/// globally-routable public address. Blocking here (rather than allow-listing)
/// is intentional: every non-global range that could reach a loopback / LAN /
/// cloud-metadata / reserved endpoint is enumerated and rejected.
///
/// IPv4 blocked ranges:
///   * `0.0.0.0/8` — "this host on this network" (RFC 1122), incl. `0.0.0.0`
///   * `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — RFC 1918 private
///   * `100.64.0.0/10` — RFC 6598 carrier-grade NAT (shared address space)
///   * `127.0.0.0/8` — loopback
///   * `169.254.0.0/16` — RFC 3927 link-local, incl. `169.254.169.254` (metadata)
///   * `192.0.0.0/24` — RFC 6890 IETF protocol assignments
///   * `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` — TEST-NET docs
///   * `192.88.99.0/24` — 6to4 relay anycast (deprecated)
///   * `198.18.0.0/15` — benchmarking
///   * `224.0.0.0/4` — multicast
///   * `240.0.0.0/4` — reserved for future use, incl. `255.255.255.255` broadcast
///
/// IPv6 blocked ranges:
///   * `::` / `::1`     — unspecified / loopback
///   * `fc00::/7`       — unique-local (ULA)
///   * `fe80::/10`      — link-local unicast
///   * `ff00::/8`       — multicast
///   * `2001:db8::/32`  — documentation
///   * IPv4-mapped / IPv4-compatible addresses are unwrapped to their
///     embedded v4 and re-checked with the IPv4 rules above (prevents a
///     `::ffff:127.0.0.1` bypass).
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(v4: Ipv4Addr) -> bool {
    let [a, b, _, _] = v4.octets();

    // std-provided predicates.
    if v4.is_unspecified()        // 0.0.0.0
        || v4.is_loopback()       // 127.0.0.0/8
        || v4.is_private()        // 10/8, 172.16/12, 192.168/16
        || v4.is_link_local()     // 169.254.0.0/16 (incl. 169.254.169.254)
        || v4.is_broadcast()      // 255.255.255.255
        || v4.is_documentation()  // 192.0.2/24, 198.51.100/24, 203.0.113/24
        || v4.is_multicast()
    // 224.0.0.0/4
    {
        return true;
    }

    // Ranges std has no stable predicate for.
    // 0.0.0.0/8 — "this network" (only 0.0.0.0 is covered by is_unspecified).
    if a == 0 {
        return true;
    }
    // 100.64.0.0/10 — carrier-grade NAT (RFC 6598).
    if a == 100 && (64..=127).contains(&b) {
        return true;
    }
    // 192.0.0.0/24 — IETF protocol assignments (RFC 6890).
    if a == 192 && b == 0 && v4.octets()[2] == 0 {
        return true;
    }
    // 192.88.99.0/24 — 6to4 relay anycast (deprecated).
    if a == 192 && b == 88 && v4.octets()[2] == 99 {
        return true;
    }
    // 198.18.0.0/15 — benchmarking (RFC 2544).
    if a == 198 && (b == 18 || b == 19) {
        return true;
    }
    // 240.0.0.0/4 — reserved for future use (255.255.255.255 already caught
    // by is_broadcast).
    if a >= 240 {
        return true;
    }

    false
}

fn is_blocked_ipv6(v6: Ipv6Addr) -> bool {
    // Unwrap IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96,
    // deprecated) addresses and apply the v4 rules — otherwise
    // `::ffff:127.0.0.1` would sail through as a "public" v6 address.
    if let Some(v4) = v6.to_ipv4() {
        return is_blocked_ipv4(v4);
    }

    if v6.is_unspecified()   // ::
        || v6.is_loopback()  // ::1
        || v6.is_multicast()
    // ff00::/8
    {
        return true;
    }

    let seg = v6.segments();
    let seg0 = seg[0];
    // fc00::/7 — unique-local addresses.
    if (seg0 & 0xfe00) == 0xfc00 {
        return true;
    }
    // fe80::/10 — link-local unicast.
    if (seg0 & 0xffc0) == 0xfe80 {
        return true;
    }
    // 2001:db8::/32 — documentation.
    if seg0 == 0x2001 && seg[1] == 0x0db8 {
        return true;
    }

    // Deprecated IPv6 transition ranges whose EMBEDDED IPv4 could reach
    // loopback / LAN. `to_ipv4()` returns None for these, so without the
    // checks below a crafted transition address (e.g. `2002:7f00:1::` = 6to4
    // wrapping 127.0.0.1) would slip through as "public" (#2661 hardening).

    // 6to4 — 2002::/16. Embedded IPv4 = bits 16..48 (segments 1 and 2):
    // `2002:AABB:CCDD::` → A.B.C.D. Extract and re-check with the v4 rules so
    // ONLY a dangerous embedded IPv4 is blocked; a legitimately-public
    // embedded IPv4 (e.g. `2002:0808:0808::` = 8.8.8.8) is allowed.
    if seg0 == 0x2002 {
        let embedded = Ipv4Addr::new(
            (seg[1] >> 8) as u8,
            (seg[1] & 0xff) as u8,
            (seg[2] >> 8) as u8,
            (seg[2] & 0xff) as u8,
        );
        return is_blocked_ipv4(embedded);
    }

    // NAT64 — 64:ff9b::/96 (well-known prefix) and 64:ff9b:1::/48 (local-use).
    // Embedded IPv4 = low 32 bits (segments 6 and 7). Extract and re-check,
    // same allow-public-embedded policy as 6to4.
    if seg0 == 0x0064 && seg[1] == 0xff9b {
        let embedded = Ipv4Addr::new(
            (seg[6] >> 8) as u8,
            (seg[6] & 0xff) as u8,
            (seg[7] >> 8) as u8,
            (seg[7] & 0xff) as u8,
        );
        return is_blocked_ipv4(embedded);
    }

    // Teredo — 2001::/32 (i.e. 2001:0000::/32). Prefix-block the whole range:
    // the embedded server/client IPv4 encoding is fiddly and Teredo is
    // deprecated, so blocking the prefix outright is the safe choice.
    if seg0 == 0x2001 && seg[1] == 0x0000 {
        return true;
    }

    false
}

/// Enforcement-time variant of [`is_blocked_ip`]. In production it is
/// identical. In `#[cfg(test)]` builds it additionally PERMITS loopback so the
/// wiremock-based integration tests — which bind their mock HTTP server on
/// `127.0.0.1` — can exercise the non-SSRF logic (redirects, status handling,
/// body parsing). Every other blocked range (private, link-local,
/// cloud-metadata, ULA, reserved, …) stays enforced even in tests, and the
/// pure `is_blocked_ip` classifier (unit-tested directly) still reports
/// loopback as blocked — the production truth.
fn is_blocked_ip_enforced(ip: IpAddr) -> bool {
    #[cfg(test)]
    if ip.is_loopback() {
        return false;
    }
    is_blocked_ip(ip)
}

/// Validate a target URL's scheme and literal-IP host BEFORE any socket is
/// opened. Domain hosts pass here — they are validated at CONNECT time by
/// [`SsrfGuardResolver`]. Returns a human-readable reason on rejection so the
/// same check can back both the up-front guard and the redirect policy.
fn validate_url_target(parsed: &url::Url) -> Result<(), String> {
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("refusing non-HTTP(S) URL scheme '{scheme}'"));
    }
    match parsed.host() {
        Some(url::Host::Ipv4(v4)) => {
            if is_blocked_ip_enforced(IpAddr::V4(v4)) {
                return Err(format!("refusing to fetch blocked IPv4 host {v4}"));
            }
        }
        Some(url::Host::Ipv6(v6)) => {
            if is_blocked_ip_enforced(IpAddr::V6(v6)) {
                return Err(format!("refusing to fetch blocked IPv6 host {v6}"));
            }
        }
        Some(url::Host::Domain(_)) => {}
        None => return Err("URL has no host".to_string()),
    }
    Ok(())
}

/// Custom DNS resolver that filters out every non-global address at connect
/// time. Wired via [`reqwest::ClientBuilder::dns_resolver`], it runs for the
/// initial host AND every redirect hop whose host is a domain name, and —
/// because resolution happens immediately before the socket is opened — it
/// defeats DNS-rebinding.
#[derive(Debug)]
struct SsrfGuardResolver;

impl Resolve for SsrfGuardResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            // Port `0`: reqwest overrides it with the scheme's conventional
            // port (see `reqwest::dns::Resolve` docs), so the value is
            // irrelevant to us — we only care about the resolved IPs.
            let resolved = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let allowed: Vec<SocketAddr> = resolved
                .filter(|sa| !is_blocked_ip_enforced(sa.ip()))
                .collect();
            if allowed.is_empty() {
                // No public address survived the filter — fail the connection
                // rather than fall back to a blocked one.
                return Err(format!(
                    "SSRF guard: host {host:?} resolved only to blocked (non-global) addresses"
                )
                .into());
            }
            let addrs: Addrs = Box::new(allowed.into_iter());
            Ok(addrs)
        })
    }
}

// ---------------------------------------------------------------------------
// HTTP fetching
// ---------------------------------------------------------------------------

/// Maximum response body size (512 KB).
const MAX_BODY_SIZE: usize = 512 * 1024;

/// Return the process-global `reqwest::Client`, lazily built on first
/// use. `reqwest::Client` is `Arc`-backed, so cloning is cheap; the
/// `OnceLock` keeps us from re-building (a ~ms operation that would
/// thrash connection pooling if done per `fetch_metadata()` call).
fn shared_client() -> Result<reqwest::Client, AppError> {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(existing) = CELL.get() {
        return Ok(existing.clone());
    }
    // Redirect policy (#2661): keep the 5-hop limit, but ALSO re-validate
    // each hop's scheme + literal-IP host. hyper-util's connector parses a
    // literal-IP host directly and never calls `SsrfGuardResolver`, so
    // without this a redirect to e.g. `http://127.0.0.1/` would slip past the
    // resolver. Domain hosts on redirects still flow through the resolver
    // (DNS-rebinding stays covered).
    let redirect_policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() >= 5 {
            return attempt.error(AppError::InvalidOperation(
                "SSRF guard: too many redirects".to_string(),
            ));
        }
        match validate_url_target(attempt.url()) {
            Ok(()) => attempt.follow(),
            Err(reason) => attempt.error(AppError::InvalidOperation(format!(
                "SSRF guard: blocked redirect target: {reason}"
            ))),
        }
    });

    let built = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .redirect(redirect_policy)
        .dns_resolver(Arc::new(SsrfGuardResolver))
        .user_agent("Agaric/1.0")
        .build()
        .map_err(|e| AppError::InvalidOperation(format!("HTTP client error: {e}")))?;
    // Benign race: two threads may both get into `build()` on first
    // call; whichever `get_or_init`s first wins, the other's client
    // is dropped. Either way the stored client is a valid shared
    // handle.
    Ok(CELL.get_or_init(|| built).clone())
}

/// Fetch metadata for a URL by downloading the page and parsing HTML.
pub async fn fetch_metadata(url: &str) -> Result<LinkMetadata, AppError> {
    // SSRF guard (#2661): reject non-HTTP(S) schemes and literal-IP hosts in
    // a blocked range BEFORE opening any socket. Domain hosts are validated
    // at connect time by `SsrfGuardResolver` (and every redirect hop by the
    // custom redirect policy in `shared_client`).
    let parsed = url::Url::parse(url)
        .map_err(|e| AppError::InvalidOperation(format!("Invalid URL {url}: {e}")))?;
    if let Err(reason) = validate_url_target(&parsed) {
        return Err(AppError::InvalidOperation(format!(
            "SSRF guard: {reason} ({url})"
        )));
    }

    let client = shared_client()?;

    let response =
        client.get(url).send().await.map_err(|e| {
            AppError::InvalidOperation(format!("Network error fetching {url}: {e}"))
        })?;

    let status = response.status().as_u16();
    let final_url = response.url().to_string();

    // Short-circuit on non-2xx so 4xx/5xx HTML error pages
    // (e.g. a 404 with `<title>Page not found</title>`) don't get parsed
    // and cached as the target page's metadata.
    //
    // Classify the non-2xx into three terminal categories so
    // the frontend can render distinct UX:
    //   * `auth_required` (401/403): sign-in card / reauth flow
    //   * `not_found` (404/410): terminal "page is gone" presentation
    //   * neither flag, `title.is_none()`: transient (5xx / other) —
    //     the frontend infers "may retry later"
    //
    // #628: key the error-state row under the **requested** `url`, not
    // `final_url` — the cache upsert keys on `meta.url` and every lookup
    // (`get_cached(pool, &url)`) uses the requested url, so storing the
    // post-redirect `final_url` here meant a redirected non-2xx (e.g.
    // http→https→404) was cached under a key that is never queried and
    // refetched on every render. `final_url` stays relevant only for
    // `detect_auth_required` on the 2xx path below.
    if !response.status().is_success() {
        return Ok(LinkMetadata {
            url: url.to_string(),
            title: None,
            favicon_url: None,
            description: None,
            fetched_at: now_ms(),
            auth_required: status == 401 || status == 403,
            not_found: status == 404 || status == 410,
        });
    }

    // Check Content-Type — only fetch text/html
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_lowercase();

    let mime_type = content_type.split(';').next().unwrap_or("");

    if !mime_type.contains("text/html")
        && !mime_type.contains("text/xhtml")
        && !mime_type.contains("application/xhtml")
    {
        // Not HTML — return minimal metadata with no parsed fields.
        // This branch is only reachable when the status is 2xx (the
        // non-2xx short-circuit above already returned), so the
        // `auth_required` / `not_found` guards are defensive — they
        // will always be `false` here.
        return Ok(LinkMetadata {
            url: url.to_string(),
            title: None,
            favicon_url: parse_favicon("", url),
            description: None,
            fetched_at: now_ms(),
            auth_required: status == 401 || status == 403,
            not_found: status == 404 || status == 410,
        });
    }

    // Read body with size limit
    let body = read_body_limited(response, MAX_BODY_SIZE)
        .await
        .map_err(|e| {
            AppError::InvalidOperation(format!("Network error reading body from {url}: {e}"))
        })?;

    let title = parse_title(&body);
    let favicon_url = parse_favicon(&body, url);
    let description = parse_description(&body);
    let auth_required = detect_auth_required(status, url, &final_url, &body);

    Ok(LinkMetadata {
        url: url.to_string(),
        title,
        favicon_url,
        description,
        fetched_at: now_ms(),
        auth_required,
        // 2xx by construction (non-2xx short-circuited above) — the
        // "soft 404" / login-page detection lives entirely in
        // `auth_required` via `detect_auth_required`.
        not_found: false,
    })
}

/// Read a response body up to `max_bytes`, discarding excess.
///
/// Streams chunks via [`reqwest::Response::chunk`] and stops as soon as
/// the accumulator hits `max_bytes` (then drops the response, which closes
/// the connection and aborts the rest of the download). Pre-2025 this used
/// `response.bytes().await?`, which materialized the entire body into memory
/// before the size check — a misbehaving server returning gigabytes of data
/// would OOM the process. The contract is unchanged: the function never
/// errors on oversize input, it just returns the first `max_bytes` bytes
/// (lossy-decoded as UTF-8).
async fn read_body_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<String, reqwest::Error> {
    // Pre-size the accumulator from `Content-Length` when the server is
    // honest, capped at `max_bytes`. The header is untrusted — the per-chunk
    // bound below is the real safety net — but a useful heuristic to avoid
    // repeated reallocs on the common case.
    let cap = response
        .content_length()
        .and_then(|n| usize::try_from(n).ok())
        .map_or(0, |n| n.min(max_bytes));
    let mut buf: Vec<u8> = Vec::with_capacity(cap);

    while let Some(chunk) = response.chunk().await? {
        let remaining = max_bytes.saturating_sub(buf.len());
        if remaining == 0 {
            break;
        }
        if chunk.len() <= remaining {
            buf.extend_from_slice(&chunk);
        } else {
            buf.extend_from_slice(&chunk[..remaining]);
            break;
        }
    }

    // Explicitly drop the response so the underlying connection is closed
    // and any remaining body bytes are not pulled across the wire.
    drop(response);

    Ok(String::from_utf8_lossy(&buf).into_owned())
}

// ---------------------------------------------------------------------------
// DB operations (runtime queries, NOT compile-time macros)
// ---------------------------------------------------------------------------

/// Retrieve cached metadata for a URL.
pub async fn get_cached(pool: &SqlitePool, url: &str) -> Result<Option<LinkMetadata>, AppError> {
    let row = sqlx::query_as::<_, LinkMetadataRow>(
        "SELECT url, title, favicon_url, description, fetched_at, auth_required, not_found \
         FROM link_metadata WHERE url = ?",
    )
    .bind(url)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(Into::into))
}

/// Insert or replace cached metadata for a URL.
pub async fn upsert(pool: &SqlitePool, meta: &LinkMetadata) -> Result<(), AppError> {
    let auth_flag: i32 = i32::from(meta.auth_required);
    let not_found_flag: i32 = i32::from(meta.not_found);
    sqlx::query(
        "INSERT OR REPLACE INTO link_metadata \
         (url, title, favicon_url, description, fetched_at, auth_required, not_found) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&meta.url)
    .bind(&meta.title)
    .bind(&meta.favicon_url)
    .bind(&meta.description)
    .bind(meta.fetched_at)
    .bind(auth_flag)
    .bind(not_found_flag)
    .execute(pool)
    .await?;

    Ok(())
}

/// Delete stale non-auth entries older than `max_age_days`.
/// Returns the number of rows deleted.
pub async fn cleanup_stale(pool: &SqlitePool, max_age_days: u32) -> Result<u64, AppError> {
    // `fetched_at` is now epoch-ms (#109 Phase 2): subtract the window in ms
    // from the current instant rather than formatting an RFC 3339 cutoff.
    let cutoff_ms = now_ms() - i64::from(max_age_days) * 86_400_000;

    let result =
        sqlx::query("DELETE FROM link_metadata WHERE auth_required = 0 AND fetched_at < ?")
            .bind(cutoff_ms)
            .execute(pool)
            .await?;

    Ok(result.rows_affected())
}

// ---------------------------------------------------------------------------
// Internal DB row type
// ---------------------------------------------------------------------------

#[derive(Debug, sqlx::FromRow)]
struct LinkMetadataRow {
    url: String,
    title: Option<String>,
    favicon_url: Option<String>,
    description: Option<String>,
    fetched_at: i64,
    auth_required: i32,
    not_found: i32,
}

impl From<LinkMetadataRow> for LinkMetadata {
    fn from(row: LinkMetadataRow) -> Self {
        Self {
            url: row.url,
            title: row.title,
            favicon_url: row.favicon_url,
            description: row.description,
            fetched_at: row.fetched_at,
            auth_required: row.auth_required != 0,
            not_found: row.not_found != 0,
        }
    }
}
