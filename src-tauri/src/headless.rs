//! The app with no window system: the production invoke handler
//! ([`crate::build_invoke_handler`] over [`agaric_commands!`]) and the
//! production managed state ([`crate::register_managed_state`]) on
//! `tauri::test::MockRuntime`, with a mock webview to deliver IPC through.
//!
//! A call through [`HeadlessApp::invoke`] crosses what a frontend `invoke()`
//! crosses: tauri's argument decoding, `State` extraction, the
//! `#[tauri::command]` wrapper with the events it emits, and the error's
//! serialization. Only the transport differs.
//!
//! It holds the state [`crate::register_managed_state`] registers and no
//! more: a command that reads state `setup_app` registers elsewhere (the
//! mirror, MCP, the mDNS status) is refused by tauri as unmanaged.
//!
//! Compiled under `test-util` only, so nothing here ships.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::Manager as _;
use tauri::test::MockRuntime;

/// A headless app's own app-data directory.
/// [`crate::app_paths::resolve_app_data_dir`] answers it before the env and OS
/// lookup, because the env override is process-global and one test process
/// holds many apps.
#[derive(Clone)]
pub struct HeadlessDataDir(pub PathBuf);

pub struct HeadlessApp {
    pub app: tauri::App<MockRuntime>,
    webview: tauri::WebviewWindow<MockRuntime>,
}

impl HeadlessApp {
    /// An app over an already-open vault. The caller owns the vault: its
    /// directory, and draining its materializer.
    #[must_use]
    pub fn new(
        pools: crate::db::DbPools,
        device_id: String,
        materializer: crate::materializer::Materializer,
        app_data_dir: &Path,
    ) -> Self {
        let builder = tauri_specta::Builder::<MockRuntime>::new().commands(agaric_commands!());
        let app = tauri::test::mock_builder()
            .invoke_handler(crate::build_invoke_handler(&builder))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build headless app");
        app.manage(HeadlessDataDir(app_data_dir.to_path_buf()));
        // Dropped: the flag is the sync daemon's, and no daemon runs here.
        let _sync_cancel_flag = crate::register_managed_state(
            &app,
            pools,
            device_id,
            materializer,
            Arc::new(agaric_sync::sync_scheduler::SyncScheduler::new()),
            &agaric_sync::foreground::LifecycleHooks::new(),
        );
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("build headless webview");
        Self { app, webview }
    }

    /// One IPC round trip. `Ok` is the command's JSON response, `Err` the
    /// serialized error (`{ kind, message, code? }` for an `AppError`).
    ///
    /// # Panics
    ///
    /// On a response that is not JSON: `read_attachment` answers raw bytes,
    /// and no caller reads them yet.
    pub async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let request = tauri::webview::InvokeRequest {
            cmd: cmd.to_owned(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("the app's own origin"),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: tauri::http::HeaderMap::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        };
        let webview: &tauri::Webview<MockRuntime> = self.webview.as_ref();
        webview.clone().on_message(
            request,
            Box::new(move |_webview, _cmd, response, _callback, _error| {
                // The receiver is gone only when the caller stopped waiting.
                let _ = tx.send(response);
            }),
        );
        match rx.await.expect("the invoke responder ran") {
            tauri::ipc::InvokeResponse::Ok(body) => Ok(body
                .deserialize::<Value>()
                .unwrap_or_else(|e| panic!("command '{cmd}' answered a non-JSON body: {e}"))),
            tauri::ipc::InvokeResponse::Err(e) => Err(e.0),
        }
    }
}
