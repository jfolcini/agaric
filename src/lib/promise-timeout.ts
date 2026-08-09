/**
 * Bound a promise by a timer.
 *
 * Lives in `lib` because two unrelated callers need it and they sit on
 * different tiers: the periodic sync trigger (`hooks/useSyncTrigger`, its
 * original home) and the pairing mutation queue (`lib/pairing-mutations`,
 * #3715). A lower tier may not import a higher one
 * (`scripts/check-lib-layering.mjs`), so the shared helper moves down rather
 * than being duplicated — it is a plain promise combinator with no React and
 * no app state in it, which is what `lib` is for.
 */

/**
 * Races `p` against a timer; rejects with `err` if `ms` elapses first.
 *
 * The timeout's `setTimeout` is cleared in `.finally()` so a winning `p` does
 * not leak a pending timer for the remainder of `ms`.
 *
 * Note that losing the race does not cancel `p` — nothing here can, promises
 * having no cancellation — so a caller that must not let a late `p` take
 * effect has to guard that itself.
 */
export async function runWithTimeout<T>(p: Promise<T>, ms: number, err: Error): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(err), ms)
  })
  try {
    return await Promise.race<T>([p, timeout])
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId)
  }
}
