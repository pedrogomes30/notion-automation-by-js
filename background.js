'use strict';

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

