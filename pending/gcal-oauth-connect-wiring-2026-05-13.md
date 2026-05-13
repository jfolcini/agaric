# GCal "Connect Google account" — wire up the desktop OAuth flow

> Status: ready for review.
> Triggered by: clicking *Connect Google account* in Settings → Google Calendar shows a red `gcal.connectFailed` toast and nothing happens. Root cause: the frontend invokes a Tauri command (`begin_gcal_oauth`) that does not exist on the Rust side. The OAuth machinery in `gcal_push::oauth` is unreachable from the UI.

## What's missing today

Frontend: `src/components/GoogleCalendarSettingsTab.tsx:317` calls `invoke('begin_gcal_oauth')`. Tauri's invoke layer rejects unknown commands; `useIpcCommand`'s `onError` fires the `gcal.connectFailed` toast.

Backend: only five GCal commands are registered (`src-tauri/src/lib.rs:234-238`) — `get_gcal_status`, `force_gcal_resync`, `disconnect_gcal`, `set_gcal_window_days`, `set_gcal_privacy_mode`. The OAuth client (`src-tauri/src/gcal_push/oauth.rs:404 begin_authorize`, `:457 exchange_code`, `:691 persist_oauth_account_email`) exists and is fully tested in isolation, but **no Tauri command wraps it and there is no callback transport** — no loopback listener, no deep-link plugin, no IPC entry point to receive `code` + `state` back from the OS browser. The component docstring openly notes this: *"`begin_gcal_oauth` (exposed by FEAT-5b's OAuth wiring)"* — that wiring was never landed.

The connector itself reads tokens through `KeyringTokenStore` and detects re-auth needs via the `gcal:reauth_required` event (FEATURE-MAP.md line 757), so the moment tokens land in the keyring the existing connector picks them up on its next cycle. **The only gap is getting tokens into the keyring.**

## Why loopback (not `tauri-plugin-deep-link`)

1. **Google's installed-app guidance.** Google's OAuth 2.0 docs split desktop and mobile. Desktop is `Loopback IP redirect` (`http://127.0.0.1:<port>`). The OOB / `urn:ietf:wg:oauth:2.0:oob` flow is deprecated. Custom URI schemes are not an allowed redirect for the *Desktop app* client-ID category — those require an *Android app* / *iOS app* client which gates on package signature / bundle ID checks the desktop binary cannot satisfy.
2. **Dev-loop and security.** Custom-scheme deep links are registered with the OS via per-platform side effects (`Info.plist` on macOS, `.desktop` MIME entry on Linux, `HKCU\Software\Classes` on Windows). Those registrations only happen for the *installed* binary; `cargo tauri dev` does not register the scheme, so the round-trip is untestable in dev. They are also not exclusive — any other app can claim `agaric://` and hijack callbacks. Loopback has none of this: bind `127.0.0.1` on a port the listener picks at runtime, advertise that exact `redirect_uri` in the authorize URL, browser hits it, listener takes the code, shuts down. Identical behaviour in dev, packaged, and portable builds. The redirect URL is unguessable per-flow.
3. **Mobile is a different flow.** Android Custom Tabs + App Links and iOS `ASWebAuthenticationSession` + Universal Links are platform-native APIs, not what `tauri-plugin-deep-link` provides. Android is already deferred per `pending/REVIEW-LATER.md` line 25; mobile is out of scope for this plan.

`tauri-plugin-deep-link` is the right tool for *intra-app* deep links (`agaric://block/<ulid>`, "Open in Agaric" share-sheet), not OAuth transport. Different problem; pick it up if/when it's needed for that.

## The fix

### 1. New Rust command `begin_gcal_oauth`

`src-tauri/src/commands/gcal.rs`. Two new commands and one supporting helper.

