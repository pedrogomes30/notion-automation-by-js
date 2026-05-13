'use strict';

// ── STORAGE ──────────────────────────────────────────────────
function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function storageSet(items) { return new Promise(r => chrome.storage.local.set(items, r)); }
function storageRemove(keys) { return new Promise(r => chrome.storage.local.remove(keys, r)); }

// ── NOTION API ───────────────────────────────────────────────
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

async function validateApiKey(key) {
  try {
    await notionFetch('/users/me', 'GET', null, key);
    return true;
  } catch {
    return false;
  }
}

function notionFetch(path, method = 'GET', body = null, apiKeyOverride = '') {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: 'na-notion-request',
        path,
        method,
        body,
        apiKey: apiKeyOverride || undefined,
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Falha de comunicacao com o background'));
          return;
        }
        if (!response || !response.ok) {
          reject(new Error((response && response.error) || 'Erro ao consultar a API do Notion'));
          return;
        }
        resolve(response.data);
      }
    );
  });
}

async function fetchDatabases() {
  const data = await notionFetch('/search', 'POST', {
    filter: { value: 'database', property: 'object' },
    page_size: 100,
  });
  return data.results || [];
}

function getDatabaseTitle(db) {
  return (db.title || []).map(t => t.plain_text).join('').trim() || db.id;
}

// ── RULES CRUD ───────────────────────────────────────────────
async function loadRules() {
  const { rules } = await storageGet('rules');
  return rules || [];
}
async function saveRules(rules) { await storageSet({ rules }); }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── SNIPPETS ─────────────────────────────────────────────────
const SNIPPETS = [
  { id: 'create-content-by-theme', label: 'Criar Conteúdo por Tema', file: 'snipets/create-content-by-theme.js' },
  { id: 'create-task-by-format', label: 'Criar Tarefa por Formato', file: 'snipets/create-task-by-format-default-task.js' },
];

async function loadSnippetContent(snippetId) {
  const snippet = SNIPPETS.find(s => s.id === snippetId);
  if (!snippet) return DEFAULT_RULE_CODE;
  try {
    const url = chrome.runtime.getURL(snippet.file);
    const response = await fetch(url);
    if (!response.ok) return DEFAULT_RULE_CODE;
    return await response.text();
  } catch (e) {
    console.warn('[Notion Automator] Erro ao carregar snippet:', e);
    return DEFAULT_RULE_CODE;
  }
}

// ── CALENDAR OVERLAY RULES CRUD ─────────────────────────────
const OVERLAY_RULES_KEY = 'na_calendar_overlay_rules';

async function loadOverlayRules() {
  const data = await storageGet(OVERLAY_RULES_KEY);
  const rules = data[OVERLAY_RULES_KEY];
  return Array.isArray(rules) ? rules : [];
}

async function saveOverlayRules(rules) {
  await storageSet({ [OVERLAY_RULES_KEY]: rules });
}

function createDefaultOverlayRule() {
  return {
    id: generateId(),
    name: 'Overlay de objetivos',
    enabled: true,
    sourceDatabaseId: '',
    targetDatabaseId: '',
    sourceDateProperty: 'Data',
    sourceLabelProperty: 'Name',
    sourceColorProperty: '',
    filter: null,
  };
}

// ── SANDBOX ──────────────────────────────────────────────────
let sandboxReady = false;
const pendingRuns = new Map();

function initSandbox() {
  const frame = document.getElementById('sandbox-frame');
  window.addEventListener('message', async event => {
    const { type, runId, reqId, path, method, body, msg, level, message } = event.data || {};

    if (type === 'sandbox-ready') { sandboxReady = true; return; }

    // ── Proxy de fetch: sandbox não tem host_permissions, popup.js tem ──
    if (type === 'notion-fetch') {
      try {
        const data = await notionFetch(path, method, body);
        frame.contentWindow.postMessage({ type: 'notion-fetch-response', reqId, data }, '*');
      } catch (e) {
        frame.contentWindow.postMessage({ type: 'notion-fetch-error', reqId, message: e.message }, '*');
      }
      return;
    }

    const run = pendingRuns.get(runId);
    if (!run) return;
    if (type === 'log') {
      appendLog(run.logEl, msg, level || 'info');
    } else if (type === 'done') {
      pendingRuns.delete(runId);
      run.resolve();
    } else if (type === 'error') {
      appendLog(run.logEl, 'Erro: ' + message, 'error');
      pendingRuns.delete(runId);
      run.reject(new Error(message));
    }
  });
  frame.addEventListener('load', () => { sandboxReady = true; });
}

