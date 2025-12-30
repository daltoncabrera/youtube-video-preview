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
let iframeProxyUrl = 'https://daltoncabrera.github.io/youtube-video-preview';
let defSize = 'small';
let defPos = 'bottom-right';

function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['strategy', 'proxyUrl', 'defSize', 'defPos'], (result) => {
            if (result.strategy) currentStrategy = result.strategy;
            if (result.proxyUrl) iframeProxyUrl = result.proxyUrl;
            if (result.defSize) defSize = result.defSize;
            if (result.defPos) defPos = result.defPos;
            console.log(`[Debug] Strategy loaded: ${currentStrategy}, Proxy: ${iframeProxyUrl}, Size: ${defSize}, Pos: ${defPos}`);
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
            if (changes.defSize) defSize = changes.defSize.newValue;
            if (changes.defPos) defPos = changes.defPos.newValue;

            // Apply Live Updates to Active Overlay
            const overlay = document.querySelector('.yt-preview-embed-overlay');
            if (overlay && (changes.defSize || changes.defPos)) {
                // Determine values to use (newly updated globals)
                const size = getInitialSize(defSize);
                const pos = getInitialPosition(defPos, size.width, size.height);

                Object.assign(overlay.style, {
                    width: size.width + 'px',
                    height: size.height + 'px',
                    ...pos
                });
            }
        }
    });
}

// --- Observer Logic ---
// We need aggressive observation because YouTube native preview replaces DOM elements on hover.
const observer = new MutationObserver((mutations) => {
    // Determine if relevant nodes were added/removed
    let shouldProcess = false;
    for (const mutation of mutations) {
        if (mutation.type === 'childList') {
            shouldProcess = true;
            break;
        }
    }
    if (shouldProcess) {
        processThumbnails();
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// JUST-IN-TIME Injection for Hover survival
document.body.addEventListener('mouseenter', (e) => {
    if (!e.target || !e.target.closest) return;
    const thumbnail = e.target.closest('ytd-thumbnail') || e.target.closest('#thumbnail');

    if (thumbnail) {
        // Force check/inject immediately
        // Search relative to the thumbnail to find the video link
        let anchor = thumbnail.querySelector('a[href*="/watch?v="]');

        // Sometimes the anchor is a sibling or parent depending on layout (list vs grid)
        if (!anchor) {
            anchor = thumbnail.parentElement.querySelector('a[href*="/watch?v="]');
        }

        if (anchor) {
            // Check if button exists inside the thumbnail container
            if (!thumbnail.querySelector(`.${PREVIEW_BTN_CLASS}`)) {
                createPreviewButton(thumbnail, anchor.getAttribute("href"));
            }
        }
    }
}, true); // Capture phase

// Periodic cleanup/check
setInterval(processThumbnails, 1500);

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

        createPreviewButton(anchor, anchor.getAttribute("href"));
    });
}

// --- Button Injection ---
function createPreviewButton(targetContainer, videoUrl) {
    // Determine the most stable parent to inject into.
    // YouTube replaces contents of ytd-thumbnail, so we want to inject into the "Card" renderer if possible.
    const card = targetContainer.closest('ytd-rich-item-renderer')
        || targetContainer.closest('ytd-grid-video-renderer')
        || targetContainer.closest('ytd-compact-video-renderer')
        || targetContainer.closest('ytd-video-renderer'); // Search results

    // If we find a stable card, use it. Otherwise fallback to targetContainer (thumbnail)
    const container = card || targetContainer;

    // Check if button already exists in this container
    if (container.querySelector(`.${PREVIEW_BTN_CLASS}`)) return;

    const videoId = extractVideoId(videoUrl);
    if (!videoId) return;

    const button = document.createElement("button");
    button.className = PREVIEW_BTN_CLASS;
    button.innerText = "Preview";

    // Style adjustments for Card injection vs Thumbnail injection
    if (card) {
        // If injecting into card, we need to position it over the thumbnail manually.
        // Usually the thumbnail is the first child or distinct.
        // We can just set Top/Right of the card.
        // Ensure card is relative
        const style = window.getComputedStyle(container);
        if (style.position === 'static') {
            container.style.position = 'relative';
        }
        // Specific adjustments might be needed, but Top-Right of card is usually Top-Right of thumbnail roughly.
        // However, standard thumbnails have margin.
        // To be safe, let's stick to the TOP RIGHT of the container.
        // But for 'ytd-rich-item-renderer', top right is above the video.
        // This is fine, or even better.
        button.style.zIndex = '2147483647';
    } else {
        // Fallback styling
        const style = window.getComputedStyle(container);
        if (style.position === 'static') {
            container.style.position = 'relative';
        }
    }

    button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openPreview(videoUrl);
    });

    container.appendChild(button);

    // Safety: If somehow it's removed, we rely on the global observer/mouseenter to re-trigger processThumbnails
}

