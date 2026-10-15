//! `e2e_sync_peer` — the second device of the real-backend e2e lane (#5365).
//!
//! The lane drives one app through tauri-driver; this is the other device. It
//! opens a vault in the directory named by its one argument and runs the app's
//! own sync daemon on it. `e2e-tauri/sync-peer.ts` drives it with one JSON
//! command per stdin line and reads one JSON reply per stdout line. The end of
//! stdin shuts it down; the log goes to stderr.
//!
//! Every step is the app's own code: `init_pools`, the daemon,
//! `confirm_pairing_inner` with the fields of the QR the app showed (what a
//! phone's camera hands the joiner), `create_block_inner`,
//! `set_property_inner`, `move_block_inner`, `get_active_block_inner` and
//! `get_property_inner`. `sync` wakes the daemon as `start_sync` does; it never
//! runs a session itself.
//!
//! A session is a pull by the device that dials (#610), so each direction has
//! its own wait: `sync` for this vault's pull from the app (`synced_at`), and
//! `wait_pulled` for the app's pull from this vault (`streamed_at`).

use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_lib::commands::{
    confirm_pairing_inner, create_block_inner, get_active_block_inner, get_property_inner,
    move_block_inner, set_property_inner,
};
use agaric_lib::db::{DbPools, init_pools, now_ms};
use agaric_lib::materializer::Materializer;
use agaric_lib::ulid::verify_active;
use agaric_store::peer_refs::{self, PeerRef};
use agaric_sync::foreground::LifecycleHooks;
use agaric_sync::pairing::{PairingSession, ScannedPeerCandidate};
use agaric_sync::sync_daemon::{SyncDaemon, SyncDaemonContext};
use agaric_sync::sync_events::{SyncEvent, SyncEventSink};
use agaric_sync::sync_scheduler::SyncScheduler;

/// How long a command waits on the app: the lane's `ACTION_TIMEOUT`.
const WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(250);
/// The app's own debounce for a change notification.
const DEBOUNCE: Duration = Duration::from_secs(3);
/// Longer than any run, so this vault pulls only when told to: a `sync` then
/// cannot be answered by a periodic pull that began before the app's write.
const NO_PERIODIC_PULL: Duration = Duration::from_secs(24 * 60 * 60);

/// One stdin line.
#[derive(Debug, PartialEq, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
enum Command {
    /// Join the app's pairing with the fields of its v2 pairing QR.
    Pair {
        passphrase: String,
        device_id: String,
        endpoint_id: String,
        addrs: Vec<String>,
    },
    /// Pull from the paired app now, and wait until the pull has landed.
    Sync,
    GetBlock {
        id: String,
    },
    /// Write a content block under `parent_id`.
    CreateBlock {
        parent_id: String,
        content: String,
    },
    /// Set text property `key` on block `id`.
    SetProperty {
        id: String,
        key: String,
        value: String,
    },
    /// Move block `id` to sibling slot `index` (0-based) under `parent_id`.
    MoveBlock {
        id: String,
        parent_id: String,
        index: i64,
    },
    /// Read text property `key` of block `id`.
    GetProperty {
        id: String,
        key: String,
    },
    /// Wait for an app pull that ends after this vault's last write. Only a
    /// pull already running at the write can answer early, without it. Before
    /// the spec types this vault's address into the app, none can run unless
    /// mDNS found this vault first; after, only an app resync
    /// (`SyncScheduler`'s `DEFAULT_RESYNC`) that spans the write.
    WaitPulled,
}

/// One stdout line.
#[derive(Serialize)]
#[serde(tag = "reply", rename_all = "snake_case")]
enum Reply {
    /// `address` is where this vault listens, as the app's peer-address field
    /// takes it: `host:port`, never a bracketed IPv6 literal.
    Paired {
        device_id: String,
        address: String,
    },
    Synced,
    Block {
        id: String,
        parent_id: Option<String>,
        content: String,
    },
    Created {
        id: String,
    },
    PropertySet,
    Moved,
    /// `value_text` is null when the block holds no such property.
    Property {
        value_text: Option<String>,
    },
    Pulled,
    Error {
        message: String,
    },
}

