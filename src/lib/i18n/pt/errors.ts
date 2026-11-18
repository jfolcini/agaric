/**
 * i18n namespace: errors — Portuguese (`pt`).
 *
 * Mirrors `src/lib/i18n/errors.ts` key for key, in the same order.
 */

export const errors: Record<string, string> = {
  'empty.noBlocks':
    'Ainda não há blocos. Clique em + Adicionar bloco abaixo para começar a escrever.',
  'empty.noPages': 'Ainda não há páginas. Crie uma para começar.',
  'loadMore.progress': '{{loaded}} de {{total}} carregados',
  'error.generic': 'Algo deu errado',
  'error.loadFailed': 'Não foi possível carregar os dados',
  'error.spacesLoadFailed': 'Não foi possível atualizar os espaços',
  'error.saveFailed': 'Não foi possível salvar',
  'error.createBlockFailed': 'Não foi possível criar o bloco',
  'error.blockNotFound': 'Não foi possível localizar esse bloco na página',
  'error.sectionCrashed': '{{section}} encontrou um erro',
  'error.unexpected': 'Ocorreu um erro inesperado',
  'storage.full':
    'O disco está cheio, então as alterações não estão sendo salvas. Libere algum espaço e tente novamente.',
  'storage.readOnly':
    'O Agaric não consegue gravar na pasta de dados, então as alterações não estão sendo salvas. Verifique se a pasta e o disco permitem gravação.',
  'storage.corrupt':
    'O banco de dados está danificado, então algumas ações falham. Exporte suas notas (Configurações › Dados) antes de alterar qualquer outra coisa.',
  'errorBoundary.dataSafe': 'Seus dados estão seguros — Tentar novamente recarrega este painel.',
  'errorBoundary.section.pageEditor': 'Editor de páginas',
  'errorBoundary.section.tabBar': 'Barra de abas',
  'errorBoundary.section.quickAccess': 'Acesso rápido',
  'errorBoundary.section.findInPage': 'Localizar na página',
  'errorBoundary.section.commandPalette': 'Paleta de comandos',
  'errorBoundary.section.searchSheet': 'Painel de pesquisa',
  'errorBoundary.section.keyboardShortcuts': 'Atalhos de teclado',
  'errorBoundary.section.welcome': 'Boas-vindas',
  'errorBoundary.section.gestureCoachMark': 'Guia de gestos',
  'errorBoundary.section.bugReport': 'Relatório de bug',
  'errorBoundary.section.quickCaptureButton': 'Botão de captura rápida',
  'errorBoundary.section.quickCapture': 'Captura rápida',
  'errorBoundary.section.newPage': 'Nova página',
  'errorBoundary.section.newMeeting': 'Nova reunião',
  'errorBoundary.section.syncSetup': 'Configuração da sincronização',
  'errorBoundary.section.notifications': 'Notificações',
  'error.loadBlocksFailed': 'Não foi possível carregar os blocos',
  'error.pageNotInCurrentSpace': 'Esta página foi movida para outro espaço',
  'error.pageInTrash': 'Esta página está na lixeira',
  'error.deleteBlockFailed': 'Não foi possível excluir o bloco',
  'error.reorderBlockFailed': 'Não foi possível reordenar o bloco',
  'error.moveBlockFailed': 'Não foi possível mover o bloco',
  'error.indentBlockFailed': 'Não foi possível aumentar o recuo do bloco',
  'error.maxNestingReached': 'Nível máximo de aninhamento atingido',
  'error.dedentBlockFailed': 'Não foi possível diminuir o recuo do bloco',
  'error.moveBlockUpFailed': 'Não foi possível mover o bloco para cima',
  'error.moveBlockDownFailed': 'Não foi possível mover o bloco para baixo',
  'error.createPageFailed': 'Não foi possível criar a página',
  'error.pasteBlocksFailed': 'Não foi possível colar os blocos',
  'error.settingsSaveFailed':
    'Não foi possível salvar suas alterações localmente — o armazenamento local pode estar cheio',
  'error.internal': 'Algo deu errado (err: {{id}})',
  'errorCode.invalidGlob': 'Esse padrão de nome de página não é válido.',
  'errorCode.invalidRegex': 'Essa expressão regular não é válida.',
  'errorCode.invalidDateFilter':
    'Esse filtro de data não é válido. Use datas YYYY-MM-DD, com o início de um intervalo antes do fim.',
  'errorCode.requiresRefresh': 'Isso mudou depois de ser carregado. Recarregue e tente novamente.',
  'errorCode.invalidRepeatRule':
    'Essa regra de repetição não é válida. Use `daily`, `weekly`, `monthly`, `yearly` ou `+Nd` / `+Nw` / `+Nm` / `+Ny` com N igual a 1 ou mais, opcionalmente precedido de `.+` (contar a partir de quando você concluir) ou `++` (recuperar o atraso até hoje).',
  'errorCode.duplicateAgentName': 'Já existe outro agente com esse nome.',
  'errorCode.builtinPropertyLocked': 'Esta propriedade é nativa, então não pode ser alterada.',
  'errorCode.unacknowledgedPropertyLoss':
    'Os valores mudaram desde a pré-visualização. Pré-visualize novamente antes de confirmar.',
}
