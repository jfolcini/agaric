/**
 * useExternalImagePolicy / useExternalImageAllowlist — localStorage-backed
 * preferences for the external-image load policy + per-host allowlist (#1492).
 *
 * Mirrors `useJournalDateFormat` / `useWeekStart`: a `useSyncExternalStore`
 * snapshot over a single localStorage key plus a non-hook getter
 * (`getExternalImagePolicy` / `getExternalImageAllowlist`) for pure render code
 * (the editor node view and the static renderer read the policy without a hook
 * when deciding whether to mount an `<img>`).
 *
 * The pure decision logic + key constants live in `lib/external-image-policy`;
 * this file is only the React/persistence glue.
 *
 * CRITICAL (useSyncExternalStore): `getSnapshot` for the allowlist returns a
 * `Set`. React bails out of a re-render only when the snapshot is referentially
 * equal across calls, so a fresh `Set` per call would loop forever. We cache the
 * parsed Set against its raw localStorage string and only rebuild when the raw
 * string changes — keeping the snapshot referentially stable between writes.
 */

import { useCallback, useSyncExternalStore } from 'react'

import {
  DEFAULT_EXTERNAL_IMAGE_POLICY,
  EXTERNAL_IMAGE_ALLOWLIST_KEY,
  EXTERNAL_IMAGE_POLICY_KEY,
  type ExternalImagePolicy,
  isExternalImagePolicy,
} from '@/lib/external-image-policy'

// ---------------------------------------------------------------------------
// Shared subscribe: re-read on any (synthetic or native) storage event for the
// relevant key. Same-window writes dispatch a synthetic `storage` event so a
// settings change reflects live in any mounted image without a remount.
// ---------------------------------------------------------------------------

function makeSubscribe(key: string) {
  return (callback: () => void): (() => void) => {
    const handler = (e: StorageEvent) => {
      if (e.key === key) callback()
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }
}

function dispatchStorage(key: string, oldValue: string | null, newValue: string | null) {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key,
      oldValue,
      newValue,
      url: window.location.href,
      storageArea: window.localStorage,
    }),
  )
}

// ---------------------------------------------------------------------------
// Policy (three-state: always | click | never)
// ---------------------------------------------------------------------------

function getPolicySnapshot(): ExternalImagePolicy {
  try {
    const stored = localStorage.getItem(EXTERNAL_IMAGE_POLICY_KEY)
    if (isExternalImagePolicy(stored)) return stored
  } catch {
    // Storage unavailable (private mode / locked-down webview). This backs
    // getExternalImagePolicy() during image render, so a throw here must not
    // break the view — fall through to the privacy-first default.
  }
  return DEFAULT_EXTERNAL_IMAGE_POLICY
}

function getPolicyServerSnapshot(): ExternalImagePolicy {
  return DEFAULT_EXTERNAL_IMAGE_POLICY
}

const subscribePolicy = makeSubscribe(EXTERNAL_IMAGE_POLICY_KEY)

export function useExternalImagePolicy(): {
  policy: ExternalImagePolicy
  setPolicy: (policy: ExternalImagePolicy) => void
} {
  const policy = useSyncExternalStore(subscribePolicy, getPolicySnapshot, getPolicyServerSnapshot)

  const setPolicy = useCallback((next: ExternalImagePolicy) => {
    let oldValue: string | null = null
    try {
      oldValue = localStorage.getItem(EXTERNAL_IMAGE_POLICY_KEY)
      localStorage.setItem(EXTERNAL_IMAGE_POLICY_KEY, next)
    } catch {
      // Storage unavailable — degrade to no-persist and skip the sync event.
      return
    }
    dispatchStorage(EXTERNAL_IMAGE_POLICY_KEY, oldValue, next)
  }, [])

  return { policy, setPolicy }
}

/** Non-hook getter for pure render code (node view / static renderer). */
export function getExternalImagePolicy(): ExternalImagePolicy {
  return getPolicySnapshot()
}

// ---------------------------------------------------------------------------
// Allowlist (set of normalized external hosts)
// ---------------------------------------------------------------------------

// Referentially-stable snapshot cache (see file header). Keyed by the raw
// localStorage string so the same Set instance is returned until a write
// changes the stored value.
let cachedRaw: string | null = null
let cachedSet: ReadonlySet<string> = new Set()

function parseAllowlist(raw: string | null): ReadonlySet<string> {
  if (raw === null) return new Set()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((h): h is string => typeof h === 'string'))
    }
  } catch {
    // Corrupt JSON — treat as empty (a malformed allowlist must never throw
    // during render). Not log-worthy: a format migration would hit this once.
  }
  return new Set()
}

function getAllowlistSnapshot(): ReadonlySet<string> {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(EXTERNAL_IMAGE_ALLOWLIST_KEY)
  } catch {
    // Storage unavailable — the empty default Set is itself stable.
    if (cachedRaw !== null) {
      cachedRaw = null
      cachedSet = new Set()
    }
    return cachedSet
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedSet = parseAllowlist(raw)
  }
  return cachedSet
}

function getAllowlistServerSnapshot(): ReadonlySet<string> {
  return cachedSet
}

const subscribeAllowlist = makeSubscribe(EXTERNAL_IMAGE_ALLOWLIST_KEY)

function writeAllowlist(next: ReadonlySet<string>): void {
  const serialized = JSON.stringify([...next])
  let oldValue: string | null = null
  try {
    oldValue = localStorage.getItem(EXTERNAL_IMAGE_ALLOWLIST_KEY)
    localStorage.setItem(EXTERNAL_IMAGE_ALLOWLIST_KEY, serialized)
  } catch {
    // Storage unavailable — degrade to no-persist and skip the sync event.
    return
  }
  dispatchStorage(EXTERNAL_IMAGE_ALLOWLIST_KEY, oldValue, serialized)
}

export function useExternalImageAllowlist(): {
  allowlist: ReadonlySet<string>
  /** Add an EXACT external host (e.g. derived from a src). No-op for null. */
  addHost: (host: string | null) => void
  removeHost: (host: string) => void
} {
  const allowlist = useSyncExternalStore(
    subscribeAllowlist,
    getAllowlistSnapshot,
    getAllowlistServerSnapshot,
  )

  const addHost = useCallback((host: string | null) => {
    if (host === null || host.length === 0) return
    const current = getAllowlistSnapshot()
    if (current.has(host)) return
    const next = new Set(current)
    next.add(host)
    writeAllowlist(next)
  }, [])

  const removeHost = useCallback((host: string) => {
    const current = getAllowlistSnapshot()
    if (!current.has(host)) return
    const next = new Set(current)
    next.delete(host)
    writeAllowlist(next)
  }, [])

  return { allowlist, addHost, removeHost }
}

/** Non-hook getter for pure render code. */
export function getExternalImageAllowlist(): ReadonlySet<string> {
  return getAllowlistSnapshot()
}
