'use strict';

(function notionCalendarOverlay() {
  const STORAGE_KEY_API = 'apiKey';
  const STORAGE_KEY_RULES = 'na_calendar_overlay_rules';
  const BADGE_CLASS = 'na-cal-overlay-day-bg';
  const TOOLTIP_CLASS = 'na-cal-overlay-tooltip';
  const DECORATED_ATTR = 'data-na-cal-overlay';

  const DAY_SELECTORS = [
    '[role="gridcell"][data-date]',
    '[data-date][role="button"]',
    '[data-date]',
    '.notion-calendar-view-day',
    '.notion-calendar-view [role="gridcell"]',
    '[aria-label][role="gridcell"]',
    '[data-testid*="calendar-day"]',
    '[class*="CalendarDay"]',
    '[class*="calendar-day"]'
  ];

  const DEFAULT_RULE = {
    id: 'default-overlay',
    enabled: false,
    sourceDatabaseId: '',
    targetDatabaseId: '',
    sourceDateProperty: 'Data',
    sourceLabelProperty: 'Name',
    sourceColorProperty: '',
    filter: null,
  };

  const state = {
    rules: [],
    observer: null,
    storageListener: null,
    urlWatcherTimer: 0,
    rafId: 0,
    debounceTimer: 0,
    loading: false,
    disabled: false,
    cacheByRule: new Map(),
    lastPath: location.pathname,
  };

  injectStyles();
  boot();

  function injectStyles() {
    if (document.getElementById('na-calendar-overlay-style')) return;
    const style = document.createElement('style');
    style.id = 'na-calendar-overlay-style';
    style.textContent = [
      '.' + BADGE_CLASS + ' {',
      '  position: absolute;',
      '  top: 4px;',
      '  left: 4px;',
      '  width: 26px;',
      '  height: 26px;',
      '  border-radius: 999px;',
      '  opacity: 0.72;',
      '  filter: saturate(1.2);',
      '  border: 1px solid rgba(255,255,255,0.38);',
      '  box-shadow: 0 3px 10px rgba(0,0,0,0.35);',
      '  pointer-events: none;',
      '  z-index: 1;',
      '}',
      '[data-na-cal-overlay-cell="1"] {',
      '  position: relative !important;',
      '}',
      '[data-na-cal-overlay-cell="1"] > * {',
      '  position: relative;',
      '  z-index: 2;',
      '}',
      '.' + TOOLTIP_CLASS + ' {',
      '  position: absolute;',
      '  left: 6px;',
      '  top: 28px;',
      '  transform: none;',
      '  max-width: 260px;',
      '  min-width: 120px;',
      '  padding: 5px 6px;',
      '  border-radius: 10px;',
      '  background: rgba(15, 18, 22, 0.96);',
      '  border: 1px solid rgba(255,255,255,0.1);',
      '  display: flex;',
      '  flex-direction: column;',
      '  gap: 4px;',
      '  box-shadow: 0 6px 20px rgba(0,0,0,0.3);',
      '  opacity: 0;',
      '  visibility: hidden;',
      '  transition: opacity 0.12s ease;',
      '  pointer-events: none;',
      '  z-index: 8;',
      '}',
      '[data-na-cal-overlay-cell="1"]:hover .' + TOOLTIP_CLASS + ' {',
      '  opacity: 1;',
      '  visibility: visible;',
      '}',
      '.' + TOOLTIP_CLASS + '-item {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 6px;',
      '  padding: 4px 7px;',
      '  border-radius: 6px;',
      '  font-size: 11px;',
      '  line-height: 1.3;',
      '  color: #f3f4f6;',
      '  text-align: left;',
      '  white-space: nowrap;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '}',
      '.' + TOOLTIP_CLASS + '-dot {',
      '  flex-shrink: 0;',
      '  width: 9px;',
      '  height: 9px;',
      '  border-radius: 50%;',
      '  opacity: 0.9;',
      '}',
      '#na-overlay-loading {',
      '  position: fixed;',
      '  z-index: 9999;',
      '  background: rgba(15,18,22,0.82);',
      '  color: #a5b4fc;',
      '  font-size: 11px;',
      '  font-family: sans-serif;',
      '  padding: 3px 9px;',
      '  border-radius: 99px;',
      '  border: 1px solid rgba(165,180,252,0.25);',
      '  box-shadow: 0 2px 8px rgba(0,0,0,0.3);',
      '  display: none;',
      '  align-items: center;',
      '  gap: 6px;',
      '  pointer-events: none;',
      '  user-select: none;',
      '  transition: opacity 0.15s ease;',
      '}',
      '#na-overlay-loading.visible {',
      '  display: flex;',
      '}',
      '@keyframes na-spin {',
      '  to { transform: rotate(360deg); }',
      '}',
      '#na-overlay-loading-dot {',
      '  width: 8px;',
      '  height: 8px;',
      '  border: 2px solid rgba(165,180,252,0.3);',
      '  border-top-color: #a5b4fc;',
      '  border-radius: 50%;',
      '  animation: na-spin 0.7s linear infinite;',
      '}'
    ].join('\n');
    document.documentElement.appendChild(style);

    // Indicador de carregamento
    if (!document.getElementById('na-overlay-loading')) {
      var loadingEl = document.createElement('div');
      loadingEl.id = 'na-overlay-loading';
      loadingEl.innerHTML = '<div id="na-overlay-loading-dot"></div><span>Overlay...</span>';
      document.documentElement.appendChild(loadingEl);
    }
  }

  function boot() {
    console.log('[Notion Automator] Calendar overlay carregando...');
    loadRules().then(function() {
      console.log('[Notion Automator] Regras carregadas:', state.rules.length);
      scheduleRender(true);
      attachMutationObserver();
      attachUrlWatcher();
    }).catch(function(err) {
      if (isContextInvalidError(err)) {
        disableOverlay('Contexto da extensao invalidado (boot). Recarregue a pagina do Notion.');
        return;
      }
      console.error('[Notion Automator] Erro ao carregar regras:', err);
    });

    state.storageListener = function(changes, areaName) {
      if (state.disabled) return;
      if (areaName !== 'local') return;
      if (changes[STORAGE_KEY_RULES]) {
        loadRules()
          .then(function() { scheduleRender(true); })
          .catch(function(err) {
            if (isContextInvalidError(err)) {
              disableOverlay('Contexto da extensao invalidado ao atualizar regras. Recarregue a pagina do Notion.');
            }
          });
      }
      if (changes[STORAGE_KEY_API]) {
        state.cacheByRule.clear();
        scheduleRender(true);
      }
    };

    try {
      chrome.storage.onChanged.addListener(state.storageListener);
    } catch (err) {
      if (isContextInvalidError(err)) {
        disableOverlay('Contexto da extensao invalidado no listener de storage. Recarregue a pagina do Notion.');
        return;
      }
      throw err;
    }
  }

  function attachMutationObserver() {
    if (state.disabled || state.observer) return;
    state.observer = new MutationObserver(function() {
      scheduleRender(false);
    });
    state.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-date', 'aria-label']
    });
  }

  function attachUrlWatcher() {
    if (state.disabled || state.urlWatcherTimer) return;
    state.urlWatcherTimer = setInterval(function() {
      if (state.disabled) return;
      if (location.pathname !== state.lastPath) {
        state.lastPath = location.pathname;
        state.cacheByRule.clear();
        scheduleRender(true);
      }
    }, 1200);
  }

  function findMonthHeadingRect() {
    // Tenta encontrar o elemento que exibe o mês/ano no cabeçalho do calendário
    var els = document.querySelectorAll(
      '[role="heading"], [class*="calendarHeader"] *, [class*="calendar-header"] *, ' +
      '[class*="CalendarHeader"] *, [class*="toolbar"] *, [class*="Toolbar"] *'
    );
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length > 4) continue;
      var text = (el.textContent || '').replace(/[◄►←→‹›<>]/g, '').trim();
      var m = text.match(/([A-Za-z\u00C0-\u017F]+)\s+(?:de\s+)?(20\d{2})/i);
      if (!m) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return null;
  }

  function setLoadingIndicator(visible) {
    var el = document.getElementById('na-overlay-loading');
    if (!el) return;
    if (visible) {
      var rect = findMonthHeadingRect();
      if (rect) {
        el.style.top   = (rect.top + (rect.height - 22) / 2) + 'px';
        el.style.left  = (rect.right + 8) + 'px';
        el.style.right = 'auto';
      } else {
        el.style.top   = '12px';
        el.style.left  = 'auto';
        el.style.right = '16px';
      }
      el.classList.add('visible');
    } else {
      el.classList.remove('visible');
    }
  }

  function scheduleRender(forceDataReload) {
    if (state.disabled) return;
    // Mostra o indicador logo ao agendar, não só quando render() começa
    setLoadingIndicator(true);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(function() {
      state.debounceTimer = 0;
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.rafId = requestAnimationFrame(function() {
        state.rafId = 0;
        render(forceDataReload).catch(function(err) {
          setLoadingIndicator(false);
          if (isContextInvalidError(err)) {
            disableOverlay('Contexto da extensao invalidado durante render. Recarregue a pagina do Notion.');
            return;
          }
          console.warn('[Notion Automator] Falha no overlay do calendario:', err);
        });
      });
    }, 280);
  }

  async function loadRules() {
    const result = await storageGet([STORAGE_KEY_RULES]);
    const raw = result[STORAGE_KEY_RULES];

    if (!Array.isArray(raw)) {
      state.rules = [];
      console.log('[Notion Automator] Nenhuma regra de overlay configurada ainda');
      return;
    }

    state.rules = raw
      .map(function(rule) {
        return Object.assign({}, DEFAULT_RULE, rule || {});
      })
      .filter(function(rule) {
        return rule.enabled && normalizeDbId(rule.sourceDatabaseId);
      });
    console.log('[Notion Automator] Regras ativas:', state.rules.length);
  }

  async function render(forceDataReload) {
    if (state.disabled) return;
    if (state.loading) {
      // já há um render em andamento; quando terminar ele apagará o indicador
      return;
    }

    // Força re-detecção do mês/ano e colunas a cada render (TTL=0),
    // mas mantém o valor antigo como fallback se a detecção falhar.
    _calYMTime = 0;
    _weekdayColsCacheTime = 0;
    _allCalYMTime = 0;

    const dayNodes = findDayNodes();
    clearOverlay(dayNodes);

    if (!dayNodes.length) {
      console.log('[Notion Automator] Nenhum dia de calendário encontrado na página');
      return;
    }
    if (!state.rules.length) {
      console.log('[Notion Automator] Nenhuma regra de overlay ativa');
      return;
    }

    state.loading = true;
    setLoadingIndicator(true);
    try {
      const currentDbId = getCurrentDatabaseId();
      const allEntriesByDate = new Map();
      const allEntriesByWeekday = new Map();

      for (const rule of state.rules) {
        if (!ruleAppliesToCurrentPage(rule, currentDbId)) {
          console.log('[Notion Automator] Regra ignorada nesta pagina (targetDb nao bate):', rule.name || rule.id);
          continue;
        }

        const entries = await getRuleEntries(rule, forceDataReload);
        console.log('[Notion Automator] Regra', rule.name || rule.id, 'retornou', entries.length, 'entrada(s)');
        mergeEntries({ byDate: allEntriesByDate, byWeekday: allEntriesByWeekday }, entries);
      }

      const summary = decorateDays(dayNodes, allEntriesByDate, allEntriesByWeekday);
      console.log('[Notion Automator] Overlay resumo:', {
        diasDetectados: dayNodes.length,
        datasComEntradas: allEntriesByDate.size,
        diasDaSemanaComEntradas: allEntriesByWeekday.size,
        diasDecorados: summary.decorated,
        diasSemData: summary.noDate,
        diasDecoradosFallbackDia: summary.decoratedByDayFallback,
      });
    } finally {
      state.loading = false;
      setLoadingIndicator(false);
    }
  }

  function ruleAppliesToCurrentPage(rule, currentDbId) {
    const targetDbId = normalizeDbId(rule.targetDatabaseId);
    if (!targetDbId) return true;
    if (!currentDbId) return false;
    return targetDbId === currentDbId;
  }

  async function getRuleEntries(rule, forceDataReload) {
    const cacheKey = JSON.stringify({
      sourceDatabaseId: normalizeDbId(rule.sourceDatabaseId),
      sourceDateProperty: rule.sourceDateProperty,
      sourceLabelProperty: rule.sourceLabelProperty,
      sourceColorProperty: rule.sourceColorProperty,
      filter: rule.filter || null,
    });

    const now = Date.now();
    const ttlMs = 60 * 1000;
    const cached = state.cacheByRule.get(cacheKey);
    if (!forceDataReload && cached && (now - cached.updatedAt) < ttlMs) {
      console.log('[Notion Automator] Cache overlay usado para regra', rule.name || rule.id, 'com', cached.entries.length, 'entrada(s)');
      return cached.entries;
    }

    const pages = await queryDatabasePages(rule.sourceDatabaseId, rule.filter || undefined);
    const entries = pages
      .map(function(page) { return pageToEntry(page, rule); })
      .filter(Boolean);

    state.cacheByRule.set(cacheKey, { updatedAt: now, entries: entries });
    return entries;
  }

  function pageToEntry(page, rule) {
    const props = (page && page.properties) || {};
    const dateRaw = props[rule.sourceDateProperty];
    const dateKey = propertyToDateKey(dateRaw);
    const weekdayKey = dateKey ? '' : propertyToWeekdayKey(dateRaw);
    if (!dateKey && !weekdayKey) return null;

    const labelRaw = props[rule.sourceLabelProperty];
    const title = propertyToText(labelRaw) || getPageTitle(props) || 'Objetivo';

    const colorRaw = rule.sourceColorProperty ? props[rule.sourceColorProperty] : null;
    // Cor da regra: propriedade Notion se configurada, senão cor fixa por regra (semente = id da regra)
    const ruleColor = colorFromSeed(rule.id || rule.name || 'default');
    const color = propertyToColor(colorRaw) || ruleColor;

    return { dateKey: dateKey, weekdayKey: weekdayKey, title: title, color: color, ruleColor: ruleColor };
  }

  function mergeEntries(targetMap, entries) {
    for (const entry of entries) {
      if (entry.dateKey) {
        if (!targetMap.byDate.has(entry.dateKey)) targetMap.byDate.set(entry.dateKey, []);
        targetMap.byDate.get(entry.dateKey).push(entry);
      }
      if (entry.weekdayKey) {
        if (!targetMap.byWeekday.has(entry.weekdayKey)) targetMap.byWeekday.set(entry.weekdayKey, []);
        targetMap.byWeekday.get(entry.weekdayKey).push(entry);
      }
    }
  }

  function decorateDays(dayNodes, entriesByDate, entriesByWeekday) {
    let decorated = 0;
    let noDate = 0;

    for (const node of dayNodes) {
      // Tenta obter a data completa (direto ou inferida via mês/ano do calendário)
      const fullDateKey = inferNodeFullDate(node);

      let dateEntries = [];
      let weekdayKey = '';

      if (fullDateKey) {
        // Entradas de data específica
        dateEntries = entriesByDate.get(fullDateKey) || [];
        // Dia da semana calculado a partir da data
        weekdayKey = nodeToWeekdayKey(node, fullDateKey);
      } else {
        noDate += 1;
        // Sem data: tenta inferir dia da semana pela coluna
        weekdayKey = nodeToWeekdayKeyFromColumn(node);
      }

      const weekdayEntries = weekdayKey ? (entriesByWeekday.get(weekdayKey) || []) : [];

      // Combina os dois, sem duplicatas (data específica tem prioridade)
      const seen = new Set();
      const entries = [];
      for (var ei = 0; ei < dateEntries.length + weekdayEntries.length; ei++) {
        var e = ei < dateEntries.length ? dateEntries[ei] : weekdayEntries[ei - dateEntries.length];
        var dedupeKey = e.title + '\x00' + e.color;
        if (!seen.has(dedupeKey)) { seen.add(dedupeKey); entries.push(e); }
      }

      if (!entries.length) continue;

      const badge = document.createElement('span');
      badge.className = BADGE_CLASS;
      badge.style.background = entries[0].color;

      const tooltip = document.createElement('div');
      tooltip.className = TOOLTIP_CLASS;
      for (var ti = 0; ti < entries.length; ti++) {
        var entry = entries[ti];
        var item = document.createElement('div');
        item.className = TOOLTIP_CLASS + '-item';
        item.style.background = 'rgba(255,255,255,0.06)';
        var dot = document.createElement('span');
        dot.className = TOOLTIP_CLASS + '-dot';
        dot.style.background = entry.color;
        var label = document.createElement('span');
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        label.textContent = entry.title;
        item.appendChild(dot);
        item.appendChild(label);
        tooltip.appendChild(item);
      }

      node.setAttribute(DECORATED_ATTR, '1');
      node.setAttribute('data-na-cal-overlay-cell', '1');
      node.appendChild(badge);
      node.appendChild(tooltip);
      decorated += 1;
    }

    return {
      decorated: decorated,
      noDate: noDate,
    };
  }

  function clearOverlay(dayNodes) {
    for (const node of dayNodes) {
      if (!node.hasAttribute(DECORATED_ATTR)) continue;
      node.removeAttribute(DECORATED_ATTR);
      node.removeAttribute('data-na-cal-overlay-cell');
      node.querySelectorAll('.' + BADGE_CLASS).forEach(function(el) { el.remove(); });
      node.querySelectorAll('.' + TOOLTIP_CLASS).forEach(function(el) { el.remove(); });
    }
  }

  function findDayNodes() {
    const seen = new Set();
    const nodes = [];
    for (const selector of DAY_SELECTORS) {
      document.querySelectorAll(selector).forEach(function(node) {
        if (!(node instanceof HTMLElement)) return;
        if (seen.has(node)) return;
        if (!nodeLikelyCalendarCell(node)) return;
        seen.add(node);
        nodes.push(node);
      });
    }
    if (nodes.length > 0) {
      console.log('[Notion Automator] Dias do calendário encontrados:', nodes.length);
    }
    return nodes;
  }

  function nodeLikelyCalendarCell(node) {
    if (node.getAttribute('data-date')) return true;
    const label = node.getAttribute('aria-label') || '';
    if (/\d{4}-\d{2}-\d{2}/.test(label)) return true;
    if (/\b(calendar|calendario|week|month|semana|mes)\b/i.test(node.className || '')) return true;

    const txt = (node.textContent || '').trim();
    if (/^\d{1,2}$/.test(txt)) {
      const parentClass = (node.parentElement && node.parentElement.className) || '';
      return /calendar|calendario|notion/i.test(parentClass);
    }
    return false;
  }

  function nodeToDateKey(node) {
    const attrDate = node.getAttribute('data-date');
    if (attrDate) {
      const m = attrDate.match(/\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
    }

    const label = node.getAttribute('aria-label') || '';
    const m = label.match(/\d{4}-\d{2}-\d{2}/);
    if (m) return m[0];

    const localized = parseLocalizedDateLabel(label);
    if (localized) return localized;

    const deepText = collectNodeDateText(node);
    const iso = findIsoDate(deepText);
    if (iso) return iso;

    const localizedDeep = parseLocalizedDateLabel(deepText);
    if (localizedDeep) return localizedDeep;

    return null;
  }

  function collectNodeDateText(node) {
    const parts = [];

    function pushIf(v) {
      if (!v) return;
      const s = String(v).trim();
      if (s) parts.push(s);
    }

    pushIf(node.getAttribute('aria-label'));
    pushIf(node.getAttribute('title'));
    pushIf(node.getAttribute('data-date'));
    pushIf(node.getAttribute('datetime'));
    pushIf(node.getAttribute('data-testid'));
    pushIf(node.textContent);

    const descendants = node.querySelectorAll('[aria-label],[title],[data-date],[datetime],[data-testid]');
    for (let i = 0; i < descendants.length && i < 25; i += 1) {
      const el = descendants[i];
      pushIf(el.getAttribute('aria-label'));
      pushIf(el.getAttribute('title'));
      pushIf(el.getAttribute('data-date'));
      pushIf(el.getAttribute('datetime'));
      pushIf(el.getAttribute('data-testid'));
    }

    return parts.join(' | ');
  }

  function findIsoDate(text) {
    if (!text) return null;
    const m = String(text).match(/\b(\d{4}-\d{2}-\d{2})\b/);
    return m ? m[1] : null;
  }

  function nodeToDayOfMonthKey(node) {
    // Percorre apenas os filhos diretos simples para achar o número do dia,
    // evitando pegar números de nomes de tarefas dentro da célula.
    for (var i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      var txt = '';
      if (child.nodeType === 3) {
        txt = (child.textContent || '').trim();
      } else if (child.nodeType === 1 && child.children.length <= 2) {
        txt = (child.textContent || '').trim();
      }
      if (!txt) continue;
      // Aceita apenas string que começa com 1 ou 2 dígitos (o número do dia)
      var m = txt.match(/^(\d{1,2})(?:\D|$)/);
      if (m) {
        var day = Number(m[1]);
        if (day >= 1 && day <= 31) return String(day).padStart(2, '0');
      }
    }
    // Fallback: primeiros 3 caracteres do textContent
    var raw = (node.textContent || '').trim().slice(0, 3);
    var fm = raw.match(/^(\d{1,2})/);
    if (fm) {
      var d = Number(fm[1]);
      if (d >= 1 && d <= 31) return String(d).padStart(2, '0');
    }
    return '';
  }

  function nodeToWeekdayKey(node, dateKey) {
    const iso = dateKey || nodeToDateKey(node);
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';

    const date = new Date(iso + 'T12:00:00');
    if (Number.isNaN(date.getTime())) return '';

    return weekdayIndexToKey(date.getDay());
  }

  function weekdayIndexToKey(index) {
    const keys = ['DOMINGO', 'SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO'];
    return keys[index] || '';
  }

  // ── CALENDAR MONTH DETECTION ─────────────────────────────────
  const MONTH_NORM_MAP = {
    JANEIRO: '01', FEVEREIRO: '02', MARCO: '03', ABRIL: '04', MAIO: '05',
    JUNHO: '06', JULHO: '07', AGOSTO: '08', SETEMBRO: '09', OUTUBRO: '10',
    NOVEMBRO: '11', DEZEMBRO: '12',
    JANUARY: '01', FEBRUARY: '02', MARCH: '03', APRIL: '04', MAY: '05',
    JUNE: '06', JULY: '07', AUGUST: '08', SEPTEMBER: '09', OCTOBER: '10',
    NOVEMBER: '11', DECEMBER: '12',
  };

  let _calYM = null;
  let _calYMTime = 0;
  let _allCalYM = [];
  let _allCalYMTime = 0;

  function detectCalendarYearMonth() {
    const now = Date.now();
    if (_calYM && (now - _calYMTime) < 15000) return _calYM;
    _calYM = null;
    _calYMTime = now;

    const els = document.querySelectorAll(
      'button, [role="heading"], [class*="calendar"] *, [class*="header"] *, [class*="nav"] *'
    );
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.children.length > 4) continue;
      var text = (el.textContent || '').replace(/[◄►←→‹›<>]/g, '').trim();
      // match "maio de 2026", "May 2026", "maio 2026" — preserva os dígitos do ano
      var m = text.match(/([A-Za-z\u00C0-\u017F]+)\s+(?:de\s+)?(20\d{2})/i);
      if (!m) continue;
      var monthNorm = String(m[1])
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z]/g, '');
      var month = MONTH_NORM_MAP[monthNorm];
      if (month) {
        _calYM = { year: m[2], month: month };
        console.log('[Notion Automator] Mês/ano do calendário detectado:', _calYM.year + '-' + _calYM.month);
        return _calYM;
      }
    }

    return _calYM;
  }

  function inferNodeFullDate(node) {
    var direct = nodeToDateKey(node);
    if (direct) return direct;
    var dayNum = nodeToDayOfMonthKey(node);
    if (!dayNum) return null;
    var ym = detectCalendarYearMonth();
    if (!ym) return null;
    return ym.year + '-' + ym.month + '-' + dayNum;
  }

  // ── WEEKDAY COLUMN DETECTION (para células sem data) ────────
  const WEEKDAY_ABBREV_MAP = {
    'DOMINGO': 'DOMINGO', 'DOM': 'DOMINGO', 'SUN': 'DOMINGO', 'SUNDAY': 'DOMINGO',
    'SEGUNDA': 'SEGUNDA', 'SEGUNDAFEIRA': 'SEGUNDA', 'SEG': 'SEGUNDA', 'MON': 'SEGUNDA', 'MONDAY': 'SEGUNDA',
    'TERCA': 'TERCA', 'TERCAFEIRA': 'TERCA', 'TER': 'TERCA', 'TUE': 'TERCA', 'TUESDAY': 'TERCA',
    'QUARTA': 'QUARTA', 'QUARTAFEIRA': 'QUARTA', 'QUA': 'QUARTA', 'WED': 'QUARTA', 'WEDNESDAY': 'QUARTA',
    'QUINTA': 'QUINTA', 'QUINTAFEIRA': 'QUINTA', 'QUI': 'QUINTA', 'THU': 'QUINTA', 'THURSDAY': 'QUINTA',
    'SEXTA': 'SEXTA', 'SEXTAFEIRA': 'SEXTA', 'SEX': 'SEXTA', 'FRI': 'SEXTA', 'FRIDAY': 'SEXTA',
    'SABADO': 'SABADO', 'SAB': 'SABADO', 'SAT': 'SABADO', 'SATURDAY': 'SABADO',
  };

  let _weekdayColsCache = null;
  let _weekdayColsCacheTime = 0;

  function getWeekdayColumns() {
    const now = Date.now();
    if (_weekdayColsCache && (now - _weekdayColsCacheTime) < 5000) return _weekdayColsCache;

    const candidates = [];
    const seen = new Set();

    document.querySelectorAll('div, span, th, td').forEach(function(el) {
      if (seen.has(el)) return;
      if (el.children.length > 2) return;
      const raw = normalizeWeekdayText((el.textContent || '').trim());
      if (!raw || raw.length > 14) return;
      const key = WEEKDAY_ABBREV_MAP[raw];
      if (!key) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || rect.top < 0 || rect.top > window.innerHeight) return;
      seen.add(el);
      candidates.push({ weekdayKey: key, rect: rect, top: Math.round(rect.top) });
    });

    if (candidates.length < 7) { _weekdayColsCache = null; return null; }

    // Agrupar por linha (top similar) e encontrar grupo com 7 dias únicos
    candidates.sort(function(a, b) { return a.top - b.top || a.rect.left - b.rect.left; });

    for (let i = 0; i <= candidates.length - 7; i++) {
      const group = candidates.slice(i, i + 7);
      const topDiff = group[group.length - 1].top - group[0].top;
      if (topDiff > 24) continue;
      const keys = new Set(group.map(function(g) { return g.weekdayKey; }));
      if (keys.size >= 6) {
        group.sort(function(a, b) { return a.rect.left - b.rect.left; });
        _weekdayColsCache = group;
        _weekdayColsCacheTime = now;
        console.log('[Notion Automator] Colunas de dias da semana detectadas:', group.map(function(g) { return g.weekdayKey; }));
        return group;
      }
    }

    _weekdayColsCache = null;
    return null;
  }

  function nodeToWeekdayKeyFromColumn(node) {
    const columns = getWeekdayColumns();
    if (!columns) return '';
    const rect = node.getBoundingClientRect();
    if (!rect.width) return '';
    const cx = rect.left + rect.width / 2;
    for (const col of columns) {
      if (cx >= col.rect.left - 8 && cx <= col.rect.right + 8) return col.weekdayKey;
    }
    return '';
  }

  function normalizeWeekdayText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
  }

  function propertyToWeekdayKey(prop) {
    const text = propertyToText(prop);
    const normalized = normalizeWeekdayText(text);
    if (!normalized) return '';

    const weekdayMap = ['DOMINGO', 'SEGUNDA', 'TERCA', 'QUARTA', 'QUINTA', 'SEXTA', 'SABADO'];
    for (const weekday of weekdayMap) {
      const base = normalizeWeekdayText(weekday);
      if (normalized === base || normalized.startsWith(base) || normalized.includes(base)) {
        return weekday;
      }
    }

    return '';
  }

  function buildEntriesByDay(entriesByDate) {
    const map = new Map();
    entriesByDate.forEach(function(entries, dateKey) {
      const day = String(dateKey || '').slice(8, 10);
      if (!day) return;
      if (!map.has(day)) map.set(day, []);
      map.get(day).push.apply(map.get(day), entries);
    });
    return map;
  }

  function parseLocalizedDateLabel(label) {
    if (!label) return null;

    const txt = String(label).toLowerCase();
    const monthMap = {
      janeiro: 1,
      fevereiro: 2,
      marco: 3,
      março: 3,
      abril: 4,
      maio: 5,
      junho: 6,
      julho: 7,
      agosto: 8,
      setembro: 9,
      outubro: 10,
      novembro: 11,
      dezembro: 12,
      january: 1,
      february: 2,
      march: 3,
      april: 4,
      may: 5,
      june: 6,
      july: 7,
      august: 8,
      september: 9,
      october: 10,
      november: 11,
      december: 12,
    };

    const regex = /(\d{1,2})\s+de\s+([a-zçãé]+)\s+de\s+(\d{4})/i;
    const pt = txt.match(regex);
    if (pt) {
      const day = Number(pt[1]);
      const month = monthMap[pt[2]];
      const year = Number(pt[3]);
      if (month && day >= 1 && day <= 31) {
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }
    }

    const en = txt.match(/([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
    if (en) {
      const month = monthMap[en[1]];
      const day = Number(en[2]);
      const year = Number(en[3]);
      if (month && day >= 1 && day <= 31) {
        return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
      }
    }

    return null;
  }

  function propertyToDateKey(prop) {
    if (!prop || typeof prop !== 'object') return null;

    if (prop.type === 'date' && prop.date && prop.date.start) {
      return prop.date.start.slice(0, 10);
    }

    if (prop.type === 'formula' && prop.formula && prop.formula.type === 'date') {
      const date = prop.formula.date;
      if (date && date.start) return date.start.slice(0, 10);
    }

    if (prop.type === 'rollup' && prop.rollup && prop.rollup.type === 'date') {
      const date = prop.rollup.date;
      if (date && date.start) return date.start.slice(0, 10);
    }

    return null;
  }

  function propertyToText(prop) {
    if (!prop || typeof prop !== 'object') return '';

    if (prop.type === 'title' && Array.isArray(prop.title)) {
      return prop.title.map(function(t) { return t.plain_text || ''; }).join('').trim();
    }
    if (prop.type === 'rich_text' && Array.isArray(prop.rich_text)) {
      return prop.rich_text.map(function(t) { return t.plain_text || ''; }).join('').trim();
    }
    if (prop.type === 'select' && prop.select) {
      return prop.select.name || '';
    }
    if (prop.type === 'status' && prop.status) {
      return prop.status.name || '';
    }
    if (prop.type === 'formula' && prop.formula) {
      if (prop.formula.type === 'string') return prop.formula.string || '';
      if (prop.formula.type === 'number') return String(prop.formula.number || '');
    }

    return '';
  }

  function propertyToColor(prop) {
    if (!prop || typeof prop !== 'object') return '';

    let notionColor = '';
    if (prop.type === 'select' && prop.select) notionColor = prop.select.color || '';
    if (prop.type === 'status' && prop.status) notionColor = prop.status.color || '';

    return notionColorToHex(notionColor);
  }

  function notionColorToHex(color) {
    const map = {
      default: '#6b7280',
      gray: '#6b7280',
      brown: '#7c4a2d',
      orange: '#c05621',
      yellow: '#b7791f',
      green: '#0b6e4f',
      blue: '#1f6feb',
      purple: '#6f42c1',
      pink: '#b83280',
      red: '#c53030',
    };
    return map[color] || '';
  }

  function colorFromSeed(seed) {
    const txt = String(seed || 'evento');
    let hash = 0;
    for (let i = 0; i < txt.length; i += 1) {
      hash = ((hash << 5) - hash) + txt.charCodeAt(i);
      hash |= 0;
    }
    const hue = Math.abs(hash) % 360;
    return 'hsl(' + hue + ' 72% 46%)';
  }

  function getPageTitle(props) {
    for (const key of Object.keys(props)) {
      const prop = props[key];
      if (prop && prop.type === 'title') return propertyToText(prop);
    }
    return '';
  }

  async function queryDatabasePages(databaseId, filter) {
    const dbId = normalizeDbId(databaseId);
    if (!dbId) return [];

    const pages = [];
    let cursor = null;

    do {
      const body = { page_size: 100 };
      if (filter) body.filter = filter;
      if (cursor) body.start_cursor = cursor;

      const res = await notionRequest('/databases/' + dbId + '/query', 'POST', body);
      pages.push.apply(pages, res.results || []);
      cursor = res.has_more ? res.next_cursor : null;
    } while (cursor);

    return pages;
  }

  async function notionRequest(path, method, body) {
    return new Promise(function(resolve, reject) {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'na-notion-request',
            path: path,
            method: method || 'GET',
            body: body || null,
          },
          function(response) {
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
      } catch (err) {
        reject(err);
      }
    });
  }

  function getCurrentDatabaseId() {
    const match = location.pathname.match(/([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/);
    return match ? normalizeDbId(match[1]) : '';
  }

  function normalizeDbId(value) {
    return String(value || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  }

  function storageGet(keys) {
    return new Promise(function(resolve, reject) {
      try {
        chrome.storage.local.get(keys, resolve);
      } catch (err) {
        reject(err);
      }
    });
  }

  function isContextInvalidError(err) {
    const msg = String((err && err.message) || err || '').toLowerCase();
    return msg.indexOf('extension context invalidated') >= 0;
  }

  function disableOverlay(reason) {
    if (state.disabled) return;
    state.disabled = true;

    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    }

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    if (state.urlWatcherTimer) {
      clearInterval(state.urlWatcherTimer);
      state.urlWatcherTimer = 0;
    }

    if (state.storageListener) {
      try {
        chrome.storage.onChanged.removeListener(state.storageListener);
      } catch (_) {
        // Ignora: contexto ja invalidado.
      }
      state.storageListener = null;
    }

    const safeReason = reason || 'Contexto da extensao invalidado.';
    console.warn('[Notion Automator] Overlay desativado:', safeReason);

    if (/invalidado|invalidated/i.test(safeReason)) {
      tryAutoRecoverContext();
    }
  }

  function tryAutoRecoverContext() {
    const key = 'na_overlay_context_recovered_once';
    const last = Number(sessionStorage.getItem(key) || '0');
    const now = Date.now();

    // Evita loop de reload: no maximo 1 tentativa por 10s nesta aba.
    if (last && (now - last) < 10000) return;

    sessionStorage.setItem(key, String(now));
    console.warn('[Notion Automator] Tentando recuperar contexto da extensao com reload da pagina...');
    setTimeout(function() {
      location.reload();
    }, 250);
  }
})();
