/**
 * Curated native-emoji dataset for the inline `:` picker (#130 Phase 2).
 *
 * Deliberately a hand-curated, high-frequency subset (~120) rather than a
 * full CLDR/emoji-mart dataset: it keeps the local-first bundle tiny (no new
 * dependency, no ~150 KB data blob) while covering the emoji people actually
 * reach for in notes. Characters are written as `\u{...}` codepoint escapes
 * so a copy-paste glyph can't silently corrupt the source. Variation
 * selectors (`\u{FE0F}`) are included where the emoji presentation needs
 * them.
 *
 * `name` is the canonical shortcode (what matches first); `keywords` are
 * additional aliases/synonyms the fuzzy matcher also indexes (so `:thumbsup`,
 * `:+1`, and `:like` all reach 👍). Extend freely — the inline picker reads
 * this list verbatim.
 */

import { matchSorter } from 'match-sorter'

export interface EmojiEntry {
  /** The native Unicode emoji to insert. */
  readonly char: string
  /** Canonical shortcode (primary match key). */
  readonly name: string
  /** Additional aliases / synonyms for fuzzy search. */
  readonly keywords: readonly string[]
}

/**
 * Display groups for the browse-grid `<EmojiPicker>` (#286). The inline `:`
 * picker (#281) ignores grouping — it reads `EMOJI`/`searchEmoji` flat — so
 * this is additive: the curated set is partitioned into these buckets purely
 * for the categorized, sticky-header grid. Order here is the grid render
 * order. Mirrors the `── … ──` section comments in `EMOJI` below.
 */
export const EMOJI_GROUPS = [
  'Smileys & Emotion',
  'Gestures & Body',
  'Hearts & Symbols',
  'Objects & Tools',
  'Nature & Misc',
] as const

export type EmojiGroup = (typeof EMOJI_GROUPS)[number]

/**
 * The first shortcode of each section in `EMOJI`. Used by `groupedEmoji()` to
 * partition the flat list sequentially: every entry inherits the group of the
 * most recent boundary at or before it. Keeping the boundaries as a name map
 * (rather than hard-coded indices) means re-ordering or inserting emoji inside
 * a section doesn't silently mis-bucket the tail.
 */
const GROUP_BOUNDARIES: Readonly<Record<string, EmojiGroup>> = {
  grinning: 'Smileys & Emotion',
  thumbsup: 'Gestures & Body',
  heart: 'Hearts & Symbols',
  check: 'Objects & Tools',
  sun: 'Nature & Misc',
}

