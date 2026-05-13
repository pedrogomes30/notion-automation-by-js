'use strict';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VER = '2022-06-28';

async function getStoredApiKey() {
  const data = await chrome.storage.local.get(['apiKey']);
  return data.apiKey || '';
}

async function notionApiRequest(path, method, body, apiKeyOverride) {
  const apiKey = apiKeyOverride || await getStoredApiKey();
  if (!apiKey) throw new Error('API Key nao configurada.');

  const response = await fetch(NOTION_API + path, {
    method: method || 'GET',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Notion-Version': NOTION_VER,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(data.message || ('Erro HTTP ' + response.status));
  }

  return data;
}

// Clique no ícone da extensão → envia toggle para o content script
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('notion.so')) return;

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'na-toggle' });
  } catch {
    // Content script ainda não estava pronto — injeta e tenta novamente
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      // Aguarda o script registrar o listener antes de enviar
      setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'na-toggle' }).catch(() => {}), 400);
    } catch (e) {
      console.error('[NA] Erro ao injetar content.js:', e);
    }
  }
});

// Badge: mostra "!" quando falta configurar
async function updateBadge() {
  const { apiKey, config } = await chrome.storage.local.get(['apiKey', 'config']);
  const ok = apiKey && config && config.contentFormatProperty;
  chrome.action.setBadgeText({ text: ok ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#e03e3e' });
}

chrome.runtime.onInstalled.addListener(updateBadge);
chrome.storage.onChanged.addListener(updateBadge);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'na-notion-request') return;

  notionApiRequest(msg.path, msg.method, msg.body, msg.apiKey)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message || 'Erro desconhecido' }));

  return true;
});

