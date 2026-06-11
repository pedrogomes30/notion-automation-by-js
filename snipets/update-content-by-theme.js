// ── Configuração ──────────────────────────────────────────────
const NOME_DB_TEMA      = 'tema';
const NOME_DB_CONTEUDO  = 'conteudo';
const NOME_DB_TAREFA    = 'tarefa'; 

// conteudo atributos
const PROP_TEMA_REL     = 'tema';      
const PROP_FORMAT_REL   = 'formato';   
const PROP_DATA_POSTAGEM= 'Data de postagem';
const PROP_DATA_GRAVACAO= 'Data de gravação';

// tema atributos
const PROP_FORMATOS     = 'formato';   
const PROP_STATUS       = 'Status';       
const PROP_CONTEUDOS    = 'conteudo'; 
const PROP_PERIODO      = 'Período';    
const STATUS_VALOR      = 'Recriar'; 
const STATUS_FINAL_TEMA = 'Em andamento'; // Status do tema após o processamento completo

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

// ── Buscar schema do Conteudo para achar o campo titulo ───────
const schemaConteudo   = await notion.fetchDatabaseSchema(dbConteudo.id);
const campTituloConteudo = notion.getTitlePropertyName(schemaConteudo);

// ── Buscar todos os Temas com o Status Alvo ───────────────────
const filtro = {
  property: PROP_STATUS,
  status: { equals: STATUS_VALOR },
};

log('Buscando temas "' + STATUS_VALOR + '" para processar e atualizar...', 'info');
const temas = await notion.queryAllPages(dbTema.id, filtro);
log(temas.length + ' tema(s) encontrado(s).', 'info');

let renomeados = 0;
let criados    = 0;
let pulados    = 0;
let temasFinalizados = 0;

const cacheFormatos = new Map();

// ── Processar cada Tema ───────────────────────────────────────
for (const tema of temas) {
  const tituloTema       = notion.getPageTitle(tema);
  const relFormatos      = tema.properties[PROP_FORMATOS]?.relation ?? [];
  const conteudosAtuais  = tema.properties[PROP_CONTEUDOS]?.relation ?? [];

  log('---------------------------------------------------------', 'info');
  log('Processando Tema: "' + tituloTema + '"', 'info');

  if (relFormatos.length === 0) {
    log('  [pulado] "' + tituloTema + '" não tem formatos vinculados.', 'warn');
    pulados++;
    continue;
  }

  // Mapeia os conteúdos existentes para evitar duplicados (formatoId -> conteudoId)
  const mapaConteudosExistentes = new Map();
  
  if (conteudosAtuais.length > 0) {
    log('  Mapeando ' + conteudosAtuais.length + ' conteúdo(s) existente(s) para atualização...', 'info');
    for (const cRef of conteudosAtuais) {
      try {
        const dadosConteudo = await notion.fetch('/pages/' + cRef.id);
        const formatoRel = dadosConteudo.properties[PROP_FORMAT_REL]?.relation ?? [];
        if (formatoRel.length > 0) {
          mapaConteudosExistentes.set(formatoRel[0].id, cRef.id);
        }
      } catch (e) {
        log('  Não foi possível ler dados do conteúdo antigo ' + cRef.id, 'warn');
      }
    }
  }

  const formatosUnicos = Array.from(new Set(relFormatos.map(f => f.id)));
  const listaFinalConteudos = [];

  // ── Varre os formatos para Atualizar ou Criar Conteúdos ───────
  for (const formatoId of formatosUnicos) {
    if (!cacheFormatos.has(formatoId)) {
      const paginaFormato = await notion.fetch('/pages/' + formatoId);
      cacheFormatos.set(formatoId, paginaFormato);
      await notion.sleep(100);
    }
    const formato = cacheFormatos.get(formatoId);
    const tituloFormato = notion.getPageTitle(formato);
    const tituloConteudoCorreto = tituloTema + ' — ' + tituloFormato;

    // Montar propriedades base comuns (Título e Datas)
    const props = {
      [campTituloConteudo]: {
        title: [{ type: 'text', text: { content: tituloConteudoCorreto } }],
      },
    };

    // Alinhamento das datas baseado no Período do Tema
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

    // Se o conteúdo já existir para este formato, APENAS ATUALIZAMOS (Mantém histórico e tarefas vinculadas!)
    if (mapaConteudosExistentes.has(formatoId)) {
      const idConteudoExistente = mapaConteudosExistentes.get(formatoId);
      await notion.updatePage(idConteudoExistente, props);
      log('    Atualizado: "' + tituloConteudoCorreto + '"', 'success');
      listaFinalConteudos.push({ id: idConteudoExistente });
      renomeados++;
    } else {
      // Se for um formato novo adicionado ao Tema depois, cria o conteúdo do zero
      if (schemaConteudo.properties[PROP_TEMA_REL]?.type === 'relation') {
        props[PROP_TEMA_REL] = { relation: [{ id: tema.id }] };
      }
      if (schemaConteudo.properties[PROP_FORMAT_REL]?.type === 'relation') {
        props[PROP_FORMAT_REL] = { relation: [{ id: formatoId }] };
      }

      const novoConteudo = await notion.createPage(dbConteudo.id, props);
      log('    Criado novo por falta de vínculo: "' + tituloConteudoCorreto + '"', 'success');
      listaFinalConteudos.push({ id: novoConteudo.id });
      criados++;
    }
    await notion.sleep(150);
  }

  // ── PASSO EXTRA: Atualizar as relações e mudar o Status do Tema ──
  const propsAtualizacaoTema = {};
  
  if (listaFinalConteudos.length > 0) {
    propsAtualizacaoTema[PROP_CONTEUDOS] = { relation: listaFinalConteudos };
  }
  
  // Atualiza o status do tema para o valor final configurado
  propsAtualizacaoTema[PROP_STATUS] = { status: { name: STATUS_FINAL_TEMA } };

  try {
    log('  Atualizando relações e mudando status do Tema para "' + STATUS_FINAL_TEMA + '"...', 'info');
    await notion.updatePage(tema.id, propsAtualizacaoTema);
    temasFinalizados++;
  } catch (err) {
    log('  Erro ao atualizar o Tema: ' + err.message, 'error');
  }

  await notion.sleep(200);
}

// ── Resumo Final ──────────────────────────────────────────────
log('\n=== RESUMO DA ATUALIZAÇÃO DE TEMAS ===', 'info');
log('Conteúdos existentes atualizados: ' + renomeados, 'success');
log('Novos conteúdos criados:          ' + criados, 'success');
log('Temas movidos para ' + STATUS_FINAL_TEMA + ':  ' + temasFinalizados, 'success');
log('Temas pulados:                    ' + pulados, 'warn');