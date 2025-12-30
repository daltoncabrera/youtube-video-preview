// --- Zen Mode Logic (Popup Window) ---
// We check for the special flag to strip down the UI
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('preview_popup')) {
    console.log("YouTube Preview Popup - Entering Zen Mode");

    // Inject Styles to hide clutter and maximize player
    const style = document.createElement('style');
    style.textContent = `
        /* Hide everything except the player */
        ytd-masthead, #secondary, #below, #comments, #chat, #merch-shelf, ytd-watch-metadata, #related, #header, #masthead-container { display: none !important; }
        
        /* Reset layout constraints to fill window */
        #page-manager { margin: 0 !important; margin-top: 0 !important; overflow: hidden !important; }
        #columns { max-width: 100% !important; margin: 0 !important; }
        #primary { max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
        #player { max-width: 100% !important; margin: 0 !important; min-height: 100vh !important; }
        ytd-watch-flexy { max-width: 100% !important; margin: 0 !important; padding: 0 !important; }
        
        /* Force player to fill viewport */
        html, body { overflow: hidden !important; background: #000 !important; }
        .html5-video-player { width: 100vw !important; height: 100vh !important; z-index: 99999 !important; }
        video { object-fit: contain !important; }
        ::-webkit-scrollbar { display: none; }
    `;

    // waiting for body or head to be available
    const injectStyles = () => {
        if (document.head || document.documentElement) {
            (document.head || document.documentElement).appendChild(style);
        } else {
            requestAnimationFrame(injectStyles);
        }
    };
    injectStyles();

    // We don't throw Error here to allow video player scripts to run, 
    // but we can stop our own extension logic from running twice.
}

// --- YouTube Preview Popup Content Script ---
console.log("YouTube Preview Popup active");

const PREVIEW_BTN_CLASS = "yt-preview-button";
const BUTTON_TEXT = "Preview";
const Z_INDEX_POPUP = 2147483647;

// --- Load Settings ---
let currentStrategy = 'embed'; // Default
let iframeProxyUrl = 'https://daltoncabrera.github.io/youtube-video-preview';
let defSize = 'small';
let defPos = 'bottom-right';
let btnPos = 'top-left'; // Button Default

