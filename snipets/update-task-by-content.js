// ── Configuração ──────────────────────────────────────────────
const NOME_DB_CONTEUDO    = 'conteudo';
const NOME_DB_TAREFA      = 'tarefa';
const NOME_DB_FORMATO     = 'formato';
const NOME_DB_TAREFA_TIPO = 'tarefa_tipo';

const PROP_STATUS         = 'Status';          // status do conteudo
const STATUS_VALOR        = 'Recriar';         // Status que engatilha a atualização
const STATUS_PROCESSO     = 'Em andamento';    // Status final do conteúdo pós-processamento

const PROP_FORMATO        = 'formato';         // relacao em conteudo -> formato
const PROP_TAREFA         = 'tarefa';          // relacao em conteudo -> tarefa
const PROP_TAREFA_TIPO    = 'tarefa_tipo';     // relacao em formato -> tarefa_tipo
const PROP_CONTEUDO_REL   = 'conteudo';        // relacao em tarefa -> conteudo
const PROP_FORMATO_REL    = 'formato';         // relacao em tarefa -> formato
const PROP_TIPO_REL       = 'tarefa_tipo';     // relacao em tarefa -> tarefa_tipo
const PROP_STATUS_TAREFA   = 'Status';         // status da tarefa
const STATUS_TAREFA_PADRAO = 'Não iniciada';    // status padrao se precisar criar novas
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

// ── Filtro: conteudos com status 'Recriar' ────────────────────
const filtro = {
  property: PROP_STATUS,
  status: { equals: STATUS_VALOR }
};

log('Buscando conteudos com status "' + STATUS_VALOR + '" para atualizar nomes de tarefas...', 'info');
const conteudos = await notion.queryAllPages(dbConteudo.id, filtro);
log(conteudos.length + ' conteudo(s) encontrado(s).', 'info');

let renomeadas = 0;
let criadas = 0;
let pulados = 0;
let atualizadosStatus = 0;

const cacheFormatos = new Map();

