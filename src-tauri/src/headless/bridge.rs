//! #6529 — the real command surface, served to a browser over a WebSocket.
//!
//! One bridge process holds one [`HeadlessApp`] and belongs to one Playwright
//! worker. The page's `invoke()` calls arrive as requests, the app's events
//! leave as pushes, and a `reset` between tests swaps in a fresh copy of a
//! template vault: a new vault as the app's first boot leaves it, booted once
//! when the bridge starts. The browser half is `src/lib/tauri-mock/bridge.ts`.
//!
//! # Protocol
//!
//! JSON text frames. A request carries an `id` and an `op`; its reply carries
//! the same `id` and either `ok` or `err`:
//!
//! | `op` | fields | effect |
//! |---|---|---|
//! | `invoke` | `cmd`, `args` | one IPC round trip; `ok` is the response, `err` the serialized error |
//! | `listen` | `event` | start pushing that event, as `{ "event", "payload" }` frames to every client |
//! | `emit` | `event`, `payload` | emit the event in the app, as its backend would |
//! | `reset` | | the open vault is dropped and a new copy of the template opens |
//!
//! Requests are taken in the order they arrive, on the thread that owns the
//! app; an `invoke` is only started there, so commands run concurrently, as a
//! page's do.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use tauri::{Emitter as _, Listener as _};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{broadcast, mpsc as async_mpsc};
use tokio_tungstenite::tungstenite::Message;

use super::HeadlessApp;

/// Events a slow client may fall behind by before it loses the oldest.
const EVENT_BACKLOG: usize = 1024;

type Respond = Box<dyn FnOnce(Value) + Send>;

/// The vault a worker's tests run against, and the template each test's copy
/// is taken from.
pub struct Bridge {
    root: PathBuf,
    template: PathBuf,
    /// `None` only inside a swap.
    app: Option<HeadlessApp>,
    /// The directory `app` has open.
    open: PathBuf,
    copies: u64,
    /// The events this app already forwards: a second `listen` adds nothing.
    listening: HashSet<String>,
    events: broadcast::Sender<String>,
}

impl Bridge {
    /// Boot the template vault under `root`, close it, and open the first
    /// copy of it.
    ///
    /// # Errors
    ///
    /// A vault could not be booted or copied.
    pub fn start(root: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        let template = root.join("template");
        HeadlessApp::boot(&template)?.shutdown();
        let mut bridge = Self {
            root: root.to_path_buf(),
            open: template.clone(),
            template,
            app: None,
            copies: 0,
            listening: HashSet::new(),
            events: broadcast::channel(EVENT_BACKLOG).0,
        };
        bridge.open_copy()?;
        Ok(bridge)
    }

    /// The pushed frames, for a client to forward.
    #[must_use]
    pub fn events(&self) -> broadcast::Receiver<String> {
        self.events.subscribe()
    }

