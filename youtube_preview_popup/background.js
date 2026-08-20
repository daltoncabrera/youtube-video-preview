chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'focusYouTubeWindow' && sender.tab?.windowId != null) {
        chrome.windows.update(sender.tab.windowId, { focused: true }).catch((error) => {
            console.warn('[YouTube Preview] Could not focus the YouTube window:', error);
        });
        return;
    }

    if (sender.tab?.id == null) return;
    const restoreKey = `ytPreviewRestore:${sender.tab.id}`;

    if (message?.action === 'rememberPiPRestore') {
        chrome.storage.session.set({ [restoreKey]: message.state }).catch((error) => {
            console.warn('[YouTube Preview] Could not remember PiP state:', error);
        });
        return;
    }

    if (message?.action === 'takePiPRestore') {
        chrome.storage.session.get(restoreKey).then(async (result) => {
            await chrome.storage.session.remove(restoreKey);
            sendResponse({ state: result[restoreKey] || null });
        }).catch((error) => {
            console.warn('[YouTube Preview] Could not read PiP state:', error);
            sendResponse({ state: null });
        });
        return true;
    }
});
