import { type ComponentType, lazy } from 'react'

/**
 * `lazy()` plus a `preload()` that fetches the chunk before the component first renders.
 *
 * Once preloaded, the factory hands React the module through a thenable that
 * resolves synchronously, so the first render does not suspend. A render that
 * suspends commits its Suspense fallback, and React then holds the component
 * back until 300 ms after that fallback (its Suspense fallback throttle),
 * however fast the chunk arrived (#5444).
 */
export function lazyWithPreload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  let loaded: { default: T } | undefined
  const preload = () =>
    load().then((module) => {
      loaded = module
      return module
    })
  const factory = () => {
    const module = loaded
    if (!module) return preload()
    // oxlint-disable-next-line unicorn/no-thenable -- lazy() reads a synchronous thenable without suspending; a resolved Promise still settles a microtask late
    const resolved = { then: (resolve: (m: typeof module) => void) => resolve(module) }
    return resolved as unknown as Promise<typeof module>
  }
  return Object.assign(lazy(factory), { preload })
}
