//! #6529 spike — the real command surface on `tauri::test::MockRuntime`.
//!
//! [`HeadlessApp`] is the app with no window system: the production invoke
//! handler ([`crate::build_invoke_handler`] over the production command list),
//! the production managed state ([`crate::register_managed_state`]), and a
//! mock webview to deliver IPC through. A call goes through the same argument
//! decoding, ACL check, `State` extraction, wrapper body and event emission a
//! frontend `invoke()` does; only the transport differs.
//!
//! Test-only (`test-util`): nothing here ships.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;
use tauri::Manager as _;
use tauri::test::MockRuntime;

/// Per-instance app-data directory. [`crate::app_paths::resolve_app_data_dir`]
/// answers this before the env/OS lookup, so two headless apps in one process
/// each keep their own vault (the env override is process-global).
#[derive(Clone)]
pub struct HeadlessDataDir(pub PathBuf);

pub struct HeadlessApp {
    pub app: tauri::App<MockRuntime>,
    pub webview: tauri::WebviewWindow<MockRuntime>,
}

impl HeadlessApp {
    /// Build an app over an already-open vault. The caller keeps ownership of
    /// the vault's lifetime (temp dir, materializer drain).
    pub fn new(
        pools: crate::db::DbPools,
        device_id: String,
        materializer: crate::materializer::Materializer,
        app_data_dir: &Path,
    ) -> Self {
        Self::with_lifecycle(
            pools,
            device_id,
            materializer,
            &agaric_sync::foreground::LifecycleHooks::new(),
            app_data_dir,
        )
    }

    /// A fresh vault in `app_data_dir`, opened the way [`crate::boot`] opens
    /// one: pools and migrations, device id, materializer, Loro init, recovery
    /// and space bootstrap. Not started: logging, deep links, the mirror, the
    /// maintenance and sync daemons, MCP. Call from outside a tokio runtime
    /// (the boot helpers `block_on`).
    pub fn boot(app_data_dir: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(app_data_dir)?;
        let (pools, device_id, _endpoint_secret) =
            crate::init_persistence(&app_data_dir.join("notes.db"), app_data_dir)?;
        let (lifecycle, materializer) = crate::build_materializer(&pools, app_data_dir);
        // `recover_at_boot` is once-per-process (a static guard); a bridge
        // that resets the vault boots many times in one process.
        agaric_sync::recovery::reset_recovery_guard();
        let _report = crate::recover_and_bootstrap(&pools, &device_id, &materializer)?;
        Ok(Self::with_lifecycle(
            pools,
            device_id,
            materializer,
            &lifecycle,
            app_data_dir,
        ))
    }

    /// Stop the materializer and close the pools, so the vault's files can go.
    pub fn shutdown(self) {
        use tauri::Manager as _;
        let materializer = self
            .app
            .state::<crate::materializer::Materializer>()
            .inner()
            .clone();
        let write = self.app.state::<crate::db::WritePool>().0.clone();
        let read = self.app.state::<crate::db::ReadPool>().0.clone();
        materializer.shutdown();
        drop(self);
        tauri::async_runtime::block_on(async {
            write.close().await;
            read.close().await;
        });
    }

    fn with_lifecycle(
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
        let scheduler = Arc::new(agaric_sync::sync_scheduler::SyncScheduler::new());
        let _cancel = crate::register_managed_state(
            &app,
            pools,
            device_id,
            materializer,
            scheduler,
            lifecycle,
        );
        app.manage(crate::mirror::MirrorState::new(app_data_dir.to_path_buf()));
        app.manage(agaric_sync::sync_events::MdnsStatusState(
            std::sync::Mutex::new(agaric_sync::sync_events::MdnsStatus::default()),
        ));
        app.manage(agaric_sync::sync_events::BindExposureStatusState(
            std::sync::Mutex::new(agaric_sync::sync_events::BindExposureStatus::default()),
        ));
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .expect("build headless webview");
        Self { app, webview }
    }

    /// One IPC round trip. `Ok` is the command's JSON response, `Err` the
    /// serialized error (`{ kind, message, code? }` for an `AppError`).
    pub async fn invoke(&self, cmd: &str, args: Value) -> Result<Value, Value> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let request = tauri::webview::InvokeRequest {
            cmd: cmd.to_owned(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "tauri://localhost".parse().expect("url"),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: tauri::http::HeaderMap::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_owned(),
        };
        let webview: &tauri::Webview<MockRuntime> = self.webview.as_ref();
        webview.clone().on_message(
            request,
            Box::new(move |_webview, _cmd, response, _callback, _error| {
                let _ = tx.send(response);
            }),
        );
        match rx.await.expect("invoke responder dropped") {
            tauri::ipc::InvokeResponse::Ok(body) => Ok(body
                .deserialize::<Value>()
                .unwrap_or_else(|_| Value::String("<raw bytes>".into()))),
            tauri::ipc::InvokeResponse::Err(e) => Err(e.0),
        }
    }
}