```rust
#[derive(serde::Serialize)]
pub struct BeginOauthOutcome {
    pub account_email: Option<String>,
}

#[tauri::command]
pub async fn begin_gcal_oauth(
    app: tauri::AppHandle,
    oauth_client: tauri::State<'_, GcalOAuthClientState>,
    token_store: tauri::State<'_, GcalTokenStoreState>,
    pools: tauri::State<'_, PoolsState>,
) -> Result<BeginOauthOutcome, AppError> {
    // 1. Bind a loopback TcpListener on 127.0.0.1:0 (OS picks a free port).
    // 2. Build the redirect URI string: format!("http://127.0.0.1:{port}/oauth/callback").
    // 3. Call OAuthClient::begin_authorize(redirect_uri) -> AuthorizeUrl { url, state }.
    //    (begin_authorize signature gains a `redirect_uri: String` arg — today it's
    //     hard-coded; thread the per-flow URI through so each flow gets its own port.)
    // 4. Spawn a tokio task: accept ONE connection, parse the GET line for `code` + `state`,
    //    write a small HTML response ("You can close this window"), close socket, drop listener.
    //    Hard-cap the wait at 5 minutes via tokio::time::timeout — abandoned flows must not leak.
    // 5. Open the authorize URL in the OS browser via tauri_plugin_shell::ShellExt::shell::open.
    // 6. await the callback channel; on receipt:
    //    a. OAuthClient::exchange_code(code, state) -> (Token, Option<email>).
    //    b. token_store.set(token).await    — KeyringTokenStore writes via OS keychain.
    //    c. persist_oauth_account_email(pool, email) — clears reauth_required + records email.
    // 7. Return BeginOauthOutcome { account_email }.
    // The connector picks up the new token on its next loop (already plumbed).
}
```

Register in `src-tauri/src/lib.rs:234-238` alongside the other five gcal commands. Add `commands::GcalOAuthClientState(Arc::new(OAuthClient::new(...)))` to the `app.manage(...)` block at `lib.rs:1252-1254`.

The existing `OAuthClient` is constructed once today inside `gcal_push::connector::spawn_connector`; pull that construction up to the same place the connector is spawned (around `lib.rs:1200`) and share the `Arc<OAuthClient>` between the connector and the new command. The PKCE cache lives on the client, so a single shared instance is required for the verifier to be findable when the callback fires.

### 2. Loopback listener as a focused module

`src-tauri/src/gcal_push/oauth_callback.rs` (new). Keeps the HTTP handling out of `commands/gcal.rs` so the command stays declarative.

```rust
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

/// Bind a loopback listener, return the chosen port + a future that resolves
/// when the OAuth provider redirects to it. Caller embeds the port into the
/// authorize URL's redirect_uri.
pub async fn bind_one_shot(timeout: Duration)
    -> Result<(u16, impl Future<Output = Result<CallbackParams, AppError>>), AppError>;
```

Implementation: raw `tokio::net::TcpListener` + manual line parsing on the request. Avoid pulling in `hyper` / `axum` — the protocol surface is "read one HTTP/1.1 GET line, parse `?code=…&state=…` from the URL, write a 200 with a small HTML body, close". ~80 LOC including error handling. The codebase already depends on `tokio` with `net` features (`src-tauri/Cargo.toml` line shows `features = [..., "net", ...]`); no new dep.