    /// Answer one request. `respond` is called once, with the reply frame.
    pub fn handle(&mut self, request: &Value, respond: impl FnOnce(Value) + Send + 'static) {
        let id = request["id"].clone();
        let reply = move |outcome: Result<Value, Value>| {
            respond(match outcome {
                Ok(value) => json!({ "id": id, "ok": value }),
                Err(error) => json!({ "id": id, "err": error }),
            });
        };
        let field = |name: &str| request[name].as_str().map(str::to_owned);
        match (request["op"].as_str(), field("cmd"), field("event")) {
            (Some("invoke"), Some(cmd), _) => {
                self.app().invoke_with(&cmd, request["args"].clone(), reply);
            }
            (Some("listen"), _, Some(event)) => {
                self.listen(event);
                reply(Ok(Value::Null));
            }
            (Some("emit"), _, Some(event)) => {
                #[expect(
                    clippy::disallowed_methods,
                    reason = "this thread owns the app, and a mock app that is not running emits inline"
                )]
                let emitted = self.app().app.emit(&event, request["payload"].clone());
                reply(
                    emitted
                        .map(|()| Value::Null)
                        .map_err(|e| json!(e.to_string())),
                );
            }
            (Some("reset"), ..) => {
                reply(self.reset().map(|()| Value::Null).map_err(|e| json!(e)));
            }
            _ => reply(Err(json!(format!("not a bridge request: {request}")))),
        }
    }

    fn app(&self) -> &HeadlessApp {
        self.app.as_ref().expect("a vault is open outside a swap")
    }

    fn listen(&mut self, event: String) {
        if self.listening.contains(&event) {
            return;
        }
        let events = self.events.clone();
        let name = event.clone();
        self.app().app.listen_any(event.clone(), move |emitted| {
            let payload: Value = serde_json::from_str(emitted.payload()).unwrap_or(Value::Null);
            // No receiver means no client is connected, which is not an error.
            let _ = events.send(json!({ "event": name, "payload": payload }).to_string());
        });
        self.listening.insert(event);
    }

    /// Drop the open copy and open a new one.
    fn reset(&mut self) -> Result<(), String> {
        if let Some(app) = self.app.take() {
            app.shutdown();
        }
        self.listening.clear();
        std::fs::remove_dir_all(&self.open)
            .map_err(|e| format!("remove {}: {e}", self.open.display()))?;
        self.open_copy()
    }

    fn open_copy(&mut self) -> Result<(), String> {
        self.copies += 1;
        self.open = self.root.join(format!("vault-{}", self.copies));
        copy_dir(&self.template, &self.open)
            .map_err(|e| format!("copy the template to {}: {e}", self.open.display()))?;
        self.app = Some(
            HeadlessApp::boot(&self.open)
                .map_err(|e| format!("boot {}: {e}", self.open.display()))?,
        );
        Ok(())
    }
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Serve a new vault under `root` on a loopback port, and never return.
/// `on_listening` is told the port once clients can connect.
///
/// Call it on a thread that is not an async runtime's: it owns the app, and
/// booting one blocks.
///
/// # Errors
///
/// The vault could not be booted, or the port could not be bound.
pub fn serve(
    root: &Path,
    port: u16,
    on_listening: impl FnOnce(u16),
) -> Result<(), Box<dyn std::error::Error>> {
    let mut bridge = Bridge::start(root)?;
    let listener = tauri::async_runtime::block_on(TcpListener::bind(("127.0.0.1", port)))?;
    let port = listener.local_addr()?.port();
    let (requests, incoming) = mpsc::channel::<(Value, Respond)>();
    let events = bridge.events.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    tauri::async_runtime::spawn(client(
                        stream,
                        requests.clone(),
                        events.subscribe(),
                    ));
                }
                Err(e) => tracing::warn!(error = %e, "bridge: accept failed"),
            }
        }
    });
    on_listening(port);
    for (request, respond) in incoming {
        bridge.handle(&request, respond);
    }
    Ok(())
}

/// One client: its requests go to the app's thread, and their replies and the
/// app's events come back.
async fn client(
    stream: TcpStream,
    requests: mpsc::Sender<(Value, Respond)>,
    mut events: broadcast::Receiver<String>,
) {
    let socket = match tokio_tungstenite::accept_async(stream).await {
        Ok(socket) => socket,
        Err(e) => {
            tracing::warn!(error = %e, "bridge: WebSocket handshake failed");
            return;
        }
    };
    let (mut sink, mut frames) = socket.split();
    let (replies, mut outgoing) = async_mpsc::unbounded_channel::<String>();
    loop {
        // `biased`, events first: an event its command emitted before it
        // answered leaves before the answer, as it does in the app.
        let frame = tokio::select! {
            biased;
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if sink.send(Message::text(event)).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(lost)) => {
                        tracing::warn!(lost, "bridge: a client fell behind and lost events");
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
                continue;
            }
            Some(reply) = outgoing.recv() => {
                if sink.send(Message::text(reply)).await.is_err() {
                    return;
                }
                continue;
            }
            frame = frames.next() => frame,
        };
        let Some(Ok(frame)) = frame else { return };
        let Message::Text(text) = frame else { continue };
        let replies = replies.clone();
        let respond: Respond = Box::new(move |reply| {
            // The client is gone only when it stopped waiting.
            let _ = replies.send(reply.to_string());
        });
        match serde_json::from_str::<Value>(text.as_str()) {
            Ok(request) => {
                if requests.send((request, respond)).is_err() {
                    return;
                }
            }
            Err(e) => respond(json!({ "id": null, "err": format!("not JSON: {e}") })),
        }
    }
}