async function runRuleInSandbox(rule, logEl) {
  if (!sandboxReady) throw new Error('Sandbox nao carregou. Feche e reabra o painel.');
  const { apiKey } = await storageGet('apiKey');
  if (!apiKey) throw new Error('API Key nao configurada.');

  appendLog(logEl, 'Buscando databases...', 'info');
  const dbList = await fetchDatabases();
  const databases = {};
  for (const db of dbList) {
    databases[db.id] = { id: db.id, title: getDatabaseTitle(db), properties: db.properties || {} };
  }
  appendLog(logEl, dbList.length + ' database(s) carregado(s).', 'success');

  return new Promise((resolve, reject) => {
    const runId = generateId();
    pendingRuns.set(runId, { logEl, resolve, reject });
    document.getElementById('sandbox-frame').contentWindow.postMessage(
      { type: 'run', code: rule.code, apiKey, databases, config: {}, runId }, '*'
    );
  });
}

// ── DOM HELPERS ──────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function setHeader(title, showBack) {
  document.getElementById('header-title').textContent = title;
  document.getElementById('btn-header-back').style.display = showBack ? 'inline-flex' : 'none';
}
function setStatus(statusId, msg, type) {
  const el = document.getElementById(statusId);
  if (!el) return;
  el.textContent = msg || '';
  el.className = msg ? 'status status-' + (type || 'info') : 'status';
}
function setLoading(msg) {
  document.getElementById('loading-msg').textContent = msg || 'Carregando...';
  showScreen('screen-loading');
}
function appendLog(logEl, msg, type) {
  const line = document.createElement('div');
  line.className   = 'log-line log-' + (type || 'info');
  line.textContent = msg;
  logEl.style.display = 'block';
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── TABS ─────────────────────────────────────────────────────
let activeTab = 'automations';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.tab === tab);
  });
  if (tab === 'databases') loadDatabasesTab();
}

// ── DATABASES TAB ────────────────────────────────────────────
async function loadDatabasesTab() {
  const container = document.getElementById('databases-container');
  if (!container) return;
  container.innerHTML = '<div class="loading-inline"><div class="spinner-sm"></div> Carregando databases...</div>';
  try {
    const dbs = await fetchDatabases();
    if (dbs.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128451;</div><p>Nenhum database encontrado.<br>Adicione a integracao aos databases no Notion.</p></div>';
      return;
    }
    container.innerHTML = '';
    for (const db of dbs) {
      const title = getDatabaseTitle(db);
      const props = Object.entries(db.properties || {});
      const card  = document.createElement('div');
      card.className = 'db-card';
      const propTags = props.map(([name, prop]) =>
        '<span class="db-prop-tag"><span class="db-prop-name">' + escapeHtml(name) + '</span>' +
        '<span class="db-prop-type"> ' + prop.type + '</span></span>'
      ).join('');
      card.innerHTML =
        '<div class="db-card-header">' +
          '<span class="db-card-icon">&#128451;</span>' +
          '<span class="db-card-name">' + escapeHtml(title) + '</span>' +
          '<span class="db-card-count">' + props.length + ' prop.</span>' +
        '</div>' +
        (props.length > 0 ? '<div class="db-card-props">' + propTags + '</div>' : '');
      container.appendChild(card);
    }
  } catch (e) {
    container.innerHTML = '<div class="status status-error">Erro ao carregar databases: ' + escapeHtml(e.message) + '</div>';
  }
}

