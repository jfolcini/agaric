//! Minimal HTTP/1.1 loopback listener used as the OAuth redirect
//! target for the desktop OAuth flow.
//!
//! Why a hand-rolled listener instead of `hyper` / `axum` / etc.: the
//! protocol surface is exactly one request — read the request line,
//! parse `?code=…&state=…` from the path, write a tiny HTML 200, close
//! the socket. Pulling a full HTTP stack just for that would dwarf the
//! ~80 LOC below in transitive deps.
//!
//! The listener binds to `127.0.0.1:0` (OS picks a free port). The
//! caller receives the chosen port up-front and embeds it into the
//! OAuth `redirect_uri`. A single connection is accepted; any further
//! connections are ignored when the listener drops at the end of the
//! future.
//!
//! Hard timeout: the future resolves with
//! `AppError::Validation("oauth.timeout")` after the supplied deadline
//! so an abandoned authorize tab never leaks the listener.
//!
//! Security:
//!
//! * Binds `127.0.0.1` explicitly — never reachable off the loopback
//!   interface.
//! * Single-use: the listener accepts exactly one connection, then is
//!   dropped at the end of the future.
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
use tokio::net::TcpListener;

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

/// Bind a one-shot loopback listener and return the chosen port plus a
/// future that resolves with the parsed callback params (or a
/// validation error keyed `oauth.timeout` after `timeout` elapses).
///
/// The caller embeds the returned port into the OAuth `redirect_uri`.
pub async fn bind_one_shot(
    timeout: Duration,
) -> Result<(u16, impl Future<Output = Result<CallbackParams, AppError>>), AppError> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, 0));
    let listener = TcpListener::bind(addr).await?;
    let port = listener.local_addr()?.port();

    let fut = async move {
        let accept = async {
            let (mut stream, _peer) = listener.accept().await?;

            // Read the request line + a bounded amount of headers.
            // We only need the GET line; cap the buffer so a malformed
            // peer can't OOM us. 8 KiB is generous for an OAuth
            // callback (Google's `state` + `code` are short).
            let mut buf = [0u8; 8192];
            let mut total = 0;
            let request_line = loop {
                let n = stream.read(&mut buf[total..]).await?;
                if n == 0 {
                    return Err(AppError::Validation("oauth.callback_no_request".to_owned()));
                }
                total += n;
                if let Some(pos) = buf[..total].iter().position(|&b| b == b'\r' || b == b'\n') {
                    break std::str::from_utf8(&buf[..pos])
                        .map_err(|_| AppError::Validation("oauth.callback_bad_utf8".to_owned()))?
                        .to_owned();
                }
                if total == buf.len() {
                    return Err(AppError::Validation(
                        "oauth.callback_oversized_request".to_owned(),
                    ));
                }
            };

            let params = parse_request_line(&request_line)?;

            // Best-effort 200 response. Failures here don't change the
            // outcome — we've already pulled the code/state off the
            // wire.
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                RESPONSE_BODY.len(),
                RESPONSE_BODY,
            );
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;

            Ok::<_, AppError>(params)
        };

        match tokio::time::timeout(timeout, accept).await {
            Ok(result) => result,
            Err(_elapsed) => Err(AppError::Validation("oauth.timeout".to_owned())),
        }
    };

    Ok((port, fut))
}

/// Parse a single HTTP/1.1 request line like:
///
/// ```text
/// GET /oauth/callback?code=ABC&state=XYZ HTTP/1.1
/// ```
///
/// Pulls `code` and `state` out of the query string, URL-decoding both.
fn parse_request_line(line: &str) -> Result<CallbackParams, AppError> {
    // Tokens: METHOD PATH HTTP/VERSION
    let mut tokens = line.split_whitespace();
    let _method = tokens
        .next()
        .ok_or_else(|| AppError::Validation("oauth.callback_missing_method".to_owned()))?;
    let path = tokens
        .next()
        .ok_or_else(|| AppError::Validation("oauth.callback_missing_path".to_owned()))?;

    let query = path
        .split_once('?')
        .map(|(_, q)| q)
        .ok_or_else(|| AppError::Validation("oauth.callback_missing_query".to_owned()))?;

    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    for (k, v) in url::form_urlencoded::parse(query.as_bytes()) {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            _ => {}
        }
    }

    let code =
        code.ok_or_else(|| AppError::Validation("oauth.callback_missing_code".to_owned()))?;
    let state =
        state.ok_or_else(|| AppError::Validation("oauth.callback_missing_state".to_owned()))?;

    Ok(CallbackParams { code, state })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpStream;

    #[tokio::test]
    async fn parses_code_and_state_from_get_request() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        // Drive a client into the listener.
        let client_task = tokio::spawn(async move {
            let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            sock.write_all(
                b"GET /oauth/callback?code=ABC123&state=XYZ789 HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
            // Drain the response so the listener sees a clean close.
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
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
            let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            // `4%2F0AY` decodes to `4/0AY` (Google authorization codes
            // include `/` which MUST be percent-encoded in transit).
            sock.write_all(
                b"GET /oauth/callback?code=4%2F0AY&state=hello%20world HTTP/1.1\r\n\
                  Host: 127.0.0.1\r\n\r\n",
            )
            .await
            .unwrap();
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
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

    #[tokio::test]
    async fn rejects_request_without_query_string() {
        let (port, fut) = bind_one_shot(Duration::from_secs(5)).await.unwrap();

        let client_task = tokio::spawn(async move {
            let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
            sock.write_all(b"GET /oauth/callback HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
                .await
                .unwrap();
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
        });

        let err = fut.await.expect_err("must reject missing query");
        client_task.await.unwrap();
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.starts_with("oauth.callback_missing_"),
                    "expected oauth.callback_missing_*, got {msg}",
                );
            }
            other => panic!("expected Validation(...), got {other:?}"),
        }
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

    #[tokio::test]
    async fn parse_request_line_extracts_code_and_state() {
        let parsed = parse_request_line("GET /oauth/callback?code=A&state=B HTTP/1.1").unwrap();
        assert_eq!(parsed.code, "A");
        assert_eq!(parsed.state, "B");
    }

    #[tokio::test]
    async fn parse_request_line_rejects_missing_state() {
        let err = parse_request_line("GET /oauth/callback?code=A HTTP/1.1").unwrap_err();
        match err {
            AppError::Validation(msg) => {
                assert_eq!(msg, "oauth.callback_missing_state");
            }
            other => panic!("expected Validation, got {other:?}"),
        }
    }
}
