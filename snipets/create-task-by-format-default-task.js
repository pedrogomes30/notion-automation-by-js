// ── Configuração ──────────────────────────────────────────────
const NOME_DB_CONTEUDO    = 'conteudo';
const NOME_DB_TAREFA      = 'tarefa';
const NOME_DB_FORMATO     = 'formato';
const NOME_DB_TAREFA_TIPO = 'tarefa_tipo';

const PROP_STATUS         = 'Status';          // status do conteudo
const STATUS_VALOR        = 'Em andamento';

const PROP_FORMATO        = 'formato';         // relacao em conteudo -> formato
const PROP_TAREFA         = 'tarefa';          // relacao em conteudo -> tarefa
const PROP_TAREFA_TIPO    = 'tarefa_tipo';     // relacao em formato -> tarefa_tipo
const PROP_CONTEUDO_REL   = 'conteudo';        // relacao em tarefa -> conteudo
const PROP_FORMATO_REL    = 'formato';         // relacao em tarefa -> formato
const PROP_TIPO_REL       = 'tarefa_tipo';     // relacao em tarefa -> tarefa_tipo
const PROP_STATUS_TAREFA   = 'Status';             // status da tarefa
const STATUS_TAREFA_PADRAO = 'Não iniciada';      // status padrao ao criar
const PROP_DATA_GRAVACAO    = 'Data de gravação';            // data de gravacao (lida do conteudo)
const PROP_DATA_FINALIZACAO = 'Data Finalização';            // data de finalizacao da tarefa
const PROP_HORARIO_PADRAO   = 'Horário padrão (em hora 0-24)'; // inteiro na tarefa_tipo (ex: 14 = 14:00)

// ── Localizar databases ───────────────────────────────────────
const dbConteudo = Object.values(databases).find(d => d.title === NOME_DB_CONTEUDO);
const dbTarefa   = Object.values(databases).find(d => d.title === NOME_DB_TAREFA);
const dbFormato  = Object.values(databases).find(d => d.title === NOME_DB_FORMATO);

if (!dbConteudo || !dbTarefa || !dbFormato) {
  log('Algum database nao encontrado. Verifique os nomes na configuracao.', 'error');
  return;
}

// ── Buscar schema do Tarefa para achar o campo titulo ─────────
const schemaTarefa      = await notion.fetchDatabaseSchema(dbTarefa.id);
const campoTituloTarefa = notion.getTitlePropertyName(schemaTarefa);

// ── Filtro: conteudos Em andamento sem tarefas ────────────────
const filtro = {
  and: [
    { property: PROP_STATUS, status:   { equals:   STATUS_VALOR } },
    { property: PROP_TAREFA, relation: { is_empty: true         } },
  ],
};

log('Buscando conteudos em andamento sem tarefas...', 'info');
const conteudos = await notion.queryAllPages(dbConteudo.id, filtro);
log(conteudos.length + ' conteudo(s) encontrado(s).', 'info');

let criadas = 0;
let pulados = 0;

// Cache de formatos: formatoId -> pagina do formato (evita re-requisicoes)
const cacheFormatos = new Map();

