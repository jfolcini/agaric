//! `emit` and `Channel::send` run on the main thread.
//!
//! Tauri's `tracing` feature turns `Webview::eval` into a round trip that
//! blocks until the main thread has run the script, and `Emitter::emit` holds
//! Tauri's webview lock across it. From any other thread, an emit then
//! deadlocks the app against an IPC request the main thread is resolving,
//! which waits on that lock. On the main thread `eval` runs inline, so nothing
//! waits. `clippy.toml` bans the direct calls everywhere but here.

use serde::Serialize;
use tauri::ipc::{Channel, IpcResponse};
use tauri::{AppHandle, Emitter, Runtime};

/// Emits `event` to every listener. Failures are logged: the caller has
/// already moved on.
pub fn emit<R, S>(app: &AppHandle<R>, event: &'static str, payload: S)
where
    R: Runtime,
    S: Serialize + Clone + Send + 'static,
{
    emit_with(app, event, payload, move |e| {
        tracing::warn!(event, error = %e, "failed to emit event");
    });
}

/// [`emit`], with `on_error` handling a failed emit in place of the default
/// warning.
pub fn emit_with<R, S>(
    app: &AppHandle<R>,
    event: &'static str,
    payload: S,
    on_error: impl FnOnce(tauri::Error) + Send + 'static,
) where
    R: Runtime,
    S: Serialize + Clone + Send + 'static,
{
    let emitter = app.clone();
    run(app, move || {
        #[expect(clippy::disallowed_methods, reason = "this is the main-thread emit")]
        let emitted = emitter.emit(event, payload);
        if let Err(e) = emitted {
            on_error(e);
        }
    });
}

/// A [`Channel`] whose sends run on the main thread.
pub struct UiChannel<R: Runtime, T: IpcResponse> {
    app: AppHandle<R>,
    channel: Channel<T>,
}

impl<R: Runtime, T: IpcResponse + Send + 'static> UiChannel<R, T> {
    pub fn new(app: AppHandle<R>, channel: Channel<T>) -> Self {
        Self { app, channel }
    }

    /// Best-effort: a channel the frontend dropped must not fail the caller.
    pub fn send(&self, message: T) {
        let channel = self.channel.clone();
        run(&self.app, move || {
            #[expect(clippy::disallowed_methods, reason = "this is the main-thread send")]
            let sent = channel.send(message);
            if let Err(e) = sent {
                tracing::debug!(error = %e, "IPC channel send failed (frontend likely dropped it)");
            }
        });
    }
}

