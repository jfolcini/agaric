/**
 * i18n namespace: markdown-reference — Portuguese (`pt`).
 *
 * Mirrors `src/lib/i18n/markdown-reference.ts` key for key, in the same order.
 */

export const markdownReference: Record<string, string> = {
  'markdownReference.group.text': 'Texto',
  'markdownReference.group.blocks': 'Blocos',
  'markdownReference.group.links': 'Links, etiquetas e incorporações',
  'markdownReference.group.tasks': 'Tarefas',
  'markdownReference.group.properties': 'Propriedades',
  'markdownReference.group.media': 'Imagens e fórmulas',
  'markdownReference.group.commands': 'Menus e emojis',

  'markdownReference.bold.title': 'Negrito',
  'markdownReference.bold.description': 'Deixa o texto em negrito. __bold__ também funciona.',
  'markdownReference.italic.title': 'Itálico',
  'markdownReference.italic.description': 'Deixa o texto em itálico. _italic_ também funciona.',
  'markdownReference.highlight.title': 'Realce',
  'markdownReference.highlight.description': 'Realça o texto.',
  'markdownReference.strike.title': 'Tachado',
  'markdownReference.strike.description': 'Risca o texto.',
  'markdownReference.underline.title': 'Sublinhado',
  'markdownReference.underline.description':
    'Sublinha o texto: Ctrl+U no editor, as tags em Editar como Markdown.',
  'markdownReference.inlineCode.title': 'Código embutido',
  'markdownReference.inlineCode.description':
    'Mostra o texto como código, exatamente como foi digitado.',
  'markdownReference.lineBreak.title': 'Quebra de linha',
  'markdownReference.lineBreak.description':
    'Shift+Enter começa uma nova linha dentro do mesmo bloco.',
  'markdownReference.escape.title': 'Caractere de escape',
  'markdownReference.escape.description':
    'Em Editar como Markdown, uma barra invertida antes de um símbolo mantém o símbolo como texto simples.',

  'markdownReference.heading.title': 'Título',
  'markdownReference.heading.description':
    'Transforma o bloco em um título. De ## a ###### os títulos ficam menores.',
  'markdownReference.bulletList.title': 'Lista com marcadores',
  'markdownReference.bulletList.description':
    'No início de um bloco, faz dele um item com marcador.',
  'markdownReference.numberedList.title': 'Lista numerada',
  'markdownReference.numberedList.description': 'No início de um bloco, faz dele um item numerado.',
  'markdownReference.quote.title': 'Citação',
  'markdownReference.quote.description': 'Mostra o texto como uma citação.',
  'markdownReference.callout.title': 'Destaque',
  'markdownReference.callout.description':
    'Em Editar como Markdown, uma caixa NOTE, INFO, TIP, WARNING ou ERROR, com o texto depois dela como título. No editor, use /callout.',
  'markdownReference.codeBlock.title': 'Bloco de código',
  'markdownReference.codeBlock.description':
    'Três crases e um espaço iniciam um bloco de código, que mantém as linhas exatamente como foram digitadas.',
  'markdownReference.codeLanguage.title': 'Linguagem do código',
  'markdownReference.codeLanguage.description':
    'O nome de uma linguagem depois das crases, antes do espaço, colore o código.',
  'markdownReference.diagram.title': 'Diagrama',
  'markdownReference.diagram.description':
    'Um bloco de código mermaid desenha um diagrama a partir do texto dentro dele.',
  'markdownReference.table.title': 'Tabela',
  'markdownReference.table.description':
    'Em Editar como Markdown, cria uma tabela cuja primeira linha é o cabeçalho. No editor, use /table.',
  'markdownReference.divider.title': 'Linha divisória',
  'markdownReference.divider.description': 'Desenha uma linha horizontal.',
  'markdownReference.query.title': 'Consulta',
  'markdownReference.query.description':
    'Lista os blocos com a etiqueta project ou com uma etiqueta que comece com ela. Precisa ser o único texto do bloco.',

  'markdownReference.link.title': 'Link',
  'markdownReference.link.description': 'Vincula o texto a um endereço web.',
  'markdownReference.webAddress.title': 'Endereço web',
  'markdownReference.webAddress.description': 'Um endereço web seguido de um espaço vira um link.',
  'markdownReference.pageLink.title': 'Link de página',
  'markdownReference.pageLink.description':
    'Cria um link para uma página. Se nenhuma página tiver esse nome, ela é criada.',
  'markdownReference.pageLinkLabel.title': 'Link de página com seu próprio texto',
  'markdownReference.pageLinkLabel.description':
    'Cria um link para uma página, mas mostra o texto depois da barra vertical.',
  'markdownReference.blockRef.title': 'Referência de bloco',
  'markdownReference.blockRef.description':
    'Mostra o texto de outro bloco, escolhido em uma lista.',
  'markdownReference.tag.title': 'Etiqueta',
  'markdownReference.tag.description':
    'Adiciona uma etiqueta ao bloco. Digitar @ também abre a lista de etiquetas.',
  'markdownReference.tagWithSpaces.title': 'Etiqueta com espaços',
  'markdownReference.tagWithSpaces.description':
    'Adiciona ao bloco uma etiqueta cujo nome tem espaços.',
  'markdownReference.pageEmbed.title': 'Incorporação de página',
  'markdownReference.pageEmbed.description':
    'Mostra uma página inteira dentro de um bloco que não tem mais nada. ![[ também inicia uma.',
  'markdownReference.blockEmbed.title': 'Incorporação de bloco',
  'markdownReference.blockEmbed.description':
    'Mostra um bloco e seus filhos dentro de um bloco que não tem mais nada.',
  'markdownReference.footnote.title': 'Nota de rodapé',
  'markdownReference.footnote.description':
    'Mostra o número de uma nota de rodapé: 1, 2, 3 na ordem em que os rótulos aparecem pela primeira vez na página. Clicar nele leva à nota.',
  'markdownReference.footnoteDefinition.title': 'Texto da nota de rodapé',
  'markdownReference.footnoteDefinition.description':
    'No início de um bloco, faz do bloco o texto da nota de rodapé, marcado com seu número.',

  'markdownReference.taskTodo.title': 'A fazer',
  'markdownReference.taskTodo.description': 'No início de um bloco, faz dele uma tarefa a fazer.',
  'markdownReference.taskDoing.title': 'Em andamento',
  'markdownReference.taskDoing.description': 'Transforma o bloco em uma tarefa em andamento.',
  'markdownReference.taskDone.title': 'Concluída',
  'markdownReference.taskDone.description': 'Transforma o bloco em uma tarefa concluída.',
  'markdownReference.taskCancelled.title': 'Cancelada',
  'markdownReference.taskCancelled.description': 'Transforma o bloco em uma tarefa cancelada.',
  'markdownReference.priority.title': 'Prioridade',
  'markdownReference.priority.description':
    'Em uma linha própria, define a prioridade: 1 é a mais alta, 3 a mais baixa.',
  'markdownReference.dueDate.title': 'Data de vencimento',
  'markdownReference.dueDate.description':
    'Em uma linha própria, define o dia em que o bloco vence.',
  'markdownReference.scheduledDate.title': 'Data agendada',
  'markdownReference.scheduledDate.description':
    'Em uma linha própria, define o dia para o qual o bloco está planejado.',

  'markdownReference.blockProperty.title': 'Propriedade',
  'markdownReference.blockProperty.description':
    'Em uma linha própria, dá uma propriedade ao bloco. Digitar :: abre a lista de nomes.',
  'markdownReference.pageProperties.title': 'Propriedades da página',
  'markdownReference.pageProperties.description':
    'Em Editar como Markdown, as linhas entre --- bem no topo definem as propriedades da página.',

  'markdownReference.image.title': 'Imagem',
  'markdownReference.image.description':
    'Mostra a imagem daquele endereço. O texto entre colchetes a descreve.',
  'markdownReference.imageWidth.title': 'Largura da imagem',
  'markdownReference.imageWidth.description':
    'Um número depois de uma barra vertical define a largura da imagem em pixels.',
  'markdownReference.pastedImage.title': 'Imagem colada',
  'markdownReference.pastedImage.description':
    'Uma imagem colada ou arrastada é salva com suas notas e escrita assim.',
  'markdownReference.mathInline.title': 'Fórmula',
  'markdownReference.mathInline.description': 'Mostra uma fórmula dentro do texto.',
  'markdownReference.mathBlock.title': 'Bloco de fórmula',
  'markdownReference.mathBlock.description':
    'Em Editar como Markdown, mostra uma fórmula em linhas próprias.',

  'markdownReference.commands.title': 'Comandos',
  'markdownReference.commands.description':
    'Abre o menu de comandos: títulos, tarefas, datas, destaques e mais.',
  'markdownReference.emoji.title': 'Emoji',
  'markdownReference.emoji.description':
    'O nome de um emoji entre dois-pontos vira o emoji. Dois-pontos seguidos de duas letras abrem uma lista.',
}