export const EMOJI: readonly EmojiEntry[] = [
  // ── Smileys & emotion ──────────────────────────────────────────────
  { char: '\u{1F600}', name: 'grinning', keywords: ['smile', 'happy'] },
  { char: '\u{1F604}', name: 'smile', keywords: ['happy', 'joy', 'grin'] },
  { char: '\u{1F601}', name: 'grin', keywords: ['happy'] },
  { char: '\u{1F602}', name: 'joy', keywords: ['laugh', 'tears', 'lol'] },
  { char: '\u{1F923}', name: 'rofl', keywords: ['rolling', 'laugh', 'lmao'] },
  { char: '\u{1F605}', name: 'sweat_smile', keywords: ['laugh', 'relief'] },
  { char: '\u{1F60A}', name: 'blush', keywords: ['smile', 'happy'] },
  { char: '\u{1F642}', name: 'slight_smile', keywords: ['smile'] },
  { char: '\u{1F609}', name: 'wink', keywords: ['flirt'] },
  { char: '\u{1F60D}', name: 'heart_eyes', keywords: ['love', 'crush'] },
  { char: '\u{1F618}', name: 'kissing_heart', keywords: ['kiss', 'love'] },
  { char: '\u{1F60E}', name: 'sunglasses', keywords: ['cool', 'shades'] },
  { char: '\u{1F914}', name: 'thinking', keywords: ['hmm', 'consider'] },
  { char: '\u{1F917}', name: 'hugging', keywords: ['hug'] },
  { char: '\u{1F643}', name: 'upside_down', keywords: ['silly', 'irony'] },
  { char: '\u{1F60F}', name: 'smirk', keywords: ['smug'] },
  { char: '\u{1F610}', name: 'neutral', keywords: ['meh', 'blank'] },
  { char: '\u{1F644}', name: 'roll_eyes', keywords: ['eyeroll', 'annoyed'] },
  { char: '\u{1F62C}', name: 'grimacing', keywords: ['awkward', 'eek'] },
  { char: '\u{1F605}', name: 'phew', keywords: ['relief', 'sweat'] },
  { char: '\u{1F634}', name: 'sleeping', keywords: ['sleep', 'zzz', 'tired'] },
  { char: '\u{1F622}', name: 'cry', keywords: ['sad', 'tear'] },
  { char: '\u{1F62D}', name: 'sob', keywords: ['cry', 'sad', 'bawl'] },
  { char: '\u{1F621}', name: 'rage', keywords: ['angry', 'mad'] },
  { char: '\u{1F620}', name: 'angry', keywords: ['mad'] },
  { char: '\u{1F631}', name: 'scream', keywords: ['shock', 'fear'] },
  { char: '\u{1F633}', name: 'flushed', keywords: ['embarrassed', 'blush'] },
  { char: '\u{1F973}', name: 'partying_face', keywords: ['party', 'celebrate', 'tada'] },
  { char: '\u{1F929}', name: 'star_struck', keywords: ['amazed', 'wow', 'stars'] },
  { char: '\u{1F92F}', name: 'mind_blown', keywords: ['exploding', 'shock', 'wow'] },
  { char: '\u{1F607}', name: 'innocent', keywords: ['angel', 'halo'] },
  { char: '\u{1F60C}', name: 'relieved', keywords: ['calm', 'content'] },
  { char: '\u{1F614}', name: 'pensive', keywords: ['sad', 'thoughtful'] },
  { char: '\u{1F61E}', name: 'disappointed', keywords: ['sad'] },
  { char: '\u{1F624}', name: 'triumph', keywords: ['huff', 'frustrated'] },
  { char: '\u{1F971}', name: 'yawning', keywords: ['tired', 'bored', 'sleepy'] },
  { char: '\u{1F975}', name: 'hot_face', keywords: ['heat', 'sweating'] },
  { char: '\u{1F976}', name: 'cold_face', keywords: ['freezing', 'cold'] },
  { char: '\u{1F644}', name: 'eyeroll', keywords: ['annoyed'] },
  { char: '\u{1F92A}', name: 'zany', keywords: ['crazy', 'goofy', 'wacky'] },
  { char: '\u{1F914}', name: 'hmm', keywords: ['thinking'] },

  // ── Gestures & body ────────────────────────────────────────────────
  { char: '\u{1F44D}', name: 'thumbsup', keywords: ['+1', 'like', 'yes', 'approve'] },
  { char: '\u{1F44E}', name: 'thumbsdown', keywords: ['-1', 'dislike', 'no'] },
  { char: '\u{1F44F}', name: 'clap', keywords: ['applause', 'bravo'] },
  { char: '\u{1F64F}', name: 'pray', keywords: ['thanks', 'please', 'hope'] },
  { char: '\u{1F44C}', name: 'ok_hand', keywords: ['ok', 'perfect'] },
  { char: '\u{1F91D}', name: 'handshake', keywords: ['deal', 'agree'] },
  { char: '\u{1F4AA}', name: 'muscle', keywords: ['strong', 'flex', 'gains'] },
  { char: '\u{1F44B}', name: 'wave', keywords: ['hi', 'hello', 'bye'] },
  { char: '\u{1F91E}', name: 'crossed_fingers', keywords: ['luck', 'hope'] },
  { char: '\u{270C}\u{FE0F}', name: 'v', keywords: ['victory', 'peace'] },
  { char: '\u{1F590}\u{FE0F}', name: 'raised_hand', keywords: ['hand', 'stop'] },
  { char: '\u{1F440}', name: 'eyes', keywords: ['look', 'watching', 'see'] },
  { char: '\u{1F926}', name: 'facepalm', keywords: ['ugh', 'disbelief'] },
  { char: '\u{1F937}', name: 'shrug', keywords: ['idk', 'whatever', 'dunno'] },
  { char: '\u{1F64C}', name: 'raised_hands', keywords: ['celebrate', 'praise', 'hooray'] },
  { char: '\u{1F447}', name: 'point_down', keywords: ['below', 'down'] },
  { char: '\u{1F446}', name: 'point_up', keywords: ['above', 'up'] },
  { char: '\u{1F449}', name: 'point_right', keywords: ['right'] },
  { char: '\u{1F448}', name: 'point_left', keywords: ['left'] },

  // ── Hearts & emotion symbols ───────────────────────────────────────
  { char: '\u{2764}\u{FE0F}', name: 'heart', keywords: ['love', 'red'] },
  { char: '\u{1F9E1}', name: 'orange_heart', keywords: ['love'] },
  { char: '\u{1F49B}', name: 'yellow_heart', keywords: ['love'] },
  { char: '\u{1F49A}', name: 'green_heart', keywords: ['love'] },
  { char: '\u{1F499}', name: 'blue_heart', keywords: ['love'] },
  { char: '\u{1F49C}', name: 'purple_heart', keywords: ['love'] },
  { char: '\u{1F5A4}', name: 'black_heart', keywords: ['love'] },
  { char: '\u{1F494}', name: 'broken_heart', keywords: ['heartbreak', 'sad'] },
  { char: '\u{1F495}', name: 'two_hearts', keywords: ['love'] },
  { char: '\u{1F4AF}', name: '100', keywords: ['hundred', 'perfect', 'score'] },
  { char: '\u{1F4A5}', name: 'boom', keywords: ['explosion', 'collision'] },
  { char: '\u{1F4A2}', name: 'anger', keywords: ['mad', 'angry'] },
  { char: '\u{1F4AC}', name: 'speech', keywords: ['comment', 'talk', 'chat'] },
  { char: '\u{1F4A4}', name: 'zzz', keywords: ['sleep', 'tired'] },

  // ── Objects & symbols (notes-app workhorses) ───────────────────────
  { char: '\u{2705}', name: 'check', keywords: ['done', 'yes', 'tick', 'complete'] },
  { char: '\u{2611}\u{FE0F}', name: 'ballot_check', keywords: ['checkbox', 'done'] },
  { char: '\u{2714}\u{FE0F}', name: 'heavy_check', keywords: ['done', 'tick'] },
  { char: '\u{274C}', name: 'x', keywords: ['no', 'cross', 'cancel', 'wrong'] },
  { char: '\u{274E}', name: 'negative_check', keywords: ['no', 'cross'] },
  { char: '\u{26A0}\u{FE0F}', name: 'warning', keywords: ['caution', 'alert'] },
  { char: '\u{1F6A7}', name: 'construction', keywords: ['wip', 'progress', 'roadblock'] },
  { char: '\u{1F6D1}', name: 'stop', keywords: ['halt', 'octagon'] },
  { char: '\u{2753}', name: 'question', keywords: ['help', 'unsure'] },
  { char: '\u{2757}', name: 'exclamation', keywords: ['important', 'alert'] },
  { char: '\u{1F4A1}', name: 'bulb', keywords: ['idea', 'light', 'tip'] },
  { char: '\u{2728}', name: 'sparkles', keywords: ['shiny', 'new', 'magic', 'clean'] },
  { char: '\u{2B50}', name: 'star', keywords: ['favorite', 'rate'] },
  { char: '\u{1F31F}', name: 'star2', keywords: ['glowing', 'shine'] },
  { char: '\u{1F525}', name: 'fire', keywords: ['hot', 'lit', 'flame'] },
  { char: '\u{1F389}', name: 'tada', keywords: ['party', 'celebrate', 'hooray', 'launch'] },
  { char: '\u{1F38A}', name: 'confetti', keywords: ['party', 'celebrate'] },
  { char: '\u{1F680}', name: 'rocket', keywords: ['launch', 'ship', 'fast', 'deploy'] },
  { char: '\u{1F3AF}', name: 'dart', keywords: ['target', 'goal', 'bullseye'] },
  { char: '\u{1F4DD}', name: 'memo', keywords: ['note', 'write', 'edit'] },
  { char: '\u{1F4CC}', name: 'pushpin', keywords: ['pin', 'note'] },
  { char: '\u{1F4CD}', name: 'round_pushpin', keywords: ['location', 'place', 'pin'] },
  { char: '\u{1F4C5}', name: 'calendar', keywords: ['date', 'schedule'] },
  { char: '\u{1F5D3}\u{FE0F}', name: 'spiral_calendar', keywords: ['date', 'schedule'] },
  { char: '\u{23F0}', name: 'alarm_clock', keywords: ['time', 'reminder', 'wake'] },
  { char: '\u{23F3}', name: 'hourglass', keywords: ['time', 'wait', 'loading'] },
  { char: '\u{1F514}', name: 'bell', keywords: ['notification', 'reminder', 'alert'] },
  { char: '\u{1F512}', name: 'lock', keywords: ['secure', 'private', 'closed'] },
  { char: '\u{1F511}', name: 'key', keywords: ['password', 'access'] },
  { char: '\u{1F50D}', name: 'mag', keywords: ['search', 'find', 'zoom'] },
  { char: '\u{1F527}', name: 'wrench', keywords: ['fix', 'tool', 'config'] },
  { char: '\u{1F528}', name: 'hammer', keywords: ['build', 'tool'] },
  { char: '\u{2699}\u{FE0F}', name: 'gear', keywords: ['settings', 'config', 'cog'] },
  { char: '\u{1F41B}', name: 'bug', keywords: ['issue', 'defect', 'insect'] },
  { char: '\u{1F4C8}', name: 'chart_up', keywords: ['growth', 'increase', 'trend'] },
  { char: '\u{1F4C9}', name: 'chart_down', keywords: ['decrease', 'loss'] },
  { char: '\u{1F4CA}', name: 'bar_chart', keywords: ['stats', 'data', 'metrics'] },
  { char: '\u{1F4B0}', name: 'money', keywords: ['cash', 'dollar', 'rich'] },
  { char: '\u{1F381}', name: 'gift', keywords: ['present', 'birthday'] },
  { char: '\u{1F4CE}', name: 'paperclip', keywords: ['attach', 'attachment'] },
  { char: '\u{1F5D1}\u{FE0F}', name: 'wastebasket', keywords: ['trash', 'delete', 'bin'] },
  { char: '\u{267B}\u{FE0F}', name: 'recycle', keywords: ['reuse', 'refresh'] },
  { char: '\u{270F}\u{FE0F}', name: 'pencil', keywords: ['edit', 'write'] },
  { char: '\u{1F4DA}', name: 'books', keywords: ['library', 'read', 'docs'] },
  { char: '\u{1F4D6}', name: 'book', keywords: ['read', 'docs', 'open_book'] },
  { char: '\u{1F4BB}', name: 'laptop', keywords: ['computer', 'code', 'work'] },
  { char: '\u{1F4F1}', name: 'phone', keywords: ['mobile', 'cell'] },
  { char: '\u{1F517}', name: 'link', keywords: ['url', 'chain', 'hyperlink'] },
  { char: '\u{1F3F7}\u{FE0F}', name: 'label', keywords: ['tag', 'price'] },
  { char: '\u{1F6A9}', name: 'flag', keywords: ['triangular', 'mark', 'milestone'] },
  { char: '\u{1F4CB}', name: 'clipboard', keywords: ['copy', 'list', 'tasks'] },
  { char: '\u{1F4E7}', name: 'email', keywords: ['mail', 'message'] },

  // ── Nature & misc ──────────────────────────────────────────────────
  { char: '\u{2600}\u{FE0F}', name: 'sun', keywords: ['sunny', 'weather', 'day'] },
  { char: '\u{1F319}', name: 'moon', keywords: ['night', 'crescent'] },
  { char: '\u{26A1}', name: 'zap', keywords: ['lightning', 'fast', 'electric', 'energy'] },
  { char: '\u{2744}\u{FE0F}', name: 'snowflake', keywords: ['cold', 'winter', 'snow'] },
  { char: '\u{1F308}', name: 'rainbow', keywords: ['pride', 'colors'] },
  { char: '\u{2615}', name: 'coffee', keywords: ['cafe', 'tea', 'break'] },
  { char: '\u{1F37A}', name: 'beer', keywords: ['drink', 'cheers'] },
  { char: '\u{1F389}', name: 'party', keywords: ['celebrate', 'tada'] },
  { char: '\u{1F355}', name: 'pizza', keywords: ['food', 'slice'] },
  { char: '\u{1F382}', name: 'cake', keywords: ['birthday', 'dessert'] },
  { char: '\u{1F916}', name: 'robot', keywords: ['bot', 'ai', 'automation'] },
  { char: '\u{1F480}', name: 'skull', keywords: ['dead', 'danger'] },
  { char: '\u{1F47B}', name: 'ghost', keywords: ['boo', 'spooky'] },
  { char: '\u{1F431}', name: 'cat', keywords: ['kitten', 'meow'] },
  { char: '\u{1F436}', name: 'dog', keywords: ['puppy', 'woof'] },
]