// ── RULES RENDER ─────────────────────────────────────────────
async function renderRules() {
  const container = document.getElementById('rules-container');
  if (!container) return;
  const rules = await loadRules();
  if (rules.length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-icon">&#9889;</div>' +
        '<p>Nenhuma automacao criada ainda.<br>Clique em <strong>+ Nova Regra</strong> para comecar.</p>' +
      '</div>';
    return;
  }
  container.innerHTML = '';
  for (const rule of rules) {
    const card = document.createElement('div');
    card.className      = 'rule-card';
    card.dataset.ruleId = rule.id;
    card.innerHTML =
      '<div class="rule-card-header">' +
        '<div class="rule-card-info">' +
          '<div class="rule-card-name">'  + escapeHtml(rule.name) + '</div>' +
          '<div class="rule-card-desc">'  + escapeHtml(rule.description || 'Sem descricao') + '</div>' +
        '</div>' +
        '<div class="rule-card-actions">' +
          '<button data-action="run"       title="Executar">&#9654;</button>' +
          '<button data-action="edit"      title="Editar">&#9998;</button>' +
          '<button data-action="duplicate" title="Duplicar">&#10697;</button>' +
          '<button data-action="delete"    title="Excluir">&#10005;</button>' +
        '</div>' +
      '</div>' +
      '<div class="rule-log" id="log-' + rule.id + '"></div>';
    container.appendChild(card);
  }
}

// ── OVERLAY RENDER ──────────────────────────────────────────
let editingOverlayRuleId = null;
let overlayDatabasesCache = null;

async function renderOverlayRules() {
  const container = document.getElementById('overlay-rules-container');
  if (!container) {
    console.log('[Notion Automator] Container overlay-rules-container nao encontrado');
    console.log('[Notion Automator] Elementos com "overlay" no ID:', document.querySelectorAll('[id*="overlay"]').length);
    console.log('[Notion Automator] screen-main visível?', document.getElementById('screen-main')?.style.display);
    console.log('[Notion Automator] Todos os elementos do DOM:', document.querySelectorAll('div').length);
    
    // Tenta encontrar usando CSS selector como fallback
    const fallback = document.querySelector('[id="overlay-rules-container"]');
    if (fallback) {
      console.log('[Notion Automator] Encontrado usando querySelector!');
    }
    return;
  }

  const rules = await loadOverlayRules();
  console.log('[Notion Automator] Renderizando', rules.length, 'regras de overlay');
  
  if (rules.length === 0) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-icon">&#128197;</div>' +
        '<p>Nenhuma regra de overlay criada.<br>Use <strong>+ Nova Regra</strong> para mapear tabela X sobre calendario de tabela Y.</p>' +
      '</div>';
    console.log('[Notion Automator] Nenhuma regra, exibindo empty state');
    return;
  }

  container.innerHTML = '';
  for (const rule of rules) {
    const card = document.createElement('div');
    card.className = 'overlay-rule-card';
    card.dataset.overlayRuleId = rule.id;
    card.innerHTML =
      '<div class="overlay-rule-header">' +
        '<input class="overlay-rule-toggle" type="checkbox" data-overlay-action="toggle" ' + (rule.enabled ? 'checked' : '') + '>' +
        '<div class="overlay-rule-info">' +
          '<div class="overlay-rule-name">' + escapeHtml(rule.name || 'Regra sem nome') + '</div>' +
          '<div class="overlay-rule-desc">X: ' + escapeHtml(shortDb(rule.sourceDatabaseId)) + '  →  Y: ' + escapeHtml(shortDb(rule.targetDatabaseId) || 'qualquer calendario') + '</div>' +
        '</div>' +
        '<div class="overlay-rule-actions">' +
          '<button data-overlay-action="edit" title="Editar">&#9998;</button>' +
          '<button data-overlay-action="delete" title="Excluir">&#10005;</button>' +
        '</div>' +
      '</div>';
    container.appendChild(card);
    console.log('[Notion Automator] Regra de overlay renderizada:', rule.name);
  }
  console.log('[Notion Automator] Renderizacao completa, total de regras:', rules.length);
}

function shortDb(value) {
  const raw = String(value || '').replace(/-/g, '');
  if (!raw) return '';
  return raw.slice(0, 8) + '...';
}

