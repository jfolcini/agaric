// Test bodies are exempt from the 70-code-line ceiling (AGENTS.md "Patterns
// caught in review" item 6); production functions over it carry `#[expect]`
// so the marker expires when the function is split (#4639).
#![cfg_attr(test, allow(clippy::too_many_lines))]
//! `agaric-mcp` — stdio ↔ socket bridge for external MCP agents.
//!
//! MCP clients (Claude Desktop, Claude Code, Cursor, Continue, …)
//! spawn their "server" as a stdio subprocess. Agaric runs its actual MCP
//! server inside the main Tauri process on a Unix-domain socket (Linux /
//! macOS) or a Windows named pipe, so this stub bridges the two: it reads
//! line-delimited JSON-RPC from stdin and forwards it to the socket, then
//! reads responses from the socket and writes them to stdout.
//!
//! Before any MCP byte it writes `AGARIC-TOKEN <token>`, the token of the
//! agent Settings → Agent access made for this client (#5667); the app
//! serves the connection as that agent, or refuses it.
//!
//! Discovery:
//!
//! 1. `--socket <path>` CLI override, if present.
//! 2. `$AGARIC_MCP_SOCKET`, if set.
//! 3. Platform default: `~/.local/share/com.agaric.app/mcp.sock` on
//!    Linux, `~/Library/Application Support/com.agaric.app/mcp.sock`
//!    on macOS, `\\.\pipe\agaric-mcp` on Windows.
//!
//! The stub exits 0 on clean EOF (either side), 2 on a bad or missing
//! argument, and 1 with a single stderr line when the socket cannot be
//! reached.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::ExitCode;

use tokio::io::{AsyncRead, AsyncWrite};

// Consume the canonical identifiers from `agaric_lib::mcp` instead of
// redeclaring them locally, so the stub binary cannot drift from the
// in-process server (e.g. a default socket-filename change that would
// silently strand any agent already running this stub).
//
// `APP_IDENTIFIER` is only needed by the unix branches of
// [`default_socket_path`] — on Windows the named-pipe path is
// already a fixed namespace constant ([`MCP_PIPE_PATH`]).
#[cfg(unix)]
use agaric_lib::mcp::APP_IDENTIFIER;
#[cfg(windows)]
use agaric_lib::mcp::MCP_PIPE_PATH;
#[cfg(unix)]
use agaric_lib::mcp::MCP_SOCKET_FILENAME;
use agaric_lib::mcp::TOKEN_PREAMBLE;

const SOCKET_ENV: &str = "AGARIC_MCP_SOCKET";

/// The refusal for a config without `--token`: every config from before
/// #5667.
const MISSING_TOKEN: &str = "--token is required: add an agent for this client in \
     Settings → Agent access and copy its config";

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
        ParsedArgs::Run {
            socket_override,
            token,
        } => run(socket_override, &token).await,
        ParsedArgs::BadArg(msg) => {
            eprintln!("agaric-mcp: {msg}");
            eprintln!("Try `agaric-mcp --help` for usage.");
            ExitCode::from(2)
        }
    }
}

enum ParsedArgs {
    Run {
        socket_override: Option<PathBuf>,
        token: String,
    },
    Version,
    Help,
    BadArg(String),
}

fn parse_args(args: &[String]) -> ParsedArgs {
    let mut socket_override = None;
    let mut token = None;
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
            "--token" => match iter.next() {
                Some(value) if !value.is_empty() => token = Some(value.clone()),
                _ => return ParsedArgs::BadArg("--token requires a value".into()),
            },
            other if other.starts_with("--socket=") => {
                let (_, value) = other.split_once('=').unwrap();
                if value.is_empty() {
                    return ParsedArgs::BadArg("--socket requires a path argument".into());
                }
                socket_override = Some(PathBuf::from(value));
            }
            other if other.starts_with("--token=") => {
                let (_, value) = other.split_once('=').unwrap();
                if value.is_empty() {
                    return ParsedArgs::BadArg("--token requires a value".into());
                }
                token = Some(value.to_owned());
            }
            other => {
                return ParsedArgs::BadArg(format!("unknown argument: {other}"));
            }
        }
    }
    match token {
        Some(token) => ParsedArgs::Run {
            socket_override,
            token,
        },
        None => ParsedArgs::BadArg(MISSING_TOKEN.to_owned()),
    }
}

fn print_help() {
    println!(
        "agaric-mcp — stdio ↔ socket bridge for the Agaric MCP server\n\
         \n\
         USAGE:\n    \
             agaric-mcp --token <token> [--socket <path>]\n\
         \n\
         OPTIONS:\n    \
             --token <token>   The agent's token, from Settings → Agent access.\n    \
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
    base.join(APP_IDENTIFIER).join(MCP_SOCKET_FILENAME)
}

#[cfg(target_os = "macos")]
fn default_socket_path() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support"))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_IDENTIFIER).join(MCP_SOCKET_FILENAME)
}

