/**
 * The Tauri events a mock command emits once it succeeds, as the backend's
 * `#[tauri::command]` wrapper emits them after its `_inner` commits.
 *
 * `setupMock` points them at the mock event bus, so the app's `listen()`
 * refreshes run in the browser as they do over the real IPC. Elsewhere they go
 * nowhere, unless the conformance harness takes them to compare with what the
 * backend recorded (`conformance-command.ts`).
 */

export type EventSink = (event: string, payload: unknown) => void

let sink: EventSink = () => {}

/** Route every later {@link emitEvent} to `next`; returns the sink it replaced. */
export function setEventSink(next: EventSink): EventSink {
  const previous = sink
  sink = next
  return previous
}

export function emitEvent(event: string, payload: unknown): void {
  sink(event, payload)
}

/**
 * `run`, dropping what it emits: a handler another command reuses runs as the
 * backend's `_inner` does inside that command, and only a wrapper emits.
 */
export function withoutEvents<T>(run: () => T): T {
  const previous = setEventSink(() => {})
  try {
    return run()
  } finally {
    setEventSink(previous)
  }
}
