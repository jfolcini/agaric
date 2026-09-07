/**
 * i18n namespace: errors — Spanish (`es`).
 *
 * Mirrors `src/lib/i18n/errors.ts` key for key, in the same order, so a
 * translation review is a side-by-side read. Merged into the `es`
 * resource bundle by `src/lib/i18n/es/index.ts`, which is loaded lazily —
 * never import this file from app code; use `t('namespace.key')`.
 *
 * Register and voice follow the English catalog: `tú`, sentence case,
 * neutral Spanish (no Spain- or Latin-America-specific vocabulary).
 */

export const errors: Record<string, string> = {
  'empty.noBlocks': 'Aún no hay bloques. Pulsa + Añadir bloque abajo para empezar a escribir.',
  'empty.noPages': 'Aún no hay páginas. Crea una para empezar.',
  'loadMore.progress': 'Se han cargado {{loaded}} de {{total}}',
  'error.generic': 'Algo ha salido mal',
  'error.loadFailed': 'No se han podido cargar los datos',
  'error.spacesLoadFailed': 'No se han podido actualizar los espacios',
  'error.saveFailed': 'No se ha podido guardar',
  'error.createBlockFailed': 'No se ha podido crear el bloque',
  'error.blockNotFound': 'No se ha encontrado ese bloque en la página',
  'error.sectionCrashed': '{{section}} ha encontrado un error',
  'error.unexpected': 'Se ha producido un error inesperado',
  'errorBoundary.dataSafe': 'Tus datos están a salvo — Reintentar vuelve a cargar este panel.',
  'errorBoundary.section.pageEditor': 'Editor de páginas',
  'errorBoundary.section.tabBar': 'Barra de pestañas',
  'errorBoundary.section.quickAccess': 'Acceso rápido',
  'errorBoundary.section.findInPage': 'Buscar en la página',
  'errorBoundary.section.commandPalette': 'Paleta de comandos',
  'errorBoundary.section.searchSheet': 'Panel de búsqueda',
  'errorBoundary.section.keyboardShortcuts': 'Atajos de teclado',
  'errorBoundary.section.welcome': 'Bienvenida',
  'errorBoundary.section.gestureCoachMark': 'Guía de gestos',
  'errorBoundary.section.bugReport': 'Informe de error',
  'errorBoundary.section.quickCaptureButton': 'Botón de captura rápida',
  'errorBoundary.section.quickCapture': 'Captura rápida',
  'errorBoundary.section.syncSetup': 'Configuración de sincronización',
  'errorBoundary.section.notifications': 'Notificaciones',
  'error.loadBlocksFailed': 'No se han podido cargar los bloques',
  'error.pageNotInCurrentSpace': 'Esta página se ha movido a otro espacio',
  'error.deleteBlockFailed': 'No se ha podido eliminar el bloque',
  'error.reorderBlockFailed': 'No se ha podido reordenar el bloque',
  'error.moveBlockFailed': 'No se ha podido mover el bloque',
  'error.indentBlockFailed': 'No se ha podido aumentar la sangría del bloque',
  'error.maxNestingReached': 'Se ha alcanzado el nivel máximo de anidamiento',
  'error.dedentBlockFailed': 'No se ha podido reducir la sangría del bloque',
  'error.moveBlockUpFailed': 'No se ha podido mover el bloque hacia arriba',
  'error.moveBlockDownFailed': 'No se ha podido mover el bloque hacia abajo',
  'error.createPageFailed': 'No se ha podido crear la página',
  'error.pasteBlocksFailed': 'No se han podido pegar los bloques',
  'error.settingsSaveFailed':
    'No se han podido guardar tus cambios en este dispositivo — puede que el almacenamiento local esté lleno',
}