function loadSettings() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['strategy', 'proxyUrl', 'defSize', 'defPos', 'btnPos'], (result) => {
            if (result.strategy) currentStrategy = result.strategy;
            if (result.proxyUrl) iframeProxyUrl = result.proxyUrl;
            if (result.defSize) defSize = result.defSize;
            if (result.defPos) defPos = result.defPos;
            if (result.btnPos) btnPos = result.btnPos;
            console.log(`[Debug] Settings loaded. BtnPos: ${btnPos}`);
        });
    } else {
        console.warn("[Warning] chrome.storage.local not available. Using default settings.");
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
            if (changes.btnPos) {
                btnPos = changes.btnPos.newValue;
                updateAllButtonPositions();
            }

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

function updateAllButtonPositions() {
    const buttons = document.querySelectorAll(`.${PREVIEW_BTN_CLASS}`);
    buttons.forEach(btn => {
        // Remove known position classes
        btn.classList.remove('top-left', 'top-right', 'bottom-left', 'bottom-right');
        // Add new one
        btn.classList.add(btnPos);

        // Dynamic re-adjustment for bottom positions
        adjustButtonPosition(btn, btn.parentElement);
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
    const thumbnail = e.target.closest('ytd-thumbnail') || e.target.closest('#thumbnail') || e.target.closest('ytd-reel-item-renderer');

    if (thumbnail) {
        // Force check/inject immediately
        // Search relative to the thumbnail to find the video link
        let anchor = thumbnail.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');

        // Sometimes the anchor is a sibling or parent depending on layout (list vs grid)
        if (!anchor) {
            anchor = thumbnail.parentElement.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]');
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
    const links = document.querySelectorAll('a[href*="/watch?v="], a[href*="/shorts/"]');

    links.forEach((anchor) => {
        // Obsolete checks removed to ensure we update recycled DOM elements
        // if (anchor.querySelector(`.${PREVIEW_BTN_CLASS}`) ... ) return;

        const hasImg = anchor.querySelector('img') || anchor.querySelector('yt-image');
        // Shorts renderers are different, sometimes ytd-rich-grid-slim-media or ytd-reel-item-renderer
        const parentThumbnail = anchor.closest('ytd-thumbnail')
            || anchor.closest('#thumbnail')
            || anchor.closest('ytd-reel-item-renderer')
            || anchor.closest('ytd-rich-grid-slim-media');

        if (!hasImg && !parentThumbnail) return;

        let target = parentThumbnail;
        if (!target) target = anchor;

        if (target.getAttribute("aria-hidden") === "true") target.removeAttribute("aria-hidden");
        const hiddenParent = target.closest('[aria-hidden="true"]');
        if (hiddenParent) hiddenParent.removeAttribute("aria-hidden");

        // Always attempt to create/update button
        createPreviewButton(anchor, anchor.getAttribute("href"));
    });
}

// --- Button Injection ---
function createPreviewButton(targetContainer, videoUrl) {
    // Determine the most stable parent to inject into.
    const card = targetContainer.closest('ytd-rich-item-renderer')
        || targetContainer.closest('ytd-grid-video-renderer')
        || targetContainer.closest('ytd-compact-video-renderer')
        || targetContainer.closest('ytd-video-renderer')
        || targetContainer.closest('ytd-reel-item-renderer') // Shorts on channel/feed
        || targetContainer.closest('ytd-rich-grid-slim-media'); // Shorts on home grid

    const container = card || targetContainer;
    const videoId = extractVideoId(videoUrl);
    if (!videoId) return;

    // Check if button already exists in this container
    let button = container.querySelector(`.${PREVIEW_BTN_CLASS}`);

    if (button) {
        // CRITICAL FIX: YouTube recycles DOM elements. 
        // We must update the button's video ID even if it exists.
        if (button.dataset.videoId !== videoId) {
            button.dataset.videoId = videoId;
        }
        return;
    }

    button = document.createElement("button");
    button.className = PREVIEW_BTN_CLASS;
    button.classList.add(btnPos); // Apply configured position
    button.innerText = "Preview";
    button.dataset.videoId = videoId; // Store ID for dynamic retrieval

    // Style adjustments...
    if (card) {
        const style = window.getComputedStyle(container);
        if (style.position === 'static') {
            container.style.position = 'relative';
        }
    } else {
        const style = window.getComputedStyle(container);
        if (style.position === 'static') {
            container.style.position = 'relative';
        }
    }

    button.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Read the LATEST video ID from the button attribute
        const currentId = e.currentTarget.dataset.videoId;
        if (currentId) {
            openPreview(`https://www.youtube.com/watch?v=${currentId}`);
        }
    });

    container.appendChild(button);

    // Apply initial positioning logic
    adjustButtonPosition(button, container);

    // Safety...
}

function adjustButtonPosition(button, container) {
    // Reset manual styles first to allow CSS classes to work for Top positions
    button.style.top = '';
    button.style.bottom = '';
    button.style.left = '';
    button.style.right = '';
    button.style.zIndex = '2147483647'; // Ensure max z-index

    // If it's a "Bottom" position AND we are inside a Card (meaning container is tall),
    // we need to anchor to the Thumbnail height manually.
    if (btnPos.startsWith('bottom')) {
        const thumbnail = container.querySelector('ytd-thumbnail') || container.querySelector('#thumbnail') || container.querySelector('ytd-reel-item-renderer') || container.querySelector('ytd-rich-grid-slim-media');
        if (thumbnail && thumbnail.offsetHeight > 0) {
            // Calculate Top offset to place it at the bottom of the thumbnail
            const offset = thumbnail.offsetHeight - 40; // 40px up from bottom of image

            button.style.top = offset + 'px';
            button.style.bottom = 'auto';

            // Explicitly enforce Left/Right properties based on pos
            if (btnPos === 'bottom-left') {
                button.style.left = '8px';
                button.style.right = 'auto'; // Clear right
            } else {
                button.style.right = '8px';
                button.style.left = 'auto'; // Clear left
            }
        }
    }
}

// Helper to extract video ID
function extractVideoId(videoUrl) {
    const urlObj = new URL(videoUrl, "https://www.youtube.com");

    // Check for standard v= parameter
    const v = urlObj.searchParams.get("v");
    if (v) return v;

    // Check for Shorts URL path: /shorts/ID
    if (urlObj.pathname.includes('/shorts/')) {
        const parts = urlObj.pathname.split('/');
        // Path is usually like /shorts/VIDEO_ID or /shorts/VIDEO_ID/other
        // parts[0] is empty, parts[1] is shorts, parts[2] is ID
        const shortsIndex = parts.indexOf('shorts');
        if (shortsIndex !== -1 && parts[shortsIndex + 1]) {
            return parts[shortsIndex + 1];
        }
    }

    return null;
}

// --- Helper: Construct Proxy URL ---
function getProxyUrl(videoId) {
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
    return embedSrc;
}

// --- Dispatcher ---
function openPreview(videoUrl) {
    const urlObj = new URL(videoUrl, "https://www.youtube.com");
    // Use our robust extractor to ensure we catch shorts URLs too if passed here
    // (Although usually we extract before calling this, safe to re-check)
    const videoId = extractVideoId(videoUrl) || urlObj.searchParams.get("v");
    if (!videoId) return;

    if (currentStrategy === 'zen') {
        openZenPopup(videoId);
    } else {
        openEmbeddedProxy(videoId);
    }
}

// Strategy 1: Zen Popup (Optimized: Uses Proxy)
function openZenPopup(videoId) {
    // NEW: Use the lightweight proxy
    let proxyUrl = getProxyUrl(videoId);

    // Ensure autoplay is passed to the proxy
    if (proxyUrl.includes('?')) {
        proxyUrl += '&autoplay=1';
    } else {
        proxyUrl += '?autoplay=1';
    }

    const width = 854;
    const height = 480;
    const left = (window.screen.width / 2) - (width / 2);
    const top = (window.screen.height / 2) - (height / 2);

    window.open(proxyUrl, "YouTubePreview", `width=${width},height=${height},top=${top},left=${left},resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=yes`);
}

// Strategy 2: Embedded Proxy
function openEmbeddedProxy(videoId) {
    const embedSrc = getProxyUrl(videoId);

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