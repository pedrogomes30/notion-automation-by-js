// ── Configuração ──────────────────────────────────────────────
// Ajuste os nomes conforme aparecem no Notion
// DBs
const NOME_DB_TEMA      = 'tema';
const NOME_DB_CONTEUDO  = 'conteudo';
const NOME_DB_TAREFA    = 'tarefa'; // Adicionado para poder limpar as tarefas

// conteudo atributos
const PROP_TEMA_REL     = 'tema';      
const PROP_FORMAT_REL   = 'formato';   
const PROP_DATA_POSTAGEM= 'Data de postagem';
const PROP_DATA_GRAVACAO= 'Data de gravação';

// tarefa atributos
const PROP_CONTEUDO_REL = 'conteudo';  // relação em Tarefa → Conteudo

// tema atributos
const PROP_FORMATOS     = 'formato';   
const PROP_STATUS       = 'Status';       
const PROP_CONTEUDOS    = 'conteudo'; 
const PROP_PERIODO      = 'Período';    
const STATUS_VALOR      = 'Em andamento'; 

// ── Localizar databases ───────────────────────────────────────
const dbTema     = Object.values(databases).find(d => d.title === NOME_DB_TEMA);
const dbConteudo = Object.values(databases).find(d => d.title === NOME_DB_CONTEUDO);
const dbTarefa   = Object.values(databases).find(d => d.title === NOME_DB_TAREFA);

if (!dbTema)     { log('Database "' + NOME_DB_TEMA + '" nao encontrado.', 'error'); return; }
if (!dbConteudo) { log('Database "' + NOME_DB_CONTEUDO + '" nao encontrado.', 'error'); return; }
if (!dbTarefa)   { log('Database "' + NOME_DB_TAREFA + '" nao encontrado.', 'error'); return; }

log('Databases encontrados:', 'success');
log('  Tema:     ' + dbTema.id, 'info');
log('  Conteudo: ' + dbConteudo.id, 'info');
log('  Tarefa:   ' + dbTarefa.id, 'info');

// ── Buscar schema do Conteudo para achar o campo titulo ───────
const schemaConteudo   = await notion.fetchDatabaseSchema(dbConteudo.id);
const campTituloConteudo = notion.getTitlePropertyName(schemaConteudo);

// ── Buscar todos os Temas com o Status Alvo ───────────────────
// REMOVIDO o filtro 'is_empty: true' para podermos pegar temas que já têm conteúdo e resetá-los
const filtro = {
  property: PROP_STATUS,
  status: { equals: STATUS_VALOR },
};

log('Buscando temas "' + STATUS_VALOR + '" para resetar...', 'info');
const temas = await notion.queryAllPages(dbTema.id, filtro);
log(temas.length + ' tema(s) encontrado(s).', 'info');

let criados  = 0;
let pulados  = 0;
let deletadosConteudo = 0;
let deletadosTarefa   = 0;

// ── Processar cada Tema ───────────────────────────────────────
for (const tema of temas) {
  const tituloTema   = notion.getPageTitle(tema);
  const relFormatos  = tema.properties[PROP_FORMATOS]?.relation ?? [];
  const conteudosAtuais = tema.properties[PROP_CONTEUDOS]?.relation ?? [];

  log('---------------------------------------------------------', 'info');
  log('Processando Tema: "' + tituloTema + '"', 'info');

  // ── PASSO 1: Limpar Conteúdos e Tarefas Antigas (Cascata) ────
  if (conteudosAtuais.length > 0) {
    log('  Removendo ' + conteudosAtuais.length + ' conteúdo(s) antigo(s) e suas tarefas...', 'warn');
    
    for (const contRef of conteudosAtuais) {
      // 1. Buscar as tarefas atreladas a este conteúdo específico para deletá-las
      const filtroTarefas = {
        property: PROP_CONTEUDO_REL,
        relation: { contains: contRef.id }
      };
      const tarefasDoConteudo = await notion.queryAllPages(dbTarefa.id, filtroTarefas);
      
      for (const tarefa of tarefasDoConteudo) {
        await notion.updatePage(tarefa.id, { archived: true });
        deletadosTarefa++;
      }

      // 2. Arquivar o conteúdo antigo
      await notion.updatePage(contRef.id, { archived: true });
      deletadosConteudo++;
      await notion.sleep(150);
    }

    // 3. Limpar temporariamente a relação de conteúdos no Tema para evitar duplicidade visual
    await notion.updatePage(tema.id, {
      [PROP_CONTEUDOS]: { relation: [] },
    });
    await notion.sleep(300);
  }

  // Verificar se existem formatos para criar os novos conteúdos
  if (relFormatos.length === 0) {
    log('  [pulado] "' + tituloTema + '" não tem formatos vinculados para recriação.', 'warn');
    pulados++;
    continue;
  }

  // ── PASSO 2: Criar Novamente os Conteúdos (Sem tarefas) ──────
  log('  Recriando conteúdos para ' + relFormatos.length + ' formato(s)...', 'info');
  const idsConteudosCriados = [];

  for (const ref of relFormatos) {
    const paginaFormato = await notion.fetch('/pages/' + ref.id);
    const tituloFormato = notion.getPageTitle(paginaFormato);
    const tituloConteudo = tituloTema + ' — ' + tituloFormato;

    // Montar propriedades da nova página de Conteúdo
    const props = {
      [campTituloConteudo]: {
        title: [{ type: 'text', text: { content: tituloConteudo } }],
      },
    };

    if (schemaConteudo.properties[PROP_TEMA_REL]?.type === 'relation') {
      props[PROP_TEMA_REL] = { relation: [{ id: tema.id }] };
    }

    if (schemaConteudo.properties[PROP_FORMAT_REL]?.type === 'relation') {
      props[PROP_FORMAT_REL] = { relation: [{ id: ref.id }] };
    }

    if (schemaConteudo.properties[PROP_DATA_POSTAGEM]?.type === 'date') {
      props[PROP_DATA_POSTAGEM] = { date: tema.properties[PROP_PERIODO]?.date };
    }

    if (schemaConteudo.properties[PROP_DATA_GRAVACAO]?.type === 'date') {
      const dataTema = tema.properties[PROP_PERIODO]?.date;
      if (dataTema && dataTema.start) {
        const dt = new Date(dataTema.start);
        dt.setDate(dt.getDate() - 2);
        const dataMenos2 = dt.toISOString().slice(0, 10);
        props[PROP_DATA_GRAVACAO] = { date: { start: dataMenos2 } };
      }
    }

    const paginaCriada = await notion.createPage(dbConteudo.id, props);
    idsConteudosCriados.push({ id: paginaCriada.id });
    log('    Criado: "' + tituloConteudo + '"', 'success');
    criados++;

    await notion.sleep(300); // rate limit
  }

  // ── PASSO 3: Atualizar o Tema com as Novas Relações ──────────
  await notion.updatePage(tema.id, {
    [PROP_CONTEUDOS]: { relation: idsConteudosCriados },
  });
  log('  Relação atualizada no tema "' + tituloTema + '" com os novos conteúdos.', 'success');

  await notion.sleep(300);
}

// ── Resumo Final ──────────────────────────────────────────────
log('\n=== RESUMO DO RESET ===', 'info');
log('Conteúdos antigos limpos: ' + deletadosConteudo, 'success');
log('Tarefas antigas limpas:   ' + deletadosTarefa, 'success');
log('Novos conteúdos criados:  ' + criados, 'success');
log('Temas pulados:            ' + pulados, 'warn');