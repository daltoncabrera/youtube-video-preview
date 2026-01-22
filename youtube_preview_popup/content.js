// --- Auto-Skip Logic for Embeds ---
if (window.location.pathname.startsWith('/embed/')) {
    let autoSkipEnabled = true;

    // Load setting (async)
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(['autoSkip'], (result) => {
            if (result.autoSkip !== undefined) {
                autoSkipEnabled = result.autoSkip;
            }
        });

        // Listen for live changes
        chrome.storage.onChanged.addListener((changes) => {
            if (changes.autoSkip) {
                autoSkipEnabled = changes.autoSkip.newValue;
            }
        });
    }

    setInterval(() => {
        if (!autoSkipEnabled) return;

        // Method 1: Click Skip Buttons
        const skipSelectors = [
            '.ytp-ad-skip-button',
            '.ytp-ad-skip-button-modern',
            '.videoAdUiSkipButton',
            '.ytp-skip-ad-button',
            '.ytp-ad-overlay-close-button',
            '.ytp-ad-skip-button-slot'
        ];

        skipSelectors.forEach(selector => {
            const elements = document.querySelectorAll(selector);
            elements.forEach(btn => {
                if (btn) {
                    btn.click();
                    // Also try triggering standard events just in case
                    ['mousedown', 'mouseup', 'click'].forEach(evt => {
                        const e = new MouseEvent(evt, { bubbles: true, cancelable: true, view: window });
                        btn.dispatchEvent(e);
                    });
                }
            });
        });

        // Method 2: Fast Forward Video (Nuclear Option)
        // Detect ad state
        const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
        const isAd = player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting'));

        if (isAd) {
            const video = document.querySelector('video');
            if (video) {
                // Force ad to end
                video.muted = true;
                video.playbackRate = 16;
                if (isFinite(video.duration) && video.duration > 0) {
                    video.currentTime = video.duration - 0.1; // Seek to almost end
                }
            }
        }
    }, 200); // Check very aggressively (5x per second)
} else {

    // --- Zen Mode Logic (Popup Window) ---
    // We check for the special flag to strip down the UI
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('preview_popup')) {


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

    const PREVIEW_BTN_CLASS = "yt-preview-button";
    const PREVIEW_WRAPPER_CLASS = "yt-preview-wrapper";
    const Z_INDEX_POPUP = 2147483647;

    // ====== PLAYBACK STATE MANAGEMENT ======
    const PlaybackState = {
        // Current playback source: null | 'queue' | 'list:listId'
        activeSource: null,
        // Queue: temporary, session-only
        queue: [],
        // Current index in queue/list
        currentIndex: 0,
        // Currently playing video ID
        currentVideoId: null,
        // Lists are loaded from storage
        lists: {},
        // Reference to current PiP window
        pipWindow: null,
        // Track if a video is currently playing (any mode)
        isPlaying: false,
        // Callback to notify UI of queue/list changes
        onStateChange: null,

        // Notify UI of state changes
        notifyChange() {
            if (this.onStateChange) {
                try {
                    this.onStateChange();
                } catch (e) {
                    console.warn('[State] onStateChange callback failed:', e);
                    this.onStateChange = null;
                }
            }
        },

        // Initialize lists from storage
        async loadLists() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                return new Promise((resolve) => {
                    chrome.storage.local.get(['ytPreviewLists'], (result) => {
                        this.lists = result.ytPreviewLists || {};
                        resolve();
                    });
                });
            }
        },

        // Save lists to storage
        async saveLists() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                return new Promise((resolve) => {
                    chrome.storage.local.set({ ytPreviewLists: this.lists }, resolve);
                });
            }
        },

        // Create a new list
        async createList(name) {
            const id = 'list_' + Date.now();
            this.lists[id] = { name, items: [] };
            await this.saveLists();
            return id;
        },

        // Get active items array
        getActiveItems() {
            if (this.activeSource === 'queue') {
                return this.queue;
            } else if (this.activeSource && this.activeSource.startsWith('list:')) {
                const listId = this.activeSource.replace('list:', '');
                return this.lists[listId]?.items || [];
            }
            return [];
        },

        // Get active source name
        getActiveSourceName() {
            if (this.activeSource === 'queue') return 'Queue';
            if (this.activeSource && this.activeSource.startsWith('list:')) {
                const listId = this.activeSource.replace('list:', '');
                return this.lists[listId]?.name || 'List';
            }
            return 'Preview';
        },

        // Preview action: clear source, play single item
        preview(videoId) {
            this.activeSource = null;
            this.queue = [];
            this.currentIndex = 0;
            this.currentVideoId = videoId;
        },

        // Queue insert: insert after current
        queueInsert(videoId) {
            if (this.activeSource !== 'queue') {
                // Switch to queue mode
                this.activeSource = 'queue';
                this.queue = this.currentVideoId ? [this.currentVideoId] : [];
                this.currentIndex = this.queue.length > 0 ? 0 : -1;
            }
            // Insert after current position (or at start if nothing playing)
            const insertPos = Math.max(0, this.currentIndex + 1);
            this.queue.splice(insertPos, 0, videoId);
            // If nothing was playing, set index to new item
            if (this.currentIndex < 0) {
                this.currentIndex = 0;
            }
            console.log('[Queue] Insert:', videoId, 'Queue:', this.queue, 'Index:', this.currentIndex);
            this.notifyChange();
        },

        // Queue append: add to end
        queueAppend(videoId) {
            if (this.activeSource !== 'queue') {
                this.activeSource = 'queue';
                this.queue = this.currentVideoId ? [this.currentVideoId] : [];
                this.currentIndex = this.queue.length > 0 ? 0 : -1;
            }
            this.queue.push(videoId);
            // If nothing was playing, set index to first item
            if (this.currentIndex < 0) {
                this.currentIndex = 0;
            }
            console.log('[Queue] Append:', videoId, 'Queue:', this.queue, 'Index:', this.currentIndex);
            this.notifyChange();
        },

        // List insert: insert after current in specified list
        async listInsert(listId, videoId) {
            if (!this.lists[listId]) {
                console.warn('[List] List not found:', listId);
                return;
            }

            // If this list is not active, activate it
            if (this.activeSource !== `list:${listId}`) {
                this.activeSource = `list:${listId}`;
                this.currentIndex = this.lists[listId].items.length > 0 ? 0 : -1;
            }

            const insertPos = Math.max(0, this.currentIndex + 1);
            this.lists[listId].items.splice(insertPos, 0, videoId);
            if (this.currentIndex < 0) this.currentIndex = 0;
            await this.saveLists();
            console.log('[List] Insert:', videoId, 'List:', this.lists[listId].items, 'Index:', this.currentIndex);
            this.notifyChange();
        },

        // List append: add to end of specified list
        async listAppend(listId, videoId) {
            if (!this.lists[listId]) {
                console.warn('[List] List not found:', listId);
                return;
            }

            // If this list is not active, activate it
            if (this.activeSource !== `list:${listId}`) {
                this.activeSource = `list:${listId}`;
                this.currentIndex = this.lists[listId].items.length > 0 ? 0 : -1;
            }

            this.lists[listId].items.push(videoId);
            if (this.currentIndex < 0) this.currentIndex = 0;
            await this.saveLists();
            console.log('[List] Append:', videoId, 'List:', this.lists[listId].items, 'Index:', this.currentIndex);
            this.notifyChange();
        },

        // Navigation
        hasNext() {
            const items = this.getActiveItems();
            return this.currentIndex < items.length - 1;
        },

        hasPrevious() {
            return this.currentIndex > 0;
        },

        next() {
            const items = this.getActiveItems();
            if (this.currentIndex < items.length - 1) {
                this.currentIndex++;
                this.currentVideoId = items[this.currentIndex];
                return this.currentVideoId;
            }
            return null;
        },

        previous() {
            const items = this.getActiveItems();
            if (this.currentIndex > 0) {
                this.currentIndex--;
                this.currentVideoId = items[this.currentIndex];
                return this.currentVideoId;
            }
            return null;
        },

        // Switch source
        switchSource(source) {
            this.activeSource = source;
            const items = this.getActiveItems();
            this.currentIndex = items.length > 0 ? 0 : -1;
            if (items.length > 0) {
                this.currentVideoId = items[0];
            }
        },

        // Get position info
        getPositionInfo() {
            const items = this.getActiveItems();
            if (!this.activeSource || items.length === 0) return null;
            return `${this.currentIndex + 1}/${items.length}`;
        }
    };

    // Load lists on init
    PlaybackState.loadLists();

    // --- Load Settings ---
    let currentStrategy = 'pip'; // Default
    let iframeProxyUrl = 'https://daltoncabrera.github.io/youtube-video-preview';
    let defSize = 'medium';
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
        // Update wrapper-based buttons
        const wrappers = document.querySelectorAll(`.${PREVIEW_WRAPPER_CLASS}`);
        wrappers.forEach(wrapper => {
            wrapper.classList.remove('top-left', 'top-right', 'bottom-left', 'bottom-right');
            wrapper.classList.add(btnPos);
            adjustWrapperPosition(wrapper, wrapper.parentElement);
        });

        // Legacy: update old-style buttons
        const buttons = document.querySelectorAll(`.${PREVIEW_BTN_CLASS}`);
        buttons.forEach(btn => {
            btn.classList.remove('top-left', 'top-right', 'bottom-left', 'bottom-right');
            btn.classList.add(btnPos);
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
            createPreviewButton(target, anchor.getAttribute("href"));
        });
    }

    // --- Button Injection (with Dropdown) ---
    function createPreviewButton(targetContainer, videoUrl) {
        // Determine the most stable parent to inject into.
        const card = targetContainer.closest('ytd-rich-item-renderer')
            || targetContainer.closest('ytd-grid-video-renderer')
            || targetContainer.closest('ytd-compact-video-renderer')
            || targetContainer.closest('ytd-video-renderer')
            || targetContainer.closest('ytd-playlist-video-renderer')
            || targetContainer.closest('ytd-playlist-panel-video-renderer')
            || targetContainer.closest('ytd-reel-item-renderer')
            || targetContainer.closest('ytd-rich-grid-slim-media');

        const container = card || targetContainer;
        const videoId = extractVideoId(videoUrl);
        if (!videoId) return;

        // Check if wrapper already exists
        let wrapper = container.querySelector(`.${PREVIEW_WRAPPER_CLASS}`);

        if (wrapper) {
            // Update video ID if changed
            if (wrapper.dataset.videoId !== videoId) {
                wrapper.dataset.videoId = videoId;
            }
            return;
        }

        // Create wrapper element
        wrapper = document.createElement("div");
        wrapper.className = `${PREVIEW_WRAPPER_CLASS} ${btnPos}`;
        wrapper.dataset.videoId = videoId;

        // Create main button
        const mainBtn = document.createElement("button");
        mainBtn.className = "yt-preview-btn-main";
        mainBtn.innerHTML = 'Preview <span class="arrow">▼</span>';

        // Create dropdown
        const dropdown = document.createElement("div");
        dropdown.className = "yt-preview-dropdown";
        dropdown.innerHTML = buildDropdownHTML();

        wrapper.appendChild(mainBtn);
        wrapper.appendChild(dropdown);

        // Style adjustments
        const style = window.getComputedStyle(container);
        if (style.position === 'static') {
            container.style.position = 'relative';
        }

        // Event handlers
        setupDropdownEvents(wrapper, dropdown);

        container.appendChild(wrapper);
        adjustWrapperPosition(wrapper, container);
    }

    // Build dropdown HTML
    function buildDropdownHTML() {
        let html = `<div class="yt-preview-dropdown-inner">
            <button class="yt-preview-dropdown-item primary" data-action="preview">
                ▶ Preview
            </button>
            <div class="yt-preview-dropdown-divider"></div>
            <div class="yt-preview-dropdown-header">Queue</div>
            <button class="yt-preview-dropdown-item" data-action="queue-insert">
                ↳ Insert next
            </button>
            <button class="yt-preview-dropdown-item" data-action="queue-append">
                + Add to end
            </button>
        `;

        // Add lists section
        const listIds = Object.keys(PlaybackState.lists);
        if (listIds.length > 0 || true) { // Always show lists section
            html += `
                <div class="yt-preview-dropdown-divider"></div>
                <div class="yt-preview-dropdown-header">Lists</div>
                <button class="yt-preview-dropdown-item" data-action="new-list">
                    + New list
                </button>
            `;

            listIds.forEach(id => {
                const list = PlaybackState.lists[id];
                html += `
                    <div class="yt-preview-submenu">
                        <button class="yt-preview-dropdown-item">
                            ${list.name} <span class="icon">▶</span>
                        </button>
                        <div class="yt-preview-submenu-content">
                            <div class="yt-preview-submenu-content-inner">
                                <button class="yt-preview-dropdown-item" data-action="list-insert" data-list-id="${id}">
                                    ↳ Insert next
                                </button>
                                <button class="yt-preview-dropdown-item" data-action="list-append" data-list-id="${id}">
                                    + Add to end
                                </button>
                            </div>
                        </div>
                    </div>
                `;
            });
        }

        html += `</div>`; // Close inner wrapper
        return html;
    }

    // Setup dropdown event handlers
    function setupDropdownEvents(wrapper, dropdown) {
        dropdown.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const btn = e.target.closest('[data-action]');
            if (!btn) return;

            const action = btn.dataset.action;
            const videoId = wrapper.dataset.videoId;
            const listId = btn.dataset.listId;

            switch (action) {
                case 'preview':
                    // Preview: clear queue and play single item
                    PlaybackState.preview(videoId);
                    openPreview(`https://www.youtube.com/watch?v=${videoId}`);
                    break;

                case 'queue-insert':
                    PlaybackState.queueInsert(videoId);
                    showNotification('Added to queue (next)');
                    // If nothing playing, start playback with the first queue item
                    if (!PlaybackState.isPlaying && PlaybackState.queue.length > 0) {
                        PlaybackState.currentVideoId = PlaybackState.queue[PlaybackState.currentIndex];
                        console.log('[Queue] Starting playback:', PlaybackState.currentVideoId);
                        openPreview(`https://www.youtube.com/watch?v=${PlaybackState.currentVideoId}`);
                    }
                    break;

                case 'queue-append':
                    PlaybackState.queueAppend(videoId);
                    showNotification('Added to queue');
                    // If nothing playing, start playback with the first queue item
                    if (!PlaybackState.isPlaying && PlaybackState.queue.length > 0) {
                        PlaybackState.currentVideoId = PlaybackState.queue[PlaybackState.currentIndex];
                        console.log('[Queue] Starting playback:', PlaybackState.currentVideoId);
                        openPreview(`https://www.youtube.com/watch?v=${PlaybackState.currentVideoId}`);
                    }
                    break;

                case 'list-insert':
                    await PlaybackState.listInsert(listId, videoId);
                    showNotification(`Added to ${PlaybackState.lists[listId].name}`);
                    refreshAllDropdowns();
                    // If nothing playing, start playback
                    if (!PlaybackState.isPlaying) {
                        const items = PlaybackState.getActiveItems();
                        if (items.length > 0) {
                            PlaybackState.currentIndex = 0;
                            PlaybackState.currentVideoId = items[0];
                            console.log('[List] Starting playback:', PlaybackState.currentVideoId);
                            openPreview(`https://www.youtube.com/watch?v=${items[0]}`);
                        }
                    }
                    break;

                case 'list-append':
                    await PlaybackState.listAppend(listId, videoId);
                    showNotification(`Added to ${PlaybackState.lists[listId].name}`);
                    refreshAllDropdowns();
                    // If nothing playing, start playback
                    if (!PlaybackState.isPlaying) {
                        const items = PlaybackState.getActiveItems();
                        if (items.length > 0) {
                            PlaybackState.currentIndex = 0;
                            PlaybackState.currentVideoId = items[0];
                            console.log('[List] Starting playback:', PlaybackState.currentVideoId);
                            openPreview(`https://www.youtube.com/watch?v=${items[0]}`);
                        }
                    }
                    break;

                case 'new-list':
                    const name = prompt('Enter list name:');
                    if (name && name.trim()) {
                        await PlaybackState.createList(name.trim());
                        refreshAllDropdowns();
                        showNotification(`Created list: ${name.trim()}`);
                    }
                    break;
            }
        });
    }

    // Refresh all dropdowns (after list changes)
    function refreshAllDropdowns() {
        document.querySelectorAll('.yt-preview-dropdown').forEach(dropdown => {
            dropdown.innerHTML = buildDropdownHTML();
            const wrapper = dropdown.closest(`.${PREVIEW_WRAPPER_CLASS}`);
            if (wrapper) {
                setupDropdownEvents(wrapper, dropdown);
            }
        });
    }

    // Show notification toast
    function showNotification(message) {
        let toast = document.querySelector('.yt-preview-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'yt-preview-toast';
            toast.style.cssText = `
                position: fixed;
                bottom: 20px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(0, 0, 0, 0.9);
                color: white;
                padding: 10px 20px;
                border-radius: 6px;
                font-size: 12px;
                z-index: 2147483647;
                transition: opacity 0.3s;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    }

    // Adjust wrapper position (similar to old button positioning)
    function adjustWrapperPosition(wrapper, container) {
        wrapper.style.zIndex = '2147483647';

        if (btnPos.startsWith('bottom')) {
            const thumbnail = container.querySelector('ytd-thumbnail') || container.querySelector('#thumbnail') || container.querySelector('ytd-reel-item-renderer') || container.querySelector('ytd-rich-grid-slim-media');
            if (thumbnail && thumbnail.offsetHeight > 0) {
                const offset = thumbnail.offsetHeight - 40;
                wrapper.style.top = offset + 'px';
                wrapper.style.bottom = 'auto';
                if (btnPos === 'bottom-left') {
                    wrapper.style.left = '8px';
                    wrapper.style.right = 'auto';
                } else {
                    wrapper.style.right = '8px';
                    wrapper.style.left = 'auto';
                }
            }
        }
    }

    // Legacy function kept for compatibility
    function adjustButtonPosition(button, container) {
        adjustWrapperPosition(button, container);
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
                // Check for trailing slash or file extension
                if (!embedSrc.endsWith('/') && !embedSrc.match(/\.\w+$/)) {
                    embedSrc += '/';
                }
                // If it ends with a file (e.g. index.html), assume we just append ?v=
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

        console.log('[Preview] Opening video:', videoId, 'Strategy:', currentStrategy);
        PlaybackState.isPlaying = true;

        if (currentStrategy === 'zen') {
            openZenPopup(videoId);
        } else if (currentStrategy === 'pip') {
            openPiPWindow(videoId);
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

    // Strategy 2: Picture-in-Picture (Always on Top)
    async function openPiPWindow(videoId) {
        // Check if Document PiP API is available
        if (!('documentPictureInPicture' in window)) {
            console.warn('[YouTube Preview] Document PiP API not available. Falling back to embedded proxy.');
            openEmbeddedProxy(videoId);
            return;
        }

        try {
            // Close existing PiP window if open
            if (window.documentPictureInPicture.window) {
                window.documentPictureInPicture.window.close();
            }

            // Get size settings
            const size = getInitialSize(defSize);

            // Request PiP window
            const pipWindow = await window.documentPictureInPicture.requestWindow({
                width: size.width,
                height: size.height
            });

            // Store reference
            PlaybackState.pipWindow = pipWindow;
            PlaybackState.currentVideoId = videoId;

            // Build the proxy URL
            const embedSrc = getProxyUrl(videoId);

            // Build source dropdown options
            const sourceOptions = buildSourceOptions();

            // Inject styles and content into PiP window with controls
            pipWindow.document.write(`
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <title>YouTube Preview</title>
                    <style>
                        * { margin: 0; padding: 0; box-sizing: border-box; }
                        html, body {
                            width: 100%;
                            height: 100%;
                            overflow: hidden;
                            background: #000;
                            font-family: Arial, sans-serif;
                        }
                        .pip-container {
                            position: relative;
                            width: 100%;
                            height: 100%;
                        }
                        iframe {
                            width: 100%;
                            height: 100%;
                            border: none;
                        }
                        /* Control Bar - Hidden by default, shows on hover */
                        .pip-control-bar {
                            position: absolute;
                            bottom: 0;
                            left: 0;
                            right: 0;
                            height: 40px;
                            background: linear-gradient(transparent, rgba(0, 0, 0, 0.9));
                            display: flex;
                            align-items: center;
                            justify-content: space-between;
                            padding: 0 12px;
                            opacity: 0;
                            transition: opacity 0.2s;
                            pointer-events: none;
                        }
                        .pip-container:hover .pip-control-bar {
                            opacity: 1;
                            pointer-events: auto;
                        }
                        .pip-bar-left {
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        }
                        .pip-bar-center {
                            display: flex;
                            align-items: center;
                            gap: 4px;
                        }
                        .pip-bar-right {
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        }
                        .pip-bar-btn {
                            background: none;
                            border: none;
                            color: white;
                            cursor: pointer;
                            font-size: 16px;
                            padding: 6px;
                            border-radius: 4px;
                            transition: background 0.2s;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .pip-bar-btn:hover:not(:disabled) {
                            background: rgba(255, 255, 255, 0.2);
                        }
                        .pip-bar-btn:disabled {
                            opacity: 0.3;
                            cursor: not-allowed;
                        }
                        .pip-bar-btn.pip-play-pause {
                            font-size: 20px;
                            padding: 6px 10px;
                        }
                        .pip-source-indicator {
                            position: relative;
                            background: rgba(255, 255, 255, 0.1);
                            color: white;
                            padding: 4px 8px;
                            border-radius: 4px;
                            font-size: 10px;
                            cursor: pointer;
                            white-space: nowrap;
                        }
                        .pip-source-indicator:hover {
                            background: rgba(255, 255, 255, 0.2);
                        }
                        .pip-source-dropdown {
                            display: none;
                            position: absolute;
                            bottom: 100%;
                            left: 0;
                            padding-bottom: 6px; /* Hoverable bridge */
                            z-index: 100;
                        }
                        .pip-source-dropdown-inner {
                            background: rgba(28, 28, 28, 0.95);
                            border: 1px solid rgba(255, 255, 255, 0.2);
                            border-radius: 6px;
                            min-width: 120px;
                            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
                            overflow: hidden;
                        }
                        .pip-source-indicator:hover .pip-source-dropdown {
                            display: block;
                        }
                        .pip-source-item {
                            padding: 8px 12px;
                            color: white;
                            font-size: 11px;
                            cursor: pointer;
                            border: none;
                            background: none;
                            width: 100%;
                            text-align: left;
                            display: block;
                        }
                        .pip-source-item:hover {
                            background: rgba(255, 255, 255, 0.1);
                        }
                        .pip-source-item.active {
                            background: rgba(255, 0, 0, 0.3);
                        }
                        .pip-queue-counter {
                            color: rgba(255, 255, 255, 0.7);
                            font-size: 11px;
                            white-space: nowrap;
                        }
                    </style>
                </head>
                <body>
                    <div class="pip-container">
                        <iframe id="pip-iframe"
                            src="${embedSrc}"
                            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            allowfullscreen>
                        </iframe>
                        <div class="pip-control-bar">
                            <div class="pip-bar-left">
                                <div class="pip-source-indicator" id="pip-source">
                                    ${PlaybackState.getActiveSourceName()} ▼
                                    <div class="pip-source-dropdown" id="pip-source-dropdown">
                                        ${sourceOptions}
                                    </div>
                                </div>
                            </div>
                            <div class="pip-bar-center">
                                <button class="pip-bar-btn" id="pip-prev" title="Previous">⏮</button>
                                <button class="pip-bar-btn pip-play-pause" id="pip-pause" title="Pause (requires proxy support)">⏸</button>
                                <button class="pip-bar-btn" id="pip-next" title="Next">⏭</button>
                            </div>
                            <div class="pip-bar-right">
                                <span class="pip-queue-counter" id="pip-counter">${PlaybackState.getPositionInfo() || ''}</span>
                            </div>
                        </div>
                    </div>
                </body>
                </html>
            `);
            pipWindow.document.close();

            // Setup PiP control handlers
            setupPiPControls(pipWindow);

            // Handle window close
            pipWindow.addEventListener('pagehide', () => {
                console.log('[YouTube Preview] PiP window closed');
                PlaybackState.pipWindow = null;
                PlaybackState.isPlaying = false;
                PlaybackState.onStateChange = null; // Clear callback
            });

        } catch (error) {
            console.error('[YouTube Preview] Failed to open PiP window:', error);
            openEmbeddedProxy(videoId);
        }
    }

    // Build source options HTML for PiP
    function buildSourceOptions() {
        const activeSource = PlaybackState.activeSource;
        let html = `<div class="pip-source-dropdown-inner">
            <button class="pip-source-item ${activeSource === 'queue' ? 'active' : ''}" data-source="queue">
                Queue ${PlaybackState.queue.length > 0 ? `(${PlaybackState.queue.length})` : ''}
            </button>
        `;

        Object.keys(PlaybackState.lists).forEach(id => {
            const list = PlaybackState.lists[id];
            const isActive = activeSource === `list:${id}`;
            html += `
                <button class="pip-source-item ${isActive ? 'active' : ''}" data-source="list:${id}">
                    ${list.name} (${list.items.length})
                </button>
            `;
        });

        html += `</div>`;
        return html;
    }

    // Setup PiP window controls
    function setupPiPControls(pipWindow) {
        const doc = pipWindow.document;
        const prevBtn = doc.getElementById('pip-prev');
        const nextBtn = doc.getElementById('pip-next');
        const pauseBtn = doc.getElementById('pip-pause');
        const iframe = doc.getElementById('pip-iframe');
        let isPaused = false;

        // Update button states
        function updateNavButtons() {
            prevBtn.disabled = !PlaybackState.hasPrevious();
            nextBtn.disabled = !PlaybackState.hasNext();

            const counter = doc.getElementById('pip-counter');
            const posInfo = PlaybackState.getPositionInfo();
            counter.textContent = posInfo || '';

            const sourceIndicator = doc.getElementById('pip-source');
            sourceIndicator.innerHTML = `${PlaybackState.getActiveSourceName()} ▼
                <div class="pip-source-dropdown" id="pip-source-dropdown">
                    ${buildSourceOptions()}
                </div>
            `;
            // Re-attach source events
            attachSourceEvents();
        }

        // Navigate to video
        function navigateToVideo(videoId) {
            console.log('[Nav] Navigating to:', videoId);
            if (videoId) {
                PlaybackState.currentVideoId = videoId;
                const newSrc = getProxyUrl(videoId);
                console.log('[Nav] New iframe src:', newSrc);
                iframe.src = newSrc;
                updateNavButtons();
            } else {
                console.log('[Nav] No video ID, nothing to navigate');
            }
        }

        // Navigation handlers
        prevBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('[Nav] Prev clicked. Current state:', {
                source: PlaybackState.activeSource,
                index: PlaybackState.currentIndex,
                items: PlaybackState.getActiveItems()
            });
            const videoId = PlaybackState.previous();
            navigateToVideo(videoId);
        });

        nextBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('[Nav] Next clicked. Current state:', {
                source: PlaybackState.activeSource,
                index: PlaybackState.currentIndex,
                items: PlaybackState.getActiveItems()
            });
            const videoId = PlaybackState.next();
            navigateToVideo(videoId);
        });

        // Pause/Play handler - uses postMessage to communicate with iframe
        // NOTE: This requires the proxy page to listen for these messages
        pauseBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log('[Pause] Button clicked, sending:', isPaused ? 'play' : 'pause');
            // Send message to iframe to toggle play/pause
            try {
                iframe.contentWindow.postMessage({ action: isPaused ? 'play' : 'pause' }, '*');
            } catch (err) {
                console.warn('[Pause] postMessage failed:', err);
            }
            isPaused = !isPaused;
            pauseBtn.textContent = isPaused ? '▶' : '⏸';
            pauseBtn.title = isPaused ? 'Play (requires proxy support)' : 'Pause (requires proxy support)';
        });

        // Source selection handler
        function attachSourceEvents() {
            const dropdown = doc.getElementById('pip-source-dropdown');
            if (!dropdown) return;

            dropdown.querySelectorAll('.pip-source-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const source = item.dataset.source;
                    PlaybackState.switchSource(source);

                    // Play first item of new source
                    const items = PlaybackState.getActiveItems();
                    if (items.length > 0) {
                        navigateToVideo(items[0]);
                    }
                    updateNavButtons();
                });
            });
        }

        attachSourceEvents();
        updateNavButtons();

        // Register callback for external queue/list changes
        PlaybackState.onStateChange = () => {
            console.log('[PiP] State changed, updating UI');
            updateNavButtons();
        };

        // Listen for video ended message from proxy to auto-play next
        window.addEventListener('message', (e) => {
            // Verify it's a video ended event
            if (e.data && e.data.action === 'videoEnded') {
                console.log('[AutoPlay] Video ended, checking for next...');
                const nextVideoId = PlaybackState.next();
                if (nextVideoId) {
                    console.log('[AutoPlay] Playing next video:', nextVideoId);
                    navigateToVideo(nextVideoId);
                } else {
                    console.log('[AutoPlay] No more videos in queue/list');
                    // Optionally close PiP or show end of playlist message
                }
            }
        });
    }

    // Strategy 3: Embedded Proxy
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
        closeBtn.onclick = () => {
            overlay.remove();
            PlaybackState.isPlaying = false;
            console.log('[Embed] Overlay closed');
        };
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
}