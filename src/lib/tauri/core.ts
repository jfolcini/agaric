import type { AppError } from '@/lib/bindings'

/**
 * Build the same `{ kind: 'cancelled', message }` shape the backend
 * emits for `AppError::Cancelled`, so `isCancellation(err)` (from
 * `lib/app-error.ts`) discriminates client-side aborts the same way
 * it discriminates server-side cancellations.
 */
export function cancelledError(reason = 'aborted client-side'): AppError {
  return { kind: 'cancelled', message: reason }
}

/**
 * Wrap a typed IPC promise so it rejects with a `cancelled`-kind
 * `AppError` if the supplied `AbortSignal` fires. The underlying IPC
 * is NOT cancelled server-side (Tauri 2 limitation); the wrapper is
 * a client-side stop-waiting primitive. Use alongside
 * `useGenerationGuard` if the consumer also needs to discard the
 * value when it eventually arrives.
 *
 * If `signal` is undefined or already aborted, the behaviour is
 * unchanged from the bare promise (already-aborted short-circuits
 * before the IPC even starts; undefined passes through verbatim).
 */
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return promise
  if (signal.aborted) {
    // The IPC promise was already constructed (args are eager); it's now
    // orphaned by the early reject below. Swallow its eventual settlement so a
    // later rejection doesn't surface as an unhandled promise rejection.
    promise.catch(() => {})
    return Promise.reject(cancelledError(signal.reason?.toString()))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(cancelledError(signal.reason?.toString()))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}
