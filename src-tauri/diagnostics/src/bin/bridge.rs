//! #6529 — the real command surface for Playwright: one `HeadlessApp` behind a
//! WebSocket, for one Playwright worker. The server and its protocol are
//! `agaric_lib::headless::bridge`; this is its process.
//!
//! ```text
//! bridge <directory>
//! ```
//!
//! `<directory>` holds the template vault and each test's copy of it; the
//! caller creates it and removes it. The port is the first line on stdout, as
//! `{"port":N}`. The process exits when its stdin closes, so a worker that
//! dies takes its bridge with it.

use std::io::Read as _;
use std::path::PathBuf;

fn main() {
    let Some(root) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: bridge <directory for the vaults>");
        std::process::exit(2);
    };
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .init();
    std::thread::spawn(|| {
        // Any outcome of the read means the parent is gone or done with us.
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
        std::process::exit(0);
    });
    let served = agaric_lib::headless::bridge::serve(&root, 0, |port| {
        println!("{}", serde_json::json!({ "port": port }));
    });
    if let Err(e) = served {
        eprintln!("bridge: {e}");
        std::process::exit(1);
    }
}
