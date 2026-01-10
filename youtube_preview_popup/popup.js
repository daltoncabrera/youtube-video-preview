document.addEventListener('DOMContentLoaded', () => {
    const zenRadio = document.querySelector('input[value="zen"]');
    const embedRadio = document.querySelector('input[value="embed"]');
    const embedSettings = document.getElementById('embed-settings');
    const proxyInput = document.getElementById('proxy-url');
    const sizeSelect = document.getElementById('def-size');
    const posSelect = document.getElementById('def-pos');
    const btnPosSelect = document.getElementById('btn-pos');
    const autoSkipCheckbox = document.getElementById('auto-skip');
    const status = document.getElementById('save-status');

    // Load saved settings
    chrome.storage.local.get(['strategy', 'proxyUrl', 'defSize', 'defPos', 'btnPos', 'autoSkip'], (result) => {
        // Default to 'embed' if not set
        const strategy = result.strategy || 'embed';

        if (strategy === 'embed') {
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
    });

    // Handle Radio Change
    function handleRadioChange() {
        if (embedRadio.checked) {
            embedSettings.classList.add('visible');
        } else {
            embedSettings.classList.remove('visible');
        }
        triggerSave();
    }

    zenRadio.addEventListener('change', handleRadioChange);
    embedRadio.addEventListener('change', handleRadioChange);

    // Handle Input/Select Changes
    proxyInput.addEventListener('input', () => debounceSave());
    sizeSelect.addEventListener('change', triggerSave);
    posSelect.addEventListener('change', triggerSave);
    btnPosSelect.addEventListener('change', triggerSave);
    autoSkipCheckbox.addEventListener('change', triggerSave);

    let timeout;
    function debounceSave() {
        clearTimeout(timeout);
        timeout = setTimeout(triggerSave, 500);
    }

    function triggerSave() {
        // Correct strategy logic based on radio
        const strategy = embedRadio.checked ? 'embed' : 'zen';
        saveSettings(strategy, proxyInput.value, sizeSelect.value, posSelect.value, btnPosSelect.value, autoSkipCheckbox.checked);
    }

    function saveSettings(strategy, proxyUrl, size, pos, btnPos, autoSkip) {
        chrome.storage.local.set({
            strategy: strategy,
            proxyUrl: proxyUrl,
            defSize: size,
            defPos: pos,
            btnPos: btnPos,
            autoSkip: autoSkip
        }, () => {
            status.textContent = "Saved!";
            setTimeout(() => { status.textContent = ""; }, 1000);
        });
    }
});
