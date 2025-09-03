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

// Proxy transcript and semantic fetch to avoid CORS in content scripts
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
  if (msg?.type === 'semanticSearch' && typeof msg.videoId === 'string' && typeof msg.q === 'string') {
    const url = `http://127.0.0.1:17321/semantic_search?videoId=${encodeURIComponent(msg.videoId)}&q=${encodeURIComponent(msg.q)}`;
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        sendResponse({ ok: true, data });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'agentQuery' && typeof msg.q === 'string') {
    const url = `http://127.0.0.1:17321/agent/query`;
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: msg.q, videoId: msg.videoId, currentTime: msg.currentTime, sessionId: msg.sessionId }) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        sendResponse({ ok: true, data });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type === 'fetchAudioDataUrl' && typeof msg.url === 'string') {
    fetch(msg.url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          sendResponse({ ok: true, dataUrl });
        };
        reader.onerror = (e) => sendResponse({ ok: false, error: String(e) });
        reader.readAsDataURL(blob);
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
}); 