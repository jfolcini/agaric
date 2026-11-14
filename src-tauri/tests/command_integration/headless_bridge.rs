//! #6529 — `agaric_lib::headless::bridge`: the vault swap behind `reset`, the
//! events it pushes, its WebSocket, and what a reset costs.
//!
//! Every test boots vaults, and a boot resets the process-wide recovery guard
//! (`reset_recovery_guard`), so these need nextest's process per test
//! (`src-tauri/tests/AGENTS.md` § "Process-global state"). They are plain
//! `#[test]`s because a boot blocks on the app's runtime and cannot run inside
//! another.

use agaric_lib::headless::bridge::{Bridge, serve};
use serde_json::{Value, json};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite;

const WAIT: Duration = Duration::from_secs(30);

/// One request, answered: `Ok` is the reply's `ok`, `Err` its `err`.
fn call(bridge: &mut Bridge, mut request: Value) -> Result<Value, Value> {
    request["id"] = json!(1);
    let (tx, rx) = mpsc::channel();
    bridge.handle(&request, move |reply| {
        let _ = tx.send(reply);
    });
    let reply = rx.recv_timeout(WAIT).expect("the bridge replied");
    assert_eq!(reply["id"], 1, "a reply carries its request's id: {reply}");
    match reply.get("err") {
        Some(error) => Err(error.clone()),
        None => Ok(reply["ok"].clone()),
    }
}

fn invoke(bridge: &mut Bridge, cmd: &str, args: Value) -> Result<Value, Value> {
    let mut request = json!({ "op": "invoke", "cmd": cmd });
    request["args"] = args;
    call(bridge, request)
}

fn first_space(bridge: &mut Bridge) -> String {
    let spaces = invoke(bridge, "list_spaces", json!({})).expect("list_spaces");
    spaces[0]["id"]
        .as_str()
        .expect("a bootstrapped space")
        .to_owned()
}

fn create_page(bridge: &mut Bridge, title: &str) -> String {
    let space_id = first_space(bridge);
    invoke(
        bridge,
        "create_page_in_space",
        json!({ "parentId": null, "content": title, "spaceId": space_id }),
    )
    .expect("create_page_in_space")
    .as_str()
    .expect("a page id")
    .to_owned()
}

fn page_title(bridge: &mut Bridge, page_id: &str) -> Result<Value, Value> {
    invoke(bridge, "get_block", json!({ "blockId": page_id })).map(|row| row["content"].clone())
}

#[test]
fn a_reset_opens_a_fresh_copy_of_the_template() {
    let root = tempfile::TempDir::new().unwrap();
    let mut bridge = Bridge::start(root.path()).expect("start the bridge");
    let template_spaces = invoke(&mut bridge, "list_spaces", json!({})).expect("list_spaces");
    assert_eq!(
        template_spaces.as_array().map(Vec::len),
        Some(2),
        "the template is a first boot's vault, with its two spaces: {template_spaces}"
    );

    let written = create_page(&mut bridge, "in one test");
    assert_eq!(page_title(&mut bridge, &written), Ok(json!("in one test")));
    call(&mut bridge, json!({ "op": "reset" })).expect("reset");
    assert_eq!(
        page_title(&mut bridge, &written).unwrap_err()["kind"],
        "not_found",
        "a reset drops what the last copy was written"
    );
    assert_eq!(
        invoke(&mut bridge, "list_spaces", json!({})).expect("list_spaces"),
        template_spaces,
        "a reset keeps what the template held, ids included"
    );
    let next = create_page(&mut bridge, "in the next test");
    assert_eq!(
        page_title(&mut bridge, &next),
        Ok(json!("in the next test")),
        "the copy a reset opens takes writes"
    );
}

#[test]
fn a_kept_vault_is_what_every_later_reset_opens() {
    let root = tempfile::TempDir::new().unwrap();
    let mut bridge = Bridge::start(root.path()).expect("start the bridge");
    let seeded = create_page(&mut bridge, "seeded");
    call(&mut bridge, json!({ "op": "keep" })).expect("keep");
    assert_eq!(
        page_title(&mut bridge, &seeded),
        Ok(json!("seeded")),
        "the vault open after a keep holds what was kept"
    );

    let written = create_page(&mut bridge, "in one test");
    call(&mut bridge, json!({ "op": "reset" })).expect("reset");
    assert_eq!(
        page_title(&mut bridge, &seeded),
        Ok(json!("seeded")),
        "a reset opens the kept vault"
    );
    assert_eq!(
        page_title(&mut bridge, &written).unwrap_err()["kind"],
        "not_found",
        "and not what a test wrote after the keep"
    );
}

/// The payloads of the frames queued for `event`, oldest first. The app emits
/// on its own schedule too (a write's rebuild follows it with a second
/// `block:properties-changed`), so a check reads one event's frames, not all.
fn pushed(events: &mut tokio::sync::broadcast::Receiver<String>, event: &str) -> Vec<Value> {
    std::iter::from_fn(|| events.try_recv().ok())
        .map(|frame| serde_json::from_str::<Value>(&frame).expect("a pushed frame is JSON"))
        .filter(|frame| frame["event"] == event)
        .map(|frame| frame["payload"].clone())
        .collect()
}