fn parse_command(line: &str) -> Result<Command, String> {
    serde_json::from_str(line).map_err(|e| format!("unreadable command {line:?}: {e}"))
}

/// The daemon's events feed a UI this vault does not have.
struct NoEvents;

impl SyncEventSink for NoEvents {
    fn on_sync_event(&self, _event: SyncEvent) {}
}

struct Peer {
    pools: DbPools,
    device_id: String,
    materializer: Materializer,
    scheduler: Arc<SyncScheduler>,
    pairing: Mutex<Option<PairingSession>>,
    daemon: SyncDaemon,
    /// The app's device id, once paired.
    app: Option<String>,
    /// When this vault last wrote, for `wait_pulled`.
    last_write_ms: i64,
}

impl Peer {
    /// The app's own vault layout (`init_persistence` in `src/lib.rs`), with the
    /// boot step a write needs: the seeded spaces registered, so a block made
    /// under a synced page resolves its space and enters that space's doc.
    async fn open(vault: &Path) -> Result<Self, AppError> {
        std::fs::create_dir_all(vault)?;
        let pools = init_pools(&vault.join("notes.db")).await?;
        let device_id = agaric_sync::device::get_or_create_device_id(&vault.join("device-id"))?;
        let endpoint_secret = agaric_sync::transport::get_or_create_endpoint_secret(
            &vault.join("sync-endpoint.key"),
        )?;
        let materializer = Materializer::with_read_pool(pools.write.clone(), pools.read.clone());
        agaric_lib::spaces::bootstrap_spaces(&pools.write, &device_id, &materializer).await?;
        let scheduler = Arc::new(SyncScheduler::with_intervals(DEBOUNCE, NO_PERIODIC_PULL));
        let daemon = SyncDaemon::start_if_peers_exist_with_lifecycle(SyncDaemonContext {
            pool: pools.write.clone(),
            device_id: device_id.clone(),
            materializer: Arc::new(materializer.clone()),
            scheduler: Arc::clone(&scheduler),
            endpoint_secret,
            event_sink: Arc::new(NoEvents),
            cancel: Arc::new(AtomicBool::new(false)),
            lifecycle: LifecycleHooks::default(),
            internet_relay: false,
        })
        .await?;
        Ok(Self {
            pools,
            device_id,
            materializer,
            scheduler,
            pairing: Mutex::new(None),
            daemon,
            app: None,
            last_write_ms: 0,
        })
    }

    async fn run(&mut self, command: Command) -> Reply {
        let result = match command {
            Command::Pair {
                passphrase,
                device_id,
                endpoint_id,
                addrs,
            } => {
                let app = ScannedPeerCandidate {
                    device_id,
                    endpoint_id,
                    addrs,
                };
                self.pair(passphrase, app).await
            }
            Command::Sync => self.sync().await,
            Command::GetBlock { id } => self.get_block(id).await,
            Command::CreateBlock { parent_id, content } => {
                self.create_block(parent_id, content).await
            }
            Command::SetProperty { id, key, value } => self.set_property(id, key, value).await,
            Command::MoveBlock {
                id,
                parent_id,
                index,
            } => self.move_block(id, parent_id, index).await,
            Command::GetProperty { id, key } => self.get_property(id, key).await,
            Command::WaitPulled => self.wait_pulled().await,
        };
        result.unwrap_or_else(|e| Reply::Error {
            message: e.to_string(),
        })
    }

    async fn pair(
        &mut self,
        passphrase: String,
        app: ScannedPeerCandidate,
    ) -> Result<Reply, AppError> {
        let app_id = app.device_id.clone();
        confirm_pairing_inner(
            &self.pools.write,
            &self.pairing,
            &self.scheduler,
            passphrase,
            Some(app),
        )
        .await?;
        // Bound when this vault's first pull from the app completes.
        self.wait_for_app(&app_id, "the pairing session", &|row: &PeerRef| {
            row.endpoint_id.is_some()
        })
        .await?;
        self.app = Some(app_id);
        let address = self
            .scheduler
            .await_local_endpoint(WAIT)
            .await
            .and_then(|advert| advert.addrs.into_iter().find(std::net::SocketAddr::is_ipv4))
            .ok_or_else(|| {
                AppError::InvalidOperation("this vault's sync endpoint has no IPv4 address".into())
            })?;
        Ok(Reply::Paired {
            device_id: self.device_id.clone(),
            address: address.to_string(),
        })
    }

