//! `agaric-mcp` — stdio ↔ socket bridge for external MCP agents.
//!
//! MCP clients (Claude Desktop, Claude Code, Cursor, Continue, Devin …)
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
    if let Some(s) = env {
        if !s.is_empty() {
            return PathBuf::from(s);
        }
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

async fn run(socket_override: Option<PathBuf>) -> ExitCode {
    let socket_path = resolve_socket_path(socket_override);

    match connect(&socket_path).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!(
                "Agaric MCP not running (socket path: {}). Enable it in Settings → Agent access.\n\
                 (underlying error: {e})",
                socket_path.display(),
            );
            ExitCode::from(1)
        }
    }
}

#[cfg(unix)]
async fn connect(socket_path: &std::path::Path) -> std::io::Result<()> {
    use tokio::net::UnixStream;
    let stream = UnixStream::connect(socket_path).await?;
    bridge(stream).await
}

#[cfg(windows)]
async fn connect(pipe_path: &std::path::Path) -> std::io::Result<()> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let pipe_str = pipe_path.to_str().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("pipe path is not valid UTF-8: {}", pipe_path.display()),
        )
    })?;
    let client = ClientOptions::new().open(pipe_str)?;
    bridge(client).await
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
}
