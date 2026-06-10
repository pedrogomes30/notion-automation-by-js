// ── CONFIGURAÇÃO DE LIMPEZA ───────────────────────────────────
// (Mantendo as mesmas constantes do seu script original)
const NOME_DB_CONTEUDO  = 'conteudo';
const PROP_TEMA_REL     = 'tema'; // Nome da relação em Conteudo → Tema

// ── Localizar database de Conteúdo ────────────────────────────
const dbConteudo = Object.values(databases).find(d => d.title === NOME_DB_CONTEUDO);

if (!dbConteudo) { 
  log('Database "' + NOME_DB_CONTEUDO + '" nao encontrado para a limpeza.', 'error'); 
  return; 
}

log('Iniciando verificação de conteúdos órfãos...', 'info');

// ── Buscar Conteúdos Órfãos ───────────────────────────────────
// Filtra apenas os conteúdos onde a relação com o Tema está vazia
const filtroOrfaos = {
  property: PROP_TEMA_REL,
  relation: {
    is_empty: true
  }
};

const conteudosOrfaos = await notion.queryAllPages(dbConteudo.id, filtroOrfaos);
log(conteudosOrfaos.length + ' conteúdo(s) órfão(s) encontrado(s).', 'info');

let deletados = 0;

// ── Deletar/Arquivar os Conteúdos Órfãos ──────────────────────
for (const conteudo of conteudosOrfaos) {
  const tituloConteudo = notion.getPageTitle(conteudo);
  
  log('Deletando conteúdo órfão: "' + tituloConteudo + '"...', 'info');
  
  // No Notion API, deletar significa atualizar a propriedade 'archived' para true
  await notion.updatePage(conteudo.id, {
    archived: true
  });
  
  deletados++;
  await notion.sleep(300); // Respeitar o rate limit da API
}

// ── Resumo da Limpeza ─────────────────────────────────────────
if (deletados > 0) {
  log('Limpeza concluída com sucesso! Total de conteúdos deletados: ' + deletados, 'success');
} else {
  log('Nenhum conteúdo órfão precisou ser deletado.', 'success');
}