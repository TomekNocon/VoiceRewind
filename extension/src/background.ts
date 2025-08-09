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