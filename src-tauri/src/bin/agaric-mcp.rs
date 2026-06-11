//! `agaric-mcp` — stdio ↔ socket bridge for external MCP agents.
//!
//! MCP clients (Claude Desktop, Claude Code, Cursor, Continue, …)
//! spawn their "server" as a stdio subprocess. Agaric runs its actual MCP
//! server inside the main Tauri process on a Unix-domain socket (Linux /
//! macOS) or a Windows named pipe, so this stub bridges the two: it reads
//! line-delimited JSON-RPC from stdin and forwards it to the socket, then
//! reads responses from the socket and writes them to stdout.
//!
//! Discovery:
//!
//! 1. `--socket <path>` CLI override, if present.
//! 2. `$AGARIC_MCP_SOCKET`, if set.
//! 3. Platform default: `~/.local/share/com.agaric.app/mcp-ro.sock` on
//!    Linux, `~/Library/Application Support/com.agaric.app/mcp-ro.sock`
//!    on macOS, `\\.\pipe\agaric-mcp-ro` on Windows.
//!
//! The stub exits 0 on clean EOF (either side) and exits 1 with a single
//! stderr line when the socket cannot be reached.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::ExitCode;

use tokio::io::{AsyncRead, AsyncWrite};

// MAINT-150 (i): consume the canonical identifiers from
// `agaric_lib::mcp` instead of redeclaring them locally. Keeping the
// path constants in one place prevents the stub binary from drifting
// from the in-process server (e.g. a default socket-filename change
// that would silently strand any agent already running this stub).
//
// `APP_IDENTIFIER` is only needed by the unix branches of
// [`default_socket_path`] — on Windows the named-pipe path is
// already a fixed namespace constant ([`MCP_RO_PIPE_PATH`]) and the
// identifier is not threaded through.
#[cfg(unix)]
use agaric_lib::mcp::APP_IDENTIFIER;
#[cfg(windows)]
use agaric_lib::mcp::MCP_RO_PIPE_PATH;
#[cfg(unix)]
use agaric_lib::mcp::MCP_RO_SOCKET_FILENAME;

const SOCKET_ENV: &str = "AGARIC_MCP_SOCKET";

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match parse_args(&args) {
        ParsedArgs::Version => {
            println!("agaric-mcp {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ParsedArgs::Help => {
            print_help();
            ExitCode::SUCCESS
        }
        ParsedArgs::Run { socket_override } => run(socket_override).await,
        ParsedArgs::BadArg(msg) => {
            eprintln!("agaric-mcp: {msg}");
            eprintln!("Try `agaric-mcp --help` for usage.");
            ExitCode::from(2)
        }
    }
}

enum ParsedArgs {
    Run { socket_override: Option<PathBuf> },
    Version,
    Help,
    BadArg(String),
}

fn parse_args(args: &[String]) -> ParsedArgs {
    let mut socket_override = None;
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--version" | "-V" => return ParsedArgs::Version,
            "--help" | "-h" => return ParsedArgs::Help,
            "--socket" => match iter.next() {
                Some(path) => socket_override = Some(PathBuf::from(path)),
                None => {
                    return ParsedArgs::BadArg("--socket requires a path argument".into());
                }
            },
            other if other.starts_with("--socket=") => {
                let (_, value) = other.split_once('=').unwrap();
                if value.is_empty() {
                    return ParsedArgs::BadArg("--socket requires a path argument".into());
                }
                socket_override = Some(PathBuf::from(value));
            }
            other => {
                return ParsedArgs::BadArg(format!("unknown argument: {other}"));
            }
        }
    }
    ParsedArgs::Run { socket_override }
}

fn print_help() {
    println!(
        "agaric-mcp — stdio ↔ socket bridge for the Agaric MCP server\n\
         \n\
         USAGE:\n    \
             agaric-mcp [--socket <path>]\n\
         \n\
         OPTIONS:\n    \
             --socket <path>   Override the MCP socket / named-pipe path.\n    \
             -V, --version     Print version and exit.\n    \
             -h, --help        Print this help and exit.\n\
         \n\
         ENVIRONMENT:\n    \
             AGARIC_MCP_SOCKET   Socket path, used when --socket is not given."
    );
}

fn resolve_socket_path(override_arg: Option<PathBuf>) -> PathBuf {
    let env_val = std::env::var(SOCKET_ENV).ok();
    resolve_socket_path_from(override_arg, env_val, default_socket_path())
}

/// Pure variant of [`resolve_socket_path`] used by tests: precedence is
/// `override_arg` > non-empty `env` > `default_path`. Exposed with explicit
/// parameters so tests do not need to mutate the process environment (which
/// is `unsafe` in Rust 1.80+ and forbidden by `unsafe_code = "deny"`).
fn resolve_socket_path_from(
    override_arg: Option<PathBuf>,
    env: Option<String>,
    default_path: PathBuf,
) -> PathBuf {
    if let Some(path) = override_arg {
        return path;
    }
    if let Some(s) = env
        && !s.is_empty()
    {
        return PathBuf::from(s);
    }
    default_path
}

