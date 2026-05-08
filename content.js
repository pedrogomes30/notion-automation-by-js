'use strict';

// ── Constantes ──────────────────────────────────────────────
const PANEL_WIDTH  = 380;   // px
const ANIM_MS      = 280;   // duração da animação de slide
const STORAGE_KEY  = 'na_panel_open';

let panelOpen      = false;
let animating      = false;

// ── Cria os elementos do painel (idempotente) ────────────────
function ensurePanel() {
  if (document.getElementById('na-panel-iframe')) return;

  // ── Backdrop: fecha ao clicar fora ──
  const backdrop = document.createElement('div');
  backdrop.id = 'na-panel-backdrop';
  Object.assign(backdrop.style, {
    position:       'fixed',
    inset:          '0',
    zIndex:         '2147483640',
    background:     'rgba(0,0,0,0)',
    pointerEvents:  'none',
    transition:     `background ${ANIM_MS}ms ease`,
  });
  backdrop.addEventListener('click', closePanel);

  // ── Iframe (panel.html é uma extension page com todos os privilégios) ──
  const iframe = document.createElement('iframe');
  iframe.id    = 'na-panel-iframe';
  iframe.src   = chrome.runtime.getURL('panel.html');
  iframe.title = 'Notion Automator';
  Object.assign(iframe.style, {
    position:   'fixed',
    top:        '0',
    right:      '0',
    height:     '100dvh',
    width:      `${PANEL_WIDTH}px`,
    border:     'none',
    zIndex:     '2147483645',
    transform:  'translateX(100%)',
    transition: `transform ${ANIM_MS}ms cubic-bezier(0.4,0,0.2,1)`,
    boxShadow:  '-6px 0 32px rgba(0,0,0,0.45)',
    background: '#191919',
  });

  // ── Botão de toggle (aba na borda esquerda) ──
  const toggle = document.createElement('button');
  toggle.id    = 'na-panel-toggle';
  toggle.setAttribute('aria-label', 'Notion Automator');
  toggle.innerHTML = '⚡';
  Object.assign(toggle.style, {
    position:      'fixed',
    right:         '0',
    top:           '50%',
    transform:     'translateY(-50%)',
    zIndex:        '2147483646',
    background:    '#2383e2',
    color:         '#fff',
    border:        'none',
    borderRadius:  '8px 0 0 8px',
    padding:       '14px 8px',
    cursor:        'pointer',
    fontSize:      '16px',
    lineHeight:    '1',
    boxShadow:     '-2px 0 10px rgba(0,0,0,0.35)',
    transition:    `right ${ANIM_MS}ms cubic-bezier(0.4,0,0.2,1), background 0.15s`,
    userSelect:    'none',
  });
  toggle.addEventListener('mouseenter', () => {
    if (!panelOpen) toggle.style.background = '#1b72cf';
  });
  toggle.addEventListener('mouseleave', () => {
    toggle.style.background = panelOpen ? '#e03e3e' : '#2383e2';
  });
  toggle.addEventListener('click', togglePanel);

  document.documentElement.appendChild(backdrop);
  document.documentElement.appendChild(iframe);
  document.documentElement.appendChild(toggle);
}

// ── Animações ────────────────────────────────────────────────
function openPanel() {
  if (panelOpen || animating) return;
  ensurePanel();
  animating = true;
  panelOpen = true;

  const iframe   = document.getElementById('na-panel-iframe');
  const toggle   = document.getElementById('na-panel-toggle');
  const backdrop = document.getElementById('na-panel-backdrop');

  iframe.style.transform        = 'translateX(0)';
  toggle.style.right            = `${PANEL_WIDTH}px`;
  toggle.style.background       = '#e03e3e';
  toggle.innerHTML              = '✕';
  backdrop.style.pointerEvents  = 'auto';
  backdrop.style.background     = 'rgba(0,0,0,0.35)';

  setTimeout(() => { animating = false; }, ANIM_MS);
}

function closePanel() {
  if (!panelOpen || animating) return;
  animating = true;
  panelOpen = false;

  const iframe   = document.getElementById('na-panel-iframe');
  const toggle   = document.getElementById('na-panel-toggle');
  const backdrop = document.getElementById('na-panel-backdrop');

  iframe.style.transform        = 'translateX(100%)';
  toggle.style.right            = '0';
  toggle.style.background       = '#2383e2';
  toggle.innerHTML              = '⚡';
  backdrop.style.pointerEvents  = 'none';
  backdrop.style.background     = 'rgba(0,0,0,0)';

  setTimeout(() => { animating = false; }, ANIM_MS);
}

function togglePanel() {
  panelOpen ? closePanel() : openPanel();
}

// ── Ouve o clique no ícone da extensão (via background.js) ───
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'na-toggle') togglePanel();
});

// ── Tecla Escape fecha o painel ──────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelOpen) closePanel();
}, true);

// ── Cria os elementos assim que o script carrega ─────────────
ensurePanel();

