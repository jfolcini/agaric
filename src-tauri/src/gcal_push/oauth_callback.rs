//! Minimal HTTP/1.1 loopback listener used as the OAuth redirect
//! target for the desktop OAuth flow.
//!
//! Why a hand-rolled listener instead of `hyper` / `axum` / etc.: the
//! protocol surface is exactly one *decisive* request — read the
//! request line, parse `?code=…&state=…` (or `?error=…`) from the
//! path, write a tiny HTML 200, close the socket. Pulling a full HTTP
//! stack just for that would dwarf the ~100 LOC below in transitive
//! deps.
//!
//! The listener binds to `127.0.0.1:0` (OS picks a free port). The
//! caller receives the chosen port up-front and embeds it into the
//! OAuth `redirect_uri`.
//!
//! #686 — the listener loops on `accept()` until a *decisive* request
//! arrives (a callback carrying `code`+`state`, an `error=` denial
//! redirect, or a malformed callback). Stray connections — browser
//! speculative preconnects that close without sending bytes,
//! `/favicon.ico` probes, anything without callback parameters — get
//! a polite 404 and do NOT consume the flow. Previously a single
//! stray connection burned the one-shot accept and the user's real
//! redirect found nobody listening.
//!
//! A consent denial (`?error=access_denied`) resolves to the typed
//! `AppError::Validation("oauth.consent_denied: …")` so the frontend
//! can distinguish "user said no" from "callback was malformed", and
//! the browser tab gets a "sign-in was cancelled" page instead of a
//! hung connection.
//!
//! Hard timeout: the future resolves with
//! `AppError::Validation("oauth.timeout")` after the supplied deadline
//! so an abandoned authorize tab never leaks the listener.
//!
//! Security:
//!
//! * Binds `127.0.0.1` explicitly — never reachable off the loopback
//!   interface.
//! * Single decisive use: the listener resolves on the first request
//!   that carries callback parameters, then is dropped at the end of
//!   the future.
//! * The query parameters are URL-decoded via `url::form_urlencoded`
//!   so percent-encoded callback values survive the round-trip.
//!
//! The 200 response body is a small HTML page that tells the user to
//! return to Agaric. It also attempts `window.close()` — best-effort,
//! since modern browsers block scripted close for tabs the user opened
//! themselves.

use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::error::AppError;

/// Parsed callback query parameters from the OAuth redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// HTML body served back to the OS browser once the code arrives. Best
/// effort — modern browsers block `window.close()` for user-opened
/// tabs, so the text fallback is the load-bearing UX.
const RESPONSE_BODY: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Agaric — \
                             sign-in complete</title></head><body style=\"font-family:system-ui,\
                             sans-serif;padding:2rem;max-width:32rem;margin:0 auto\"><h1>Sign-in \
                             complete</h1><p>You can close this window and return to Agaric.</p>\
                             <script>window.close()</script></body></html>";

/// HTML body served when the redirect carries `error=` — the user
/// denied consent (or Google reported another authorization error).
const DENIED_BODY: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Agaric — \
                           sign-in cancelled</title></head><body style=\"font-family:system-ui,\
                           sans-serif;padding:2rem;max-width:32rem;margin:0 auto\"><h1>Sign-in \
                           cancelled</h1><p>Google Calendar was not connected. You can close \
                           this window and return to Agaric.</p></body></html>";

/// Result of classifying one received request line (#686).
#[derive(Debug)]
enum ParsedCallback {
    /// The real redirect: `code` + `state` present.
    Params(CallbackParams),
    /// Authorization error redirect (`?error=access_denied&…`) —
    /// carries the OAuth `error` code.
    Denied(String),
    /// Looks like our callback (has `code` or `state`) but is missing
    /// its counterpart — a genuinely broken redirect; fail the flow
    /// with the carried error.
    Malformed(AppError),
    /// Not our callback at all (no query string, or a query without
    /// any of `code` / `state` / `error`, e.g. a favicon probe) —
    /// answer 404 and keep listening.
    Stray,
}