async function openOverlayEditor(ruleId) {
  editingOverlayRuleId = ruleId || null;
  setHeader(ruleId ? 'Editar Overlay' : 'Novo Overlay', true);
  setStatus('status-overlay-editor', '');

  const rules = await loadOverlayRules();
  const current = ruleId ? rules.find(r => r.id === ruleId) : null;
  const rule = Object.assign(createDefaultOverlayRule(), current || {});

  const nameEl = document.getElementById('overlay-name');
  const enabledEl = document.getElementById('overlay-enabled');
  const sourceDbEl = document.getElementById('overlay-source-db');
  const targetDbEl = document.getElementById('overlay-target-db');
  const filterEl = document.getElementById('overlay-filter');

  nameEl.value = rule.name || '';
  enabledEl.value = rule.enabled ? 'true' : 'false';
  filterEl.value = rule.filter ? JSON.stringify(rule.filter, null, 2) : '';

  if (!overlayDatabasesCache) {
    overlayDatabasesCache = await fetchDatabases();
  }

  fillDatabaseSelect(sourceDbEl, overlayDatabasesCache, rule.sourceDatabaseId, false);
  fillDatabaseSelect(targetDbEl, overlayDatabasesCache, rule.targetDatabaseId, true);

  await fillOverlayPropertySelects(rule.sourceDatabaseId, rule);

  showScreen('screen-overlay-editor');
  nameEl.focus();
}

function fillDatabaseSelect(selectEl, dbs, selectedId, includeAnyOption) {
  if (!selectEl) return;
  const selected = String(selectedId || '');

  let html = '';
  if (includeAnyOption) {
    html += '<option value="">Qualquer calendario</option>';
  }

  html += dbs.map(db => {
    const id = String(db.id || '');
    const title = escapeHtml(getDatabaseTitle(db));
    const isSelected = normalizeDbId(id) === normalizeDbId(selected);
    return '<option value="' + escapeHtml(id) + '" ' + (isSelected ? 'selected' : '') + '>' + title + '</option>';
  }).join('');

  selectEl.innerHTML = html;
}

async function fillOverlayPropertySelects(sourceDbId, presetRule) {
  const dateEl = document.getElementById('overlay-date-prop');
  const labelEl = document.getElementById('overlay-label-prop');
  const colorEl = document.getElementById('overlay-color-prop');

  if (!sourceDbId) {
    dateEl.innerHTML = '<option value="">Selecione uma database fonte</option>';
    labelEl.innerHTML = '<option value="">Selecione uma database fonte</option>';
    colorEl.innerHTML = '<option value="">Sem cor customizada</option>';
    return;
  }

  const schema = await notionFetch('/databases/' + sourceDbId);
  const props = schema.properties || {};

  const dateProps = Object.entries(props).filter(([, prop]) => ['date', 'formula', 'rollup'].includes(prop.type));
  const labelProps = Object.entries(props).filter(([, prop]) => ['title', 'rich_text', 'select', 'status', 'formula'].includes(prop.type));
  const colorProps = Object.entries(props).filter(([, prop]) => ['select', 'status'].includes(prop.type));

  setPropertyOptions(dateEl, dateProps, presetRule.sourceDateProperty, 'Escolha a propriedade de data');
  setPropertyOptions(labelEl, labelProps, presetRule.sourceLabelProperty, 'Escolha a propriedade de label');
  setPropertyOptions(colorEl, colorProps, presetRule.sourceColorProperty, 'Sem cor customizada', true);
}

function setPropertyOptions(selectEl, propsEntries, selectedName, firstLabel, allowEmpty) {
  let html = '';
  if (allowEmpty) {
    html += '<option value="">' + escapeHtml(firstLabel) + '</option>';
  }

  if (!propsEntries.length) {
    selectEl.innerHTML = html + '<option value="">Nenhuma propriedade compativel encontrada</option>';
    return;
  }

  html += propsEntries.map(([name, prop]) => {
    const selected = name === selectedName ? 'selected' : '';
    return '<option value="' + escapeHtml(name) + '" ' + selected + '>' + escapeHtml(name) + ' [' + prop.type + ']</option>';
  }).join('');

  selectEl.innerHTML = html;
}