for (const conteudo of conteudos) {
  const tituloConteudo = notion.getPageTitle(conteudo);
  const relFormatosRaw = conteudo.properties[PROP_FORMATO]?.relation ?? [];
  const tarefasAtuais  = conteudo.properties[PROP_TAREFA]?.relation ?? [];

  log('---------------------------------------------------------', 'info');
  log('Processando Conteúdo: "' + tituloConteudo + '"', 'info');

  if (relFormatosRaw.length === 0) {
    log('   [pulado] "' + tituloConteudo + '" sem formato vinculado.', 'warn');
    pulados++;
    continue;
  }

  // Puxa os dados reais das tarefas que já estão vinculadas hoje para sabermos o tipo delas
  const mapaTarefasExistentes = new Map(); // tarefaTipoId -> tarefaId
  
  if (tarefasAtuais.length > 0) {
    log('   Mapeando ' + tarefasAtuais.length + ' tarefa(s) existente(s) para renomear...', 'info');
    for (const tRef of tarefasAtuais) {
      try {
        const dadosTarefa = await notion.fetch('/pages/' + tRef.id);
        const tipoRel = dadosTarefa.properties[PROP_TIPO_REL]?.relation ?? [];
        if (tipoRel.length > 0) {
          mapaTarefasExistentes.set(tipoRel[0].id, tRef.id);
        }
      } catch (e) {
        log('   Não foi possível ler dados da tarefa ' + tRef.id, 'warn');
      }
    }
  }

  const formatosUnicos = Array.from(new Set(relFormatosRaw.map(f => f.id)));
  const listaFinalTarefas = [];

  // ── Varre os formatos e tipos para Atualizar ou Criar ────────
  for (const formatoId of formatosUnicos) {
    if (!cacheFormatos.has(formatoId)) {
      const paginaFormato = await notion.fetch('/pages/' + formatoId);
      cacheFormatos.set(formatoId, paginaFormato);
      await notion.sleep(100);
    }
    const formato           = cacheFormatos.get(formatoId);
    const relTarefaTiposRaw = formato.properties[PROP_TAREFA_TIPO]?.relation ?? [];

    const tarefaTiposUnicos = Array.from(new Set(relTarefaTiposRaw.map(t => t.id)));

    for (const tarefaTipoId of tarefaTiposUnicos) {
      const tarefaTipo   = await notion.fetch('/pages/' + tarefaTipoId);
      const nomeTipo     = notion.getPageTitle(tarefaTipo);
      const tituloTarefaCorreto = nomeTipo + ' — ' + tituloConteudo; // O nome updated com o nome do conteúdo novo

      // Monta as propriedades básicas de atualização/criação
      const props = {
        [campoTituloTarefa]: {
          title: [{ type: 'text', text: { content: tituloTarefaCorreto } }],
        },
      };

      // Alinha datas de gravação e finalização caso tenham mudado no conteúdo
      const dataGravacao = conteudo.properties[PROP_DATA_GRAVACAO]?.date ?? null;
      if (dataGravacao && schemaTarefa.properties[PROP_DATA_GRAVACAO]?.type === 'date') {
        props[PROP_DATA_GRAVACAO] = { date: dataGravacao };
      }

      if (dataGravacao && schemaTarefa.properties[PROP_DATA_FINALIZACAO]?.type === 'date') {
        const horaRaw = tarefaTipo.properties[PROP_HORARIO_PADRAO]?.number;
        const hora    = (horaRaw != null && horaRaw >= 0 && horaRaw <= 23) ? horaRaw : null;
        if (hora != null) {
          const dataBase = (dataGravacao.start ?? dataGravacao).slice(0, 10);
          const hh       = String(hora).padStart(2, '0');
          const dataFinal = dataBase + 'T' + hh + ':00:00';
          props[PROP_DATA_FINALIZACAO] = { date: { start: dataFinal } };
        } else {
          props[PROP_DATA_FINALIZACAO] = { date: dataGravacao };
        }
      }

      // Se a tarefa já existir para esse tipo, nós APENAS RENOMEAMOS (evita erro de 'archived')
      if (mapaTarefasExistentes.has(tarefaTipoId)) {
        const idTarefaExistente = mapaTarefasExistentes.get(tarefaTipoId);
        await notion.updatePage(idTarefaExistente, props);
        log('    Renomeada: "' + tituloTarefaCorreto + '"', 'success');
        listaFinalTarefas.push({ id: idTarefaExistente });
        renomeadas++;
      } else {
        // Se mudou de formato e essa tarefa não existia, cria uma nova
        if (schemaTarefa.properties[PROP_CONTEUDO_REL]?.type === 'relation') {
          props[PROP_CONTEUDO_REL] = { relation: [{ id: conteudo.id }] };
        }
        if (schemaTarefa.properties[PROP_FORMATO_REL]?.type === 'relation') {
          props[PROP_FORMATO_REL] = { relation: [{ id: formatoId }] };
        }
        if (schemaTarefa.properties[PROP_TIPO_REL]?.type === 'relation') {
          props[PROP_TIPO_REL] = { relation: [{ id: tarefaTipoId }] };
        }
        if (schemaTarefa.properties[PROP_STATUS_TAREFA]?.type === 'status') {
          props[PROP_STATUS_TAREFA] = { status: { name: STATUS_TAREFA_PADRAO } };
        }

        const novaTarefa = await notion.createPage(dbTarefa.id, props);
        log('    Criada nova por falta de vínculo: "' + tituloTarefaCorreto + '"', 'success');
        listaFinalTarefas.push({ id: novaTarefa.id });
        criadas++;
      }
      await notion.sleep(150);
    }
  }

  // Objeto contendo os dados a serem atualizados na página do Conteúdo ativo
  const propriedadesAtualizacaoConteudo = {};

  // 1. Se houver tarefas, prepara para injetar a relação atualizada
  if (listaFinalTarefas.length > 0) {
    propriedadesAtualizacaoConteudo[PROP_TAREFA] = { relation: listaFinalTarefas };
  }

  // 2. CORREÇÃO SOLICITADA: Adiciona a alteração de status do conteúdo para "Em desenvolvimento"
  propriedadesAtualizacaoConteudo[PROP_STATUS] = { status: { name: STATUS_PROCESSO } };

  // Executa o update único no conteúdo (relação + mudança de status)
  try {
    log('   Atualizando status do Conteúdo para "' + STATUS_PROCESSO + '"...', 'info');
    await notion.updatePage(conteudo.id, propriedadesAtualizacaoConteudo);
    atualizadosStatus++;
  } catch (err) {
    log('   Erro ao atualizar status do conteúdo ' + tituloConteudo + ': ' + err.message, 'error');
  }

  await notion.sleep(100);
}

// ── Resumo Final ──────────────────────────────────────────────
log('\n=== RESUMO DA ATUALIZAÇÃO ===', 'info');
log('Tarefas antigas renomeadas:  ' + renomeadas, 'success');
log('Novas tarefas geradas:       ' + criadas, 'success');
log('Conteúdos movidos para Em desenvolvimento: ' + atualizadosStatus, 'success');
log('Conteúdos pulados:           ' + pulados, 'warn');