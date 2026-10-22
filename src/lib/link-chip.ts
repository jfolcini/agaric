/**
 * The target id of the `[[link]]` or `((ref))` chip under `target`, static or
 * in the editor; both renderers mark a navigable chip with these attributes.
 */
export function pageLinkIdAt(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined
  const chip = target.closest('[data-type="block-link"][data-id], [data-type="block-ref"][data-id]')
  return chip?.getAttribute('data-id') ?? undefined
}
