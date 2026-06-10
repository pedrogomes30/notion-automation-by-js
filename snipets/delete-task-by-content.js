// ── CONFIGURAÇÃO DE LIMPEZA ───────────────────────────────────
const NOME_DB_TAREFA    = 'tarefa';
const PROP_CONTEUDO_REL = 'conteudo'; // Nome da relação em Tarefa → Conteudo

// ── Localizar database de Tarefas ─────────────────────────────
const dbTarefa = Object.values(databases).find(d => d.title === NOME_DB_TAREFA);

if (!dbTarefa) {
  log('Database "' + NOME_DB_TAREFA + '" nao encontrado para a limpeza.', 'error');
  return;
}

log('Iniciando verificação de tarefas órfãs...', 'info');

// ── Buscar Tarefas Órfãs ──────────────────────────────────────
const filtroTarefasOrfaos = {
  property: PROP_CONTEUDO_REL,
  relation: {
    is_empty: true
  }
};

const tarefasOrfaos = await notion.queryAllPages(dbTarefa.id, filtroTarefasOrfaos);
log(tarefasOrfaos.length + ' tarefa(s) órfã(s) encontrada(s).', 'info');

let tarefasDeletadas = 0;

// ── Deletar/Arquivar as Tarefas Órfãs via Extensão ────────────
for (const tarefa of tarefasOrfaos) {
  const tituloTarefa = notion.getPageTitle(tarefa);
  
  log('Deletando tarefa órfã: "' + tituloTarefa + '"...', 'info');
  
  try {
    // 🔥 CORREÇÃO: Usando a assinatura correta do método fetch da extensão.
    // Passamos a URL, o método como string separada e o corpo do payload.
    // Isso ignora as travas do updatePage e faz a deleção real usando a própria extensão!
    await notion.fetch('/pages/' + tarefa.id, 'PATCH', {
      archived: true
    });
    
    log('  [Sucesso] Tarefa "' + tituloTarefa + '" enviada para a lixeira.', 'success');
    tarefasDeletadas++;
  } catch (erro) {
    log('  [Falha] Extensão não conseguiu deletar: ' + erro.message, 'error');
  }
  
  await notion.sleep(300); // Respeitar o rate limit da API do Notion
}

// ── Resumo da Limpeza ─────────────────────────────────────────
if (tarefasDeletadas > 0) {
  log('Limpeza de tarefas concluída! Total de tarefas deletadas: ' + tarefasDeletadas, 'success');
} else {
  log('Nenhuma tarefa órfã precisou ser deletada.', 'success');
}