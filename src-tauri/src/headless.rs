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
//! [`HeadlessApp::new`] holds the state [`crate::register_managed_state`]
//! registers and no more. [`HeadlessApp::boot`] adds what [`crate::boot`]
//! registers around it, except MCP's: nothing here starts a server, a daemon
//! or a background task, and a command that reads state no one registered is
//! refused by tauri as unmanaged.
//!
//! Compiled under `test-util` only, so nothing here ships.

pub mod bridge;

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
        Self::over(
            pools,
            device_id,
            materializer,
            &agaric_sync::foreground::LifecycleHooks::new(),
            app_data_dir,
        )
    }

    /// The vault in `app_data_dir`, opened as [`crate::boot`] opens one: pools
    /// and migrations, the device id, the materializer, recovery and the
    /// space bootstrap. An empty directory becomes a new vault.
    ///
    /// Call it from outside an async runtime: the boot phases block on one.
    ///
    /// # Errors
    ///
    /// Whatever a boot phase returns, as the app's own boot would.
    pub fn boot(app_data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(app_data_dir)?;
        let db_path = app_data_dir.join(crate::db::VAULT_DB_FILE);
        let (pools, device_id, _endpoint_secret) = crate::init_persistence(&db_path, app_data_dir)?;
        let (lifecycle, materializer) = crate::build_materializer(&pools, app_data_dir);
        // Recovery runs once per process, and one process boots many vaults.
        agaric_sync::recovery::reset_recovery_guard();
        let report = crate::recover_and_bootstrap(&pools, &device_id, &materializer)?;
        let headless = Self::over(pools, device_id, materializer, &lifecycle, app_data_dir);
        let app = &headless.app;
        crate::surface_recovery_status(app, &report);
        app.manage(crate::mirror::MirrorState::new(app_data_dir.to_path_buf()));
        app.manage(agaric_sync::sync_events::MdnsStatusState(
            std::sync::Mutex::new(agaric_sync::sync_events::MdnsStatus::default()),
        ));
        app.manage(agaric_sync::sync_events::BindExposureStatusState(
            std::sync::Mutex::new(agaric_sync::sync_events::BindExposureStatus::default()),
        ));
        Ok(headless)
    }

    /// Save the engines and close the vault, so its files can be copied or
    /// removed. Call it from outside an async runtime.
    pub fn shutdown(self) {
        let materializer = self
            .app
            .state::<crate::materializer::Materializer>()
            .inner()
            .clone();
        let write = self.app.state::<crate::db::WritePool>().0.clone();
        let read = self.app.state::<crate::db::ReadPool>().0.clone();
        // The save the app runs when the OS suspends it.
        tauri::async_runtime::block_on(
            agaric_engine::loro::snapshot::save_engines_and_advance_cursor(&write, &materializer),
        );
        materializer.shutdown();
        drop(self);
        tauri::async_runtime::block_on(async {
            write.close().await;
            read.close().await;
        });
    }

    fn over(
        pools: crate::db::DbPools,
        device_id: String,
        materializer: crate::materializer::Materializer,
        lifecycle: &agaric_sync::foreground::LifecycleHooks,
        app_data_dir: &Path,
    ) -> Self {
        let builder = tauri_specta::Builder::<MockRuntime>::new().commands(agaric_commands!());
        let app = tauri::test::mock_builder()
            .invoke_handler(crate::build_invoke_handler(&builder))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("build headless app");
        app.manage(HeadlessDataDir(app_data_dir.to_path_buf()));
        // Before the state: `register_managed_state` hangs the lifecycle
        // listener on the main window, and warns when there is none.
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("build headless webview");
        // Dropped: the flag is the sync daemon's, and no daemon runs here.
        let _sync_cancel_flag = crate::register_managed_state(
            &app,
            pools,
            device_id,
            materializer,
            Arc::new(agaric_sync::sync_scheduler::SyncScheduler::new()),
            lifecycle,
        );
        Self { app, webview }
    }

    /// Send one IPC request and hand its outcome to `respond`, on whichever
    /// thread the command finished on. `Ok` is the command's JSON response,
    /// `Err` the serialized error: `{ kind, message, code? }` for an
    /// `AppError`, a bare string when the request never reached its command
    /// or the command answered raw bytes (`read_attachment`), which this
    /// transport does not carry.
    pub fn invoke_with(
        &self,
        cmd: &str,
        args: Value,
        respond: impl FnOnce(Result<Value, Value>) + Send + 'static,
    ) {
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
            Box::new(move |_webview, cmd, response, _callback, _error| {
                respond(match response {
                    tauri::ipc::InvokeResponse::Ok(body) => {
                        body.deserialize::<Value>().map_err(|e| {
                            Value::String(format!("command '{cmd}' answered a non-JSON body: {e}"))
                        })
                    }
                    tauri::ipc::InvokeResponse::Err(e) => Err(e.0),
                });
            }),
        );
    }

    /// [`Self::invoke_with`], awaited.
    pub async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.invoke_with(cmd, args, move |outcome| {
            // The receiver is gone only when the caller stopped waiting.
            let _ = tx.send(outcome);
        });
        rx.await.expect("the invoke responder ran")
    }
}
