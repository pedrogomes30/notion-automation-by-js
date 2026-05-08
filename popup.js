'use strict';

// ── STORAGE ──────────────────────────────────────────────────
function storageGet(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function storageSet(items) { return new Promise(r => chrome.storage.local.set(items, r)); }
function storageRemove(keys) { return new Promise(r => chrome.storage.local.remove(keys, r)); }

// ── NOTION API ───────────────────────────────────────────────
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

async function validateApiKey(key) {
  const res = await fetch(`${NOTION_API}/users/me`, {
    headers: { 'Authorization': `Bearer ${key}`, 'Notion-Version': NOTION_VER },
  });
  return res.ok;
}

async function notionFetch(path, method = 'GET', body = null) {
  const { apiKey } = await storageGet('apiKey');
  if (!apiKey) throw new Error('API Key nao configurada.');
  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VER,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${NOTION_API}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Erro HTTP ${res.status}`);
  return data;
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
  setHeader('Notion Automator', false);
  await renderRules();
  showScreen('screen-main');
  // Activate last used tab
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === activeTab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('active', p.dataset.tab === activeTab);
  });
  if (activeTab === 'databases') loadDatabasesTab();
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
  await storageRemove(['apiKey', 'rules']);
  location.reload();
}

// ── INIT ─────────────────────────────────────────────────────
async function initApp() {
  const { apiKey } = await storageGet('apiKey');
  if (!apiKey) { showScreen('screen-api'); return; }
  await navigateToMain();
}

document.addEventListener('DOMContentLoaded', () => {
  initSandbox();

  // Header
  document.getElementById('btn-header-back').addEventListener('click', navigateToMain);

  // API screen
  document.getElementById('btn-save-api').addEventListener('click', handleSaveApi);
  document.getElementById('input-api-key').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSaveApi();
  });
  document.getElementById('link-integrations').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: 'https://www.notion.so/my-integrations' });
  });

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Databases tab
  document.getElementById('btn-refresh-dbs').addEventListener('click', loadDatabasesTab);

  // Automations tab
  document.getElementById('btn-add-rule').addEventListener('click', () => openRuleEditor(null));
  document.getElementById('btn-export-rules').addEventListener('click', handleExportRules);
  document.getElementById('btn-import-rules').addEventListener('click', handleImportRules);

  // Reset
  document.getElementById('btn-reset').addEventListener('click', handleReset);
  document.getElementById('btn-reset-all').addEventListener('click', handleResetAll);

  // Rule cards (event delegation)
  document.getElementById('rules-container').addEventListener('click', e => {
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

  // Rule editor
  document.getElementById('btn-editor-cancel').addEventListener('click', navigateToMain);
  document.getElementById('btn-editor-save').addEventListener('click', handleSaveRule);

  // Tab key inserts 2 spaces in code editor
  document.getElementById('editor-code').addEventListener('keydown', e => {
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
    }
  });

  initApp();
});