for (const conteudo of conteudos) {
  const tituloConteudo = notion.getPageTitle(conteudo);
  const relFormatos    = conteudo.properties[PROP_FORMATO]?.relation ?? [];

  if (relFormatos.length === 0) {
    log('  [pulado] "' + tituloConteudo + '" sem formato vinculado.', 'warn');
    pulados++;
    continue;
  }

  // Acumula IDs de TODAS as tarefas criadas para todos os formatos do conteudo
  const idsTarefasCriadas = [];

  for (const formatoRef of relFormatos) {
    // Buscar formato — usa cache se ja foi carregado antes
    if (!cacheFormatos.has(formatoRef.id)) {
      const paginaFormato = await notion.fetch('/pages/' + formatoRef.id);
      cacheFormatos.set(formatoRef.id, paginaFormato);
      await notion.sleep(100);
    }
    const formato        = cacheFormatos.get(formatoRef.id);
    const relTarefaTipos = formato.properties[PROP_TAREFA_TIPO]?.relation ?? [];

    if (relTarefaTipos.length === 0) {
      log('  [pulado] Formato "' + notion.getPageTitle(formato) + '" sem tarefas padrao.', 'warn');
      continue;
    }

    log('  Formato: "' + notion.getPageTitle(formato) + '" — ' + relTarefaTipos.length + ' tipo(s) de tarefa', 'info');

    for (const tarefaTipoRef of relTarefaTipos) {
      const tarefaTipo   = await notion.fetch('/pages/' + tarefaTipoRef.id);
      const nomeTipo     = notion.getPageTitle(tarefaTipo);
      const tituloTarefa = nomeTipo + ' — ' + tituloConteudo;

      const props = {
        [campoTituloTarefa]: {
          title: [{ type: 'text', text: { content: tituloTarefa } }],
        },
      };

      // Status padrao
      if (schemaTarefa.properties[PROP_STATUS_TAREFA]?.type === 'status') {
        props[PROP_STATUS_TAREFA] = { status: { name: STATUS_TAREFA_PADRAO } };
      }

      // Herdar data de gravacao do conteudo
      const dataGravacao = conteudo.properties[PROP_DATA_GRAVACAO]?.date ?? null;
      if (dataGravacao && schemaTarefa.properties[PROP_DATA_GRAVACAO]?.type === 'date') {
        props[PROP_DATA_GRAVACAO] = { date: dataGravacao };
      }

      // Data de finalizacao = data de gravacao no horario definido na tarefa_tipo
      if (dataGravacao && schemaTarefa.properties[PROP_DATA_FINALIZACAO]?.type === 'date') {
        const horaRaw = tarefaTipo.properties[PROP_HORARIO_PADRAO]?.number;
        const hora    = (horaRaw != null && horaRaw >= 0 && horaRaw <= 23) ? horaRaw : null;
        if (hora != null) {
          // Monta timestamp ISO com o horario do tipo: ex. '2025-03-10T14:00:00'
          const dataBase = (dataGravacao.start ?? dataGravacao).slice(0, 10); // 'YYYY-MM-DD'
          const hh       = String(hora).padStart(2, '0');
          const dataFinal = dataBase + 'T' + hh + ':00:00';
          props[PROP_DATA_FINALIZACAO] = { date: { start: dataFinal } };
        } else {
          // Sem horario definido: usa so a data
          props[PROP_DATA_FINALIZACAO] = { date: dataGravacao };
        }
      }

      // Relacoes: conteudo, formato e tarefa_tipo
      if (schemaTarefa.properties[PROP_CONTEUDO_REL]?.type === 'relation') {
        props[PROP_CONTEUDO_REL] = { relation: [{ id: conteudo.id }] };
      }
      if (schemaTarefa.properties[PROP_FORMATO_REL]?.type === 'relation') {
        props[PROP_FORMATO_REL] = { relation: [{ id: formato.id }] };
      }
      if (schemaTarefa.properties[PROP_TIPO_REL]?.type === 'relation') {
        props[PROP_TIPO_REL] = { relation: [{ id: tarefaTipo.id }] };
      }

      const tarefaCriada = await notion.createPage(dbTarefa.id, props);
      idsTarefasCriadas.push({ id: tarefaCriada.id });
      log('    Criada: "' + tituloTarefa + '"', 'success');
      criadas++;
      await notion.sleep(200);
    }
  } // fim loop formatos

  // Vincular todas as tarefas (N formatos x M tipos) ao conteudo de uma vez
  if (idsTarefasCriadas.length > 0) {
    await notion.updatePage(conteudo.id, {
      [PROP_TAREFA]: { relation: idsTarefasCriadas },
    });
    log('  ' + idsTarefasCriadas.length + ' tarefa(s) vinculada(s) a "' + tituloConteudo + '".', 'success');
    await notion.sleep(200);
  }
}

log('', 'info');
log('Concluido! Tarefas criadas: ' + criadas + ' | Conteudos pulados: ' + pulados, 'success');