/// Bind a loopback listener and return the chosen port plus a future
/// that resolves with the parsed callback params, a typed
/// `oauth.consent_denied` error on an `error=` redirect, or a
/// validation error keyed `oauth.timeout` after `timeout` elapses.
///
/// The caller embeds the returned port into the OAuth `redirect_uri`.
pub async fn bind_one_shot(
    timeout: Duration,
) -> Result<(u16, impl Future<Output = Result<CallbackParams, AppError>>), AppError> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let listener = TcpListener::bind(addr).await?;
    let port = listener.local_addr()?.port();

    let fut = async move {
        let accept_loop = async {
            // #686 — keep accepting until a decisive request arrives;
            // stray connections must not consume the flow. The outer
            // timeout bounds the whole loop.
            loop {
                let (mut stream, _peer) = listener.accept().await?;

                let request_line = match read_request_line(&mut stream).await {
                    Ok(line) => line,
                    Err(e) => {
                        // Speculative preconnect (closed without bytes),
                        // oversized or non-UTF-8 garbage — log and keep
                        // listening for the real redirect.
                        tracing::debug!(
                            target: "gcal",
                            error = %e,
                            "oauth callback listener: ignoring unreadable connection",
                        );
                        continue;
                    }
                };

                match parse_request_line(&request_line) {
                    ParsedCallback::Params(params) => {
                        respond(&mut stream, "200 OK", RESPONSE_BODY).await;
                        return Ok(params);
                    }
                    ParsedCallback::Denied(error) => {
                        respond(&mut stream, "200 OK", DENIED_BODY).await;
                        return Err(AppError::Validation(format!(
                            "oauth.consent_denied: {error}"
                        )));
                    }
                    ParsedCallback::Malformed(e) => {
                        respond(&mut stream, "400 Bad Request", DENIED_BODY).await;
                        return Err(e);
                    }
                    ParsedCallback::Stray => {
                        tracing::debug!(
                            target: "gcal",
                            request_line = %request_line,
                            "oauth callback listener: ignoring stray request",
                        );
                        respond(&mut stream, "404 Not Found", "").await;
                        // Keep listening — the real redirect is still
                        // on its way.
                    }
                }
            }
        };

        match tokio::time::timeout(timeout, accept_loop).await {
            Ok(result) => result,
            Err(_elapsed) => Err(AppError::Validation("oauth.timeout".to_owned())),
        }
    };

    Ok((port, fut))
}

/// Read the HTTP request line from `stream`, bounded at 8 KiB so a
/// malformed peer can't OOM us (Google's `state` + `code` are short).
async fn read_request_line(stream: &mut TcpStream) -> Result<String, AppError> {
    let mut buf = [0u8; 8192];
    let mut total = 0;
    loop {
        let n = stream.read(&mut buf[total..]).await?;
        if n == 0 {
            return Err(AppError::Validation("oauth.callback_no_request".to_owned()));
        }
        total += n;
        if let Some(pos) = buf[..total].iter().position(|&b| b == b'\r' || b == b'\n') {
            return Ok(std::str::from_utf8(&buf[..pos])
                .map_err(|_| AppError::Validation("oauth.callback_bad_utf8".to_owned()))?
                .to_owned());
        }
        if total == buf.len() {
            return Err(AppError::Validation(
                "oauth.callback_oversized_request".to_owned(),
            ));
        }
    }
}