/// Runs `task` inside the caller's span, so it stays in the caller's trace.
fn run<R: Runtime>(app: &AppHandle<R>, task: impl FnOnce() + Send + 'static) {
    let caller = tracing::Span::current();
    if let Err(e) = app.run_on_main_thread(move || caller.in_scope(task)) {
        tracing::warn!(error = %e, "main thread is gone; dropping a UI event");
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::mpsc;
    use std::thread::ThreadId;
    use std::time::Duration;

    use tauri::test::MockRuntime;

    /// A mock app whose event loop runs on its own thread, standing in for the
    /// main thread. A mock app that is not running executes main-thread tasks
    /// inline on the caller, which would hide where an emit actually runs.
    pub(crate) fn running_mock_app() -> (tauri::AppHandle<MockRuntime>, ThreadId) {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::spawn(move || {
            app.run(move |_, event| {
                if matches!(event, tauri::RunEvent::Ready) {
                    let _ = ready_tx.send(std::thread::current().id());
                }
            });
        });
        let main_thread = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("mock event loop never became ready");
        (handle, main_thread)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use tauri::Listener;
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::test_support::running_mock_app;
    use super::{UiChannel, emit, emit_with};

    const TIMEOUT: Duration = Duration::from_secs(10);

    #[test]
    fn emit_from_a_worker_thread_runs_on_the_main_thread() {
        let (app, main_thread) = running_mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen("test:event", move |event| {
            let _ = tx.send((std::thread::current().id(), event.payload().to_string()));
        });

        let worker_app = app.clone();
        std::thread::spawn(move || emit(&worker_app, "test:event", 42))
            .join()
            .expect("emitting thread panicked");

        let (emitted_on, payload) = rx.recv_timeout(TIMEOUT).expect("event never emitted");
        assert_eq!(emitted_on, main_thread);
        assert_eq!(payload, "42");
    }

    #[test]
    fn emit_with_hands_an_emit_failure_to_on_error() {
        let payload = std::collections::BTreeMap::from([((1, 2), "value")]);
        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();

        emit_with(app.handle(), "test:event", payload, move |e| {
            let _ = tx.send(e.to_string());
        });

        let errors: Vec<String> = rx.try_iter().collect();
        assert_eq!(
            errors.len(),
            1,
            "on_error must run exactly once: {errors:?}"
        );
        assert!(
            errors[0].contains("key must be a string"),
            "unexpected error: {}",
            errors[0]
        );
    }

    #[test]
    fn emit_with_an_unserializable_payload_logs_instead_of_panicking() {
        // A map with non-string keys has no JSON form, so `Emitter::emit` errs.
        let payload = std::collections::BTreeMap::from([((1, 2), "value")]);
        let app = tauri::test::mock_app();

        emit(app.handle(), "test:event", payload);
    }

    #[test]
    fn channel_send_from_a_worker_thread_runs_on_the_main_thread() {
        let (app, main_thread) = running_mock_app();
        let (tx, rx) = mpsc::channel();
        let channel = Channel::<u32>::new(move |body| {
            let InvokeResponseBody::Json(json) = body else {
                panic!("expected a JSON channel payload");
            };
            let _ = tx.send((std::thread::current().id(), json));
            Ok(())
        });
        let ui_channel = UiChannel::new(app.clone(), channel);

        std::thread::spawn(move || ui_channel.send(7))
            .join()
            .expect("sending thread panicked");

        let (sent_on, json) = rx.recv_timeout(TIMEOUT).expect("message never sent");
        assert_eq!(sent_on, main_thread);
        assert_eq!(json, "7");
    }

    /// Records each new span's parent name, process-wide: the span under test
    /// opens on the mock main thread, where a thread-local subscriber is absent.
    type SpanParents = Vec<(&'static str, Option<String>)>;

    #[derive(Clone, Default)]
    struct ParentLog(std::sync::Arc<std::sync::Mutex<SpanParents>>);

    impl<S> tracing_subscriber::Layer<S> for ParentLog
    where
        S: tracing::Subscriber + for<'a> tracing_subscriber::registry::LookupSpan<'a>,
    {
        fn on_new_span(
            &self,
            attrs: &tracing::span::Attributes<'_>,
            id: &tracing::span::Id,
            ctx: tracing_subscriber::layer::Context<'_, S>,
        ) {
            let parent = ctx
                .span(id)
                .and_then(|span| span.parent())
                .map(|p| p.name().to_string());
            self.0
                .lock()
                .unwrap()
                .push((attrs.metadata().name(), parent));
        }
    }

    impl ParentLog {
        fn parent_of(&self, name: &str) -> Option<String> {
            let log = self.0.lock().unwrap();
            log.iter()
                .find(|(span, _)| *span == name)
                .and_then(|(_, parent)| parent.clone())
        }
    }

    #[test]
    fn emits_and_sends_stay_in_the_callers_trace() {
        use tracing_subscriber::layer::SubscriberExt as _;
        let log = ParentLog::default();
        tracing::subscriber::set_global_default(tracing_subscriber::registry().with(log.clone()))
            .expect("no other global subscriber in this test process");
        let (app, _) = running_mock_app();
        let (tx, rx) = mpsc::channel();
        let emitted = tx.clone();
        app.listen("test:event", move |_| {
            let _ = emitted.send(());
        });
        let channel = Channel::<u32>::new(move |_| {
            let _callback = tracing::info_span!("channel_callback").entered();
            let _ = tx.send(());
            Ok(())
        });
        let ui_channel = UiChannel::new(app.clone(), channel);

        let worker_app = app.clone();
        std::thread::spawn(move || {
            let _caller = tracing::info_span!("caller").entered();
            emit(&worker_app, "test:event", 1);
            ui_channel.send(2);
        })
        .join()
        .expect("worker thread panicked");
        for _ in 0..2 {
            rx.recv_timeout(TIMEOUT)
                .expect("event or message never delivered");
        }

        assert_eq!(log.parent_of("app::emit").as_deref(), Some("caller"));
        assert_eq!(log.parent_of("channel_callback").as_deref(), Some("caller"));
    }

    #[test]
    fn channel_send_to_a_dropped_frontend_channel_does_not_panic() {
        let channel = Channel::<u32>::new(|_| Err(tauri::Error::WebviewNotFound));
        let app = tauri::test::mock_app();

        UiChannel::new(app.handle().clone(), channel).send(7);
    }
}
