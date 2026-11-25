import type { Page } from '@playwright/test'

import { SEED_IDS } from '@/lib/tauri-mock/seed'

import { settleBackend } from '../helpers'

type Invoke = (cmd: string, args?: unknown) => Promise<unknown>

/**
 * Data for the tour, on top of the mock's seed, written through the app's own
 * commands: "Product Roadmap Q1" holds headings, a nested list, every task
 * state, P1–P3, due, overdue, scheduled and past-scheduled dates, tags, properties, a callout,
 * a quote, a table, code, math and a long paragraph; a dozen pages give the
 * lists volume (namespaces included), and two trashed pages fill the Trash.
 */
export async function seedShowcase(page: Page): Promise<void> {
  await page.evaluate(
    async ({ space, quick, projects, meetings, tagWork, tagIdea }) => {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
        .__TAURI_INTERNALS__
      const scope = { kind: 'active', space_id: space }
      const day = (offset: number): string => {
        const d = new Date()
        d.setDate(d.getDate() + offset)
        return d.toISOString().slice(0, 10)
      }
      const idOf = (row: unknown): string =>
        typeof row === 'string' ? row : (row as { id: string }).id
      const block = async (parentId: string, content: string): Promise<string> =>
        idOf(
          await invoke('create_block', {
            blockType: 'content',
            content,
            parentId,
            index: null,
            scope,
            blockId: null,
          }),
        )
      const tag = async (name: string): Promise<string> =>
        idOf(
          await invoke('create_block', {
            blockType: 'tag',
            content: name,
            parentId: null,
            index: null,
            scope,
            blockId: null,
          }),
        )
      const pageNamed = async (title: string): Promise<string> =>
        (await invoke('create_page_in_space', {
          parentId: null,
          content: title,
          spaceId: space,
        })) as string
      const task = async (
        parentId: string,
        content: string,
        fields: {
          state: string
          priority?: string
          due?: number
          scheduled?: number
          tag?: string
        },
      ): Promise<string> => {
        const id = await block(parentId, content)
        await invoke('set_todo_state', { blockId: id, state: fields.state })
        if (fields.priority) await invoke('set_priority', { blockId: id, level: fields.priority })
        if (fields.due !== undefined) {
          await invoke('set_due_date', { blockId: id, date: day(fields.due) })
        }
        if (fields.scheduled !== undefined) {
          await invoke('set_scheduled_date', { blockId: id, date: day(fields.scheduled) })
        }
        if (fields.tag) await invoke('add_tag', { blockId: id, tagId: fields.tag })
        return id
      }

      const tagDesign = await tag('design')
      const tagMobile = await tag('mobile')
      const tagUrgent = await tag('urgent')
      for (const name of ['reading', 'health', 'finance']) await tag(name)

      const roadmap = await pageNamed('Product Roadmap Q1')
      await invoke('set_property', {
        blockId: roadmap,
        key: 'status',
        value: { value_text: 'active' },
      })
      await invoke('add_tag', { blockId: roadmap, tagId: tagDesign })
      await block(roadmap, '# Goals for the quarter')
      await block(
        roadmap,
        `Ship a **mobile-first** redesign, cut onboarding time in *half*, and make ==sync feel instant==. See [[${projects}]] and [[${meetings}]].`,
      )
      await task(roadmap, 'Audit every screen on a phone', {
        state: 'DOING',
        priority: '1',
        due: 2,
        tag: tagMobile,
      })
      await task(roadmap, 'Define the spacing and type scale tokens', {
        state: 'TODO',
        priority: '2',
        scheduled: 0,
        tag: tagDesign,
      })
      await task(roadmap, 'Write the onboarding checklist', { state: 'TODO', scheduled: -2 })
      await task(roadmap, 'Pick the accent colour', { state: 'DONE' })
      await task(roadmap, 'Replace the custom date picker', { state: 'CANCELLED' })
      await task(roadmap, 'Fix the overdue badge colour', {
        state: 'TODO',
        priority: '3',
        due: -3,
        tag: tagUrgent,
      })
      const study = await block(roadmap, 'Usability study with five participants')
      await invoke('set_property', { blockId: study, key: 'effort', value: { value_text: '1d' } })
      await invoke('set_property', {
        blockId: study,
        key: 'assignee',
        value: { value_text: 'Robin' },
      })
      await invoke('add_tag', { blockId: study, tagId: tagWork })
      await block(roadmap, '## Research notes')
      const themes = await block(roadmap, 'Interviews surfaced three recurring themes:')
      const nav = await block(themes, 'Navigation is hard to discover on small screens')
      await block(nav, 'Most participants never opened the drawer')
      await block(themes, 'Dialogs feel cramped; sheets feel native')
      await block(themes, `Typing on the go needs a bigger hit area #[${tagIdea}]`)
      await block(roadmap, '> [!NOTE] Decision\n> Use bottom sheets for every overlay on phones.')
      await block(roadmap, '> "Simplicity is the ultimate sophistication."')
      await block(
        roadmap,
        '| Screen | Status | Owner |\n| --- | --- | --- |\n| Journal | Reviewed | Ana |\n| Pages | In progress | Sam |\n| Settings | Not started | Lee |',
      )
      await block(
        roadmap,
        '```ts\nexport function spacing(step: number): string {\n  return `${step * 4}px`\n}\n```',
      )
      await block(roadmap, 'Inline math $E = mc^2$ and a [link to the docs](https://example.com).')
      await block(roadmap, '---')
      await block(roadmap, '1. First numbered step\n2. Second numbered step')
      await block(
        roadmap,
        'A long paragraph to check line length and rhythm: Agaric keeps every note on your own devices, syncs them over the local network, and lets you outline, link and query your blocks without any cloud account. The interface should make that feel calm and focused rather than busy.',
      )
      await block(quick, `Remember to review [[${roadmap}]] before Friday`)

      for (const title of [
        'Reading list',
        'Health/Running log',
        'Health/Meal plan',
        'Finance/Budget 2027',
        'Travel ideas',
        'Book notes — Thinking in Systems',
        'Recipes',
        'Home renovation',
        'Work/1:1 notes',
        'Work/Hiring pipeline',
        'A page with a fairly long title that should wrap or truncate gracefully',
      ]) {
        await block(await pageNamed(title), `Notes for ${title}`)
      }
      for (const title of ['Old draft', 'Scratch']) {
        await invoke('delete_block', { blockId: await pageNamed(title) })
      }
    },
    {
      space: SEED_IDS.SPACE_PERSONAL,
      quick: SEED_IDS.PAGE_QUICK_NOTES,
      projects: SEED_IDS.PAGE_PROJECTS,
      meetings: SEED_IDS.PAGE_MEETINGS,
      tagWork: SEED_IDS.TAG_WORK,
      tagIdea: SEED_IDS.TAG_IDEA,
    },
  )
  await settleBackend(page)
}
