/**
 * The title a page created with no name gets (#4723): the New page dialog
 * (`usePageCreation`) uses it for a blank title.
 *
 * `create_page_in_space` RESOLVES an existing title to that page instead of
 * creating a second one, so passing the literal 'Untitled' twice would reopen
 * the first Untitled page the user left un-renamed. Picking the first free
 * `Untitled N` before the create keeps every "New page" a new page.
 */

const BASE_TITLE = 'Untitled'

/**
 * The first of `Untitled`, `Untitled 2`, `Untitled 3`, … that `titles` does
 * not already contain. Exact string compare, matching the backend's
 * exact-content resolve rule.
 */
export function untitledTitle(titles: Iterable<string | null>): string {
  const taken = new Set(titles)
  let candidate = BASE_TITLE
  let suffix = 1
  while (taken.has(candidate)) {
    suffix += 1
    candidate = `${BASE_TITLE} ${suffix}`
  }
  return candidate
}