/**
 * Fuzzy-search the curated emoji set by shortcode + aliases. Mirrors the
 * match-sorter usage in the other pickers (`slash-commands`, tag search).
 * A leading `:` (if the caller passes the raw trigger text) is stripped.
 */
export function searchEmoji(query: string, limit = 24): EmojiEntry[] {
  const q = query.replace(/^:/, '').trim()
  if (q === '') return EMOJI.slice(0, limit)
  return matchSorter(EMOJI as EmojiEntry[], q, {
    keys: ['name', 'keywords'],
  }).slice(0, limit)
}

export interface EmojiGroupBucket {
  readonly group: EmojiGroup
  readonly emoji: readonly EmojiEntry[]
}

/**
 * Partition the flat curated `EMOJI` list into `EMOJI_GROUPS` buckets for the
 * browse-grid. Walks the list once, switching the active group whenever an
 * entry's `name` is a known boundary (see `GROUP_BOUNDARIES`). Entries before
 * the first boundary (there are none today) fall into the first group. Empty
 * groups are omitted so the grid never renders a header with no emoji.
 */
export function groupedEmoji(): EmojiGroupBucket[] {
  const buckets = new Map<EmojiGroup, EmojiEntry[]>()
  let current: EmojiGroup = EMOJI_GROUPS[0]
  for (const entry of EMOJI) {
    const boundary = GROUP_BOUNDARIES[entry.name]
    if (boundary !== undefined) current = boundary
    const bucket = buckets.get(current)
    if (bucket === undefined) buckets.set(current, [entry])
    else bucket.push(entry)
  }
  return EMOJI_GROUPS.filter((g) => buckets.has(g)).map((group) => ({
    group,
    emoji: buckets.get(group) ?? [],
  }))
}
