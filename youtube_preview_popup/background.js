chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.action !== 'focusYouTubeWindow' || sender.tab?.windowId == null) return;

    chrome.windows.update(sender.tab.windowId, { focused: true }).catch((error) => {
        console.warn('[YouTube Preview] Could not focus the YouTube window:', error);
    });
});