async function handleSaveOverlayRule() {
  const name = document.getElementById('overlay-name').value.trim();
  const enabled = document.getElementById('overlay-enabled').value === 'true';
  const sourceDatabaseId = document.getElementById('overlay-source-db').value.trim();
  const targetDatabaseId = document.getElementById('overlay-target-db').value.trim();
  const sourceDateProperty = document.getElementById('overlay-date-prop').value.trim();
  const sourceLabelProperty = document.getElementById('overlay-label-prop').value.trim();
  const sourceColorProperty = document.getElementById('overlay-color-prop').value.trim();
  const filterText = document.getElementById('overlay-filter').value.trim();

  if (!name) {
    setStatus('status-overlay-editor', 'Informe um nome para a regra.', 'error');
    return;
  }
  if (!sourceDatabaseId) {
    setStatus('status-overlay-editor', 'Selecione a database fonte (Tabela X).', 'error');
    return;
  }
  if (!sourceDateProperty) {
    setStatus('status-overlay-editor', 'Selecione a propriedade de data.', 'error');
    return;
  }
  if (!sourceLabelProperty) {
    setStatus('status-overlay-editor', 'Selecione a propriedade de label.', 'error');
    return;
  }

  let parsedFilter = null;
  if (filterText) {
    try {
      parsedFilter = JSON.parse(filterText);
    } catch {
      setStatus('status-overlay-editor', 'Filtro JSON invalido.', 'error');
      return;
    }
  }

  const rules = await loadOverlayRules();
  const item = {
    id: editingOverlayRuleId || generateId(),
    name: name,
    enabled: enabled,
    sourceDatabaseId: sourceDatabaseId,
    targetDatabaseId: targetDatabaseId,
    sourceDateProperty: sourceDateProperty,
    sourceLabelProperty: sourceLabelProperty,
    sourceColorProperty: sourceColorProperty,
    filter: parsedFilter,
  };

  if (editingOverlayRuleId) {
    const idx = rules.findIndex(r => r.id === editingOverlayRuleId);
    if (idx >= 0) rules[idx] = item;
  } else {
    rules.push(item);
  }

  await saveOverlayRules(rules);
  await navigateToMain();
}

async function handleDeleteOverlayRule(ruleId) {
  const rules = await loadOverlayRules();
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return;
  if (!confirm('Excluir regra de overlay "' + (rule.name || 'sem nome') + '"?')) return;
  await saveOverlayRules(rules.filter(r => r.id !== ruleId));
  await renderOverlayRules();
}

async function handleToggleOverlayRule(ruleId, enabled) {
  const rules = await loadOverlayRules();
  const idx = rules.findIndex(r => r.id === ruleId);
  if (idx < 0) return;
  rules[idx] = Object.assign({}, rules[idx], { enabled: !!enabled });
  await saveOverlayRules(rules);
  await renderOverlayRules();
}