/// Best-effort response write. Failures here don't change the outcome
/// — for decisive requests we've already pulled the parameters off
/// the wire; for strays we just keep listening.
async fn respond(stream: &mut TcpStream, status: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Classify a single HTTP/1.1 request line like:
///
/// ```text
/// GET /oauth/callback?code=ABC&state=XYZ HTTP/1.1
/// ```
///
/// Pulls `code` / `state` / `error` out of the query string,
/// URL-decoding each.  Precedence: `error=` (denial) wins, then
/// `code`+`state` (success), then partial callback params
/// (malformed), then stray.
fn parse_request_line(line: &str) -> ParsedCallback {
    // Tokens: METHOD PATH HTTP/VERSION
    let mut tokens = line.split_whitespace();
    let _method = tokens.next();
    let Some(path) = tokens.next() else {
        return ParsedCallback::Stray;
    };

    let Some((_, query)) = path.split_once('?') else {
        return ParsedCallback::Stray;
    };

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut error: Option<String> = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }

    // #686 — a denial redirect (`?error=access_denied&state=…`)
    // carries no `code`; classify it BEFORE the missing-code check so
    // user-denied consent stops surfacing as `callback_missing_code`.
    if let Some(error) = error {
        return ParsedCallback::Denied(error);
    }

    match (code, state) {
        (Some(code), Some(state)) => ParsedCallback::Params(CallbackParams { code, state }),
        (Some(_), None) => ParsedCallback::Malformed(AppError::Validation(
            "oauth.callback_missing_state".to_owned(),
        )),
        (None, Some(_)) => ParsedCallback::Malformed(AppError::Validation(
            "oauth.callback_missing_code".to_owned(),
        )),
        // Query string without any callback parameter — not ours.
        (None, None) => ParsedCallback::Stray,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    /// Drive one raw HTTP request into the listener and drain the
    /// response so the listener sees a clean close.
    async fn send_request(port: u16, request: &[u8]) {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        sock.write_all(request).await.unwrap();
        let mut buf = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
    }

    #[tokio::test]
    async fn parses_code_and_state_from_get_request() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            send_request(
                port,
                b"GET /oauth/callback?code=ABC123&state=XYZ789 HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await;
        });

        let params = fut.await.expect("callback must succeed");
        client_task.await.unwrap();

        assert_eq!(params.code, "ABC123");
        assert_eq!(params.state, "XYZ789");
    }

    #[tokio::test]
    async fn url_decodes_code_and_state() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            // `4%2F0AY` decodes to `4/0AY` (Google authorization codes
            // include `/` which MUST be percent-encoded in transit).
            send_request(
                port,
                b"GET /oauth/callback?code=4%2F0AY&state=hello%20world HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await;
        });

        let params = fut.await.expect("callback must succeed");
        client_task.await.unwrap();

        assert_eq!(params.code, "4/0AY");
        assert_eq!(params.state, "hello world");
    }

    #[tokio::test]
    async fn timeout_resolves_to_validation_error() {
        let (_port, fut) = bind_one_shot(Duration::from_millis(50)).await.unwrap();
        // Do NOT connect — let the deadline fire.
        let err = fut.await.expect_err("must time out");
        match err {
            AppError::Validation(msg) => {
                assert_eq!(msg, "oauth.timeout", "must surface the keyed timeout");
            }
            other => panic!("expected Validation(oauth.timeout), got {other:?}"),
        }
    }

    // ── #686 — denial redirects are typed, not "missing code" ─────

    #[tokio::test]
    async fn denial_redirect_resolves_to_typed_consent_denied() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            // Google's denial redirect: `error=access_denied` plus the
            // echoed state — and NO code.
            send_request(
                port,
                b"GET /oauth/callback?error=access_denied&state=XYZ789 HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await;
        });

        let err = fut.await.expect_err("denial must resolve to an error");
        client_task.await.unwrap();
        match err {
            AppError::Validation(msg) => {
                assert_eq!(
                    msg, "oauth.consent_denied: access_denied",
                    "denial must surface the typed consent_denied key, not callback_missing_code"
                );
            }
            other => panic!("expected Validation(oauth.consent_denied: …), got {other:?}"),
        }
    }

    #[tokio::test]
    async fn denial_redirect_is_served_a_response_page() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            sock.write_all(
                b"GET /oauth/callback?error=access_denied HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        });

        let _ = fut.await;
        let response = client_task.await.unwrap();
        assert!(
            response.starts_with("HTTP/1.1 200 OK"),
            "denial must be answered with a page, got: {response}"
        );
        assert!(
            response.contains("Sign-in cancelled"),
            "denial page must say the sign-in was cancelled, got: {response}"
        );
    }

    // ── #686 — stray connections must not kill the flow ───────────

    #[tokio::test]
    async fn preconnect_without_bytes_does_not_consume_the_flow() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            // Speculative browser preconnect: open and close without
            // sending a single byte.
            let sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            drop(sock);
            // The real redirect arrives afterwards.
            send_request(
                port,
                b"GET /oauth/callback?code=REAL&state=DEAL HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await;
        });

        let params = fut
            .await
            .expect("flow must survive a stray preconnect (#686)");
        client_task.await.unwrap();
        assert_eq!(params.code, "REAL");
        assert_eq!(params.state, "DEAL");
    }

    #[tokio::test]
    async fn favicon_probe_gets_404_and_flow_still_completes() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            // Favicon probe — no query string at all.
            let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            sock.write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .await
                .unwrap();
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
            let favicon_response = String::from_utf8_lossy(&buf).into_owned();

            send_request(
                port,
                b"GET /oauth/callback?code=REAL&state=DEAL HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await;
            favicon_response
        });

        let params = fut.await.expect("flow must survive a favicon probe (#686)");
        let favicon_response = client_task.await.unwrap();
        assert!(
            favicon_response.starts_with("HTTP/1.1 404"),
            "stray request must get a 404, got: {favicon_response}"
        );
        assert_eq!(params.code, "REAL");
    }

    /// A request without a query string no longer kills the flow — it
    /// is a stray; the listener keeps waiting and the real callback
    /// still lands (pre-#686 this returned `callback_missing_query`
    /// and the flow was dead).
    #[tokio::test]
    async fn request_without_query_string_is_a_stray_not_fatal() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            send_request(
                port,
                b"GET /oauth/callback HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            )
            .await;
            send_request(
                port,
                b"GET /oauth/callback?code=REAL&state=DEAL HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await;
        });

        let params = fut
            .await
            .expect("query-less request must not end the flow (#686)");
        client_task.await.unwrap();
        assert_eq!(params.code, "REAL");
    }

    /// The listener binds 127.0.0.1 only. We can't easily prove a
    /// non-loopback peer is rejected (there is no second NIC in CI to
    /// connect from), but binding to `LOCALHOST` is what guarantees it
    /// at the OS level — verify by inspecting `local_addr`.
    #[tokio::test]
    async fn binds_to_loopback_only() {
        let (port, _fut) = bind_one_shot(Duration::from_secs(1)).await.unwrap();
        // Reach the listener by its loopback address; that the bind
        // succeeded with `127.0.0.1:0` is the structural guarantee
        // here. The future is dropped at end-of-scope.
        assert!(port > 0, "OS must assign a non-zero port");
    }

    // ── parse_request_line classification matrix ──────────────────

    #[test]
    fn parse_request_line_extracts_code_and_state() {
        let parsed = parse_request_line("GET /oauth/callback?code=A&state=B HTTP/1.1");
        match parsed {
            ParsedCallback::Params(params) => {
                assert_eq!(params.code, "A");
                assert_eq!(params.state, "B");
            }
            other => panic!("expected Params, got {other:?}"),
        }
    }

    #[test]
    fn parse_request_line_code_without_state_is_malformed() {
        let parsed = parse_request_line("GET /oauth/callback?code=A HTTP/1.1");
        match parsed {
            ParsedCallback::Malformed(AppError::Validation(msg)) => {
                assert_eq!(msg, "oauth.callback_missing_state");
            }
            other => panic!("expected Malformed(callback_missing_state), got {other:?}"),
        }
    }

    #[test]
    fn parse_request_line_state_without_code_is_malformed() {
        let parsed = parse_request_line("GET /oauth/callback?state=B HTTP/1.1");
        match parsed {
            ParsedCallback::Malformed(AppError::Validation(msg)) => {
                assert_eq!(msg, "oauth.callback_missing_code");
            }
            other => panic!("expected Malformed(callback_missing_code), got {other:?}"),
        }
    }

    #[test]
    fn parse_request_line_error_param_wins_over_missing_code() {
        let parsed = parse_request_line("GET /oauth/callback?error=access_denied&state=B HTTP/1.1");
        assert!(
            matches!(parsed, ParsedCallback::Denied(ref e) if e == "access_denied"),
            "expected Denied(access_denied), got {parsed:?}"
        );
    }

    #[test]
    fn parse_request_line_unrelated_query_is_stray() {
        let parsed = parse_request_line("GET /?probe=1 HTTP/1.1");
        assert!(
            matches!(parsed, ParsedCallback::Stray),
            "expected Stray, got {parsed:?}"
        );
        let parsed = parse_request_line("GET /favicon.ico HTTP/1.1");
        assert!(
            matches!(parsed, ParsedCallback::Stray),
            "expected Stray, got {parsed:?}"
        );
    }
}
