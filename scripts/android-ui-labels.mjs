// The English UI strings the on-device Android scripts find controls by, read
// from the app's catalog so a reworded value cannot leave a stale copy in a
// script. Node strips the catalog's types on import.

import { common } from '../src/lib/i18n/common.ts'

/** The English value of `key` in `src/lib/i18n/common.ts`; throws on a missing key. */
export function english(key) {
  const value = common[key]
  if (value === undefined) {
    throw new Error(`android-ui-labels: no key '${key}' in src/lib/i18n/common.ts`)
  }
  return value
}
