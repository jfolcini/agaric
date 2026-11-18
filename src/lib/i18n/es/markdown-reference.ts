/**
 * i18n namespace: markdown-reference — Spanish (`es`).
 *
 * Mirrors `src/lib/i18n/markdown-reference.ts` key for key, in the same order.
 */

export const markdownReference: Record<string, string> = {
  'markdownReference.group.text': 'Texto',
  'markdownReference.group.blocks': 'Bloques',
  'markdownReference.group.links': 'Enlaces, etiquetas e incrustaciones',
  'markdownReference.group.tasks': 'Tareas',
  'markdownReference.group.properties': 'Propiedades',
  'markdownReference.group.media': 'Imágenes y fórmulas',
  'markdownReference.group.commands': 'Menús y emojis',

  'markdownReference.bold.title': 'Negrita',
  'markdownReference.bold.description': 'Pone el texto en negrita. __bold__ también funciona.',
  'markdownReference.italic.title': 'Cursiva',
  'markdownReference.italic.description': 'Pone el texto en cursiva. _italic_ también funciona.',
  'markdownReference.highlight.title': 'Resaltado',
  'markdownReference.highlight.description': 'Resalta el texto.',
  'markdownReference.strike.title': 'Tachado',
  'markdownReference.strike.description': 'Tacha el texto.',
  'markdownReference.underline.title': 'Subrayado',
  'markdownReference.underline.description':
    'Subraya el texto: Ctrl+U en el editor; las etiquetas, en Editar como Markdown.',
  'markdownReference.inlineCode.title': 'Código en línea',
  'markdownReference.inlineCode.description': 'Muestra el texto como código, tal cual se escribe.',
  'markdownReference.lineBreak.title': 'Salto de línea',
  'markdownReference.lineBreak.description':
    'Shift+Enter empieza una línea nueva dentro del mismo bloque.',
  'markdownReference.escape.title': 'Carácter de escape',
  'markdownReference.escape.description':
    'En Editar como Markdown, una barra invertida antes de un símbolo lo mantiene como texto normal.',

  'markdownReference.heading.title': 'Encabezado',
  'markdownReference.heading.description':
    'Convierte el bloque en un encabezado. De ## a ###### se crean encabezados más pequeños.',
  'markdownReference.bulletList.title': 'Lista con viñetas',
  'markdownReference.bulletList.description':
    'Al principio de un bloque, lo convierte en un elemento con viñeta.',
  'markdownReference.numberedList.title': 'Lista numerada',
  'markdownReference.numberedList.description':
    'Al principio de un bloque, lo convierte en un elemento numerado.',
  'markdownReference.quote.title': 'Cita',
  'markdownReference.quote.description': 'Muestra el texto como una cita.',
  'markdownReference.callout.title': 'Destacado',
  'markdownReference.callout.description':
    'En Editar como Markdown, un cuadro NOTE, INFO, TIP, WARNING o ERROR, con el texto que le sigue como título. En el editor, usa /callout.',
  'markdownReference.codeBlock.title': 'Bloque de código',
  'markdownReference.codeBlock.description':
    'Tres comillas invertidas y un espacio inician un bloque de código, que mantiene las líneas tal cual se escriben.',
  'markdownReference.codeLanguage.title': 'Lenguaje del código',
  'markdownReference.codeLanguage.description':
    'El nombre de un lenguaje después de las comillas invertidas, antes del espacio, colorea el código.',
  'markdownReference.diagram.title': 'Diagrama',
  'markdownReference.diagram.description':
    'Un bloque de código mermaid dibuja un diagrama a partir del texto que contiene.',
  'markdownReference.table.title': 'Tabla',
  'markdownReference.table.description':
    'En Editar como Markdown, crea una tabla cuya primera fila es el encabezado. En el editor, usa /table.',
  'markdownReference.divider.title': 'Separador',
  'markdownReference.divider.description': 'Dibuja una línea horizontal.',
  'markdownReference.query.title': 'Consulta',
  'markdownReference.query.description':
    'Lista los bloques con la etiqueta project o con una etiqueta que empiece por project. Debe ser el único texto de su bloque.',

  'markdownReference.link.title': 'Enlace',
  'markdownReference.link.description': 'Enlaza el texto a una dirección web.',
  'markdownReference.webAddress.title': 'Dirección web',
  'markdownReference.webAddress.description':
    'Una dirección web seguida de un espacio se convierte en un enlace.',
  'markdownReference.pageLink.title': 'Enlace a página',
  'markdownReference.pageLink.description':
    'Enlaza a una página. Si ninguna página tiene ese nombre, se crea.',
  'markdownReference.pageLinkLabel.title': 'Enlace a página con tu propio texto',
  'markdownReference.pageLinkLabel.description':
    'Enlaza a una página, pero muestra el texto que va después de la barra.',
  'markdownReference.blockRef.title': 'Referencia a bloque',
  'markdownReference.blockRef.description':
    'Muestra el texto de otro bloque, elegido de una lista.',
  'markdownReference.tag.title': 'Etiqueta',
  'markdownReference.tag.description':
    'Etiqueta el bloque. Escribir @ también abre la lista de etiquetas.',
  'markdownReference.tagWithSpaces.title': 'Etiqueta con espacios',
  'markdownReference.tagWithSpaces.description':
    'Etiqueta el bloque con un nombre que tiene espacios.',
  'markdownReference.pageEmbed.title': 'Incrustación de página',
  'markdownReference.pageEmbed.description':
    'Muestra una página entera dentro de un bloque sin más contenido. ![[ también inicia una.',
  'markdownReference.blockEmbed.title': 'Incrustación de bloque',
  'markdownReference.blockEmbed.description':
    'Muestra un bloque y sus hijos dentro de un bloque sin más contenido.',
  'markdownReference.footnote.title': 'Nota al pie',
  'markdownReference.footnote.description':
    'Muestra el número de una nota al pie: 1, 2, 3 en el orden en que cada identificador aparece por primera vez en la página. Al hacer clic, va a la nota.',
  'markdownReference.footnoteDefinition.title': 'Texto de la nota al pie',
  'markdownReference.footnoteDefinition.description':
    'Al principio de un bloque, convierte el bloque en el texto de la nota al pie, marcado con su número.',

  'markdownReference.taskTodo.title': 'Por hacer',
  'markdownReference.taskTodo.description':
    'Al principio de un bloque, lo convierte en una tarea por hacer.',
  'markdownReference.taskDoing.title': 'En curso',
  'markdownReference.taskDoing.description': 'Convierte el bloque en una tarea en curso.',
  'markdownReference.taskDone.title': 'Hecha',
  'markdownReference.taskDone.description': 'Convierte el bloque en una tarea terminada.',
  'markdownReference.taskCancelled.title': 'Cancelada',
  'markdownReference.taskCancelled.description': 'Convierte el bloque en una tarea cancelada.',
  'markdownReference.priority.title': 'Prioridad',
  'markdownReference.priority.description':
    'En su propia línea, establece la prioridad: 1 es la más alta y 3 la más baja.',
  'markdownReference.dueDate.title': 'Fecha de vencimiento',
  'markdownReference.dueDate.description':
    'En su propia línea, establece el día en que vence el bloque.',
  'markdownReference.scheduledDate.title': 'Fecha programada',
  'markdownReference.scheduledDate.description':
    'En su propia línea, establece el día para el que está planificado el bloque.',

  'markdownReference.blockProperty.title': 'Propiedad',
  'markdownReference.blockProperty.description':
    'En su propia línea, da una propiedad al bloque. Escribir :: abre la lista de nombres.',
  'markdownReference.pageProperties.title': 'Propiedades de página',
  'markdownReference.pageProperties.description':
    'En Editar como Markdown, las líneas entre --- al principio del todo establecen las propiedades de la página.',

  'markdownReference.image.title': 'Imagen',
  'markdownReference.image.description':
    'Muestra la imagen de esa dirección. El texto entre corchetes la describe.',
  'markdownReference.imageWidth.title': 'Ancho de imagen',
  'markdownReference.imageWidth.description':
    'Un número después de una barra establece el ancho de la imagen en píxeles.',
  'markdownReference.pastedImage.title': 'Imagen pegada',
  'markdownReference.pastedImage.description':
    'Una imagen pegada o soltada se guarda con tus notas y se escribe así.',
  'markdownReference.mathInline.title': 'Fórmula',
  'markdownReference.mathInline.description': 'Muestra una fórmula dentro del texto.',
  'markdownReference.mathBlock.title': 'Bloque de fórmula',
  'markdownReference.mathBlock.description':
    'En Editar como Markdown, muestra una fórmula en líneas propias.',

  'markdownReference.commands.title': 'Comandos',
  'markdownReference.commands.description':
    'Abre el menú de comandos: encabezados, tareas, fechas, destacados y más.',
  'markdownReference.emoji.title': 'Emoji',
  'markdownReference.emoji.description':
    'El nombre de un emoji entre dos puntos se convierte en el emoji. Dos puntos y dos letras abren una lista.',
}