#[cfg(windows)]
fn default_socket_path() -> PathBuf {
    PathBuf::from(MCP_PIPE_PATH)
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn default_socket_path() -> PathBuf {
    // Other unices — same filename under $HOME/.local/share as Linux.
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".local/share"))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_IDENTIFIER).join(MCP_SOCKET_FILENAME)
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

async fn run(socket_override: Option<PathBuf>, token: &str) -> ExitCode {
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

    match bridge(stream, token, tokio::io::stdin(), tokio::io::stdout()).await {
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

/// Write the agent's token preamble, then shuttle bytes between
/// stdin/stdout and the connected socket. When stdin closes, shut down the
/// socket's write half so the server observes EOF — but keep reading from
/// the socket until the server closes it. This is the standard MCP
/// stdio-stub convention and lets the server flush any pending response
/// before the bin exits.
async fn bridge<S, I, O>(stream: S, token: &str, mut stdin: I, mut stdout: O) -> std::io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    I: AsyncRead + Unpin + Send + 'static,
    O: AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt;

    let (mut read_half, mut write_half) = tokio::io::split(stream);
    write_half
        .write_all(format!("{TOKEN_PREAMBLE} {token}\n").as_bytes())
        .await?;

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

    /// The socket of a parsed `Run`, panicking on anything else.
    fn run_args(argv: &[&str]) -> (Option<PathBuf>, String) {
        match parse_args(&args_from(argv)) {
            ParsedArgs::Run {
                socket_override,
                token,
            } => (socket_override, token),
            _ => panic!("expected Run for {argv:?}"),
        }
    }

    #[test]
    fn parse_args_token_alone_runs_on_the_default_socket() {
        let (socket, token) = run_args(&["agaric-mcp", "--token", "agt_1"]);
        assert!(socket.is_none(), "no --socket means the default socket");
        assert_eq!(token, "agt_1");
    }

    #[test]
    fn parse_args_takes_both_token_forms_5667() {
        assert_eq!(run_args(&["agaric-mcp", "--token", "agt_a"]).1, "agt_a");
        assert_eq!(run_args(&["agaric-mcp", "--token=agt_b"]).1, "agt_b");
    }

    /// Every config from before #5667 lacks `--token`.
    #[test]
    fn parse_args_without_a_token_is_a_bad_arg_naming_settings_5667() {
        match parse_args(&args_from(&["agaric-mcp", "--socket", "/tmp/x.sock"])) {
            ParsedArgs::BadArg(msg) => assert!(
                msg.contains("Settings → Agent access"),
                "the error names where to get a token: {msg}",
            ),
            _ => panic!("a config without --token must not run"),
        }
    }

    #[test]
    fn parse_args_token_missing_value_is_bad_arg() {
        for argv in [
            &["agaric-mcp", "--token"][..],
            &["agaric-mcp", "--token="][..],
            &["agaric-mcp", "--token", ""][..],
        ] {
            assert!(
                matches!(parse_args(&args_from(argv)), ParsedArgs::BadArg(_)),
                "{argv:?} gives no token",
            );
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
        let (socket, _) = run_args(&["agaric-mcp", "--socket", "/tmp/x.sock", "--token", "t"]);
        assert_eq!(socket.unwrap(), PathBuf::from("/tmp/x.sock"));
    }

    #[test]
    fn parse_args_socket_override_equals_form() {
        let (socket, _) = run_args(&["agaric-mcp", "--token", "t", "--socket=/tmp/y.sock"]);
        assert_eq!(socket.unwrap(), PathBuf::from("/tmp/y.sock"));
    }

    #[test]
    fn parse_args_socket_missing_value_is_bad_arg() {
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "--token", "t", "--socket"])),
            ParsedArgs::BadArg(_)
        ));
        assert!(matches!(
            parse_args(&args_from(&["agaric-mcp", "--token", "t", "--socket="])),
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

    /// The server reads the token from the first line, before any MCP byte;
    /// stdin that is already waiting must not overtake it.
    #[tokio::test]
    async fn writes_preamble_first_5667() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let (server_side, bridge_side) = tokio::io::duplex(1024);
        let (mut client_stdin, bridge_stdin) = tokio::io::duplex(1024);
        client_stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n")
            .await
            .unwrap();
        drop(client_stdin);

        let bridge_task = tokio::spawn(bridge(
            bridge_side,
            "agt_0123",
            bridge_stdin,
            tokio::io::sink(),
        ));

        let mut server = BufReader::new(server_side);
        let mut first = String::new();
        server.read_line(&mut first).await.unwrap();
        assert_eq!(first, "AGARIC-TOKEN agt_0123\n", "the token comes first");
        let mut second = String::new();
        server.read_line(&mut second).await.unwrap();
        assert!(
            second.starts_with("{\"jsonrpc\""),
            "stdin follows the preamble: {second:?}",
        );

        drop(server);
        bridge_task.await.unwrap().expect("the bridge ends cleanly");
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