// Helper to extract video ID
function extractVideoId(videoUrl) {
    const urlObj = new URL(videoUrl, "https://www.youtube.com");
    return urlObj.searchParams.get("v");
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
    let embedSrc = iframeProxyUrl;

    // Logic for "daltoncabrera.github.io" style proxies that expect ?v=
    if (embedSrc.includes('youtube-video-preview')) {
        // Ensure we have the query param structure
        if (!embedSrc.includes('?v=')) {
            // Check for trailing slash
            if (!embedSrc.endsWith('/')) {
                embedSrc += '/';
            }
            embedSrc += '?v=';
        }
        embedSrc = embedSrc + videoId;
    } else if (embedSrc.includes('?v=') || embedSrc.endsWith('=')) {
        // Generic query param proxy
        embedSrc = embedSrc + videoId;
    } else {
        // Fallback for standard path-based proxies like "/embed/"
        if (!embedSrc.endsWith('/')) {
            embedSrc += '/';
        }
        embedSrc = embedSrc + videoId + "?autoplay=1";
    }

    // Check for existing overlay
    const existingOverlay = document.querySelector('.yt-preview-embed-overlay');

    if (existingOverlay) {
        // Reuse existing overlay: Just update the Iframe
        const iframe = existingOverlay.querySelector('iframe');
        if (iframe) {
            iframe.src = embedSrc;
            return; // Done
        } else {
            // Should not happen, but if iframe missing, remove and recreate
            existingOverlay.remove();
        }
    }

    // Create New Overlay
    const overlay = document.createElement('div');
    overlay.className = 'yt-preview-embed-overlay';

    // Calculate Layout
    const size = getInitialSize(defSize);
    const pos = getInitialPosition(defPos, size.width, size.height);

    Object.assign(overlay.style, {
        position: 'fixed',
        zIndex: Z_INDEX_POPUP, backgroundColor: 'black', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column',
        border: '1px solid #333',
        resize: 'both',
        minWidth: '300px',
        minHeight: '170px',
        // Dynamic Props
        width: size.width + 'px',
        height: size.height + 'px',
        ...pos
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

        // Reset to top/left positioning for dragging
        overlay.style.right = 'auto';
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

// --- Layout Helpers ---
function getInitialSize(sizeKey) {
    switch (sizeKey) {
        case 'medium': return { width: 640, height: 360 };
        case 'large': return { width: 854, height: 480 };
        case 'small':
        default: return { width: 480, height: 270 };
    }
}

function getInitialPosition(posKey, w, h) {
    const margin = 20;
    switch (posKey) {
        case 'top-left': return { top: margin + 'px', left: margin + 'px', bottom: 'auto', right: 'auto', transform: 'none' };
        case 'top-right': return { top: margin + 'px', right: margin + 'px', bottom: 'auto', left: 'auto', transform: 'none' };
        case 'bottom-left': return { bottom: margin + 'px', left: margin + 'px', top: 'auto', right: 'auto', transform: 'none' };
        case 'center':
            return {
                top: '50%',
                left: '50%',
                transform: 'translate(-50%, -50%)',
                bottom: 'auto',
                right: 'auto'
            };
        case 'bottom-right':
        default: return { bottom: margin + 'px', right: margin + 'px', top: 'auto', left: 'auto', transform: 'none' };
    }
}