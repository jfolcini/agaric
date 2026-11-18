/**
 * i18n namespace: errors — German (`de`).
 *
 * Mirrors `src/lib/i18n/errors.ts` key for key, in the same order.
 */

export const errors: Record<string, string> = {
  'empty.noBlocks':
    'Noch keine Blöcke. Klicke unten auf + Block hinzufügen, um mit dem Schreiben zu beginnen.',
  'empty.noPages': 'Noch keine Seiten. Erstelle eine, um loszulegen.',
  'loadMore.progress': '{{loaded}} von {{total}} geladen',
  'error.generic': 'Etwas ist schiefgelaufen',
  'error.loadFailed': 'Daten konnten nicht geladen werden',
  'error.spacesLoadFailed': 'Bereiche konnten nicht aktualisiert werden',
  'error.saveFailed': 'Speichern fehlgeschlagen',
  'error.createBlockFailed': 'Block konnte nicht erstellt werden',
  'error.blockNotFound': 'Dieser Block wurde auf der Seite nicht gefunden',
  'error.sectionCrashed': '{{section}}: Es ist ein Fehler aufgetreten',
  'error.unexpected': 'Ein unerwarteter Fehler ist aufgetreten',
  'storage.full':
    'Der Datenträger ist voll, daher werden Änderungen nicht gespeichert. Gib etwas Speicherplatz frei und versuche es dann erneut.',
  'storage.readOnly':
    'Agaric kann nicht in seinen Datenordner schreiben, daher werden Änderungen nicht gespeichert. Prüfe, ob der Ordner und sein Datenträger beschreibbar sind.',
  'storage.corrupt':
    'Die Datenbank ist beschädigt, daher schlagen einige Aktionen fehl. Exportiere deine Notizen (Einstellungen › Daten), bevor du etwas anderes änderst.',
  'errorBoundary.dataSafe': 'Deine Daten sind sicher — "Erneut versuchen" lädt diese Ansicht neu.',
  'errorBoundary.section.pageEditor': 'Seiteneditor',
  'errorBoundary.section.tabBar': 'Tab-Leiste',
  'errorBoundary.section.quickAccess': 'Schnellzugriff',
  'errorBoundary.section.findInPage': 'Auf der Seite suchen',
  'errorBoundary.section.commandPalette': 'Befehlspalette',
  'errorBoundary.section.searchSheet': 'Suchfenster',
  'errorBoundary.section.keyboardShortcuts': 'Tastenkürzel',
  'errorBoundary.section.welcome': 'Willkommen',
  'errorBoundary.section.gestureCoachMark': 'Gesten-Hinweis',
  'errorBoundary.section.bugReport': 'Fehlerbericht',
  'errorBoundary.section.quickCaptureButton': 'Schaltfläche für Schnellerfassung',
  'errorBoundary.section.quickCapture': 'Schnellerfassung',
  'errorBoundary.section.newPage': 'Neue Seite',
  'errorBoundary.section.newMeeting': 'Neue Besprechung',
  'errorBoundary.section.syncSetup': 'Sync-Einrichtung',
  'errorBoundary.section.notifications': 'Benachrichtigungen',
  'error.loadBlocksFailed': 'Blöcke konnten nicht geladen werden',
  'error.pageNotInCurrentSpace': 'Diese Seite wurde in einen anderen Bereich verschoben',
  'error.pageInTrash': 'Diese Seite liegt im Papierkorb',
  'error.deleteBlockFailed': 'Block konnte nicht gelöscht werden',
  'error.reorderBlockFailed': 'Block konnte nicht neu angeordnet werden',
  'error.moveBlockFailed': 'Block konnte nicht verschoben werden',
  'error.indentBlockFailed': 'Block konnte nicht eingerückt werden',
  'error.maxNestingReached': 'Maximale Verschachtelungstiefe erreicht',
  'error.dedentBlockFailed': 'Block konnte nicht ausgerückt werden',
  'error.moveBlockUpFailed': 'Block konnte nicht nach oben verschoben werden',
  'error.moveBlockDownFailed': 'Block konnte nicht nach unten verschoben werden',
  'error.createPageFailed': 'Seite konnte nicht erstellt werden',
  'error.pasteBlocksFailed': 'Blöcke konnten nicht eingefügt werden',
  'error.settingsSaveFailed':
    'Deine Änderungen konnten nicht lokal gespeichert werden — der lokale Speicher ist möglicherweise voll',
  'error.internal': 'Etwas ist schiefgelaufen (err: {{id}})',
  'errorCode.invalidGlob': 'Dieses Seitennamen-Muster ist ungültig.',
  'errorCode.invalidRegex': 'Dieser reguläre Ausdruck ist ungültig.',
  'errorCode.invalidDateFilter':
    'Dieser Datumsfilter ist ungültig. Verwende Daten im Format YYYY-MM-DD, mit dem Beginn eines Zeitraums vor seinem Ende.',
  'errorCode.requiresRefresh':
    'Das hat sich seit dem Laden geändert. Lade es neu und versuche es erneut.',
  'errorCode.invalidRepeatRule':
    'Diese Wiederholungsregel ist ungültig. Verwende `daily`, `weekly`, `monthly`, `yearly` oder `+Nd` / `+Nw` / `+Nm` / `+Ny` mit N ab 1, optional mit vorangestelltem `.+` (ab dem Erledigen zählen) oder `++` (bis heute nachholen).',
  'errorCode.duplicateAgentName': 'Ein anderer Agent hat bereits diesen Namen.',
  'errorCode.builtinPropertyLocked':
    'Diese Eigenschaft ist integriert und kann daher nicht geändert werden.',
  'errorCode.unacknowledgedPropertyLoss':
    'Die Werte haben sich seit der Vorschau geändert. Sieh dir die Vorschau erneut an, bevor du bestätigst.',
}
