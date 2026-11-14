# Session 4140 — Android's link-preview client trusts bundled roots, so the platform verifier is never asked

#6763 said that on Android an `https` link preview may abort the app: reqwest's certificate verifier there is `rustls-platform-verifier`, which panics unless the app has given it a JVM handle, and release builds abort on a panic. The session set out to check that trail against the resolved dependency graph and the crates' sources, then fix whatever was exposed. Nothing here was run on a device.

## The trail holds

Read from `cargo tree --workspace --target aarch64-linux-android -e features -i rustls-platform-verifier` and the sources in `~/.cargo/registry`:

- `rustls-platform-verifier` has one dependent in the Android graph, `reqwest`. Both of reqwest's public rustls features (`rustls`, `rustls-no-provider`) pull it; reqwest 0.13 has no feature that selects bundled roots instead.
- In `ClientBuilder::build`'s rustls branch reqwest installs `rustls_platform_verifier::Verifier::new` only when verification is on and `tls_certs_only` was not called. `tls_certs_only` builds a plain `RootCertStore` verifier, and a client given a whole `ClientConfig` (`tls_backend_preconfigured`) skips the branch.
- On Android `Verifier::new` succeeds and the first `verify_server_cert` reaches `android::global()`, which `expect`s a handle set only by the crate's five `init_*` functions. Nothing in this repo or in the registry sources of the graph (tauri, wry, tao, reqwest, iroh) calls one, and the Gradle project does not carry the crate's Kotlin component.

## Which clients are exposed

| Client | On Android | Exposed |
| --- | --- | --- |
| `link_metadata::shared_client` (agaric-store) | default verifier, reached by a paste, a hover or the link popover | **yes** |
| OTLP exporter (`agaric-observability`) | same default verifier, but built only when `AGARIC_OTEL` and an `AGARIC_OTEL_ENDPOINT` are in the process environment, and verifies only for an `https://` loopback collector | no: an app started by the launcher has neither variable |
| iroh (`net_report`, pkarr), `n0-dns-resolver` DoH | `tls_backend_preconfigured` with their own `ClientConfig` over `webpki-roots` | no |
| iroh-relay client | `tokio-websockets` over iroh's `CaTlsConfig`, whose default is `webpki-roots`; its `platform-verifier` feature is off | no |
| iroh QUIC (`noq`) | its own verifier for the peer's key | no |
| tauri's `reqwest::ClientBuilder` | compiled only under `cfg(all(dev, mobile))`, the dev-server proxy | no, not in an APK that ships |
| the release check | made in Kotlin (#6726) | no |
| `tauri-plugin-updater`, `tokio-tungstenite`, `rustls-native-certs` | not in the Android graph | no |

## Fix

Option (a) of the issue: on Android `shared_client` calls `with_bundled_roots`, which is `tls_certs_only` over `webpki-root-certs` (the Mozilla set as DER, a target dependency for Android only). No JNI, no Gradle change. The other option, initialising the verifier in `jni_on_load` and adding its Kotlin component, follows the phone's trust store but needs a patched generated Gradle project, an R8 keep rule and handles crossing from `jni 0.22` to the verifier's `jni 0.21`, none of which CI can run.

The trade: a CA the user installed on the phone is not trusted, so such a link stays a plain link. A failed fetch was already an `AppError` the UI handles.

`rustls-platform-verifier` stays in the Android graph, because reqwest cannot be built without it; the after-tree is identical to the before-tree. What changed is that the exposed client no longer installs it. `webpki-root-certs` appears under `agaric-store` for the Android target and under no desktop target's normal edges.

## Guard

`bundled_roots_client_never_consults_the_platform_trust_store` (Linux hosts): `SSL_CERT_FILE` makes the platform store hold one throwaway certificate, served by a local TLS stub. The negative control shows reqwest's default verifier trusts the stub; the guard shows a `with_bundled_roots` client refuses it as an unknown issuer. A reqwest update that routes `tls_certs_only` through the platform verifier reddens it. Falsified by swapping `tls_certs_only` for `tls_certs_merge`: red on the guard's `expect_err`.

Not covered on the host: that `shared_client` applies `with_bundled_roots` under `cfg(target_os = "android")`, and that a real site's chain verifies against the bundle. With the `cfg` forced on, the 90 `link_metadata` lib tests pass on Linux; the phone check is a line on #6513.

## Traps

- `rcgen` (dev-only, for the throwaway certificate) adds 14 packages to `Cargo.lock`, most through a weak `x509-parser?` feature that is never built, and re-resolves `quinn-udp`'s `windows-sys` edge to a version already in the lock. A committed key would have needed a `detect-private-key` exclusion instead.
- `cargo nextest run -p agaric-store` builds the non-test lib too, where the Android-only dependency is absent on the host: forcing the `cfg` for a host run needs `--lib`.

## Shipped

One PR for #6763. Ran: the new test and its falsification, the `link_metadata` tests, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo deny check`, `cargo audit`, and the pre-push verify.
