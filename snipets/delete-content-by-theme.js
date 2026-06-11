// ── CONFIGURAÇÃO DE LIMPEZA EM CASCATA ────────────────────────
const NOME_DB_CONTEUDO  = 'conteudo';
const NOME_DB_TAREFA    = 'tarefa';

const PROP_TEMA_REL     = 'tema';     // Relação em Conteudo → Tema
const PROP_CONTEUDO_REL = 'conteudo'; // Relação em Tarefa → Conteudo

// ── Localizar databases ───────────────────────────────────────
const dbConteudo = Object.values(databases).find(d => d.title === NOME_DB_CONTEUDO);
const dbTarefa   = Object.values(databases).find(d => d.title === NOME_DB_TAREFA);

if (!dbConteudo) { log('Database "' + NOME_DB_CONTEUDO + '" nao encontrado.', 'error'); return; }
if (!dbTarefa)   { log('Database "' + NOME_DB_TAREFA + '" nao encontrado.', 'error'); return; }

log('Iniciando varredura em cascata para conteúdos e tarefas órfãs...', 'info');

// ── Buscar Conteúdos Órfãos (Sem Tema) ────────────────────────
const filtroConteudosOrfaos = {
  property: PROP_TEMA_REL,
  relation: { is_empty: true }
};

const conteudosOrfaos = await notion.queryAllPages(dbConteudo.id, filtroConteudosOrfaos);
log(conteudosOrfaos.length + ' conteúdo(s) órfão(s) detectado(s).', 'info');

let totalConteudosDeletados = 0;
let totalTarefasDeletadas = 0;

// ── Processar Deleção em Cascata ──────────────────────────────
for (const conteudo of conteudosOrfaos) {
  const tituloConteudo = notion.getPageTitle(conteudo);
  
  log('---------------------------------------------------------', 'info');
  log('Processando órfão: "' + tituloConteudo + '"', 'info');

  // 1. Buscar todas as tarefas vinculadas a ESTE conteúdo específico antes de deletá-lo
  const filtroTarefasFilhas = {
    property: PROP_CONTEUDO_REL,
    relation: { contains: conteudo.id }
  };
  
  const tarefasFilhas = await notion.queryAllPages(dbTarefa.id, filtroTarefasFilhas);
  
  if (tarefasFilhas.length > 0) {
    log('  Encontrada(s) ' + tarefasFilhas.length + ' tarefa(s) dependente(s). Removendo...', 'warn');
    
    for (const tarefa of tarefasFilhas) {
      const tituloTarefa = notion.getPageTitle(tarefa);
      try {
        // Envia a tarefa para a lixeira via assinatura nativa da extensão
        await notion.fetch('/pages/' + tarefa.id, 'PATCH', { archived: true });
        totalTarefasDeletadas++;
      } catch (err) {
        log('    [Falha] Não foi possível deletar tarefa "' + tituloTarefa + '": ' + err.message, 'error');
      }
      await notion.sleep(100);
    }
  }

  // 2. Agora que os filhos foram limpos, deleta o Conteúdo pai
  try {
    log('  Enviando conteúdo "' + tituloConteudo + '" para a lixeira...', 'info');
    await notion.fetch('/pages/' + conteudo.id, 'PATCH', { archived: true });
    totalConteudosDeletados++;
  } catch (err) {
    log('  [Falha] Não foi possível deletar conteúdo: ' + err.message, 'error');
  }

  await notion.sleep(200); // Respeitar o rate limit global do Notion
}

// ── Varredura de Segurança: Tarefas Órfãs Soltas ──────────────
// Caso alguma tarefa tenha ficado órfã por outro motivo no Notion
log('---------------------------------------------------------', 'info');
log('Executando varredura de segurança para tarefas órfãs remanescentes...', 'info');

const filtroTarefasOrfaosGerais = {
  property: PROP_CONTEUDO_REL,
  relation: { is_empty: true }
};

const tarefasOrfaosSoltas = await notion.queryAllPages(dbTarefa.id, filtroTarefasOrfaosGerais);

if (tarefasOrfaosSoltas.length > 0) {
  log('  Detectadas ' + tarefasOrfaosSoltas.length + ' tarefa(s) órfã(s) soltas. Limpando...', 'warn');
  for (const tarefa of tarefasOrfaosSoltas) {
    try {
      await notion.fetch('/pages/' + tarefa.id, 'PATCH', { archived: true });
      totalTarefasDeletadas++;
    } catch (err) {
      // Ignora falhas silenciosas no log geral
    }
    await notion.sleep(100);
  }
}

// ── Resumo Final da Limpeza ───────────────────────────────────
log('\n=== RESUMO DA LIMPEZA EM CASCATA ===', 'info');
log('Total de Conteúdos limpos: ' + totalConteudosDeletados, 'success');
log('Total de Tarefas limpas:   ' + totalTarefasDeletadas, 'success');
if (totalConteudosDeletados === 0 && totalTarefasDeletadas === 0) {
  log('Seu workspace já estava 100% limpo.', 'success');
}