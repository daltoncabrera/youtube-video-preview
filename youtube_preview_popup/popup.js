document.addEventListener('DOMContentLoaded', () => {
    const pipRadio = document.querySelector('input[value="pip"]');
    const zenRadio = document.querySelector('input[value="zen"]');
    const embedRadio = document.querySelector('input[value="embed"]');
    const embedSettings = document.getElementById('embed-settings');
    const proxyInput = document.getElementById('proxy-url');
    const sizeSelect = document.getElementById('def-size');
    const posSelect = document.getElementById('def-pos');
    const btnPosSelect = document.getElementById('btn-pos');
    const autoSkipCheckbox = document.getElementById('auto-skip');
    const repeatCheckbox = document.getElementById('repeat-mode');
    const shuffleCheckbox = document.getElementById('shuffle-mode');
    const status = document.getElementById('save-status');
    const openPreviewBtn = document.getElementById('open-preview-btn');

    // Handle Open Preview button click
    openPreviewBtn.addEventListener('click', async () => {
        // Get queue and lists from storage
        const data = await chrome.storage.local.get(['ytPreviewQueue', 'ytPreviewLists', 'ytPreviewActiveSource', 'ytPreviewCurrentIndex']);

        let videoId = null;
        let source = null;
        let index = 0;

        const queue = data.ytPreviewQueue || [];
        const lists = data.ytPreviewLists || {};
        const listIds = Object.keys(lists);

        const savedSource = data.ytPreviewActiveSource;
        const savedIndex = Number.isInteger(data.ytPreviewCurrentIndex) ? data.ytPreviewCurrentIndex : 0;

        // Resume the active source first; fall back to queue, then newest non-empty list.
        if (savedSource === 'queue' && queue.length > 0) {
            index = Math.min(Math.max(savedIndex, 0), queue.length - 1);
            videoId = queue[index];
            source = 'queue';
        } else if (savedSource?.startsWith('list:') && lists[savedSource.slice(5)]?.items?.length) {
            const activeList = lists[savedSource.slice(5)];
            index = Math.min(Math.max(savedIndex, 0), activeList.items.length - 1);
            videoId = activeList.items[index];
            source = savedSource;
        } else if (queue.length > 0) {
            videoId = queue[0];
            source = 'queue';
            index = 0;
        } else if (listIds.length > 0) {
            // Get the last list (most recently created)
            const lastListId = listIds[listIds.length - 1];
            const lastList = lists[lastListId];
            if (lastList && lastList.items && lastList.items.length > 0) {
                videoId = lastList.items[0];
                source = `list:${lastListId}`;
                index = 0;
            }
        }

        if (!videoId) {
            status.textContent = "No videos in queue or lists";
            status.style.color = '#ff6b6b';
            setTimeout(() => {
                status.textContent = "";
                status.style.color = '#4CAF50';
            }, 2000);
            return;
        }

        // First check if current active tab is YouTube
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const isActiveYouTube = activeTab?.url?.includes('youtube.com');

        if (isActiveYouTube) {
            // Use current YouTube tab
            await chrome.tabs.sendMessage(activeTab.id, {
                action: 'openPreview',
                videoId: videoId,
                source: source,
                index: index
            });
        } else {
            // Check for any other YouTube tab
            const ytTabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });

            if (ytTabs.length === 0) {
                // No YouTube tab open - open YouTube with params to trigger PiP
                chrome.tabs.create({
                    url: `https://www.youtube.com/?ytPreviewAutoOpen=${videoId}&source=${encodeURIComponent(source)}&index=${index}`
                });
            } else {
                // Send message to first YouTube tab and focus it
                await chrome.tabs.sendMessage(ytTabs[0].id, {
                    action: 'openPreview',
                    videoId: videoId,
                    source: source,
                    index: index
                });
                chrome.tabs.update(ytTabs[0].id, { active: true });
            }
        }

        window.close();
    });

    // Load saved settings
    chrome.storage.local.get(['strategy', 'proxyUrl', 'defSize', 'defPos', 'btnPos', 'autoSkip', 'repeatMode', 'shuffleMode'], (result) => {
        // Default to 'pip' if not set
        const strategy = result.strategy || 'pip';

        if (strategy === 'pip') {
            pipRadio.checked = true;
            embedSettings.classList.add('visible'); // PiP also uses size settings
        } else if (strategy === 'embed') {
            embedRadio.checked = true;
            embedSettings.classList.add('visible');
        } else {
            zenRadio.checked = true;
            embedSettings.classList.remove('visible');
        }

        if (result.proxyUrl) proxyInput.value = result.proxyUrl;
        if (result.defSize) sizeSelect.value = result.defSize;
        if (result.defPos) posSelect.value = result.defPos;
        if (result.btnPos) btnPosSelect.value = result.btnPos;
        else btnPosSelect.value = 'top-left'; // Default

        // Default AutoSkip to TRUE if undefined
        autoSkipCheckbox.checked = (result.autoSkip !== false);
        repeatCheckbox.checked = (result.repeatMode === true);
        shuffleCheckbox.checked = (result.shuffleMode === true);
    });

    // Handle Radio Change
    function handleRadioChange() {
        if (embedRadio.checked || pipRadio.checked) {
            embedSettings.classList.add('visible');
        } else {
            embedSettings.classList.remove('visible');
        }
        triggerSave();
    }

    pipRadio.addEventListener('change', handleRadioChange);
    zenRadio.addEventListener('change', handleRadioChange);
    embedRadio.addEventListener('change', handleRadioChange);

    // Handle Input/Select Changes
    proxyInput.addEventListener('input', () => debounceSave());
    sizeSelect.addEventListener('change', triggerSave);
    posSelect.addEventListener('change', triggerSave);
    btnPosSelect.addEventListener('change', triggerSave);
    autoSkipCheckbox.addEventListener('change', triggerSave);
    repeatCheckbox.addEventListener('change', triggerSave);
    shuffleCheckbox.addEventListener('change', triggerSave);

    let timeout;
    function debounceSave() {
        clearTimeout(timeout);
        timeout = setTimeout(triggerSave, 500);
    }

    function triggerSave() {
        // Correct strategy logic based on radio
        let strategy = 'pip'; // Default
        if (embedRadio.checked) strategy = 'embed';
        else if (zenRadio.checked) strategy = 'zen';
        else if (pipRadio.checked) strategy = 'pip';
        saveSettings({
            strategy,
            proxyUrl: proxyInput.value,
            defSize: sizeSelect.value,
            defPos: posSelect.value,
            btnPos: btnPosSelect.value,
            autoSkip: autoSkipCheckbox.checked,
            repeatMode: repeatCheckbox.checked,
            shuffleMode: shuffleCheckbox.checked
        });
    }

    function saveSettings(settings) {
        chrome.storage.local.set(settings, () => {
            status.textContent = "Saved!";
            setTimeout(() => { status.textContent = ""; }, 1000);
        });
    }
});
