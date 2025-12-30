// --- Zen Mode Logic (Popup Window) ---
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('preview_popup')) {
    console.log("YouTube Preview Popup - Entering Zen Mode");

    // Inject Styles to hide clutter and maximize player
    const style = document.createElement('style');
    style.textContent = `
        /* Hide everything except the player */
        ytd-masthead, #secondary, #below, #comments, #chat, #merch-shelf, ytd-watch-metadata, #related, #header, #masthead-container { display: none !important; }
        
        /* Reset layout constraints */
        #page-manager { margin: 0 !important; margin-top: 0 !important; }
        #columns { max-width: 100% !important; margin: 0 !important; }
        #primary { max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
        #player { max-width: 100% !important; margin: 0 !important; min-height: 100vh !important; }
        
        /* Force player to fill viewport */
        html, body { overflow: hidden !important; background: #000 !important; }
        .html5-video-player { width: 100vw !important; height: 100vh !important; z-index: 99999 !important; }
        video { object-fit: contain !important; }
        ::-webkit-scrollbar { display: none; }
    `;
    document.documentElement.appendChild(style);
    throw new Error("Zen Mode Activated - Stopping script execution");
}

console.log("YouTube Preview Popup active - Generic Link Strategy");

const PREVIEW_BTN_CLASS = "yt-preview-button";
const BUTTON_TEXT = "Preview";
const Z_INDEX_POPUP = 2147483647;

// --- Load Settings ---
let currentStrategy = 'zen'; // Default
let iframeProxyUrl = 'https://www.youtube-nocookie.com/embed/';

function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['strategy', 'proxyUrl'], (result) => {
            if (result.strategy) currentStrategy = result.strategy;
            if (result.proxyUrl) iframeProxyUrl = result.proxyUrl;
            console.log(`[Debug] Strategy loaded: ${currentStrategy}, Proxy: ${iframeProxyUrl}`);
        });
    } else {
        console.warn("[Warning] chrome.storage.local not available. Using default 'Zen Mode'.");
    }
}
loadSettings();

// Listen for changes
if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local') {
            if (changes.strategy) currentStrategy = changes.strategy.newValue;
            if (changes.proxyUrl) iframeProxyUrl = changes.proxyUrl.newValue;
        }
    });
}

// --- Observer Logic ---
const observer = new MutationObserver((mutations) => {
    let shouldProcess = false;
    for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
            shouldProcess = true;
            break;
        }
    }
    if (shouldProcess) {
        processThumbnails();
    }
});

observer.observe(document.body, { childList: true, subtree: true });

setTimeout(processThumbnails, 1000);
setInterval(processThumbnails, 2000);

function processThumbnails() {
    const links = document.querySelectorAll('a[href*="/watch?v="]');

    links.forEach((anchor) => {
        if (anchor.querySelector(`.${PREVIEW_BTN_CLASS}`) || anchor.parentElement.querySelector(`.${PREVIEW_BTN_CLASS}`)) return;

        const hasImg = anchor.querySelector('img') || anchor.querySelector('yt-image');
        const parentThumbnail = anchor.closest('ytd-thumbnail') || anchor.closest('#thumbnail');

        if (!hasImg && !parentThumbnail) return;

        let target = parentThumbnail;
        if (!target) target = anchor;

        if (target.getAttribute("aria-hidden") === "true") target.removeAttribute("aria-hidden");
        const hiddenParent = target.closest('[aria-hidden="true"]');
        if (hiddenParent) hiddenParent.removeAttribute("aria-hidden");

        if (target.querySelector(`.${PREVIEW_BTN_CLASS}`)) return;

        createPreviewButton(target, anchor.getAttribute("href"));
    });
}

function createPreviewButton(container, videoUrl) {
    const button = document.createElement("button");
    button.className = PREVIEW_BTN_CLASS;
    button.innerText = BUTTON_TEXT;

    button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPreview(videoUrl);
    });

    const overlays = container.querySelector("#overlays");
    if (overlays) {
        overlays.appendChild(button);
    } else {
        const style = window.getComputedStyle(container);
        if (style.position === 'static') container.style.position = 'relative';
        container.appendChild(button);
    }
}

// --- Dispatcher ---
function openPreview(videoUrl) {
    const urlObj = new URL(videoUrl, "https://www.youtube.com");
    const videoId = urlObj.searchParams.get("v");
    if (!videoId) return;

    if (currentStrategy === 'zen') {
        openZenPopup(videoId);
    } else {
        openEmbeddedProxy(videoId);
    }
}

// Strategy 1: Zen Popup
function openZenPopup(videoId) {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&autoplay=1&preview_popup=1`;
    const width = 854;
    const height = 480;
    const left = (window.screen.width / 2) - (width / 2);
    const top = (window.screen.height / 2) - (height / 2);

    window.open(watchUrl, "YouTubePreview", `width=${width},height=${height},top=${top},left=${left},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=yes`);
}

// Strategy 2: Embedded Proxy
function openEmbeddedProxy(videoId) {
    // Check if proxy URL ends with slash or needs one, usually embed servers are like /embed/ID
    // If user enters 'https://yewtu.be/embed/', we append ID.
    // If user enters 'https://invidious.io/watch?v=', we append ID. 
    // We assume standard embed proxy pattern: BASE_URL + VIDEO_ID

    let embedSrc = iframeProxyUrl;
    if (!embedSrc.endsWith('/') && !embedSrc.endsWith('=')) {
        embedSrc += '/'; // intelligent guess
    }

    // Quick Fix for query param based proxies vs path based
    if (embedSrc.includes('watch?v=')) {
        embedSrc = embedSrc + videoId + "&autoplay=1";
    } else {
        embedSrc = embedSrc + videoId + "?autoplay=1";
    }

    // Remove existing if any
    const existing = document.querySelector('.yt-preview-embed-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'yt-preview-embed-overlay';
    Object.assign(overlay.style, {
        position: 'fixed', bottom: '20px', right: '20px', width: '480px', height: '270px',
        zIndex: Z_INDEX_POPUP, backgroundColor: 'black', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        border: '1px solid #333'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
        height: '30px', background: '#202020', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', cursor: 'move'
    });

    const closeBtn = document.createElement('button');
    closeBtn.innerText = '×';
    Object.assign(closeBtn.style, {
        background: 'none', border: 'none', color: '#ccc', fontSize: '24px', cursor: 'pointer', padding: '0 8px'
    });
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    overlay.appendChild(header);

    const content = document.createElement('div');
    content.style.flex = '1';

    content.innerHTML = `<iframe 
        src="${embedSrc}" 
        style="width:100%; height:100%; border:none;"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" 
        allowfullscreen>
    </iframe>`;

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    // Simple Drag Logic
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = overlay.getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;
        overlay.style.right = 'auto'; // Switch to left/top positioning
        overlay.style.bottom = 'auto';
        overlay.style.left = initialLeft + 'px';
        overlay.style.top = initialTop + 'px';
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        overlay.style.left = (initialLeft + dx) + 'px';
        overlay.style.top = (initialTop + dy) + 'px';
    });

    window.addEventListener('mouseup', () => { isDragging = false; });
}