function normalizeDbId(value) {
  return String(value || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

// ── RULES ACTIONS ────────────────────────────────────────────
async function handleRunRule(ruleId) {
  const rules = await loadRules();
  const rule  = rules.find(r => r.id === ruleId);
  if (!rule) return;
  const card  = document.querySelector('[data-rule-id="' + ruleId + '"]');
  if (!card) return;
  const logEl = card.querySelector('.rule-log');
  const btns  = card.querySelectorAll('.rule-card-actions button');
  logEl.innerHTML = '';
  card.classList.add('running');
  btns.forEach(b => { b.disabled = true; });
  try {
    await runRuleInSandbox(rule, logEl);
    appendLog(logEl, 'Concluido com sucesso.', 'success');
  } catch (e) {
    if (!logEl.querySelector('.log-error')) appendLog(logEl, e.message, 'error');
  } finally {
    card.classList.remove('running');
    btns.forEach(b => { b.disabled = false; });
  }
}

async function handleDeleteRule(ruleId) {
  const rules = await loadRules();
  const rule  = rules.find(r => r.id === ruleId);
  if (!rule) return;
  if (!confirm('Excluir a automacao "' + rule.name + '"?')) return;
  await saveRules(rules.filter(r => r.id !== ruleId));
  renderRules();
}

async function handleDuplicateRule(ruleId) {
  const rules = await loadRules();
  const rule  = rules.find(r => r.id === ruleId);
  if (!rule) return;
  rules.push(Object.assign({}, rule, { id: generateId(), name: rule.name + ' (copia)' }));
  await saveRules(rules);
  renderRules();
}

// ── IMPORT / EXPORT ──────────────────────────────────────────
async function handleExportRules() {
  const rules = await loadRules();
  if (rules.length === 0) { alert('Nenhuma automacao para exportar.'); return; }
  const json = JSON.stringify(rules, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'notion-automations-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function handleImportRules() {
  const input = document.createElement('input');
  input.type   = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const text     = await file.text();
      const imported = JSON.parse(text);
      if (!Array.isArray(imported)) throw new Error('Formato invalido: esperado um array de regras.');
      const valid = imported.filter(r => r.name && r.code);
      if (valid.length === 0) throw new Error('Nenhuma regra valida encontrada no arquivo.');
      const existing = await loadRules();
      const merged   = existing.concat(valid.map(r => Object.assign({}, r, { id: generateId() })));
      await saveRules(merged);
      await renderRules();
      alert(valid.length + ' automacao(oes) importada(s) com sucesso.');
    } catch (e) {
      alert('Erro ao importar: ' + e.message);
    }
  };
  input.click();
}

// ── RULE EDITOR ──────────────────────────────────────────────
let editingRuleId = null;

async function openRuleEditor(ruleId) {
  editingRuleId = ruleId || null;
  const nameEl = document.getElementById('editor-name');
  const descEl = document.getElementById('editor-desc');
  const codeEl = document.getElementById('editor-code');
  if (ruleId) {
    const rules = await loadRules();
    const rule  = rules.find(r => r.id === ruleId);
    if (!rule) return;
    nameEl.value = rule.name;
    descEl.value = rule.description || '';
    codeEl.value = rule.code;
    setHeader('Editar Automacao', true);
  } else {
    nameEl.value = '';
    descEl.value = '';
    codeEl.value = DEFAULT_RULE_CODE;
    setHeader('Nova Automacao', true);
  }
  setStatus('status-editor', '');
  await buildApiRef();
  showScreen('screen-rule-editor');
  nameEl.focus();
}

async function buildApiRef() {
  const refBody = document.getElementById('api-ref-body');
  refBody.innerHTML = '<span style="color:var(--text3)">Carregando databases...</span>';
  try {
    const dbs = await fetchDatabases();
    let html  = '<span class="ref-sec">// Databases disponiveis (' + dbs.length + ')</span>\n\n';
    for (const db of dbs) {
      const title = escapeHtml(getDatabaseTitle(db));
      html += '<span class="ref-key">databases["' + escapeHtml(db.id) + '"]</span>' +
              '  <span class="ref-cmt">// ' + title + '</span>\n';
      for (const [name, prop] of Object.entries(db.properties || {})) {
        html += '  <span class="ref-cmt">• "' + escapeHtml(name) + '"  [' + prop.type + ']</span>\n';
      }
      html += '\n';
    }
    html += '<span class="ref-sec">// Funcoes disponiveis</span>\n';
    html += '<span class="ref-fn">notion.queryAllPages</span>(dbId, filter?)       <span class="ref-cmt">-> Page[]</span>\n';
    html += '<span class="ref-fn">notion.createPage</span>(dbId, props, children?) <span class="ref-cmt">-> Page</span>\n';
    html += '<span class="ref-fn">notion.updatePage</span>(pageId, props)          <span class="ref-cmt">-> Page</span>\n';
    html += '<span class="ref-fn">notion.fetchDatabaseSchema</span>(dbId)          <span class="ref-cmt">-> DB schema</span>\n';
    html += '<span class="ref-fn">notion.getPageTitle</span>(page)                 <span class="ref-cmt">-> string</span>\n';
    html += '<span class="ref-fn">notion.fetch</span>(path, method?, body?)        <span class="ref-cmt">-> any</span>\n';
    html += '<span class="ref-fn">log</span>(msg, level)                           <span class="ref-cmt">-> void</span>';
    refBody.innerHTML = html;
  } catch (e) {
    refBody.innerHTML = '<span class="ref-cmt">Erro ao carregar: ' + escapeHtml(e.message) + '</span>';
  }
}

async function handleSaveRule() {
  const name = document.getElementById('editor-name').value.trim();
  const desc = document.getElementById('editor-desc').value.trim();
  const code = document.getElementById('editor-code').value.trim();
  if (!name) { setStatus('status-editor', 'O nome e obrigatorio.', 'error'); return; }
  if (!code) { setStatus('status-editor', 'O codigo JavaScript e obrigatorio.', 'error'); return; }
  const rules = await loadRules();
  if (editingRuleId) {
    const idx = rules.findIndex(r => r.id === editingRuleId);
    if (idx >= 0) rules[idx] = Object.assign({}, rules[idx], { name, description: desc, code });
  } else {
    rules.push({ id: generateId(), name, description: desc, code });
  }
  await saveRules(rules);
  navigateToMain();
}

// ── NAVIGATION ───────────────────────────────────────────────
async function navigateToMain() {
  console.log('[Notion Automator] Navegando para tela principal...');
  setHeader('Notion Automator', false);
  await renderRules();
  console.log('[Notion Automator] Regras de automacao renderizadas');
  await renderOverlayRules();
  console.log('[Notion Automator] Regras de overlay renderizadas');
  showScreen('screen-main');
  console.log('[Notion Automator] Tela principal exibida');
}

// ── DEFAULT RULE CODE ────────────────────────────────────────
const DEFAULT_RULE_CODE = [
  '// databases: objeto indexado pelo ID de cada database',
  '// Cada entrada: { id, title, properties: { [nome]: { type, ... } } }',
  '//',
  '// Encontrar database por titulo:',
  '// const db = Object.values(databases).find(d => d.title === "Meu Database");',
  '',
  '// Listar todos os databases e suas propriedades',
  'log("Databases acessiveis:", "info");',
  'for (const db of Object.values(databases)) {',
  '  log("  " + db.title, "info");',
  '  for (const [name, prop] of Object.entries(db.properties)) {',
  '    log("    - " + name + "  [" + prop.type + "]", "info");',
  '  }',
  '}',
  '',
  '// Exemplo: buscar paginas de um database',
  '// const db = Object.values(databases).find(d => d.title === "Temas");',
  '// if (!db) { log("Database nao encontrado", "error"); return; }',
  '// const pages = await notion.queryAllPages(db.id);',
  '// log(pages.length + " pagina(s) encontrada(s).", "success");',
].join('\n');

// ── SETUP HANDLER ────────────────────────────────────────────
async function handleSaveApi() {
  const key = document.getElementById('input-api-key').value.trim();
  if (!key) { setStatus('status-api', 'Insira o token de integracao.', 'error'); return; }
  const btn = document.getElementById('btn-save-api');
  btn.disabled = true;
  setStatus('status-api', 'Validando token...', 'info');
  try {
    if (!await validateApiKey(key)) {
      setStatus('status-api', 'Token invalido. Verifique e tente novamente.', 'error');
      btn.disabled = false;
      return;
    }
    await storageSet({ apiKey: key });
    const existing = await loadRules();
    if (existing.length === 0) {
      await saveRules([{
        id: generateId(),
        name: 'Explorar Databases',
        description: 'Lista todos os databases acessiveis e suas propriedades.',
        code: DEFAULT_RULE_CODE,
      }]);
    }
    setStatus('status-api', '');
    await navigateToMain();
  } catch (e) {
    setStatus('status-api', 'Erro: ' + e.message, 'error');
    btn.disabled = false;
  }
}

// ── RESET ────────────────────────────────────────────────────
async function handleReset() {
  if (!confirm('Trocar a API Key?\nAs regras de automacao serao mantidas.')) return;
  await storageRemove(['apiKey']);
  location.reload();
}
async function handleResetAll() {
  if (!confirm('Apagar TUDO, incluindo API Key e todas as regras?\nEssa acao nao pode ser desfeita.')) return;
  await storageRemove(['apiKey', 'rules', OVERLAY_RULES_KEY]);
  location.reload();
}

// ── INIT ─────────────────────────────────────────────────────
async function initApp() {
  console.log('[Notion Automator] Popup carregando...');
  const { apiKey } = await storageGet('apiKey');
  if (!apiKey) {
    console.log('[Notion Automator] Nenhuma API Key, exibindo tela de setup');
    showScreen('screen-api');
    return;
  }
  console.log('[Notion Automator] API Key encontrada, navegando para tela principal');
  await navigateToMain();
}

document.addEventListener('DOMContentLoaded', () => {
  initSandbox();

  function onClick(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', handler);
  }

  function onKeydown(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('keydown', handler);
  }

  // Header
  onClick('btn-header-back', navigateToMain);

  // API screen
  onClick('btn-save-api', handleSaveApi);
  onKeydown('input-api-key', e => {
    if (e.key === 'Enter') handleSaveApi();
  });
  onClick('link-integrations', e => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://www.notion.so/my-integrations' });
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Databases tab
  onClick('btn-refresh-dbs', loadDatabasesTab);

  // Automations tab
  onClick('btn-add-rule', () => openRuleEditor(null));
  onClick('btn-export-rules', handleExportRules);
  onClick('btn-import-rules', handleImportRules);

  // Overlay tab
  onClick('btn-add-overlay-rule', () => openOverlayEditor(null));
  onClick('btn-overlay-cancel', navigateToMain);
  onClick('btn-overlay-save', handleSaveOverlayRule);

  const sourceDbSelect = document.getElementById('overlay-source-db');
  if (sourceDbSelect) {
    sourceDbSelect.addEventListener('change', async () => {
      const sourceDbId = sourceDbSelect.value;
      await fillOverlayPropertySelects(sourceDbId, {
        sourceDateProperty: '',
        sourceLabelProperty: '',
        sourceColorProperty: '',
      });
    });
  }

  // Reset
  onClick('btn-reset', handleReset);
  onClick('btn-reset-all', handleResetAll);

  // Rule cards (event delegation)
  const rulesContainer = document.getElementById('rules-container');
  if (rulesContainer) rulesContainer.addEventListener('click', e => {
    const btn  = e.target.closest('[data-action]');
    if (!btn) return;
    const card = btn.closest('[data-rule-id]');
    if (!card) return;
    const id  = card.dataset.ruleId;
    const act = btn.dataset.action;
    if      (act === 'run')       handleRunRule(id);
    else if (act === 'edit')      openRuleEditor(id);
    else if (act === 'duplicate') handleDuplicateRule(id);
    else if (act === 'delete')    handleDeleteRule(id);
  });

  const overlayContainer = document.getElementById('overlay-rules-container');
  if (overlayContainer) overlayContainer.addEventListener('click', e => {
    const btn = e.target.closest('[data-overlay-action]');
    if (!btn) return;
    const card = btn.closest('[data-overlay-rule-id]');
    if (!card) return;
    const id = card.dataset.overlayRuleId;
    const action = btn.dataset.overlayAction;
    if (action === 'edit') openOverlayEditor(id);
    if (action === 'delete') handleDeleteOverlayRule(id);
  });

  if (overlayContainer) overlayContainer.addEventListener('change', e => {
    const toggle = e.target.closest('[data-overlay-action="toggle"]');
    if (!toggle) return;
    const card = toggle.closest('[data-overlay-rule-id]');
    if (!card) return;
    handleToggleOverlayRule(card.dataset.overlayRuleId, toggle.checked);
  });

  // Rule editor
  onClick('btn-editor-cancel', navigateToMain);
  onClick('btn-editor-save', handleSaveRule);

  // Snippet selector
  const snippetSelect = document.getElementById('editor-snippet');
  if (snippetSelect) {
    snippetSelect.addEventListener('change', async e => {
      const snippetId = e.target.value;
      if (!snippetId) return;
      const codeEl = document.getElementById('editor-code');
      const content = await loadSnippetContent(snippetId);
      codeEl.value = content;
      e.target.value = ''; // Reset selector
    });
  }

  // Tab key inserts 2 spaces in code editor
  onKeydown('editor-code', e => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const el    = e.target;
    const start = el.selectionStart;
    const end   = el.selectionEnd;
    el.value    = el.value.slice(0, start) + '  ' + el.value.slice(end);
    el.selectionStart = el.selectionEnd = start + 2;
  });

  // Escape closes editor
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('screen-rule-editor').classList.contains('active')) {
      navigateToMain();
      return;
    }
    if (e.key === 'Escape' && document.getElementById('screen-overlay-editor').classList.contains('active')) {
      navigateToMain();
    }
  });

  initApp();
});