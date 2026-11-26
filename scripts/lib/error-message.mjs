/**
 * The text of a caught value: an `Error`'s own message, or the thrown value itself.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}