#[cfg(target_os = "linux")]
fn default_socket_path() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_IDENTIFIER).join(MCP_RO_SOCKET_FILENAME)
}

#[cfg(target_os = "macos")]
fn default_socket_path() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support"))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_IDENTIFIER).join(MCP_RO_SOCKET_FILENAME)
}

#[cfg(windows)]
fn default_socket_path() -> PathBuf {
    PathBuf::from(MCP_RO_PIPE_PATH)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn default_socket_path() -> PathBuf {
    // Other unices — same filename under $HOME/.local/share as Linux.
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_IDENTIFIER).join(MCP_RO_SOCKET_FILENAME)
}

/// #696 — message for a CONNECT-phase failure: the socket could not be
/// reached at all, so "the server is not running" is the right
/// diagnosis and "enable it in Settings" the right remedy.
fn connect_failure_message(socket_path: &std::path::Path, err: &std::io::Error) -> String {
    format!(
        "Agaric MCP not running (socket path: {}). Enable it in Settings → Agent access.\n\
         (underlying error: {err})",
        socket_path.display(),
    )
}

/// #696 — message for a BRIDGE-phase failure: the session connected and
/// then broke mid-flight (broken pipe, app quit, disconnect-all). The
/// old code funnelled this through the connect-phase wording, telling
/// the user a running-then-killed server was "not running — enable it
/// in Settings", which sends them to a toggle that is already on.
fn bridge_failure_message(socket_path: &std::path::Path, err: &std::io::Error) -> String {
    format!(
        "Agaric MCP connection lost after the session started (socket path: {}). \
         The app may have quit, restarted, or disconnected agents.\n\
         (underlying error: {err})",
        socket_path.display(),
    )
}

async fn run(socket_override: Option<PathBuf>) -> ExitCode {
    let socket_path = resolve_socket_path(socket_override);

    // #696 — connect and bridge are distinct phases with distinct
    // failure stories; do not collapse them into one error message.
    let stream = match connect(&socket_path).await {
        Ok(stream) => stream,
        Err(e) => {
            eprintln!("{}", connect_failure_message(&socket_path, &e));
            return ExitCode::from(1);
        }
    };

    match bridge(stream).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{}", bridge_failure_message(&socket_path, &e));
            ExitCode::from(1)
        }
    }
}

#[cfg(unix)]
async fn connect(socket_path: &std::path::Path) -> std::io::Result<tokio::net::UnixStream> {
    use tokio::net::UnixStream;
    UnixStream::connect(socket_path).await
}

#[cfg(windows)]
async fn connect(
    pipe_path: &std::path::Path,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe_str = pipe_path.to_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("pipe path is not valid UTF-8: {}", pipe_path.display()),
        )
    })?;
    ClientOptions::new().open(pipe_str)
}

