import { axe as _axe } from 'vitest-axe'

// Re-exports vitest-axe's `axe()` with the `aria-hidden-focus` rule disabled
// by default. Radix portals (Sheet/Dialog/AlertDialog/Popover/...) insert
// `<span data-radix-focus-guard tabindex=0 aria-hidden>` sentinels as part
// of their focus-trap implementation; under happy-dom these trip axe's
// `aria-hidden-focus` rule even though the guards are never user-reachable.
// jsdom's looser focus-visibility computation hid the violation. Tests that
// specifically want to verify `aria-hidden-focus` can re-enable it by
// passing `rules: { 'aria-hidden-focus': { enabled: true } }`. PEND-37.
export async function axe(
  target: Parameters<typeof _axe>[0],
  options?: Parameters<typeof _axe>[1],
) {
  return _axe(target, {
    ...options,
    rules: {
      'aria-hidden-focus': { enabled: false },
      ...(options?.rules ?? {}),
    },
  })
}
