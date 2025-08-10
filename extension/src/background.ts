chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && tab.url.includes('youtube.com/watch')) {
      await chrome.storage.local.set({ activeYouTubeTabId: tabId });
      if (tabId) chrome.tabs.sendMessage(tabId, { type: 'active-tab' }).catch(() => {});
    }
  } catch {}
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    if (changeInfo.status === 'complete' && tab.url && tab.url.includes('youtube.com/watch')) {
      await chrome.storage.local.set({ activeYouTubeTabId: tabId });
      chrome.tabs.sendMessage(tabId, { type: 'active-tab' }).catch(() => {});
    }
  } catch {}
});

// Periodic heartbeat to help content scripts show connection status
setInterval(async () => {
  try {
    const { activeYouTubeTabId } = await chrome.storage.local.get('activeYouTubeTabId');
    if (activeYouTubeTabId) {
      chrome.tabs.sendMessage(activeYouTubeTabId, { type: 'heartbeat' }).catch(() => {});
    }
  } catch {}
}, 5000);

// Proxy transcript fetch to avoid CORS in content scripts
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'fetchTranscript' && typeof msg.videoId === 'string') {
    const url = `http://127.0.0.1:17321/transcript?videoId=${encodeURIComponent(msg.videoId)}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        sendResponse({ ok: true, data });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true; // keep channel open
  }
}); 