#[test]
fn a_listened_event_is_pushed_once_and_listening_ends_with_the_vault() {
    // An event no command emits, so every frame for it is this test's own.
    const PING: &str = "bridge-test:ping";
    let root = tempfile::TempDir::new().unwrap();
    let mut bridge = Bridge::start(root.path()).expect("start the bridge");
    let mut events = bridge.events();
    let listen = json!({ "op": "listen", "event": PING });
    let emit = json!({ "op": "emit", "event": PING, "payload": { "n": 1 } });

    // Twice: a page that reloads listens again, and must not hear double.
    call(&mut bridge, listen.clone()).expect("listen");
    call(&mut bridge, listen.clone()).expect("listen again");
    call(&mut bridge, emit.clone()).expect("emit");
    assert_eq!(
        pushed(&mut events, PING),
        [json!({ "n": 1 })],
        "an emit request is pushed back, once however often the event was listened to"
    );

    // What a command's wrapper emits is pushed by the time the command answers.
    call(
        &mut bridge,
        json!({ "op": "listen", "event": "block:properties-changed" }),
    )
    .expect("listen");
    let space_id = first_space(&mut bridge);
    let page = create_page(&mut bridge, "a page");
    let block = invoke(
        &mut bridge,
        "create_block",
        json!({
            "blockType": "content",
            "content": "a task",
            "parentId": page,
            "scope": { "kind": "active", "space_id": space_id },
        }),
    )
    .expect("create_block");
    let block_id = block["id"].as_str().expect("the created block's id");
    invoke(
        &mut bridge,
        "set_todo_state",
        json!({ "blockId": block_id, "state": "TODO" }),
    )
    .expect("set_todo_state");
    assert_eq!(
        pushed(&mut events, "block:properties-changed").first(),
        Some(&json!({ "block_id": block_id, "changed_keys": ["todo_state"] })),
        "the frame carries the payload the wrapper emitted"
    );

    // The next vault's app has no listener until its page asks again.
    call(&mut bridge, json!({ "op": "reset" })).expect("reset");
    call(&mut bridge, emit.clone()).expect("emit after a reset");
    assert_eq!(
        pushed(&mut events, PING),
        [] as [Value; 0],
        "a reset ends the old vault's listening"
    );
    call(&mut bridge, listen).expect("listen on the new vault");
    call(&mut bridge, emit).expect("emit");
    assert_eq!(
        pushed(&mut events, PING),
        [json!({ "n": 1 })],
        "the new vault pushes once it is listened to"
    );
}

#[test]
fn a_request_and_an_event_cross_the_websocket() {
    let root = tempfile::TempDir::new().unwrap();
    let dir = root.path().to_path_buf();
    let (port_tx, port_rx) = mpsc::channel();
    // `serve` never returns; the thread ends with the test's process.
    std::thread::spawn(move || {
        serve(&dir, 0, |port| port_tx.send(port).expect("report the port")).expect("serve");
    });
    let port = port_rx.recv_timeout(WAIT).expect("the bridge is listening");
    let stream = std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.set_read_timeout(Some(WAIT)).unwrap();
    let (mut socket, _) =
        tungstenite::client(format!("ws://127.0.0.1:{port}"), stream).expect("handshake");
    let mut send = |request: Value| {
        socket
            .send(tungstenite::Message::text(request.to_string()))
            .expect("send");
        let frame = socket.read().expect("a frame");
        serde_json::from_str::<Value>(frame.to_text().expect("a text frame")).expect("JSON")
    };

    let spaces = send(json!({ "id": 7, "op": "invoke", "cmd": "list_spaces", "args": {} }));
    assert_eq!(spaces["id"], 7, "the reply names its request: {spaces}");
    assert!(
        spaces["ok"][0]["id"].is_string(),
        "an invoke answers with the command's response: {spaces}"
    );
    let refused =
        send(json!({ "id": 8, "op": "invoke", "cmd": "get_block", "args": { "blockId": "NOPE" } }));
    assert_eq!(
        refused["err"]["kind"], "not_found",
        "a refusal answers with the serialized AppError: {refused}"
    );
    let unknown = send(json!({ "id": 9, "op": "invoke", "cmd": "no_such_command", "args": {} }));
    assert!(
        unknown["err"].is_string(),
        "a command the app does not have is an error, not a hang: {unknown}"
    );

    assert_eq!(
        send(json!({ "id": 10, "op": "listen", "event": "sync:progress" }))["id"],
        10
    );
    // The push and the reply to `emit` both arrive; the push was produced first.
    let pushed = send(json!({ "id": 11, "op": "emit", "event": "sync:progress", "payload": 3 }));
    assert_eq!(
        pushed,
        json!({ "event": "sync:progress", "payload": 3 }),
        "an event is pushed to a connected client"
    );
}

/// The budget #6529 sets for the reset each test pays: a median of 300 ms.
const RESET_BUDGET: Duration = Duration::from_millis(300);
const RESETS: usize = 15;

#[test]
fn a_reset_stays_within_its_budget() {
    let root = tempfile::TempDir::new().unwrap();
    let mut bridge = Bridge::start(root.path()).expect("start the bridge");
    let mut took: Vec<Duration> = (0..RESETS)
        .map(|_| {
            // A vault a test wrote to, as the one a reset replaces is.
            create_page(&mut bridge, "in one test");
            let started = Instant::now();
            call(&mut bridge, json!({ "op": "reset" })).expect("reset");
            started.elapsed()
        })
        .collect();
    took.sort_unstable();
    let median = took[RESETS / 2];
    eprintln!(
        "bridge reset over {RESETS} runs: median {median:?}, fastest {:?}, slowest {:?}",
        took[0],
        took[RESETS - 1]
    );
    assert!(
        median <= RESET_BUDGET,
        "a reset's median was {median:?}, over the {RESET_BUDGET:?} budget (all: {took:?})"
    );
}
