document.addEventListener('DOMContentLoaded', () => {
    const zenRadio = document.querySelector('input[value="zen"]');
    const embedRadio = document.querySelector('input[value="embed"]');
    const embedSettings = document.getElementById('embed-settings');
    const proxyInput = document.getElementById('proxy-url');
    const status = document.getElementById('save-status');

    // Load saved settings
    chrome.storage.local.get(['strategy', 'proxyUrl'], (result) => {
        if (result.strategy === 'embed') {
            embedRadio.checked = true;
            embedSettings.classList.add('visible');
        } else {
            zenRadio.checked = true;
            embedSettings.classList.remove('visible');
        }

        if (result.proxyUrl) {
            proxyInput.value = result.proxyUrl;
        }
    });

    // Handle Radio Change
    function handleRadioChange() {
        if (embedRadio.checked) {
            embedSettings.classList.add('visible');
            saveSettings('embed', proxyInput.value);
        } else {
            embedSettings.classList.remove('visible');
            saveSettings('zen', proxyInput.value);
        }
    }

    zenRadio.addEventListener('change', handleRadioChange);
    embedRadio.addEventListener('change', handleRadioChange);

    // Handle Input Change
    proxyInput.addEventListener('input', () => {
        // Debounce simple
        saveSettings(embedRadio.checked ? 'embed' : 'zen', proxyInput.value);
    });

    function saveSettings(strategy, proxyUrl) {
        chrome.storage.local.set({
            strategy: strategy,
            proxyUrl: proxyUrl
        }, () => {
            status.textContent = "Saved!";
            setTimeout(() => { status.textContent = ""; }, 1000);
        });
    }
});