    async fn sync(&self) -> Result<Reply, AppError> {
        let app_id = self.paired_app()?;
        let before = peer_refs::get_peer_ref(&self.pools.read, app_id)
            .await?
            .and_then(|row| row.synced_at);
        self.scheduler.notify_change();
        self.wait_for_app(
            app_id,
            "this vault's pull from the app",
            &|row: &PeerRef| row.synced_at > before,
        )
        .await?;
        self.materializer.flush_foreground().await?;
        self.materializer.flush_background().await?;
        Ok(Reply::Synced)
    }

    async fn get_block(&self, id: String) -> Result<Reply, AppError> {
        let row = get_active_block_inner(&self.pools.read, BlockId::from_string(id)?).await?;
        Ok(Reply::Block {
            id: row.id.into_string(),
            parent_id: row.parent_id.map(BlockId::into_string),
            content: row.content.unwrap_or_default(),
        })
    }

    async fn create_block(
        &mut self,
        parent_id: String,
        content: String,
    ) -> Result<Reply, AppError> {
        let row = create_block_inner(
            &self.pools.write,
            &self.device_id,
            &self.materializer,
            "content".into(),
            content,
            Some(BlockId::from_string(parent_id)?),
            None,
        )
        .await?;
        self.last_write_ms = now_ms();
        Ok(Reply::Created {
            id: row.id.into_string(),
        })
    }

    async fn set_property(
        &mut self,
        id: String,
        key: String,
        value: String,
    ) -> Result<Reply, AppError> {
        let block = verify_active(&self.pools.read, &BlockId::from_string(id)?).await?;
        set_property_inner(
            &self.pools.write,
            &self.device_id,
            &self.materializer,
            block,
            key,
            Some(value),
            None,
            None,
            None,
            None,
            None,
        )
        .await?;
        self.last_write_ms = now_ms();
        Ok(Reply::PropertySet)
    }

    async fn move_block(
        &mut self,
        id: String,
        parent_id: String,
        index: i64,
    ) -> Result<Reply, AppError> {
        move_block_inner(
            &self.pools.write,
            &self.device_id,
            &self.materializer,
            BlockId::from_string(id)?,
            Some(BlockId::from_string(parent_id)?),
            index,
        )
        .await?;
        self.last_write_ms = now_ms();
        Ok(Reply::Moved)
    }

    async fn get_property(&self, id: String, key: String) -> Result<Reply, AppError> {
        let row = get_property_inner(&self.pools.read, &BlockId::from_string(id)?, &key).await?;
        Ok(Reply::Property {
            value_text: row.and_then(|row| row.value_text),
        })
    }

    async fn wait_pulled(&self) -> Result<Reply, AppError> {
        let app_id = self.paired_app()?;
        let since = self.last_write_ms;
        self.wait_for_app(
            app_id,
            "the app's pull from this vault",
            &|row: &PeerRef| row.streamed_at.is_some_and(|at| at > since),
        )
        .await?;
        Ok(Reply::Pulled)
    }

    fn paired_app(&self) -> Result<&str, AppError> {
        self.app
            .as_deref()
            .ok_or_else(|| AppError::InvalidOperation("not paired yet: send `pair` first".into()))
    }

    /// Poll this vault's row for the app until `done` holds.
    async fn wait_for_app(
        &self,
        app_id: &str,
        what: &str,
        done: &dyn Fn(&PeerRef) -> bool,
    ) -> Result<(), AppError> {
        let deadline = tokio::time::Instant::now() + WAIT;
        loop {
            let row = peer_refs::get_peer_ref(&self.pools.read, app_id).await?;
            if row.as_ref().is_some_and(done) {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(AppError::InvalidOperation(format!(
                    "waited {WAIT:?} for {what}; this vault's row for the app is {row:?}"
                )));
            }
            tokio::time::sleep(POLL).await;
        }
    }

    fn close(self) {
        self.daemon.shutdown();
        self.materializer.shutdown();
    }
}