The HTML response is a single-page "You can close this window and return to Agaric." with a `<script>window.close()</script>` (best-effort — modern browsers block `window.close()` for tabs the user opened, but it's a free attempt).

Hard timeout: 5 minutes. Abandoned listeners exit on the timeout branch.

Bind to `127.0.0.1` only (not `0.0.0.0`) — the listener should never be reachable from outside the loopback interface.

### 3. Frontend changes (small)

`src/components/GoogleCalendarSettingsTab.tsx`.

- The existing call site (`:316-326`) already has the right shape — `invoke('begin_gcal_oauth')` + `loadStatus()` on success + error toast. Once the backend lands the command, the FE works as-is.
- Two polish improvements:
  - The button needs a `disabled` + `aria-busy` while the IPC is in flight (the OAuth round-trip is user-paced — they have to consent in the browser — and can take 30s+). A spinner / "Waiting for browser…" label is better than a stuck button.
  - The `gcal.connectFailed` toast string today is generic. Surface the specific failure modes: `oauth.timeout` ("Timed out waiting for Google sign-in. Please try again."), `oauth.invalid_state` ("Sign-in could not be verified. Please try again."), `oauth.exchange_failed` ("Google rejected the sign-in. Check your network and try again."). The existing `OAuthClient::exchange_code` already returns these as keyed `AppError::Validation` variants (see `oauth.rs:451-455`); plumb them through `useIpcCommand`'s error payload.

### 4. Configuration: Google client ID

The OAuth client today is constructed from compile-time constants in `gcal_push::oauth::OAuthClient::new`. Verify the *Desktop app* client ID is real and present (it may be a placeholder in dev). If missing or misconfigured, the authorize URL will 400 from Google's side; surface this as a dedicated `oauth.client_misconfigured` error so devs aren't chasing the wrong bug. Out of scope: changing how the client ID is provisioned (env var vs build-time const) — that's a separate decision.

## Verification

- `cargo test -p agaric-tauri gcal_push::oauth_callback` — unit tests for the loopback listener (parses `code` + `state`, returns `Timeout` after the deadline, refuses non-loopback connections by virtue of bind addr).
- `cargo test -p agaric-tauri commands::gcal::tests::begin_oauth_*` — happy path with a fake `OAuthClient` that short-circuits `exchange_code`; verifies the token is written to the test `TokenStore` and the email is persisted.
- `npm run test -- GoogleCalendarSettingsTab` — existing tests already mock `invoke('begin_gcal_oauth')` (the test file checks both success and rejection paths); add cases for the new typed error toasts.
- Manual end-to-end (one of the few flows that genuinely needs a real browser): click *Connect*, Chrome opens, sign in, redirect to `127.0.0.1:<port>`, dialog reflects connected state, calendar list loads, an event push round-trips. Run from `cargo tauri dev` to confirm the dev-build path works (one of the loopback-vs-deep-link advantages).

## Cost / impact / risk

| Dimension | Notes |
| --- | --- |
| **Cost** | M. Backend command + loopback module: ~0.5 day. Threading `OAuthClient` as shared `Arc` state + the `begin_authorize(redirect_uri)` signature change: ~2 hours (touches the connector spawn site too). Frontend polish (busy state + typed errors): ~2 hours. Tests: ~3 hours. End-to-end manual verification: ~1 hour. Total: 1.5–2 days. |
| **Impact** | Closes the only path to using GCal sync at all on a fresh install. Removes the dead "(exposed by FEAT-5b's OAuth wiring)" docstring lie. Unblocks the entire FEAT-5 feature for users on desktop. The MAINT-216 reauth banner (separately tracked in `REVIEW-LATER.md`) becomes actionable — its "Reconnect" button can call this same command. |
| **Risk** | Low. Localised to gcal_push + commands/gcal + lib.rs registration. The loopback listener is short, single-use, hard-timeout-bounded, bound to 127.0.0.1 only. No new dependency. No platform-conditional code. The only fragile bit is the dev-time Google client-ID config — a real misconfiguration shows up as `oauth.client_misconfigured` and is a one-time fix. |
| **Reversibility** | High. Pure additions on the backend (one new command, one new module, one new shared `Arc` in app state). FE changes are diff-able. Easy to revert. |

## Out of scope

- Android / iOS OAuth (deferred per `pending/REVIEW-LATER.md` line 25 — needs Custom Tabs + App Links / Universal Links + a separate Google client per platform).
- The MAINT-216 "Reconnect" banner that listens to `gcal:reauth_required`. That's separately tracked; this plan makes the *Reconnect* action wire-able by giving it a working IPC to call.
- Switching from compile-time client-ID constants to runtime config / env vars.
- Any UX changes beyond busy-state + typed error messages on the Connect button.
- `tauri-plugin-deep-link` for any purpose. Picked up separately if intra-app deep links are wanted.
