// ── Configuração ──────────────────────────────────────────────
// Ajuste os nomes conforme aparecem no Notion
//DB
const NOME_DB_TEMA      = 'tema';
const NOME_DB_CONTEUDO  = 'conteudo';
//conteudo atributos
const PROP_TEMA_REL     = 'tema';      // nome da relação em Conteudo → Tema (se existir)
const PROP_FORMAT_REL   = 'formato';      // nome da relação em Conteudo → Tema (se existir)
const PROP_DATA_POSTAGEM= 'Data de postagem';
const PROP_DATA_GRAVACAO= 'Data de gravação';
// tema atributos
const PROP_FORMATOS     = 'formato';   // nome da relação em Tema → Formato
const PROP_STATUS       = 'Status';       // nome da propriedade de status em Tema
const PROP_CONTEUDOS    = 'conteudo'; 
const PROP_PERIODO      = 'Período';    // nome da relação em Tema → Conteudo
const STATUS_VALOR      = 'Em andamento'; // valor exato do status no Notion

// ── Localizar databases ───────────────────────────────────────
const dbTema     = Object.values(databases).find(d => d.title === NOME_DB_TEMA);
const dbConteudo = Object.values(databases).find(d => d.title === NOME_DB_CONTEUDO);

if (!dbTema)     { log('Database "' + NOME_DB_TEMA + '" nao encontrado.', 'error'); return; }
if (!dbConteudo) { log('Database "' + NOME_DB_CONTEUDO + '" nao encontrado.', 'error'); return; }

log('Databases encontrados:', 'success');
log('  Tema:     ' + dbTema.id, 'info');
log('  Conteudo: ' + dbConteudo.id, 'info');

// ── Buscar schema do Conteudo para achar o campo titulo ───────
const schemaConteudo   = await notion.fetchDatabaseSchema(dbConteudo.id);
const campTituloConteudo = notion.getTitlePropertyName(schemaConteudo);

// ── Buscar todos os Temas ─────────────────────────────────────
const filtro = {
  and: [
    {
      property: PROP_STATUS,
      status: { equals: STATUS_VALOR },
    },
    {
      property: PROP_CONTEUDOS,
      relation: { is_empty: true },
    },
  ],
};
log('Buscando temas...', 'info');
const temas = await notion.queryAllPages(dbTema.id, filtro);
log(temas.length + ' tema(s) encontrado(s).', 'info');

let criados  = 0;
let pulados  = 0;

// ── Para cada Tema, criar um Conteudo por Formato ─────────────
for (const tema of temas) {
  const tituloTema   = notion.getPageTitle(tema);
  const relFormatos  = tema.properties[PROP_FORMATOS]?.relation ?? [];

  if (relFormatos.length === 0) {
    log('  [pulado] "' + tituloTema + '" nao tem formatos vinculados.', 'warn');
    pulados++;
    continue;
  }

  log('Processando "' + tituloTema + '" (' + relFormatos.length + ' formato(s))...', 'info');

  const idsConteudosCriados = [];

  for (const ref of relFormatos) {
    // Buscar dados do Formato para usar o titulo no nome do Conteudo
    const paginaFormato = await notion.fetch('/pages/' + ref.id);
    const tituloFormato = notion.getPageTitle(paginaFormato);

    const tituloConteudo = tituloTema + ' — ' + tituloFormato;

    // Montar propriedades da nova pagina
    const props = {
      [campTituloConteudo]: {
        title: [{ type: 'text', text: { content: tituloConteudo } }],
      },
    };

    // Se o database Conteudo tiver relação com Tema, preencher
    if (schemaConteudo.properties[PROP_TEMA_REL]?.type === 'relation') {
      props[PROP_TEMA_REL] = { relation: [{ id: tema.id }] };
    }

    if (schemaConteudo.properties[PROP_FORMAT_REL]?.type === 'relation') {
      props[PROP_FORMAT_REL] = { relation: [{ id: ref.id }] };
    }

    // copiar a data do atributo do tema para a data no conteúdo
    if(schemaConteudo.properties[PROP_DATA_POSTAGEM]?.type === 'date'){
        props[PROP_DATA_POSTAGEM] = { date: tema.properties[PROP_PERIODO]?.date };
    }

    if (schemaConteudo.properties[PROP_DATA_GRAVACAO]?.type === 'date') {
        const dataTema = tema.properties[PROP_PERIODO]?.date;
        if (dataTema && dataTema.start) {
            const dt = new Date(dataTema.start);
            dt.setDate(dt.getDate() - 2);
            const dataMenos2 = dt.toISOString().slice(0, 10); // 'YYYY-MM-DD'
            props[PROP_DATA_GRAVACAO] = { date: { start: dataMenos2 } };
        }
    }


    const paginaCriada = await notion.createPage(dbConteudo.id, props);
    idsConteudosCriados.push({ id: paginaCriada.id });
    log('  Criado: "' + tituloConteudo + '"', 'success');
    criados++;

    await notion.sleep(300); // respeitar rate limit da API
  }

  await notion.updatePage(tema.id, {
    [PROP_CONTEUDOS]: { relation: idsConteudosCriados },
  });
  log('  Relacao atualizada no tema "' + tituloTema + '" (' + idsConteudosCriados.length + ' conteudo(s)).', 'success');

  await notion.sleep(300);
}

// ── Resumo ────────────────────────────────────────────────────
log('', 'info');
log('Concluido! Criados: ' + criados + ' | Pulados: ' + pulados, 'success');