async fn serve(mut peer: Peer) -> std::io::Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await? {
        let reply = match parse_command(&line) {
            Ok(command) => peer.run(command).await,
            Err(message) => Reply::Error { message },
        };
        let mut json = serde_json::to_string(&reply)?;
        json.push('\n');
        stdout.write_all(json.as_bytes()).await?;
        stdout.flush().await?;
    }
    peer.close();
    Ok(())
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();
    let Some(vault) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: e2e_sync_peer <vault-dir>");
        return ExitCode::from(2);
    };
    let peer = match Peer::open(&vault).await {
        Ok(peer) => peer,
        Err(e) => {
            eprintln!("e2e_sync_peer: cannot open {}: {e}", vault.display());
            return ExitCode::from(2);
        }
    };
    match serve(peer).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("e2e_sync_peer: {e}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_takes_the_qr_fields_and_ignores_the_qr_version() {
        let line = r#"{"cmd":"pair","v":2,"passphrase":"acorn bucket candle dune","device_id":"DEV-A","endpoint_id":"KEY-A","addrs":["10.0.0.2:4100"]}"#;
        assert_eq!(
            parse_command(line),
            Ok(Command::Pair {
                passphrase: "acorn bucket candle dune".into(),
                device_id: "DEV-A".into(),
                endpoint_id: "KEY-A".into(),
                addrs: vec!["10.0.0.2:4100".into()],
            }),
            "a pair command is the decoded QR with a `cmd` added"
        );
    }

    #[test]
    fn a_unit_command_needs_only_its_name() {
        assert_eq!(
            parse_command(r#"{"cmd":"wait_pulled"}"#),
            Ok(Command::WaitPulled),
            "a command without fields is its name alone"
        );
    }

    #[test]
    fn set_property_takes_a_block_key_and_text_value() {
        assert_eq!(
            parse_command(r#"{"cmd":"set_property","id":"B1","key":"k","value":"v"}"#),
            Ok(Command::SetProperty {
                id: "B1".into(),
                key: "k".into(),
                value: "v".into(),
            }),
            "sync-peer.ts sends a property as its block id, key and text value"
        );
    }

    #[test]
    fn move_block_takes_a_block_its_new_parent_and_a_slot() {
        assert_eq!(
            parse_command(r#"{"cmd":"move_block","id":"B1","parent_id":"P1","index":0}"#),
            Ok(Command::MoveBlock {
                id: "B1".into(),
                parent_id: "P1".into(),
                index: 0,
            }),
            "sync-peer.ts sends a move as the block id, its new parent and a 0-based slot"
        );
    }

    #[test]
    fn get_property_takes_a_block_and_key() {
        assert_eq!(
            parse_command(r#"{"cmd":"get_property","id":"B1","key":"k"}"#),
            Ok(Command::GetProperty {
                id: "B1".into(),
                key: "k".into(),
            }),
            "sync-peer.ts asks for a property by block id and key"
        );
    }

    #[test]
    fn an_unknown_command_is_refused_naming_the_line() {
        let err = parse_command(r#"{"cmd":"push"}"#).expect_err("there is no push command");
        assert!(
            err.contains(r#"{\"cmd\":\"push\"}"#),
            "the refusal must quote the line it could not read, got: {err}"
        );
    }

    #[test]
    fn a_command_missing_a_field_is_refused() {
        let err = parse_command(r#"{"cmd":"create_block","content":"x"}"#)
            .expect_err("create_block needs a parent_id");
        assert!(
            err.contains("parent_id"),
            "the refusal must name the missing field, got: {err}"
        );
    }

    #[test]
    fn a_reply_names_its_kind_in_the_reply_field() {
        let created = serde_json::to_value(Reply::Created { id: "B1".into() }).unwrap();
        assert_eq!(
            created,
            serde_json::json!({ "reply": "created", "id": "B1" }),
            "sync-peer.ts reads the kind from `reply` and the fields beside it"
        );
        let synced = serde_json::to_value(Reply::Synced).unwrap();
        assert_eq!(
            synced,
            serde_json::json!({ "reply": "synced" }),
            "a reply without fields is its kind alone"
        );
    }
}
