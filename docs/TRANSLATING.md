# Translating Agaric

How the interface is translated, how to add a language or a regional variant, and the shared rules, style and glossary every translation follows. For the UI components named in the context notes, see [`UI-MAP.md`](UI-MAP.md); for what each feature does, see [`FEATURE-MAP.md`](FEATURE-MAP.md).

## How the catalogs work

- **English is the source.** It lives in one file per namespace under `src/lib/i18n/` (`common.ts`, `pages.ts`, `editor.ts`, …), each a flat map of dotted keys to text.
- **Every English key has translator context.** A `// Translators:` comment heads each group of keys (a run of lines with no blank line): where the string appears, what kind of text it is, what each `{{placeholder}}` holds, and any constraint. `translator-context.test.ts` fails on a key without one.
- **Each language is a directory** `src/lib/i18n/<tag>/` that mirrors the English files, key for key and in the same order, so a review is a side-by-side read. Its `index.ts` merges the namespaces and registers the language's `date-fns` locale.
- **Every shipped language is complete.** `locale-catalogs.test.ts` fails when a language lacks an English key, carries a key English does not have, changes a placeholder or an inline tag, or keeps a value pasted from English. A new English string therefore lands with its translations, in the same change.
- **The language picker** (Settings › General) lists `LOCALES` in `src/lib/i18n/locales.ts`, each language named in itself. "System" follows the device and is the default. In debug mode it also offers the [pseudo-locale](#check-a-layout-with-the-pseudo-locale).

## Add a language

1. Add the tag and the language's own name to `LOCALES` in `src/lib/i18n/locales.ts`, keeping the list alphabetical by that name: `it: { nativeName: 'Italiano' }`.
2. Add its loader to `LOCALE_LOADERS` in `src/lib/i18n/set-locale.ts`; `npm run typecheck` fails until it exists.
3. Create `src/lib/i18n/<tag>/`: copy `src/lib/i18n/es/index.ts`, rename the export and the `date-fns` locale it registers, and add one file per English namespace file, each exporting the same name as its English sibling.
4. Add the directory to `extend-exclude` in `_typos.toml`, so the spell checker skips words that are not English.
5. If the language has a CLDR plural category used only for rare numbers (Spanish `many` covers exact millions), list it in `OPTIONAL_PLURAL_CATEGORIES` in `locale-catalogs.test.ts`.
6. Translate, then run `npx vitest run src/lib/i18n`. The failures list every missing key with the file it belongs in, every placeholder that drifted, and every value still in English. Words your language spells exactly as English ("Agenda", "Zoom") go in that language's `SAME_AS_ENGLISH` list in the same test.
7. Add the language to the e2e table in `e2e/language-preference.spec.ts` and run `npx playwright test e2e/language-preference.spec.ts`.

A language ships only when it is complete. Work on a branch, namespace by namespace if you like (a commit per namespace makes the review easy); the test tells you what is left.

## Add a regional variant

A tag with a region (`pt-PT`, `es-419`, `fr-CA`) is a variant of its base language, the tag's first part. The variant's files hold **only** the keys whose wording differs; every other key comes from the base language, then English. `loadLocale` loads the base first, and a variant that registers no `date-fns` locale dates like its base. The steps are those above, except that the directory holds only the overriding keys; the completeness test does not apply to a variant.

## Check a layout with the pseudo-locale

The pseudo-locale `en-XA` is English made to look foreign: every letter accented, every string about 40% longer, and each one wrapped in `⟦…⟧`. It is generated from English when it loads (`src/lib/i18n/en-XA/index.ts`), so it is always complete, and it is a testing aid, not a shipped language.

Turn on **Debug mode** (Settings › About), then pick **Pseudo-locale (en-XA)** in Settings › General › Language. A device whose language is `en-XA` (Android's developer pseudo-locale) gets it through "System". Then walk the screens you changed:

- **Text without the markers is hardcoded.** It bypasses `t()` and stays English in every language.
- **A missing closing `⟧` is truncation.** The string is cut off, and a longer translation loses more.
- **A broken layout is a string that will overflow in German or French**: a label that clips, wraps badly or pushes a control out of view.

Placeholders, inline tags, the `ENGLISH_IN_EVERY_LOCALE` values and the language names in the picker stay as they are, and dates follow English.

## Rules every translation follows

- **Placeholders stay byte-identical.** `{{count}}`, `{{title}}` and every other `{{name}}` keep their name and their number of occurrences; move them anywhere in the sentence.
- **Inline tags stay.** `<strong>…</strong>`, `<mono>…</mono>`, `<kbd>…</kbd>`, `<lnk>…</lnk>`, `<m0/>`: translate the text between the tags, never drop or add one.
- **Plurals follow your language's categories.** English has `_one` and `_other`; your file carries a form for each [CLDR plural category](https://cldr.unicode.org/index/cldr-spec/plural-rules) of your language. In Portuguese and French `_one` also covers 0, so write it to read well for both.
- **Literal syntax stays literal.** Markdown (`**bold**`, `##`, `- [ ]`), `[[Page]]`, `((block))`, `#tag`, `key:: value`, slash commands (`/template`), search prefixes (`tag:`, `path:`, `AND`, `OR`, `NOT`), task keywords (TODO, DOING, DONE, CANCELLED), key names in shortcuts (Ctrl, Shift, Enter, Esc), URLs and example addresses.
- **Some values must stay English**, because a parser or the platform reads them: `aria-keyshortcuts` tokens, the example input of the date field (the date parser reads English words only), brand and theme names. They are listed in `ENGLISH_IN_EVERY_LOCALE` in `src/lib/i18n/english-in-every-locale.ts`, and `locale-catalogs.test.ts` fails if one is translated.
- **Keep a label's colon** where the context note says the code splits on it (`Label: {{x}}`).
- **Read the context note first.** It says whether the text is a button, a screen-reader label, a toast or a heading, and which value lands in each placeholder; translate the meaning there, not the English word.

## Kinds of text

The context notes name the kind of text. Each has its own constraints.

| Kind | Where it shows | Write it |
|---|---|---|
| Button, menu item, tab | A clickable control | Short; the action, in your language's convention for commands (infinitive in German and French, imperative in Spanish and Portuguese) |
| Heading, label | Above or beside content | Short noun phrase, sentence case |
| Placeholder | Grey hint inside an empty input | Short; an example or an invitation |
| Tooltip | On hover over a control | One short phrase, often with the shortcut |
| `aria-label` | Never seen: read aloud by a screen reader | A full, unambiguous phrase naming the control and its target |
| Announcement | Read aloud after an action (the Announcer) | A short complete sentence saying what happened |
| Toast | Brief pop-up message (the Toaster) | One sentence; errors say what failed, not why |
| Dialog title, body | ConfirmDialog and other dialogs | Title is a question or an action; body explains the consequence |
| Empty state | A list with nothing in it | What is missing and how to add it |
| Chip, badge | Small pill inside a row | As short as possible; often a count or one word |

## Style

All languages: sentence case (never Title Case, even where English uses it), friendly and direct, and the same register throughout. Keep English straight double quotes `"…"` around names. Keep `…` or `...` as the English has it.

| Language | Address | Commands | Notes |
|---|---|---|---|
| Spanish (`es`) | `tú` | Imperative ("Pulsa", "Escribe") | Neutral international Spanish, no regional slang. Errors in the perfect tense ("No se ha podido guardar"). `¿…?` and `¡…!` |
| Portuguese (`pt`) | Implied `você` | Imperative ("Clique", "Digite") | Written as Brazilian Portuguese: arquivo, tela, excluir, gerund for progress ("Carregando…"). A `pt-PT` variant would override the differing words |
| German (`de`) | `du`, lowercase | Infinitive ("Seite erstellen") | Nouns capitalized; compound nouns ("Seitentitel"). "Tag" (tag) can read as "day": prefer "Tags" or rephrase where both appear |
| French (`fr`) | `vous` | Infinitive ("Créer une page") | Typographic apostrophe `’`. A no-break space before `:` `;` `?` `!`, written ` ` in the source |

## Glossary

The app's own terms and their agreed translations. Use them consistently; a term that is missing here gets the translation the existing catalog already uses (search your language's directory).

| English | Meaning | es | pt | de | fr |
|---|---|---|---|---|---|
| block | One bullet of content; pages are trees of blocks | bloque | bloco | Block | bloc |
| page | A titled tree of blocks | página | página | Seite | page |
| journal | The dated daily notes, one page per day | diario | diário | Journal | journal |
| tag | A label attached to blocks and pages (`#tag`) | etiqueta | etiqueta | Tag (Pl. Tags) | étiquette |
| property | Typed metadata on a block (`key:: value`) | propiedad | propriedade | Eigenschaft | propriété |
| space | A separate set of pages, like work and personal | espacio | espaço | Bereich | espace |
| template | A page copied into others | plantilla | modelo | Vorlage | modèle |
| alias | Another name for the same page | alias | alias | Alias | alias |
| agenda | The list of tasks by date | agenda | agenda | Agenda | agenda |
| task | A block with a TODO-style state | tarea | tarefa | Aufgabe | tâche |
| due date | When a task is due | fecha de vencimiento | data de vencimento | Fälligkeitsdatum | date d’échéance |
| scheduled date | When a task is planned | fecha programada | data agendada | geplantes Datum | date planifiée |
| deadline | The last day for a task | fecha límite | prazo | Frist | date limite |
| priority | A task's importance | prioridad | prioridade | Priorität | priorité |
| linked references | Blocks elsewhere that link to this page | referencias enlazadas | referências vinculadas | Verknüpfte Verweise | références liées |
| unlinked references | Blocks that mention the page title without a link | referencias sin enlazar | referências não vinculadas | Nicht verknüpfte Verweise | références non liées |
| link | A clickable reference to a page or URL | enlace | link | Link | lien |
| block reference | A link to one block, `((id))` | referencia a bloque | referência de bloco | Blockverweis | référence de bloc |
| embed | A block or page shown inside another | incrustación | incorporação | Einbettung | intégration |
| query | A saved search shown inline | consulta | consulta | Abfrage | requête |
| graph | The view of pages as connected dots | grafo | grafo | Graph | graphe |
| search | Full-text search across pages | búsqueda | pesquisa | Suche | recherche |
| sync | Copying changes between the user's own devices | sincronización | sincronização | Synchronisierung | synchronisation |
| device | A computer or phone running Agaric | dispositivo | dispositivo | Gerät | appareil |
| pair | Linking two devices so they sync | emparejar | parear | koppeln | associer |
| passphrase | The words typed to pair two devices | frase de contraseña | frase secreta | Passphrase | phrase secrète |
| trash | Where deleted pages wait before removal | papelera | lixeira | Papierkorb | corbeille |
| delete permanently | Remove from the trash for good | eliminar definitivamente | excluir permanentemente | endgültig löschen | supprimer définitivement |
| restore | Bring back from the trash or history | restaurar | restaurar | wiederherstellen | restaurer |
| history | The record of past edits | historial | histórico | Verlauf | historique |
| undo / redo | Reverse or repeat the last edit | deshacer / rehacer | desfazer / refazer | Rückgängig / Wiederholen | annuler / rétablir |
| conflict | Two devices changed the same thing | conflicto | conflito | Konflikt | conflit |
| settings | The preferences screen | configuración | configurações | Einstellungen | paramètres |
| shortcut | A keyboard combination | atajo | atalho | Tastenkürzel | raccourci |
| command palette | The searchable list of every command | paleta de comandos | paleta de comandos | Befehlspalette | palette de commandes |
| slash command | A command typed after `/` in a block | comando de barra | comando de barra | Slash-Befehl | commande slash |
| quick capture | A small window to jot a note fast | captura rápida | captura rápida | Schnellerfassung | capture rapide |
| callout | A highlighted box (note, tip, warning) | destacado | destaque | Hinweisblock | encadré |
| heading | A title-level block | encabezado | título | Überschrift | titre |
| indent / outdent | Nest a block deeper / shallower | aumentar / reducir sangría | aumentar / diminuir recuo | einrücken / ausrücken | augmenter / diminuer le retrait |
| collapse / expand | Hide / show a block's children | contraer / expandir | recolher / expandir | einklappen / ausklappen | réduire / développer |
| attachment | A file stored with a block | adjunto | anexo | Anhang | pièce jointe |
| bookmark | A page pinned to the top of the page list | marcador | favorito | Lesezeichen | favori |
| page mode | Editing a whole page as one document | modo página | modo página | Seitenmodus | mode page |
| Edit as Markdown | Editing a page as raw Markdown text | Editar como Markdown | Editar como Markdown | Als Markdown bearbeiten | Modifier en Markdown |
| agent | An AI tool given access through MCP | agente | agente | Agent | agent |
| toolbar | The row of formatting buttons | barra de herramientas | barra de ferramentas | Symbolleiste | barre d’outils |
| sidebar | The navigation rail on the left | barra lateral | barra lateral | Seitenleiste | barre latérale |

## Review checklist

When reviewing a translation, side by side with the English file and its context notes:

- The meaning fits the context note: the right sense of an ambiguous word, the right kind of text.
- Glossary terms are used, and the same thing is called the same way everywhere, including help text that names another control ("press **Add filter**").
- Placeholders read naturally with the values the note says they hold, in gender and case.
- Buttons, tabs and chips are short enough for a phone screen.
- Grammar, register and typography follow the style table.