/// Shuttle bytes between stdin/stdout and the connected socket. When stdin
/// closes, shut down the socket's write half so the server observes EOF —
/// but keep reading from the socket until the server closes it. This is
/// the standard MCP stdio-stub convention and lets the server flush any
/// pending response before the bin exits.
async fn bridge<S>(stream: S) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    use tokio::io::AsyncWriteExt;

    let (mut read_half, mut write_half) = tokio::io::split(stream);
    let mut stdin = tokio::io::stdin();
    let mut stdout = tokio::io::stdout();

    let to_socket = tokio::spawn(async move {
        let r = tokio::io::copy(&mut stdin, &mut write_half).await;
        // Signal EOF to the server while leaving the read half alive so
        // late responses still arrive.
        let _ = write_half.shutdown().await;
        r.map(|_| ())
    });

    let from_socket_result = tokio::io::copy(&mut read_half, &mut stdout)
        .await
        .map(|_| ());

    // Once the socket reader finishes, stop forwarding stdin.
    to_socket.abort();
    from_socket_result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_from(argv: &[&str]) -> Vec<String> {
        argv.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn parse_args_default_is_run_without_override() {
        match parse_args(&args_from(&["agaric-mcp"])) {
            ParsedArgs::Run { socket_override } => assert!(socket_override.is_none()),
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn parse_args_version_flag() {
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "--version"])),
            ParsedArgs::Version
        ));
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "-V"])),
            ParsedArgs::Version
        ));
    }

    #[test]
    fn parse_args_help_flag() {
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "--help"])),
            ParsedArgs::Help
        ));
    }

    #[test]
    fn parse_args_socket_override_space_form() {
        match parse_args(&args_from(&["agaric-mcp", "--socket", "/tmp/x.sock"])) {
            ParsedArgs::Run { socket_override } => {
                assert_eq!(socket_override.unwrap(), PathBuf::from("/tmp/x.sock"));
            }
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn parse_args_socket_override_equals_form() {
        match parse_args(&args_from(&["agaric-mcp", "--socket=/tmp/y.sock"])) {
            ParsedArgs::Run { socket_override } => {
                assert_eq!(socket_override.unwrap(), PathBuf::from("/tmp/y.sock"));
            }
            _ => panic!("expected Run"),
        }
    }

    #[test]
    fn parse_args_socket_missing_value_is_bad_arg() {
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "--socket"])),
            ParsedArgs::BadArg(_)
        ));
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "--socket="])),
            ParsedArgs::BadArg(_)
        ));
    }

    #[test]
    fn parse_args_unknown_flag_is_bad_arg() {
        match parse_args(&args_from(&["agaric-mcp", "--unknown"])) {
            ParsedArgs::BadArg(msg) => assert!(msg.contains("unknown")),
            _ => panic!("expected BadArg"),
        }
    }

    #[test]
    fn resolve_socket_path_from_prefers_cli_override() {
        let resolved = resolve_socket_path_from(
            Some(PathBuf::from("/tmp/cli.sock")),
            Some("/tmp/env.sock".into()),
            PathBuf::from("/tmp/default.sock"),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/cli.sock"));
    }

    #[test]
    fn resolve_socket_path_from_falls_back_to_env() {
        let resolved = resolve_socket_path_from(
            None,
            Some("/tmp/env.sock".into()),
            PathBuf::from("/tmp/default.sock"),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/env.sock"));
    }

    #[test]
    fn resolve_socket_path_from_falls_back_to_default_when_env_empty() {
        let resolved = resolve_socket_path_from(
            None,
            Some(String::new()),
            PathBuf::from("/tmp/default.sock"),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/default.sock"));
    }

    #[test]
    fn resolve_socket_path_from_falls_back_to_default_when_env_missing() {
        let resolved = resolve_socket_path_from(None, None, PathBuf::from("/tmp/default.sock"));
        assert_eq!(resolved, PathBuf::from("/tmp/default.sock"));
    }

    // ── #696 — connect-phase vs bridge-phase failure messages ──────────

    #[test]
    fn connect_failure_message_advises_enabling_in_settings() {
        let err = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        let msg = connect_failure_message(std::path::Path::new("/tmp/x.sock"), &err);
        assert!(
            msg.contains("Agaric MCP not running"),
            "connect-phase failure means the server is unreachable: {msg}"
        );
        assert!(
            msg.contains("Settings"),
            "connect-phase remedy is the Settings toggle: {msg}"
        );
        assert!(msg.contains("/tmp/x.sock"), "names the socket path: {msg}");
        assert!(msg.contains("refused"), "carries the io detail: {msg}");
    }

    #[test]
    fn bridge_failure_message_does_not_claim_server_not_running() {
        let err = std::io::Error::new(std::io::ErrorKind::BrokenPipe, "broken pipe");
        let msg = bridge_failure_message(std::path::Path::new("/tmp/x.sock"), &err);
        assert!(
            !msg.contains("not running"),
            "#696: a mid-session failure must NOT claim the server is not running: {msg}"
        );
        assert!(
            !msg.contains("Enable it in Settings"),
            "#696: the enable-toggle advice is wrong for a session that already started: {msg}"
        );
        assert!(
            msg.contains("after the session started"),
            "bridge-phase wording identifies the mid-session phase: {msg}"
        );
        assert!(msg.contains("broken pipe"), "carries the io detail: {msg}");
    }

    /// #696 happy + error path through the real `connect` + `bridge`
    /// machinery on unix: a server that accepts and immediately closes
    /// lets `connect` succeed (so a subsequent failure would be
    /// bridge-phase, not connect-phase), while a missing socket file
    /// fails in the connect phase.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn connect_phase_distinguishes_missing_socket_from_live_server() {
        use tokio::net::UnixListener;

        let dir = tempfile::TempDir::new().expect("tempdir");
        let live_path = dir.path().join("live.sock");
        let listener = UnixListener::bind(&live_path).expect("bind");
        let accept_task = tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        // Live socket: connect-phase succeeds.
        let stream = connect(&live_path).await;
        assert!(
            stream.is_ok(),
            "connect must succeed against a live socket: {stream:?}"
        );
        drop(stream);
        let _ = accept_task.await;

        // Missing socket: connect-phase fails (this is the only case
        // that should produce the "not running" guidance).
        let missing = dir.path().join("missing.sock");
        let err = connect(&missing).await.expect_err("no socket bound");
        let msg = connect_failure_message(&missing, &err);
        assert!(msg.contains("Agaric MCP not running"));
    }
}
