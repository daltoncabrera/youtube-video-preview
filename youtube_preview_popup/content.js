// --- Auto-Skip Logic for Embeds ---
if (window.location.pathname.startsWith('/embed/')) {
    let autoSkipEnabled = true;
    let modifiedAdVideo = null;
    let previousVideoState = null;

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

    const restoreVideo = () => {
        if (modifiedAdVideo && previousVideoState) {
            modifiedAdVideo.muted = previousVideoState.muted;
            modifiedAdVideo.playbackRate = previousVideoState.playbackRate;
        }
        modifiedAdVideo = null;
        previousVideoState = null;
    };

    setInterval(() => {
        if (!autoSkipEnabled) {
            restoreVideo();
            return;
        }

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
                if (modifiedAdVideo !== video) {
                    restoreVideo();
                    modifiedAdVideo = video;
                    previousVideoState = { muted: video.muted, playbackRate: video.playbackRate };
                }
                video.muted = true;
                video.playbackRate = 8;
            }
        } else {
            restoreVideo();
        }
    }, 750);
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
    const previewWrappersByHost = new WeakMap();

    function escapeHTML(value) {
        return String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#039;');
    }

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
        // Video titles cache (videoId -> title)
        videoTitles: {},
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

        // Initialize lists and titles from storage
        async loadLists() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                return new Promise((resolve) => {
                    chrome.storage.local.get([
                        'ytPreviewLists', 'ytVideoTitles', 'ytPreviewQueue',
                        'ytPreviewActiveSource', 'ytPreviewCurrentIndex', 'ytPreviewCurrentVideoId'
                    ], (result) => {
                        this.lists = result.ytPreviewLists || {};
                        this.videoTitles = result.ytVideoTitles || {};
                        this.queue = Array.isArray(result.ytPreviewQueue) ? result.ytPreviewQueue : [];
                        this.activeSource = result.ytPreviewActiveSource || null;
                        this.currentIndex = Number.isInteger(result.ytPreviewCurrentIndex)
                            ? result.ytPreviewCurrentIndex
                            : (this.queue.length ? 0 : -1);
                        this.currentVideoId = result.ytPreviewCurrentVideoId || null;
                        this.normalizePlayback();
                        resolve();
                    });
                });
            }
        },

        normalizePlayback() {
            const items = this.getActiveItems();
            if (!items.length) {
                this.currentIndex = -1;
                if (this.activeSource) this.currentVideoId = null;
                return;
            }
            this.currentIndex = Math.min(Math.max(this.currentIndex, 0), items.length - 1);
            this.currentVideoId = items[this.currentIndex];
        },

        async savePlayback() {
            if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
            await chrome.storage.local.set({
                ytPreviewQueue: this.queue,
                ytPreviewActiveSource: this.activeSource,
                ytPreviewCurrentIndex: this.currentIndex,
                ytPreviewCurrentVideoId: this.currentVideoId
            });
        },

        commitPlayback() {
            this.savePlayback().catch(error => console.warn('[State] Could not persist playback:', error));
            this.notifyChange();
        },

        // Save lists to storage
        async saveLists() {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                return new Promise((resolve) => {
                    chrome.storage.local.set({ ytPreviewLists: this.lists }, resolve);
                });
            }
        },

        // Save video title
        async saveVideoTitle(videoId, title) {
            this.videoTitles[videoId] = title;
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                return new Promise((resolve) => {
                    chrome.storage.local.set({ ytVideoTitles: this.videoTitles }, resolve);
                });
            }
        },

        // Get video title
        getVideoTitle(videoId) {
            return this.videoTitles[videoId] || null;
        },

        // Create a new list
        async createList(name) {
            const id = 'list_' + Date.now();
            this.lists[id] = { name, items: [] };
            await this.saveLists();
            return id;
        },

        // Rename a list
        async renameList(listId, newName) {
            if (!this.lists[listId]) {
                console.warn('[List] List not found:', listId);
                return false;
            }
            this.lists[listId].name = newName;
            await this.saveLists();
            console.log('[List] Renamed:', listId, 'to', newName);
            this.notifyChange();
            return true;
        },

        // Delete a list
        async deleteList(listId) {
            if (!this.lists[listId]) {
                console.warn('[List] List not found:', listId);
                return false;
            }
            // If this list is active, switch to queue
            if (this.activeSource === `list:${listId}`) {
                this.activeSource = 'queue';
                this.currentIndex = this.queue.length > 0 ? 0 : -1;
            }
            delete this.lists[listId];
            await this.saveLists();
            console.log('[List] Deleted:', listId);
            this.commitPlayback();
            return true;
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
            this.commitPlayback();
        },

        // Queue insert: insert after current
        queueInsert(videoId) {
            if (this.activeSource !== 'queue') {
                // Switch to queue mode
                this.activeSource = 'queue';
                this.queue = this.currentVideoId ? [this.currentVideoId] : [];
                this.currentIndex = this.queue.length > 0 ? 0 : -1;
            }
            // Remove duplicate if exists
            const existingIdx = this.queue.indexOf(videoId);
            if (existingIdx !== -1) {
                this.queue.splice(existingIdx, 1);
                if (existingIdx <= this.currentIndex) {
                    this.currentIndex--;
                }
            }
            // Insert after current position (or at start if nothing playing)
            const insertPos = Math.max(0, this.currentIndex + 1);
            this.queue.splice(insertPos, 0, videoId);
            // If nothing was playing, set index to new item
            if (this.currentIndex < 0) {
                this.currentIndex = 0;
            }
            console.log('[Queue] Insert:', videoId, 'Queue:', this.queue, 'Index:', this.currentIndex);
            this.commitPlayback();
        },

        // Queue append: add to end
        queueAppend(videoId) {
            if (this.activeSource !== 'queue') {
                this.activeSource = 'queue';
                this.queue = this.currentVideoId ? [this.currentVideoId] : [];
                this.currentIndex = this.queue.length > 0 ? 0 : -1;
            }
            // Remove duplicate if exists
            const existingIdx = this.queue.indexOf(videoId);
            if (existingIdx !== -1) {
                this.queue.splice(existingIdx, 1);
                if (existingIdx <= this.currentIndex) {
                    this.currentIndex--;
                }
            }
            this.queue.push(videoId);
            // If nothing was playing, set index to first item
            if (this.currentIndex < 0) {
                this.currentIndex = 0;
            }
            console.log('[Queue] Append:', videoId, 'Queue:', this.queue, 'Index:', this.currentIndex);
            this.commitPlayback();
        },

        // List insert: insert after current in specified list
        // Does NOT change active source - just adds to the list
        async listInsert(listId, videoId) {
            if (!this.lists[listId]) {
                console.warn('[List] List not found:', listId);
                return;
            }

            // Remove duplicate if exists
            const items = this.lists[listId].items;
            const existingIdx = items.indexOf(videoId);
            if (existingIdx !== -1) {
                items.splice(existingIdx, 1);
                if (this.activeSource === `list:${listId}` && existingIdx <= this.currentIndex) {
                    this.currentIndex--;
                }
            }

            // If this list is the active source, insert after current position
            if (this.activeSource === `list:${listId}`) {
                const insertPos = Math.max(0, this.currentIndex + 1);
                items.splice(insertPos, 0, videoId);
            } else {
                // Otherwise just add to end (since there's no "current position" in inactive list)
                items.push(videoId);
            }

            await this.saveLists();
            console.log('[List] Insert:', videoId, 'to list:', listId, 'Items:', this.lists[listId].items);
            if (this.activeSource === `list:${listId}`) this.commitPlayback();
            else this.notifyChange();
        },

        // List append: add to end of specified list
        // Does NOT change active source - just adds to the list
        async listAppend(listId, videoId) {
            if (!this.lists[listId]) {
                console.warn('[List] List not found:', listId);
                return;
            }

            // Remove duplicate if exists
            const items = this.lists[listId].items;
            const existingIdx = items.indexOf(videoId);
            if (existingIdx !== -1) {
                items.splice(existingIdx, 1);
                if (this.activeSource === `list:${listId}` && existingIdx <= this.currentIndex) {
                    this.currentIndex--;
                }
            }

            items.push(videoId);
            await this.saveLists();
            console.log('[List] Append:', videoId, 'to list:', listId, 'Items:', this.lists[listId].items);
            if (this.activeSource === `list:${listId}`) this.commitPlayback();
            else this.notifyChange();
        },

        // Navigation (respects repeatMode and shuffleMode from outer scope)
        hasNext() {
            const items = this.getActiveItems();
            if (items.length === 0) return false;
            // With repeat, there's always a next (loops back)
            if (typeof repeatMode !== 'undefined' && repeatMode) return true;
            return this.currentIndex < items.length - 1;
        },

        hasPrevious() {
            const items = this.getActiveItems();
            if (items.length === 0) return false;
            // With repeat, there's always a previous (loops back)
            if (typeof repeatMode !== 'undefined' && repeatMode) return true;
            return this.currentIndex > 0;
        },

        next() {
            const items = this.getActiveItems();
            if (items.length === 0) return null;

            // Shuffle mode: pick random video (different from current if possible)
            if (typeof shuffleMode !== 'undefined' && shuffleMode && items.length > 1) {
                let randomIndex;
                do {
                    randomIndex = Math.floor(Math.random() * items.length);
                } while (randomIndex === this.currentIndex && items.length > 1);
                this.currentIndex = randomIndex;
                this.currentVideoId = items[this.currentIndex];
                this.commitPlayback();
                return this.currentVideoId;
            }

            // Normal next
            if (this.currentIndex < items.length - 1) {
                this.currentIndex++;
                this.currentVideoId = items[this.currentIndex];
                this.commitPlayback();
                return this.currentVideoId;
            }

            // Repeat mode: loop back to start
            if (typeof repeatMode !== 'undefined' && repeatMode && items.length > 0) {
                this.currentIndex = 0;
                this.currentVideoId = items[0];
                this.commitPlayback();
                return this.currentVideoId;
            }

            return null;
        },

        previous() {
            const items = this.getActiveItems();
            if (items.length === 0) return null;

            // Shuffle mode: pick random video
            if (typeof shuffleMode !== 'undefined' && shuffleMode && items.length > 1) {
                let randomIndex;
                do {
                    randomIndex = Math.floor(Math.random() * items.length);
                } while (randomIndex === this.currentIndex && items.length > 1);
                this.currentIndex = randomIndex;
                this.currentVideoId = items[this.currentIndex];
                this.commitPlayback();
                return this.currentVideoId;
            }

            // Normal previous
            if (this.currentIndex > 0) {
                this.currentIndex--;
                this.currentVideoId = items[this.currentIndex];
                this.commitPlayback();
                return this.currentVideoId;
            }

            // Repeat mode: loop to end
            if (typeof repeatMode !== 'undefined' && repeatMode && items.length > 0) {
                this.currentIndex = items.length - 1;
                this.currentVideoId = items[this.currentIndex];
                this.commitPlayback();
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
            console.log('[Source] Switched to:', source, 'Items:', items.length);
            this.commitPlayback();
        },

        // Get position info
        getPositionInfo() {
            const items = this.getActiveItems();
            if (!this.activeSource || items.length === 0) return null;
            return `${this.currentIndex + 1}/${items.length}`;
        }
    };

    // Load lists on init
    const playbackReady = PlaybackState.loadLists().then(() => {
        refreshAllDropdowns();
        injectPlaylistPanelButtons();
    });

    // --- Load Settings ---
    let currentStrategy = 'pip'; // Default
    let iframeProxyUrl = 'https://daltoncabrera.github.io/youtube-video-preview';
    let defSize = 'medium';
    let defPos = 'bottom-right';
    let btnPos = 'top-left'; // Button Default
    let repeatMode = false;
    let shuffleMode = false;

    function loadSettings() {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['strategy', 'proxyUrl', 'defSize', 'defPos', 'btnPos', 'repeatMode', 'shuffleMode'], (result) => {
                if (result.strategy) currentStrategy = result.strategy;
                if (result.proxyUrl) iframeProxyUrl = result.proxyUrl;
                if (result.defSize) defSize = result.defSize;
                if (result.defPos) defPos = result.defPos;
                if (result.btnPos) btnPos = result.btnPos;
                repeatMode = result.repeatMode === true;
                shuffleMode = result.shuffleMode === true;
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
                if (changes.repeatMode !== undefined) repeatMode = changes.repeatMode.newValue;
                if (changes.shuffleMode !== undefined) shuffleMode = changes.shuffleMode.newValue;
                if (changes.ytPreviewLists) PlaybackState.lists = changes.ytPreviewLists.newValue || {};
                if (changes.ytVideoTitles) PlaybackState.videoTitles = changes.ytVideoTitles.newValue || {};
                if (changes.ytPreviewQueue) PlaybackState.queue = changes.ytPreviewQueue.newValue || [];
                if (changes.ytPreviewActiveSource) PlaybackState.activeSource = changes.ytPreviewActiveSource.newValue || null;
                if (changes.ytPreviewCurrentIndex) PlaybackState.currentIndex = changes.ytPreviewCurrentIndex.newValue;
                if (changes.ytPreviewCurrentVideoId) PlaybackState.currentVideoId = changes.ytPreviewCurrentVideoId.newValue || null;

                if (changes.ytPreviewLists || changes.ytPreviewQueue || changes.ytPreviewActiveSource ||
                    changes.ytPreviewCurrentIndex || changes.ytPreviewCurrentVideoId) {
                    PlaybackState.normalizePlayback();
                    PlaybackState.notifyChange();
                }

                // Apply Live Updates to Active Overlay
                const overlay = document.querySelector('.yt-preview-embed-overlay');
                if (overlay && (changes.defSize || changes.defPos)) {
                    // Determine values to use (newly updated globals)
                    const size = getInitialSize(defSize);
                    const pos = getInitialPosition(defPos, size.width, size.height);

                    Object.assign(overlay.style, {
                        width: size.width + 'px',
                        height: (size.height + 76) + 'px',
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
    let thumbnailScanTimer = null;
    const scheduleThumbnailScan = () => {
        if (thumbnailScanTimer) return;
        thumbnailScanTimer = setTimeout(() => {
            thumbnailScanTimer = null;
            processThumbnails();
        }, 250);
    };

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
            scheduleThumbnailScan();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // JUST-IN-TIME injection and portal activation. pointerover runs before a
    // possible pointerdown/click, so moving the control cannot cancel the
    // user's first click.
    document.body.addEventListener('pointerover', (e) => {
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
                if (!thumbnail.querySelector(`.${PREVIEW_WRAPPER_CLASS}`)) {
                    createPreviewButton(thumbnail, anchor.getAttribute("href"));
                }
                const activeWrapper = previewWrappersByHost.get(thumbnail);
                if (activeWrapper?._floatAboveYouTube) activeWrapper._floatAboveYouTube(e);
            }
        }
    }, true); // Capture phase

    // Periodic cleanup/check
    setInterval(processThumbnails, 5000);

    // Check for playlist panel on watch pages
    setInterval(injectPlaylistPanelButtons, 4000);

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

            if (target.closest('[aria-hidden="true"]')) return;

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
        // Keep the control in the thumbnail's own stacking context. YouTube adds
        // hover overlays inside the thumbnail that can otherwise sit above a
        // button appended to the outer card.
        const buttonHost = targetContainer;
        const videoId = extractVideoId(videoUrl);
        if (!videoId) return;

        // Check if wrapper already exists, including when it is temporarily
        // portaled to document.body to escape YouTube's stacking contexts.
        let wrapper = previewWrappersByHost.get(buttonHost)
            || buttonHost.querySelector(`:scope > .${PREVIEW_WRAPPER_CLASS}`);

        if (wrapper) {
            // Update video ID if changed
            if (wrapper.dataset.videoId !== videoId) {
                wrapper.dataset.videoId = videoId;
            }
            return;
        }

        // Extract video title from the container
        const videoTitle = extractVideoTitle(container);

        // Create wrapper element
        wrapper = document.createElement("div");
        wrapper.className = `${PREVIEW_WRAPPER_CLASS} ${btnPos}`;
        wrapper.dataset.videoId = videoId;
        wrapper.dataset.videoTitle = videoTitle || '';
        wrapper._previewContainer = container;

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
        const style = window.getComputedStyle(buttonHost);
        if (style.position === 'static') {
            buttonHost.style.position = 'relative';
        }
        buttonHost.style.isolation = 'isolate';

        // Event handlers
        setupDropdownEvents(wrapper, dropdown);
        mainBtn.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
            mainBtn.dataset.ignoreNextClick = 'true';
            dropdown.querySelector('[data-action="preview-now"]')?.click();
            setTimeout(() => { delete mainBtn.dataset.ignoreNextClick; }, 500);
        });
        mainBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (mainBtn.dataset.ignoreNextClick === 'true') {
                delete mainBtn.dataset.ignoreNextClick;
                return;
            }
            dropdown.querySelector('[data-action="preview-now"]')?.click();
        });

        buttonHost.appendChild(wrapper);
        previewWrappersByHost.set(buttonHost, wrapper);
        setupFloatingPreviewLayer(wrapper, buttonHost);
        adjustWrapperPosition(wrapper, buttonHost);
    }

    function setupFloatingPreviewLayer(wrapper, host) {
        let restoreTimer = null;
        let watchdogInterval = null;
        let isFloating = false;
        let anchorRect = null;
        let lastPointer = null;

        const pointInsideRect = (point, rect) => Boolean(point && rect
            && point.x >= rect.left && point.x <= rect.right
            && point.y >= rect.top && point.y <= rect.bottom);

        const positionFloatingWrapper = () => {
            if (!anchorRect) return;
            const margin = 10;
            Object.assign(wrapper.style, {
                display: 'block',
                visibility: 'visible',
                opacity: '1',
                position: 'fixed',
                zIndex: String(Z_INDEX_POPUP),
                top: (anchorRect.top + margin) + 'px',
                right: 'auto',
                bottom: 'auto',
                left: btnPos === 'top-right'
                    ? 'auto'
                    : btnPos === 'center'
                        ? (anchorRect.left + anchorRect.width / 2) + 'px'
                        : (anchorRect.left + margin) + 'px',
                transform: btnPos === 'center' ? 'translateX(-50%)' : 'none'
            });

            if (btnPos === 'top-right') {
                wrapper.style.right = (window.innerWidth - anchorRect.right + margin) + 'px';
            }
        };

        const keepPreviewAlive = () => {
            if (!isFloating) return;
            if (wrapper.parentElement !== document.body) document.body.appendChild(wrapper);
            wrapper.classList.add('floating');
            positionFloatingWrapper();
        };

        const restore = () => {
            clearTimeout(restoreTimer);
            clearInterval(watchdogInterval);
            watchdogInterval = null;
            isFloating = false;
            document.removeEventListener('pointermove', handlePointerMove, true);
            if (host.isConnected) host.appendChild(wrapper);
            else wrapper.remove();
            wrapper.classList.remove('floating');
            wrapper.style.removeProperty('display');
            wrapper.style.removeProperty('visibility');
            wrapper.style.removeProperty('opacity');
            wrapper.style.removeProperty('position');
            wrapper.style.removeProperty('z-index');
            wrapper.style.removeProperty('top');
            wrapper.style.removeProperty('right');
            wrapper.style.removeProperty('bottom');
            wrapper.style.removeProperty('left');
            wrapper.style.removeProperty('transform');
        };

        const scheduleRestore = () => {
            clearTimeout(restoreTimer);
            restoreTimer = setTimeout(() => {
                const wrapperRect = wrapper.isConnected ? wrapper.getBoundingClientRect() : null;
                const stillInside = pointInsideRect(lastPointer, anchorRect)
                    || pointInsideRect(lastPointer, wrapperRect)
                    || (lastPointer?.target instanceof Node && wrapper.contains(lastPointer.target));

                if (stillInside) {
                    keepPreviewAlive();
                    return;
                }
                restore();
            }, 300);
        };

        const handlePointerMove = (event) => {
            if (!isFloating) return;
            lastPointer = { x: event.clientX, y: event.clientY, target: event.target };
            const rect = anchorRect;
            const insideThumbnail = pointInsideRect(lastPointer, rect);
            const insidePreview = event.target instanceof Node && wrapper.contains(event.target);

            if (insideThumbnail || insidePreview) {
                clearTimeout(restoreTimer);
            } else {
                scheduleRestore();
            }
        };

        const floatAboveYouTube = (event) => {
            clearTimeout(restoreTimer);
            if (!host.isConnected) return;

            if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
                lastPointer = { x: event.clientX, y: event.clientY, target: event.target };
            }
            if (isFloating && wrapper.parentElement === document.body) {
                keepPreviewAlive();
                return;
            }
            anchorRect = host.getBoundingClientRect();
            isFloating = true;
            wrapper.classList.add('floating');
            document.body.appendChild(wrapper);
            document.addEventListener('pointermove', handlePointerMove, true);
            keepPreviewAlive();
            clearInterval(watchdogInterval);
            watchdogInterval = setInterval(keepPreviewAlive, 100);
        };

        wrapper._floatAboveYouTube = floatAboveYouTube;

        host.addEventListener('mouseenter', floatAboveYouTube);
        wrapper.addEventListener('mouseenter', () => clearTimeout(restoreTimer));

        // Move out of YouTube's clickable card before the browser creates the
        // subsequent click event. This prevents delegated SPA navigation from
        // treating extension menu actions as clicks on the video link.
        wrapper.addEventListener('pointerdown', (event) => {
            event.stopPropagation();
        });
        wrapper.addEventListener('mousedown', (event) => {
            event.stopPropagation();
        });
        wrapper.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        wrapper.addEventListener('auxclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
    }

    // Build dropdown HTML
    function buildDropdownHTML() {
        let html = `<div class="yt-preview-dropdown-inner">
            <div class="yt-preview-dropdown-header">Queue</div>
            <button class="yt-preview-dropdown-item primary" data-action="preview-now">
                ▶ Preview Now
            </button>
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
                            ${escapeHTML(list.name)} <span class="icon">▶</span>
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

    // Helper to add single video
    function addSingleVideo(action, videoId, videoTitle, listId) {
        if (videoId && videoTitle) {
            PlaybackState.saveVideoTitle(videoId, videoTitle);
        }

        switch (action) {
            case 'queue-insert':
                PlaybackState.queueInsert(videoId);
                showNotification('Added to queue (next)');
                if (!PlaybackState.isPlaying && !PlaybackState.pipWindow) {
                    PlaybackState.currentVideoId = videoId;
                    PlaybackState.currentIndex = PlaybackState.queue.indexOf(videoId);
                    openPreview(`https://www.youtube.com/watch?v=${videoId}`);
                }
                break;
            case 'queue-append':
                PlaybackState.queueAppend(videoId);
                showNotification('Added to queue');
                if (!PlaybackState.isPlaying && !PlaybackState.pipWindow) {
                    PlaybackState.currentVideoId = videoId;
                    PlaybackState.currentIndex = PlaybackState.queue.indexOf(videoId);
                    openPreview(`https://www.youtube.com/watch?v=${videoId}`);
                }
                break;
            case 'list-insert':
                PlaybackState.listInsert(listId, videoId);
                showNotification(`Added to ${PlaybackState.lists[listId].name}`);
                refreshAllDropdowns();
                break;
            case 'list-append':
                PlaybackState.listAppend(listId, videoId);
                showNotification(`Added to ${PlaybackState.lists[listId].name}`);
                refreshAllDropdowns();
                break;
        }
    }

    // Helper to add all playlist videos
    async function addAllPlaylistVideos(action, listId, playlistName) {
        const videos = getPlaylistVideoIds();
        if (videos.length === 0) {
            showNotification('No videos found in playlist');
            return;
        }

        // Save all titles
        for (const v of videos) {
            if (v.title) {
                PlaybackState.saveVideoTitle(v.videoId, v.title);
            }
        }

        if (action === 'new-list') {
            // Create new list with playlist name
            const newListId = await PlaybackState.createList(playlistName);
            for (const v of videos) {
                await PlaybackState.listAppend(newListId, v.videoId);
            }
            showNotification(`Created "${playlistName}" with ${videos.length} videos`);
            refreshAllDropdowns();
        } else {
            // Add to current source (queue or active list)
            if (PlaybackState.activeSource === 'queue' || !PlaybackState.activeSource) {
                for (const v of videos) {
                    PlaybackState.queueAppend(v.videoId);
                }
                showNotification(`Added ${videos.length} videos to queue`);
            } else if (PlaybackState.activeSource.startsWith('list:')) {
                const currentListId = PlaybackState.activeSource.replace('list:', '');
                for (const v of videos) {
                    await PlaybackState.listAppend(currentListId, v.videoId);
                }
                showNotification(`Added ${videos.length} videos to ${PlaybackState.lists[currentListId].name}`);
                refreshAllDropdowns();
            }
        }
        PlaybackState.notifyChange();
    }

    // Setup dropdown event handlers
    function setupDropdownEvents(wrapper, dropdown) {
        if (dropdown.dataset.eventsBound === 'true') return;
        dropdown.dataset.eventsBound = 'true';

        // Document PiP requires transient user activation. Execute menu actions
        // during the trusted pointerdown instead of waiting for a delegated
        // click, which YouTube can delay or consume on the first interaction.
        dropdown.addEventListener('pointerdown', (event) => {
            const button = event.target.closest('[data-action]');
            if (!button) return;

            event.preventDefault();
            event.stopPropagation();
            button.dataset.ignoreNextTrustedClick = 'true';
            button.click();

            setTimeout(() => {
                delete button.dataset.ignoreNextTrustedClick;
            }, 500);
        });

        dropdown.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            if (e.isTrusted && btn.dataset.ignoreNextTrustedClick === 'true') {
                delete btn.dataset.ignoreNextTrustedClick;
                return;
            }

            const action = btn.dataset.action;
            const videoId = wrapper.dataset.videoId;
            const videoTitle = wrapper.dataset.videoTitle;
            const listId = btn.dataset.listId;

            // Check if this is a playlist item (for queue/list add actions)
            const container = wrapper._previewContainer
                || wrapper.closest('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-rich-item-renderer, ytd-video-renderer');
            const videoUrl = container?.querySelector('a[href*="/watch"]')?.href || `https://www.youtube.com/watch?v=${videoId}`;
            const playlistInfo = detectYouTubePlaylist(container, videoUrl);

            // For queue/list actions, check if we should show playlist dialog
            if (playlistInfo && ['queue-insert', 'queue-append', 'list-insert', 'list-append'].includes(action)) {
                showPlaylistActionDialog(playlistInfo, videoId, videoTitle, async (dialogAction) => {
                    if (!dialogAction) return; // Cancelled

                    if (dialogAction === 'single') {
                        addSingleVideo(action, videoId, videoTitle, listId);
                    } else if (dialogAction === 'all-new') {
                        await addAllPlaylistVideos('new-list', null, playlistInfo.name);
                    } else if (dialogAction === 'all-current') {
                        await addAllPlaylistVideos('current', null, null);
                    }
                });
                return;
            }

            // Save video title if we have one
            if (videoId && videoTitle) {
                PlaybackState.saveVideoTitle(videoId, videoTitle);
            }

            switch (action) {
                case 'preview-now':
                    // Preview Now: insert into queue and play immediately
                    if (PlaybackState.activeSource !== 'queue') {
                        // Switch to queue mode, keeping current video if any
                        PlaybackState.activeSource = 'queue';
                        if (PlaybackState.currentVideoId && !PlaybackState.queue.includes(PlaybackState.currentVideoId)) {
                            PlaybackState.queue = [PlaybackState.currentVideoId];
                            PlaybackState.currentIndex = 0;
                        } else {
                            PlaybackState.queue = [];
                            PlaybackState.currentIndex = -1;
                        }
                    }
                    // Insert after current position
                    const insertPos = Math.max(0, PlaybackState.currentIndex + 1);
                    PlaybackState.queue.splice(insertPos, 0, videoId);
                    // Move to the inserted video
                    PlaybackState.currentIndex = insertPos;
                    PlaybackState.currentVideoId = videoId;
                    PlaybackState.commitPlayback();
                    console.log('[Preview Now] Inserted and playing:', videoId, 'Queue:', PlaybackState.queue, 'Index:', PlaybackState.currentIndex);
                    PlaybackState.commitPlayback();
                    openPreview(`https://www.youtube.com/watch?v=${videoId}`);
                    break;

                case 'queue-insert':
                    PlaybackState.queueInsert(videoId);
                    showNotification('Added to queue (next)');
                    // Only start playback if nothing is currently playing and no PiP window exists
                    if (!PlaybackState.isPlaying && !PlaybackState.pipWindow) {
                        PlaybackState.currentVideoId = videoId;
                        PlaybackState.currentIndex = PlaybackState.queue.indexOf(videoId);
                        openPreview(`https://www.youtube.com/watch?v=${videoId}`);
                    }
                    break;

                case 'queue-append':
                    PlaybackState.queueAppend(videoId);
                    showNotification('Added to queue');
                    // Only start playback if nothing is currently playing and no PiP window exists
                    if (!PlaybackState.isPlaying && !PlaybackState.pipWindow) {
                        PlaybackState.currentVideoId = videoId;
                        PlaybackState.currentIndex = PlaybackState.queue.indexOf(videoId);
                        openPreview(`https://www.youtube.com/watch?v=${videoId}`);
                    }
                    break;

                case 'list-insert':
                    await PlaybackState.listInsert(listId, videoId);
                    showNotification(`Added to ${PlaybackState.lists[listId].name}`);
                    refreshAllDropdowns();
                    // Do NOT auto-play - just add to list
                    break;

                case 'list-append':
                    await PlaybackState.listAppend(listId, videoId);
                    showNotification(`Added to ${PlaybackState.lists[listId].name}`);
                    refreshAllDropdowns();
                    // Do NOT auto-play - just add to list
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

    // Helper to extract video title from container element
    function extractVideoTitle(container) {
        // For mix/playlist items, we need to be careful to get the individual video title
        // not the playlist/mix name. The key is to look for #video-title within the
        // item's metadata section, which always contains the specific video's title.

        // Check if this is a playlist/mix item (various renderers)
        const isPlaylistItem = container.matches('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer') ||
            container.closest('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer');

        // Check if we're on a mix/watch page with playlist panel
        const isInMixPanel = container.closest('ytd-playlist-panel-renderer') ||
            container.closest('ytd-watch-next-secondary-results-renderer');

        // Priority 1: For playlist/mix items, get the video title from within the item itself
        if (isPlaylistItem || isInMixPanel) {
            // Look for the video title element within the specific video item
            const videoTitleEl = container.querySelector('#video-title, a#video-title, [id="video-title"]');
            if (videoTitleEl) {
                // The title attribute has the full untruncated title
                const title = videoTitleEl.getAttribute('title') || videoTitleEl.textContent?.trim();
                if (title) return title;
            }
        }

        // Priority 2: Standard video title selectors (for regular video cards)
        const selectors = [
            '#video-title',
            '#video-title-link',
            'a#video-title',
            '[id="video-title"]',
            'yt-formatted-string#video-title',
            'h3 a',
            '.title'
        ];

        for (const selector of selectors) {
            const el = container.querySelector(selector);
            if (el) {
                // Prefer title attribute (has full title), then text content
                const title = el.getAttribute('title') || el.textContent?.trim() || el.getAttribute('aria-label');
                if (title) return title;
            }
        }

        // Priority 3: Try aria-label on video links (extract just the video name)
        const links = container.querySelectorAll('a[href*="/watch"], a[href*="/shorts/"]');
        for (const link of links) {
            const label = link.getAttribute('aria-label') || link.getAttribute('title');
            if (label) {
                // aria-label often contains extra info like "Video Title by Channel - 1M views - 10 minutes"
                // Extract just the video title part (before " by ")
                const cleanTitle = label.split(' by ')[0].trim();
                if (cleanTitle) return cleanTitle;
            }
        }

        // Priority 4: For mix videos on home/search pages, check parent elements
        // Mix videos can appear as regular video cards but might have different structure
        const parentItem = container.closest('ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer');
        if (parentItem && parentItem !== container) {
            const titleEl = parentItem.querySelector('#video-title, a#video-title');
            if (titleEl) {
                const title = titleEl.getAttribute('title') || titleEl.textContent?.trim();
                if (title) return title;
            }
        }

        return null;
    }

    // Helper to detect if video is part of a YouTube playlist
    function detectYouTubePlaylist(container, videoUrl) {
        // Guard against null container
        if (!container) return null;

        // Check if container is a playlist item
        const isPlaylistItem = container.matches('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer') ||
            container.closest('ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer') ||
            container.closest('ytd-playlist-video-list-renderer');

        if (!isPlaylistItem) return null;

        // Try to get playlist ID from URL
        try {
            const url = new URL(videoUrl, 'https://www.youtube.com');
            const listId = url.searchParams.get('list');
            if (!listId) return null;

            // Get playlist name
            let playlistName = null;

            // Try to find playlist title in the page
            const playlistTitleEl = document.querySelector(
                'ytd-playlist-header-renderer #container h1 a, ' +
                'ytd-playlist-header-renderer .metadata-wrapper yt-formatted-string, ' +
                '#playlist-header h3 a, ' +
                'ytd-playlist-panel-renderer #playlist-title, ' +
                '#header-description h3'
            );
            if (playlistTitleEl) {
                playlistName = playlistTitleEl.textContent?.trim() || playlistTitleEl.getAttribute('title');
            }

            // Count videos in playlist
            const playlistItems = document.querySelectorAll(
                'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer'
            );

            return {
                listId,
                name: playlistName || 'YouTube Playlist',
                videoCount: playlistItems.length
            };
        } catch (e) {
            return null;
        }
    }

    // Get all video IDs from a YouTube playlist on the page
    function getPlaylistVideoIds() {
        const items = document.querySelectorAll(
            'ytd-playlist-video-renderer a#video-title, ' +
            'ytd-playlist-panel-video-renderer a#video-title'
        );
        const videos = [];
        items.forEach(item => {
            const href = item.getAttribute('href');
            if (href) {
                const videoId = extractVideoId(href);
                const title = item.getAttribute('title') || item.textContent?.trim();
                if (videoId) {
                    videos.push({ videoId, title });
                }
            }
        });
        return videos;
    }

    // Show playlist action dialog
    function showPlaylistActionDialog(playlistInfo, videoId, videoTitle, callback) {
        // Remove existing dialog if any
        const existing = document.querySelector('.yt-preview-playlist-dialog');
        if (existing) existing.remove();

        const dialog = document.createElement('div');
        dialog.className = 'yt-preview-playlist-dialog';
        dialog.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(28, 28, 28, 0.98);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 12px;
            padding: 20px;
            z-index: 2147483647;
            min-width: 320px;
            max-width: 400px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
            font-family: 'YouTube Sans', 'Roboto', sans-serif;
        `;

        dialog.innerHTML = `
            <div style="margin-bottom: 16px;">
                <h3 style="margin: 0 0 8px 0; color: #fff; font-size: 16px;">Playlist Detected</h3>
                <p style="margin: 0; color: #aaa; font-size: 12px;">${escapeHTML(playlistInfo.name)} (${playlistInfo.videoCount} videos)</p>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px;">
                <button class="dialog-btn" data-action="single" style="
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    padding: 10px 16px;
                    color: #fff;
                    font-size: 13px;
                    cursor: pointer;
                    text-align: left;
                ">
                    <strong>Add this video only</strong>
                    <span style="display: block; font-size: 11px; color: #888; margin-top: 2px;">${escapeHTML(videoTitle || videoId)}</span>
                </button>
                <button class="dialog-btn" data-action="all-new" style="
                    background: rgba(255, 0, 0, 0.2);
                    border: 1px solid rgba(255, 0, 0, 0.3);
                    border-radius: 6px;
                    padding: 10px 16px;
                    color: #fff;
                    font-size: 13px;
                    cursor: pointer;
                    text-align: left;
                ">
                    <strong>Import entire playlist</strong>
                    <span style="display: block; font-size: 11px; color: #888; margin-top: 2px;">Create new list: "${escapeHTML(playlistInfo.name)}"</span>
                </button>
                <button class="dialog-btn" data-action="all-current" style="
                    background: rgba(255, 255, 255, 0.1);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 6px;
                    padding: 10px 16px;
                    color: #fff;
                    font-size: 13px;
                    cursor: pointer;
                    text-align: left;
                ">
                    <strong>Add all to current queue/list</strong>
                    <span style="display: block; font-size: 11px; color: #888; margin-top: 2px;">Append ${playlistInfo.videoCount} videos</span>
                </button>
            </div>
            <button class="dialog-cancel" style="
                position: absolute;
                top: 12px;
                right: 12px;
                background: none;
                border: none;
                color: #888;
                font-size: 18px;
                cursor: pointer;
                padding: 4px;
            ">✕</button>
        `;

        // Add backdrop
        const backdrop = document.createElement('div');
        backdrop.className = 'yt-preview-playlist-backdrop';
        backdrop.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 2147483646;
        `;

        document.body.appendChild(backdrop);
        document.body.appendChild(dialog);

        // Handle button clicks
        dialog.querySelectorAll('.dialog-btn').forEach(btn => {
            btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(255, 0, 0, 0.3)');
            btn.addEventListener('mouseleave', () => {
                if (btn.dataset.action === 'all-new') {
                    btn.style.background = 'rgba(255, 0, 0, 0.2)';
                } else {
                    btn.style.background = 'rgba(255, 255, 255, 0.1)';
                }
            });
            btn.addEventListener('click', () => {
                backdrop.remove();
                dialog.remove();
                callback(btn.dataset.action);
            });
        });

        // Handle cancel
        dialog.querySelector('.dialog-cancel').addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
            callback(null);
        });

        backdrop.addEventListener('click', () => {
            backdrop.remove();
            dialog.remove();
            callback(null);
        });
    }

    // --- Helper: Close YouTube's native mini player ---
    let miniPlayerObserver = null;

    function closeYouTubeMiniPlayer() {
        try {
            // Find YouTube's mini player element
            const miniPlayer = document.querySelector('ytd-miniplayer[active]');
            if (miniPlayer) {
                // Try clicking the close button
                const closeBtn = miniPlayer.querySelector('.ytp-miniplayer-close-button, button[aria-label="Close"]');
                if (closeBtn) {
                    closeBtn.click();
                    console.log('[YouTube Preview] Closed YouTube mini player via button');
                } else {
                    // Fallback: remove active attribute
                    miniPlayer.removeAttribute('active');
                    console.log('[YouTube Preview] Closed YouTube mini player via attribute');
                }
            }

            // Also try to pause any playing video in the main player
            const mainVideo = document.querySelector('video.html5-main-video');
            if (mainVideo && !mainVideo.paused) {
                mainVideo.pause();
                console.log('[YouTube Preview] Paused main YouTube video');
            }
        } catch (err) {
            console.warn('[YouTube Preview] Error closing mini player:', err);
        }
    }

    // Interval-based watcher for YouTube mini player
    let miniPlayerWatcherInterval = null;

    function startMiniPlayerWatcher() {
        if (miniPlayerWatcherInterval) return; // Already watching

        console.log('[YouTube Preview] Starting mini player watcher');

        miniPlayerWatcherInterval = setInterval(() => {
            // Check if mini player is active
            const miniPlayer = document.querySelector('ytd-miniplayer');
            if (miniPlayer && miniPlayer.hasAttribute('active')) {
                console.log('[YouTube Preview] Detected active mini player, closing it');
                closeYouTubeMiniPlayer();
            }

            // Also check for video playing in mini player
            const miniPlayerVideo = document.querySelector('ytd-miniplayer video');
            if (miniPlayerVideo && !miniPlayerVideo.paused) {
                miniPlayerVideo.pause();
                console.log('[YouTube Preview] Paused mini player video');
            }
        }, 500); // Check every 500ms
    }

    function stopMiniPlayerWatcher() {
        if (miniPlayerWatcherInterval) {
            clearInterval(miniPlayerWatcherInterval);
            miniPlayerWatcherInterval = null;
            console.log('[YouTube Preview] Stopped mini player watcher');
        }
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

    function getProxyOrigin(videoId) {
        try {
            return new URL(getProxyUrl(videoId), window.location.href).origin;
        } catch {
            return '*';
        }
    }

    function loadVideoWithoutReplacingFrame(iframe, videoId) {
        if (!iframe?.contentWindow || !videoId) return false;
        iframe.contentWindow.postMessage(
            { action: 'loadVideo', videoId },
            getProxyOrigin(videoId)
        );
        return true;
    }

    function controlIcon(name) {
        const paths = {
            previous: '<path d="M7 5v14M18 6l-8 6 8 6V6z"/>',
            next: '<path d="M17 5v14M6 6l8 6-8 6V6z"/>',
            pause: '<path d="M8 5h3v14H8zM14 5h3v14h-3z"/>',
            play: '<path d="M8 5v14l11-7z"/>',
            shuffle: '<path d="M4 7h3.5c4 0 5 10 9 10H20M17 14l3 3-3 3M4 17h3.5c1.5 0 2.6-1.4 3.7-3M17 4l3 3-3 3"/>',
            repeat: '<path d="M17 2l3 3-3 3M20 5H8a4 4 0 0 0-4 4v1M7 22l-3-3 3-3M4 19h12a4 4 0 0 0 4-4v-1"/>',
            list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
            focus: '<path d="M9 7l-5 5 5 5M4 12h11a5 5 0 0 1 5 5"/>'
        };
        return `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
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

            // Close YouTube's native mini player if active and start watching
            closeYouTubeMiniPlayer();
            startMiniPlayerWatcher();

            // Get size settings
            const size = getInitialSize(defSize);

            // Request PiP window
            const pipWindow = await window.documentPictureInPicture.requestWindow({
                width: size.width,
                height: size.height + 46
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
                            display: flex;
                            flex-direction: column;
                            width: 100%;
                            height: 100%;
                            min-height: 0;
                            background: #090909;
                        }
                        .pip-video-surface {
                            flex: 1;
                            min-height: 0;
                            background: #000;
                        }
                        iframe {
                            display: block;
                            width: 100%;
                            height: 100%;
                            border: none;
                        }
                        .pip-control-bar {
                            flex: 0 0 46px;
                            height: 46px;
                            background: linear-gradient(180deg, #18181b 0%, #101012 100%);
                            border-top: 1px solid rgba(255, 255, 255, 0.08);
                            display: flex;
                            align-items: center;
                            justify-content: space-between;
                            padding: 0 10px;
                            box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.18);
                        }
                        .pip-bar-left {
                            display: flex;
                            align-items: center;
                            gap: 6px;
                        }
                        .pip-bar-center {
                            display: flex;
                            align-items: center;
                            gap: 6px;
                        }
                        .pip-bar-right {
                            display: flex;
                            align-items: center;
                            gap: 6px;
                        }
                        .pip-bar-btn {
                            width: 32px;
                            height: 32px;
                            background: transparent;
                            border: 1px solid transparent;
                            color: #d8d8dc;
                            cursor: pointer;
                            padding: 7px;
                            border-radius: 9px;
                            transition: color .15s, background .15s, border-color .15s, transform .15s;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .pip-bar-btn svg, .pip-list-toggle svg {
                            width: 17px;
                            height: 17px;
                            fill: none;
                            stroke: currentColor;
                            stroke-width: 1.8;
                            stroke-linecap: round;
                            stroke-linejoin: round;
                        }
                        .pip-bar-btn:hover:not(:disabled) {
                            color: #fff;
                            background: rgba(255, 255, 255, 0.08);
                            border-color: rgba(255, 255, 255, 0.08);
                        }
                        .pip-bar-btn:disabled {
                            opacity: 0.3;
                            cursor: not-allowed;
                        }
                        .pip-bar-btn.pip-toggle-btn {
                            opacity: 0.58;
                        }
                        .pip-bar-btn.pip-toggle-btn.active {
                            opacity: 1;
                            color: #ff4e55;
                            background: rgba(255, 54, 62, 0.1);
                        }
                        .pip-bar-btn.pip-play-pause {
                            width: 36px;
                            height: 36px;
                            color: #f2f2f4;
                            background: rgba(255, 255, 255, 0.08);
                            border-color: rgba(255, 255, 255, 0.1);
                            border-radius: 50%;
                            padding: 9px;
                        }
                        .pip-bar-btn.pip-play-pause:hover:not(:disabled) {
                            color: #fff;
                            background: rgba(255, 255, 255, 0.14);
                            border-color: rgba(255, 255, 255, 0.16);
                            transform: scale(1.04);
                        }
                        .pip-source-indicator {
                            position: relative;
                            background: rgba(255, 255, 255, 0.055);
                            border: 1px solid rgba(255, 255, 255, 0.08);
                            color: #ededf0;
                            padding: 7px 9px;
                            border-radius: 9px;
                            font-size: 11px;
                            cursor: pointer;
                            white-space: nowrap;
                        }
                        .pip-source-indicator:hover {
                            background: rgba(255, 255, 255, 0.1);
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
                            display: flex;
                            align-items: center;
                            justify-content: space-between;
                            gap: 8px;
                        }
                        .pip-source-item:hover {
                            background: rgba(255, 255, 255, 0.1);
                        }
                        .pip-source-item.active {
                            background: rgba(255, 0, 0, 0.3);
                        }
                        .pip-source-item.disabled {
                            opacity: 0.4;
                            cursor: not-allowed;
                        }
                        .pip-source-item.disabled:hover {
                            background: none;
                        }
                        .pip-source-name {
                            flex: 1;
                            overflow: hidden;
                            text-overflow: ellipsis;
                            white-space: nowrap;
                        }
                        .pip-source-actions {
                            display: none;
                            gap: 4px;
                        }
                        .pip-source-item:hover .pip-source-actions {
                            display: flex;
                        }
                        .pip-list-action {
                            background: none;
                            border: none;
                            color: rgba(255, 255, 255, 0.6);
                            cursor: pointer;
                            font-size: 10px;
                            padding: 2px 4px;
                            border-radius: 3px;
                            line-height: 1;
                        }
                        .pip-list-action:hover {
                            background: rgba(255, 255, 255, 0.2);
                            color: white;
                        }
                        .pip-list-action[data-action="delete"]:hover,
                        .pip-list-action[data-action="clear-queue"]:hover {
                            background: rgba(255, 0, 0, 0.4);
                            color: white;
                        }
                        .pip-queue-counter {
                            color: rgba(255, 255, 255, 0.7);
                            font-size: 11px;
                            white-space: nowrap;
                        }
                        /* Sidebar Panel */
                        .pip-main-wrapper {
                            display: flex;
                            width: 100%;
                            height: 100%;
                        }
                        .pip-player-area {
                            flex: 1;
                            position: relative;
                            min-width: 0;
                        }
                        .pip-sidebar {
                            width: 0;
                            background: #1a1a1a;
                            border-left: 1px solid #333;
                            overflow: hidden;
                            transition: width 0.2s ease;
                            display: flex;
                            flex-direction: column;
                        }
                        .pip-sidebar.open {
                            width: 200px;
                        }
                        .pip-sidebar-header {
                            padding: 8px 10px;
                            background: #252525;
                            border-bottom: 1px solid #333;
                            font-size: 11px;
                            font-weight: 600;
                            color: #fff;
                            display: flex;
                            justify-content: space-between;
                            align-items: center;
                        }
                        .pip-sidebar-close {
                            background: none;
                            border: none;
                            color: #888;
                            cursor: pointer;
                            font-size: 14px;
                            padding: 0;
                            line-height: 1;
                        }
                        .pip-sidebar-close:hover {
                            color: #fff;
                        }
                        .pip-sidebar-list {
                            flex: 1;
                            overflow-y: auto;
                            overflow-x: hidden;
                        }
                        .pip-sidebar-list::-webkit-scrollbar {
                            width: 6px;
                        }
                        .pip-sidebar-list::-webkit-scrollbar-track {
                            background: #1a1a1a;
                        }
                        .pip-sidebar-list::-webkit-scrollbar-thumb {
                            background: #444;
                            border-radius: 3px;
                        }
                        .pip-sidebar-list::-webkit-scrollbar-thumb:hover {
                            background: #555;
                        }
                        .pip-sidebar-item {
                            display: flex;
                            align-items: center;
                            padding: 6px 8px;
                            gap: 8px;
                            cursor: pointer;
                            border-bottom: 1px solid #2a2a2a;
                            transition: background 0.15s;
                        }
                        .pip-sidebar-item:hover {
                            background: rgba(255, 255, 255, 0.1);
                        }
                        .pip-sidebar-item.active {
                            background: rgba(255, 0, 0, 0.2);
                        }
                        .pip-sidebar-thumb {
                            width: 60px;
                            height: 34px;
                            background: #333;
                            border-radius: 3px;
                            flex-shrink: 0;
                            object-fit: cover;
                        }
                        .pip-sidebar-info {
                            flex: 1;
                            min-width: 0;
                            display: flex;
                            flex-direction: column;
                            gap: 2px;
                        }
                        .pip-sidebar-title {
                            font-size: 10px;
                            color: #fff;
                            overflow: hidden;
                            text-overflow: ellipsis;
                            display: -webkit-box;
                            -webkit-line-clamp: 2;
                            -webkit-box-orient: vertical;
                            line-height: 1.3;
                        }
                        .pip-sidebar-delete {
                            background: none;
                            border: none;
                            color: #666;
                            cursor: pointer;
                            font-size: 12px;
                            padding: 4px;
                            opacity: 0;
                            transition: opacity 0.15s;
                        }
                        .pip-sidebar-item:hover .pip-sidebar-delete {
                            opacity: 1;
                        }
                        .pip-sidebar-delete:hover {
                            color: #ff4444;
                        }
                        .pip-sidebar-empty {
                            padding: 20px;
                            text-align: center;
                            color: #666;
                            font-size: 11px;
                        }
                        .pip-list-toggle {
                            width: 32px;
                            height: 32px;
                            display: grid;
                            place-items: center;
                            background: transparent;
                            border: 1px solid transparent;
                            color: #d8d8dc;
                            cursor: pointer;
                            padding: 7px;
                            border-radius: 9px;
                        }
                        .pip-list-toggle:hover {
                            color: #fff;
                            background: rgba(255, 255, 255, 0.08);
                        }
                    </style>
                </head>
                <body>
                    <div class="pip-main-wrapper">
                        <div class="pip-player-area">
                            <div class="pip-container">
                                <div class="pip-video-surface">
                                    <iframe id="pip-iframe"
                                        src="${embedSrc}"
                                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                        allowfullscreen>
                                    </iframe>
                                </div>
                                <div class="pip-control-bar">
                                    <div class="pip-bar-left">
                                        <div class="pip-source-indicator" id="pip-source">
                                            ${escapeHTML(PlaybackState.getActiveSourceName())} ▼
                                            <div class="pip-source-dropdown" id="pip-source-dropdown">
                                                ${sourceOptions}
                                            </div>
                                        </div>
                                        <button class="pip-list-toggle" id="pip-list-toggle" title="Show playlist" aria-label="Show playlist">${controlIcon('list')}</button>
                                    </div>
                                    <div class="pip-bar-center">
                                        <button class="pip-bar-btn" id="pip-prev" title="Previous" aria-label="Previous">${controlIcon('previous')}</button>
                                        <button class="pip-bar-btn pip-play-pause" id="pip-pause" title="Pause" aria-label="Pause">${controlIcon('pause')}</button>
                                        <button class="pip-bar-btn" id="pip-next" title="Next" aria-label="Next">${controlIcon('next')}</button>
                                    </div>
                                    <div class="pip-bar-right">
                                        <button class="pip-bar-btn pip-toggle-btn ${shuffleMode ? 'active' : ''}" id="pip-shuffle" title="Shuffle" aria-label="Shuffle">${controlIcon('shuffle')}</button>
                                        <button class="pip-bar-btn pip-toggle-btn ${repeatMode ? 'active' : ''}" id="pip-repeat" title="Repeat" aria-label="Repeat">${controlIcon('repeat')}</button>
                                        <span class="pip-queue-counter" id="pip-counter">${PlaybackState.getPositionInfo() || ''}</span>
                                        <button class="pip-bar-btn" id="pip-focus-tab" title="Focus YouTube tab" aria-label="Focus YouTube tab">${controlIcon('focus')}</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="pip-sidebar" id="pip-sidebar">
                            <div class="pip-sidebar-header">
                                <span id="pip-sidebar-title">Playlist</span>
                                <button class="pip-sidebar-close" id="pip-sidebar-close" title="Close">✕</button>
                            </div>
                            <div class="pip-sidebar-list" id="pip-sidebar-list">
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
                stopMiniPlayerWatcher(); // Stop watching for mini player
            });

        } catch (error) {
            console.error('[YouTube Preview] Failed to open PiP window:', error);
            openEmbeddedProxy(videoId);
        }
    }

    // Build source options HTML for PiP
    function buildSourceOptions() {
        const activeSource = PlaybackState.activeSource;
        const queueCount = PlaybackState.queue.length;
        let html = `<div class="pip-source-dropdown-inner">
            <div class="pip-source-item ${activeSource === 'queue' ? 'active' : ''}" data-source="queue">
                <span class="pip-source-name">Queue ${queueCount > 0 ? `(${queueCount})` : ''}</span>
                ${queueCount > 0 ? `<span class="pip-source-actions">
                    <button class="pip-list-action" data-action="clear-queue" title="Clear queue">🗑</button>
                </span>` : ''}
            </div>
        `;

        Object.keys(PlaybackState.lists).forEach(id => {
            const list = PlaybackState.lists[id];
            const isActive = activeSource === `list:${id}`;
            const isEmpty = list.items.length === 0;
            html += `
                <div class="pip-source-item ${isActive ? 'active' : ''} ${isEmpty ? 'disabled' : ''}" data-source="list:${id}">
                    <span class="pip-source-name">${escapeHTML(list.name)} ${isEmpty ? '(empty)' : `(${list.items.length})`}</span>
                    <span class="pip-source-actions">
                        <button class="pip-list-action" data-action="rename" data-list-id="${id}" title="Rename">✎</button>
                        <button class="pip-list-action" data-action="delete" data-list-id="${id}" title="Delete">✕</button>
                    </span>
                </div>
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
            sourceIndicator.innerHTML = `${escapeHTML(PlaybackState.getActiveSourceName())} ▼
                <div class="pip-source-dropdown" id="pip-source-dropdown">
                    ${buildSourceOptions()}
                </div>
            `;
            // Re-attach source events
            attachSourceEvents();

            // Update shuffle/repeat button states
            const shuffleBtnEl = doc.getElementById('pip-shuffle');
            const repeatBtnEl = doc.getElementById('pip-repeat');
            if (shuffleBtnEl) {
                shuffleBtnEl.classList.toggle('active', shuffleMode);
            }
            if (repeatBtnEl) {
                repeatBtnEl.classList.toggle('active', repeatMode);
            }
        }

        // Navigate to video
        function navigateToVideo(videoId) {
            console.log('[Nav] Navigating to:', videoId);
            if (videoId) {
                PlaybackState.currentVideoId = videoId;
                loadVideoWithoutReplacingFrame(iframe, videoId);
                updateNavButtons();
                updateSidebar();
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
                iframe.contentWindow.postMessage(
                    { action: isPaused ? 'play' : 'pause' },
                    getProxyOrigin(PlaybackState.currentVideoId)
                );
            } catch (err) {
                console.warn('[Pause] postMessage failed:', err);
            }
            isPaused = !isPaused;
            pauseBtn.innerHTML = controlIcon(isPaused ? 'play' : 'pause');
            pauseBtn.title = isPaused ? 'Play' : 'Pause';
            pauseBtn.setAttribute('aria-label', pauseBtn.title);
        });

        // Shuffle toggle handler
        const shuffleBtn = doc.getElementById('pip-shuffle');
        shuffleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            shuffleMode = !shuffleMode;
            shuffleBtn.classList.toggle('active', shuffleMode);
            // Save to storage
            chrome.storage.local.set({ shuffleMode });
            updateNavButtons();
        });

        // Repeat toggle handler
        const repeatBtn = doc.getElementById('pip-repeat');
        repeatBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            repeatMode = !repeatMode;
            repeatBtn.classList.toggle('active', repeatMode);
            // Save to storage
            chrome.storage.local.set({ repeatMode });
            updateNavButtons();
        });

        // Focus YouTube tab handler (keeps PiP open)
        const focusTabBtn = doc.getElementById('pip-focus-tab');
        focusTabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Focus the parent YouTube window/tab
            window.focus();
        });

        // Source selection handler using event delegation
        function attachSourceEvents() {
            const dropdown = doc.getElementById('pip-source-dropdown');
            if (!dropdown) return;

            // Remove old listener if exists (by replacing the element with a clone)
            const newDropdown = dropdown.cloneNode(true);
            dropdown.parentNode.replaceChild(newDropdown, dropdown);

            // Use event delegation for all clicks in dropdown
            newDropdown.addEventListener('click', (e) => {
                const target = e.target;

                // Check if clicking on delete button
                const deleteBtn = target.closest('.pip-list-action[data-action="delete"]');
                if (deleteBtn) {
                    e.preventDefault();
                    e.stopPropagation();

                    const listId = deleteBtn.dataset.listId;
                    const list = PlaybackState.lists[listId];
                    if (!list) return;

                    const item = deleteBtn.closest('.pip-source-item');
                    const nameSpan = item.querySelector('.pip-source-name');
                    const actionsSpan = item.querySelector('.pip-source-actions');

                    // Hide name and actions, show confirmation
                    nameSpan.style.display = 'none';
                    actionsSpan.style.display = 'none';

                    // Create confirmation UI
                    const confirmDiv = doc.createElement('div');
                    confirmDiv.className = 'pip-delete-confirm';
                    confirmDiv.style.cssText = `
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        flex: 1;
                    `;
                    confirmDiv.innerHTML = `
                        <span style="font-size: 10px; color: #ff6b6b;">Delete?</span>
                        <button class="pip-confirm-yes" style="
                            background: #cc0000;
                            border: none;
                            color: white;
                            padding: 2px 8px;
                            border-radius: 3px;
                            font-size: 10px;
                            cursor: pointer;
                        ">Yes</button>
                        <button class="pip-confirm-no" style="
                            background: rgba(255,255,255,0.2);
                            border: none;
                            color: white;
                            padding: 2px 8px;
                            border-radius: 3px;
                            font-size: 10px;
                            cursor: pointer;
                        ">No</button>
                    `;

                    item.insertBefore(confirmDiv, actionsSpan);

                    // Handle confirmation clicks
                    confirmDiv.querySelector('.pip-confirm-yes').addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        PlaybackState.deleteList(listId).then(() => {
                            updateNavButtons();
                        });
                    });

                    confirmDiv.querySelector('.pip-confirm-no').addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        // Restore original UI
                        confirmDiv.remove();
                        nameSpan.style.display = '';
                        actionsSpan.style.display = '';
                    });

                    return;
                }

                // Check if clicking on clear queue button
                const clearQueueBtn = target.closest('.pip-list-action[data-action="clear-queue"]');
                if (clearQueueBtn) {
                    e.preventDefault();
                    e.stopPropagation();

                    // Clear the queue
                    PlaybackState.queue = [];
                    PlaybackState.currentIndex = -1;
                    PlaybackState.currentVideoId = null;
                    PlaybackState.notifyChange();
                    updateNavButtons();
                    showNotification('Queue cleared');

                    return;
                }

                // Check if clicking on rename button
                const renameBtn = target.closest('.pip-list-action[data-action="rename"]');
                if (renameBtn) {
                    e.stopPropagation();

                    const listId = renameBtn.dataset.listId;
                    const list = PlaybackState.lists[listId];
                    if (!list) return;

                    const item = renameBtn.closest('.pip-source-item');
                    const nameSpan = item.querySelector('.pip-source-name');
                    const actionsSpan = item.querySelector('.pip-source-actions');

                    // Hide name and actions, show input
                    nameSpan.style.display = 'none';
                    actionsSpan.style.display = 'none';

                    // Create input
                    const input = doc.createElement('input');
                    input.type = 'text';
                    input.value = list.name;
                    input.className = 'pip-rename-input';
                    input.style.cssText = `
                        flex: 1;
                        background: rgba(255,255,255,0.1);
                        border: 1px solid rgba(255,255,255,0.3);
                        border-radius: 3px;
                        color: white;
                        font-size: 11px;
                        padding: 4px 6px;
                        outline: none;
                    `;

                    // Prevent click from bubbling
                    input.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                    });

                    item.insertBefore(input, actionsSpan);
                    input.focus();
                    input.select();

                    // Save on Enter or blur
                    const saveRename = async () => {
                        const newName = input.value.trim();
                        if (newName && newName !== list.name) {
                            await PlaybackState.renameList(listId, newName);
                        }
                        updateNavButtons();
                    };

                    input.addEventListener('keydown', (ev) => {
                        if (ev.key === 'Enter') {
                            ev.preventDefault();
                            saveRename();
                        } else if (ev.key === 'Escape') {
                            ev.preventDefault();
                            updateNavButtons();
                        }
                    });

                    input.addEventListener('blur', saveRename);
                    return;
                }

                // Check if clicking on input
                if (target.tagName === 'INPUT') {
                    e.stopPropagation();
                    return;
                }

                // Check if clicking on source item (not action buttons)
                const sourceItem = target.closest('.pip-source-item');
                if (sourceItem && !target.closest('.pip-list-action')) {
                    e.stopPropagation();

                    // Prevent selecting disabled (empty) lists
                    if (sourceItem.classList.contains('disabled')) {
                        return;
                    }

                    const source = sourceItem.dataset.source;
                    PlaybackState.switchSource(source);

                    const items = PlaybackState.getActiveItems();
                    if (items.length > 0) {
                        navigateToVideo(items[0]);
                    }
                    updateNavButtons();
                }
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
        // Note: The iframe posts to its parent, which is the PiP window
        pipWindow.addEventListener('message', (e) => {
            // Verify it's a video ended event
            if (e.source === iframe.contentWindow && e.data && e.data.action === 'videoEnded') {
                console.log('[AutoPlay] Video ended, checking for next...');
                const nextVideoId = PlaybackState.next();
                if (nextVideoId) {
                    console.log('[AutoPlay] Playing next video:', nextVideoId);
                    navigateToVideo(nextVideoId);
                } else {
                    console.log('[AutoPlay] No more videos in queue/list');
                }
            }
        });

        // ===== SIDEBAR FUNCTIONALITY =====
        const sidebar = doc.getElementById('pip-sidebar');
        const sidebarList = doc.getElementById('pip-sidebar-list');
        const sidebarTitle = doc.getElementById('pip-sidebar-title');
        const listToggle = doc.getElementById('pip-list-toggle');
        const sidebarClose = doc.getElementById('pip-sidebar-close');

        // Toggle sidebar
        listToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
            if (sidebar.classList.contains('open')) {
                updateSidebar();
            }
        });

        // Close sidebar
        sidebarClose.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.remove('open');
        });

        // Get YouTube thumbnail URL
        function getThumbUrl(videoId) {
            return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
        }

        // Video title cache
        const titleCache = {};

        // Fetch video title - first check stored titles, then oEmbed API
        async function fetchVideoTitle(videoId) {
            // Check local cache first
            if (titleCache[videoId]) {
                return titleCache[videoId];
            }
            // Check persistent storage
            const storedTitle = PlaybackState.getVideoTitle(videoId);
            if (storedTitle) {
                titleCache[videoId] = storedTitle;
                return storedTitle;
            }
            // Fetch from oEmbed API
            try {
                const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                if (response.ok) {
                    const data = await response.json();
                    titleCache[videoId] = data.title;
                    // Save to persistent storage for future use
                    PlaybackState.saveVideoTitle(videoId, data.title);
                    return data.title;
                }
            } catch (e) {
                console.warn('[Title] Failed to fetch title for:', videoId);
            }
            return videoId; // Fallback to video ID
        }

        // Update sidebar content
        function updateSidebar() {
            const items = PlaybackState.getActiveItems();
            sidebarTitle.textContent = PlaybackState.getActiveSourceName();

            if (items.length === 0) {
                sidebarList.innerHTML = '<div class="pip-sidebar-empty">No videos</div>';
                return;
            }

            let html = '';
            items.forEach((videoId, index) => {
                const isActive = index === PlaybackState.currentIndex;
                // Check local cache, then persistent storage
                const cachedTitle = titleCache[videoId] || PlaybackState.getVideoTitle(videoId);
                if (cachedTitle && !titleCache[videoId]) {
                    titleCache[videoId] = cachedTitle; // Populate local cache
                }
                html += `
                    <div class="pip-sidebar-item ${isActive ? 'active' : ''}" data-index="${index}" data-video-id="${videoId}">
                        <img class="pip-sidebar-thumb" src="${getThumbUrl(videoId)}" alt="">
                        <div class="pip-sidebar-info">
                            <span class="pip-sidebar-title" data-video-id="${escapeHTML(videoId)}">${escapeHTML(cachedTitle || 'Loading...')}</span>
                        </div>
                        <button class="pip-sidebar-delete" data-index="${index}" title="Remove">✕</button>
                    </div>
                `;
            });
            sidebarList.innerHTML = html;

            // Fetch titles for items not in cache
            items.forEach(async (videoId) => {
                if (!titleCache[videoId]) {
                    const title = await fetchVideoTitle(videoId);
                    // Update the DOM element if it still exists
                    const titleEl = sidebarList.querySelector(`.pip-sidebar-title[data-video-id="${videoId}"]`);
                    if (titleEl) {
                        titleEl.textContent = title;
                    }
                }
            });

            // Attach event listeners
            sidebarList.querySelectorAll('.pip-sidebar-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.classList.contains('pip-sidebar-delete')) return;
                    const index = parseInt(item.dataset.index);
                    const videoId = item.dataset.videoId;
                    PlaybackState.currentIndex = index;
                    PlaybackState.currentVideoId = videoId;
                    navigateToVideo(videoId);
                    updateSidebar();
                });
            });

            sidebarList.querySelectorAll('.pip-sidebar-delete').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const index = parseInt(btn.dataset.index);
                    removeFromSource(index);
                });
            });

            // Scroll active item into view
            const activeItem = sidebarList.querySelector('.pip-sidebar-item.active');
            if (activeItem) {
                activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }

        // Remove item from current source
        async function removeFromSource(index) {
            const source = PlaybackState.activeSource;
            if (source === 'queue') {
                PlaybackState.queue.splice(index, 1);
                // Adjust currentIndex if needed
                if (index < PlaybackState.currentIndex) {
                    PlaybackState.currentIndex--;
                } else if (index === PlaybackState.currentIndex) {
                    // Current video was removed
                    if (PlaybackState.queue.length === 0) {
                        PlaybackState.currentIndex = -1;
                        PlaybackState.currentVideoId = null;
                    } else if (index >= PlaybackState.queue.length) {
                        PlaybackState.currentIndex = PlaybackState.queue.length - 1;
                        PlaybackState.currentVideoId = PlaybackState.queue[PlaybackState.currentIndex];
                        navigateToVideo(PlaybackState.currentVideoId);
                    } else {
                        PlaybackState.currentVideoId = PlaybackState.queue[index];
                        navigateToVideo(PlaybackState.currentVideoId);
                    }
                }
            } else if (source && source.startsWith('list:')) {
                const listId = source.replace('list:', '');
                const list = PlaybackState.lists[listId];
                if (list) {
                    list.items.splice(index, 1);
                    await PlaybackState.saveLists();
                    // Adjust currentIndex if needed
                    if (index < PlaybackState.currentIndex) {
                        PlaybackState.currentIndex--;
                    } else if (index === PlaybackState.currentIndex) {
                        if (list.items.length === 0) {
                            PlaybackState.currentIndex = -1;
                            PlaybackState.currentVideoId = null;
                        } else if (index >= list.items.length) {
                            PlaybackState.currentIndex = list.items.length - 1;
                            PlaybackState.currentVideoId = list.items[PlaybackState.currentIndex];
                            navigateToVideo(PlaybackState.currentVideoId);
                        } else {
                            PlaybackState.currentVideoId = list.items[index];
                            navigateToVideo(PlaybackState.currentVideoId);
                        }
                    }
                }
            }
            PlaybackState.commitPlayback();
            updateSidebar();
            updateNavButtons();
        }

        // Update callback to also refresh sidebar
        PlaybackState.onStateChange = () => {
            console.log('[PiP] State changed, updating UI');
            updateNavButtons();
            if (sidebar.classList.contains('open')) {
                updateSidebar();
            }
        };
    }

    // Strategy 3: Embedded Proxy
    function openEmbeddedProxy(videoId) {
        // Close YouTube's native mini player if active and start watching
        closeYouTubeMiniPlayer();
        startMiniPlayerWatcher();

        const embedSrc = getProxyUrl(videoId);

        // Check for existing overlay
        const existingOverlay = document.querySelector('.yt-preview-embed-overlay');

        if (existingOverlay) {
            // Reuse existing overlay: Just update the Iframe
            const iframe = existingOverlay.querySelector('iframe');
            if (iframe) {
                loadVideoWithoutReplacingFrame(iframe, videoId);
                PlaybackState.currentVideoId = videoId;
                updateEmbedControls(existingOverlay);
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
            minHeight: '200px',
            // Dynamic Props
            width: size.width + 'px',
            height: (size.height + 76) + 'px',
            ...pos
        });

        // Header with drag and close
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
            overlay.dispatchEvent(new Event('yt-preview-cleanup'));
            overlay.remove();
            PlaybackState.isPlaying = false;
            PlaybackState.onStateChange = null;
            stopMiniPlayerWatcher(); // Stop watching for mini player
            console.log('[Embed] Overlay closed');
        };
        header.appendChild(closeBtn);
        overlay.appendChild(header);

        // Main wrapper for content + sidebar
        const mainWrapper = document.createElement('div');
        mainWrapper.className = 'embed-main-wrapper';
        Object.assign(mainWrapper.style, {
            display: 'flex',
            flex: '1',
            overflow: 'hidden'
        });

        // Content area with iframe
        const content = document.createElement('div');
        content.className = 'embed-player-area';
        Object.assign(content.style, {
            flex: '1',
            position: 'relative',
            minWidth: '0'
        });

        content.innerHTML = `<iframe
        src="${embedSrc}"
        style="width:100%; height:100%; border:none;"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen>
    </iframe>`;

        mainWrapper.appendChild(content);

        // Sidebar panel
        const sidebar = document.createElement('div');
        sidebar.className = 'embed-sidebar';
        Object.assign(sidebar.style, {
            width: '0',
            background: '#1a1a1a',
            borderLeft: '1px solid #333',
            overflow: 'hidden',
            transition: 'width 0.2s ease',
            display: 'flex',
            flexDirection: 'column'
        });
        sidebar.innerHTML = `
            <div class="embed-sidebar-header" style="padding:8px 10px;background:#252525;border-bottom:1px solid #333;font-size:11px;font-weight:600;color:#fff;display:flex;justify-content:space-between;align-items:center;">
                <span class="embed-sidebar-title">Playlist</span>
                <button class="embed-sidebar-close" style="background:none;border:none;color:#888;cursor:pointer;font-size:14px;padding:0;line-height:1;" title="Close">✕</button>
            </div>
            <div class="embed-sidebar-list" style="flex:1;overflow-y:auto;overflow-x:hidden;"></div>
        `;
        mainWrapper.appendChild(sidebar);

        overlay.appendChild(mainWrapper);

        // Control bar at bottom
        const controlBar = document.createElement('div');
        controlBar.className = 'embed-control-bar';
        Object.assign(controlBar.style, {
            flex: '0 0 46px',
            height: '46px',
            background: 'linear-gradient(180deg, #18181b 0%, #101012 100%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 10px',
            borderTop: '1px solid rgba(255,255,255,.08)',
            boxShadow: '0 -8px 24px rgba(0,0,0,.18)'
        });

        controlBar.innerHTML = `
            <div class="embed-bar-left" style="display:flex;align-items:center;gap:6px;">
                <div class="embed-source-indicator" style="position:relative;cursor:pointer;background:rgba(255,255,255,0.1);padding:4px 8px;border-radius:4px;font-size:11px;color:#fff;">
                    <span class="embed-source-name">${escapeHTML(PlaybackState.getActiveSourceName())}</span> ▼
                    <div class="embed-source-dropdown" style="display:none;position:absolute;bottom:100%;left:0;margin-bottom:4px;background:rgba(28,28,28,0.95);border:1px solid rgba(255,255,255,0.2);border-radius:6px;min-width:140px;box-shadow:0 4px 12px rgba(0,0,0,0.6);max-height:200px;overflow-y:auto;">
                    </div>
                </div>
                <button class="embed-control-btn embed-list-toggle" title="Show playlist" aria-label="Show playlist">${controlIcon('list')}</button>
            </div>
            <div class="embed-bar-center" style="display:flex;align-items:center;gap:8px;">
                <button class="embed-control-btn embed-prev" title="Previous" aria-label="Previous">${controlIcon('previous')}</button>
                <button class="embed-control-btn embed-pause primary" title="Pause" aria-label="Pause">${controlIcon('pause')}</button>
                <button class="embed-control-btn embed-next" title="Next" aria-label="Next">${controlIcon('next')}</button>
            </div>
            <div class="embed-bar-right" style="display:flex;align-items:center;gap:6px;">
                <button class="embed-control-btn embed-shuffle ${shuffleMode ? 'active' : ''}" title="Shuffle" aria-label="Shuffle">${controlIcon('shuffle')}</button>
                <button class="embed-control-btn embed-repeat ${repeatMode ? 'active' : ''}" title="Repeat" aria-label="Repeat">${controlIcon('repeat')}</button>
                <span class="embed-counter" style="font-size:11px;color:rgba(255,255,255,0.7);"></span>
            </div>
        `;

        overlay.appendChild(controlBar);
        document.body.appendChild(overlay);

        // Setup control bar events
        setupEmbedControls(overlay);

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

        const handleDragMove = (e) => {
            if (!isDragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            overlay.style.left = (initialLeft + dx) + 'px';
            overlay.style.top = (initialTop + dy) + 'px';
        };

        const handleDragEnd = () => { isDragging = false; };
        window.addEventListener('mousemove', handleDragMove);
        window.addEventListener('mouseup', handleDragEnd);

        // Listen for video ended message from iframe
        const handleEmbedMessage = (e) => {
            const activeIframe = overlay.querySelector('iframe');
            if (e.source === activeIframe?.contentWindow && e.data && e.data.action === 'videoEnded') {
                console.log('[Embed AutoPlay] Video ended, checking for next...');
                const nextVideoId = PlaybackState.next();
                if (nextVideoId) {
                    console.log('[Embed AutoPlay] Playing next video:', nextVideoId);
                    const iframe = overlay.querySelector('iframe');
                    if (iframe) {
                        loadVideoWithoutReplacingFrame(iframe, nextVideoId);
                        PlaybackState.currentVideoId = nextVideoId;
                        updateEmbedControls(overlay);
                    }
                } else {
                    console.log('[Embed AutoPlay] No more videos in queue/list');
                }
            }
        };
        window.addEventListener('message', handleEmbedMessage);
        overlay.addEventListener('yt-preview-cleanup', () => {
            window.removeEventListener('message', handleEmbedMessage);
            window.removeEventListener('mousemove', handleDragMove);
            window.removeEventListener('mouseup', handleDragEnd);
        }, { once: true });
    }

    // Setup embed control bar events
    function setupEmbedControls(overlay) {
        const sourceIndicator = overlay.querySelector('.embed-source-indicator');
        const sourceDropdown = overlay.querySelector('.embed-source-dropdown');
        const prevBtn = overlay.querySelector('.embed-prev');
        const nextBtn = overlay.querySelector('.embed-next');
        const pauseBtn = overlay.querySelector('.embed-pause');
        const listToggle = overlay.querySelector('.embed-list-toggle');
        const sidebar = overlay.querySelector('.embed-sidebar');
        const sidebarList = overlay.querySelector('.embed-sidebar-list');
        const sidebarTitle = overlay.querySelector('.embed-sidebar-title');
        const sidebarClose = overlay.querySelector('.embed-sidebar-close');

        let isPaused = false;
        const embedTitleCache = {};

        // Navigate to video helper
        function navigateToVideo(videoId) {
            const iframe = overlay.querySelector('iframe');
            if (iframe) {
                loadVideoWithoutReplacingFrame(iframe, videoId);
                PlaybackState.currentVideoId = videoId;
            }
        }

        // Show/hide dropdown on hover
        sourceIndicator.addEventListener('mouseenter', () => {
            updateSourceDropdown();
            sourceDropdown.style.display = 'block';
        });
        sourceIndicator.addEventListener('mouseleave', () => {
            sourceDropdown.style.display = 'none';
        });

        // Update source dropdown content
        function updateSourceDropdown() {
            const activeSource = PlaybackState.activeSource;
            const queueCount = PlaybackState.queue.length;
            let html = `
                <div class="embed-source-item" data-source="queue" style="padding:8px 12px;color:#fff;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;${activeSource === 'queue' ? 'background:rgba(255,0,0,0.3);' : ''}">
                    <span>Queue ${queueCount > 0 ? `(${queueCount})` : ''}</span>
                    ${queueCount > 0 ? `<button class="embed-clear-queue" style="background:none;border:none;color:rgba(255,255,255,0.6);cursor:pointer;font-size:10px;padding:2px 4px;" title="Clear queue">🗑</button>` : ''}
                </div>
            `;
            Object.keys(PlaybackState.lists).forEach(id => {
                const list = PlaybackState.lists[id];
                const isActive = activeSource === `list:${id}`;
                const isEmpty = list.items.length === 0;
                html += `
                    <div class="embed-source-item ${isEmpty ? 'disabled' : ''}" data-source="list:${id}" style="padding:8px 12px;color:#fff;font-size:11px;cursor:${isEmpty ? 'not-allowed' : 'pointer'};display:flex;align-items:center;gap:8px;${isActive ? 'background:rgba(255,0,0,0.3);' : ''}${isEmpty ? 'opacity:0.4;' : ''}">
                        ${escapeHTML(list.name)} ${isEmpty ? '(empty)' : `(${list.items.length})`}
                    </div>
                `;
            });
            sourceDropdown.innerHTML = html;

            // Add click events
            sourceDropdown.querySelectorAll('.embed-source-item').forEach(item => {
                item.addEventListener('mouseenter', () => {
                    if (!item.classList.contains('disabled')) {
                        item.style.background = 'rgba(255,255,255,0.1)';
                    }
                });
                item.addEventListener('mouseleave', () => {
                    const isActive = item.dataset.source === PlaybackState.activeSource ||
                        (item.dataset.source.startsWith('list:') && PlaybackState.activeSource === item.dataset.source);
                    item.style.background = isActive ? 'rgba(255,0,0,0.3)' : '';
                });
                item.addEventListener('click', (e) => {
                    // Don't switch source if clicking clear queue button
                    if (e.target.classList.contains('embed-clear-queue')) return;
                    if (item.classList.contains('disabled')) return;
                    const source = item.dataset.source;
                    PlaybackState.switchSource(source);
                    const items = PlaybackState.getActiveItems();
                    if (items.length > 0) {
                        navigateToVideo(items[0]);
                    }
                    updateEmbedControls(overlay);
                    updateEmbedSidebar();
                    sourceDropdown.style.display = 'none';
                });
            });

            // Add clear queue handler
            const clearQueueBtn = sourceDropdown.querySelector('.embed-clear-queue');
            if (clearQueueBtn) {
                clearQueueBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    PlaybackState.queue = [];
                    PlaybackState.currentIndex = -1;
                    PlaybackState.currentVideoId = null;
                    PlaybackState.commitPlayback();
                    updateSourceDropdown();
                    updateEmbedControls(overlay);
                    updateEmbedSidebar();
                    showNotification('Queue cleared');
                });
            }
        }

        // Prev/Next buttons
        prevBtn.addEventListener('click', () => {
            const prevVideoId = PlaybackState.previous();
            if (prevVideoId) {
                navigateToVideo(prevVideoId);
                updateEmbedControls(overlay);
                updateEmbedSidebar();
            }
        });

        nextBtn.addEventListener('click', () => {
            const nextVideoId = PlaybackState.next();
            if (nextVideoId) {
                navigateToVideo(nextVideoId);
                updateEmbedControls(overlay);
                updateEmbedSidebar();
            }
        });

        // Play/Pause button
        pauseBtn.addEventListener('click', () => {
            const iframe = overlay.querySelector('iframe');
            if (iframe && iframe.contentWindow) {
                isPaused = !isPaused;
                iframe.contentWindow.postMessage(
                    { action: isPaused ? 'pause' : 'play' },
                    getProxyOrigin(PlaybackState.currentVideoId)
                );
                pauseBtn.innerHTML = controlIcon(isPaused ? 'play' : 'pause');
                pauseBtn.title = isPaused ? 'Play' : 'Pause';
                pauseBtn.setAttribute('aria-label', pauseBtn.title);
            }
        });

        // Shuffle toggle button
        const shuffleBtn = overlay.querySelector('.embed-shuffle');
        shuffleBtn.addEventListener('click', () => {
            shuffleMode = !shuffleMode;
            shuffleBtn.classList.toggle('active', shuffleMode);
            shuffleBtn.style.opacity = shuffleMode ? '1' : '0.5';
            chrome.storage.local.set({ shuffleMode });
            updateEmbedControls(overlay);
        });

        // Repeat toggle button
        const repeatBtn = overlay.querySelector('.embed-repeat');
        repeatBtn.addEventListener('click', () => {
            repeatMode = !repeatMode;
            repeatBtn.classList.toggle('active', repeatMode);
            repeatBtn.style.opacity = repeatMode ? '1' : '0.5';
            chrome.storage.local.set({ repeatMode });
            updateEmbedControls(overlay);
        });

        // List toggle button
        listToggle.addEventListener('click', () => {
            const isOpen = sidebar.style.width !== '0px' && sidebar.style.width !== '';
            sidebar.style.width = isOpen ? '0' : '180px';
            if (!isOpen) {
                updateEmbedSidebar();
            }
        });

        // Sidebar close button
        sidebarClose.addEventListener('click', () => {
            sidebar.style.width = '0';
        });

        // Fetch video title helper
        async function fetchEmbedVideoTitle(videoId) {
            if (embedTitleCache[videoId]) return embedTitleCache[videoId];
            const storedTitle = PlaybackState.getVideoTitle(videoId);
            if (storedTitle) {
                embedTitleCache[videoId] = storedTitle;
                return storedTitle;
            }
            try {
                const response = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
                if (response.ok) {
                    const data = await response.json();
                    embedTitleCache[videoId] = data.title;
                    PlaybackState.saveVideoTitle(videoId, data.title);
                    return data.title;
                }
            } catch (e) { }
            return videoId;
        }

        // Update sidebar content
        function updateEmbedSidebar() {
            const items = PlaybackState.getActiveItems();
            sidebarTitle.textContent = PlaybackState.getActiveSourceName();

            if (items.length === 0) {
                sidebarList.innerHTML = '<div style="padding:20px;text-align:center;color:#666;font-size:11px;">No videos</div>';
                return;
            }

            let html = '';
            items.forEach((videoId, index) => {
                const isActive = index === PlaybackState.currentIndex;
                const cachedTitle = embedTitleCache[videoId] || PlaybackState.getVideoTitle(videoId);
                if (cachedTitle && !embedTitleCache[videoId]) embedTitleCache[videoId] = cachedTitle;
                html += `
                    <div class="embed-sidebar-item" data-index="${index}" data-video-id="${videoId}" style="display:flex;align-items:center;padding:6px 8px;gap:8px;cursor:pointer;border-bottom:1px solid #2a2a2a;${isActive ? 'background:rgba(255,0,0,0.2);' : ''}">
                        <img src="https://i.ytimg.com/vi/${videoId}/mqdefault.jpg" style="width:50px;height:28px;background:#333;border-radius:3px;flex-shrink:0;object-fit:cover;" alt="">
                        <span class="embed-sidebar-title" data-video-id="${escapeHTML(videoId)}" style="flex:1;font-size:10px;color:#fff;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;line-height:1.3;">${escapeHTML(cachedTitle || 'Loading...')}</span>
                        <button class="embed-sidebar-delete" data-index="${index}" style="background:none;border:none;color:#666;cursor:pointer;font-size:12px;padding:4px;" title="Remove">✕</button>
                    </div>
                `;
            });
            sidebarList.innerHTML = html;

            // Fetch titles for items not in cache
            items.forEach(async (videoId) => {
                if (!embedTitleCache[videoId]) {
                    const title = await fetchEmbedVideoTitle(videoId);
                    const titleEl = sidebarList.querySelector(`.embed-sidebar-title[data-video-id="${videoId}"]`);
                    if (titleEl) titleEl.textContent = title;
                }
            });

            // Attach click events
            sidebarList.querySelectorAll('.embed-sidebar-item').forEach(item => {
                item.addEventListener('click', (e) => {
                    if (e.target.classList.contains('embed-sidebar-delete')) return;
                    const index = parseInt(item.dataset.index);
                    const videoId = item.dataset.videoId;
                    PlaybackState.currentIndex = index;
                    PlaybackState.currentVideoId = videoId;
                    navigateToVideo(videoId);
                    updateEmbedControls(overlay);
                    updateEmbedSidebar();
                });
                item.addEventListener('mouseenter', () => {
                    if (!item.style.background.includes('rgba(255, 0, 0')) {
                        item.style.background = 'rgba(255,255,255,0.1)';
                    }
                });
                item.addEventListener('mouseleave', () => {
                    const isActive = parseInt(item.dataset.index) === PlaybackState.currentIndex;
                    item.style.background = isActive ? 'rgba(255,0,0,0.2)' : '';
                });
            });

            // Delete buttons
            sidebarList.querySelectorAll('.embed-sidebar-delete').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const index = parseInt(btn.dataset.index);
                    await removeFromEmbedSource(index);
                });
                btn.addEventListener('mouseenter', () => btn.style.color = '#ff4444');
                btn.addEventListener('mouseleave', () => btn.style.color = '#666');
            });

            // Scroll active into view
            const activeItem = sidebarList.querySelector('.embed-sidebar-item[style*="rgba(255, 0, 0"]');
            if (activeItem) activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        // Remove item from source
        async function removeFromEmbedSource(index) {
            const source = PlaybackState.activeSource;
            if (source === 'queue') {
                PlaybackState.queue.splice(index, 1);
                if (index < PlaybackState.currentIndex) {
                    PlaybackState.currentIndex--;
                } else if (index === PlaybackState.currentIndex) {
                    if (PlaybackState.queue.length === 0) {
                        PlaybackState.currentIndex = -1;
                        PlaybackState.currentVideoId = null;
                    } else if (index >= PlaybackState.queue.length) {
                        PlaybackState.currentIndex = PlaybackState.queue.length - 1;
                        PlaybackState.currentVideoId = PlaybackState.queue[PlaybackState.currentIndex];
                        navigateToVideo(PlaybackState.currentVideoId);
                    } else {
                        PlaybackState.currentVideoId = PlaybackState.queue[index];
                        navigateToVideo(PlaybackState.currentVideoId);
                    }
                }
            } else if (source && source.startsWith('list:')) {
                const listId = source.replace('list:', '');
                const list = PlaybackState.lists[listId];
                if (list) {
                    list.items.splice(index, 1);
                    await PlaybackState.saveLists();
                    if (index < PlaybackState.currentIndex) {
                        PlaybackState.currentIndex--;
                    } else if (index === PlaybackState.currentIndex) {
                        if (list.items.length === 0) {
                            PlaybackState.currentIndex = -1;
                            PlaybackState.currentVideoId = null;
                        } else if (index >= list.items.length) {
                            PlaybackState.currentIndex = list.items.length - 1;
                            PlaybackState.currentVideoId = list.items[PlaybackState.currentIndex];
                            navigateToVideo(PlaybackState.currentVideoId);
                        } else {
                            PlaybackState.currentVideoId = list.items[index];
                            navigateToVideo(PlaybackState.currentVideoId);
                        }
                    }
                }
            }
            PlaybackState.commitPlayback();
            updateEmbedSidebar();
            updateEmbedControls(overlay);
        }

        // Register state change callback
        PlaybackState.onStateChange = () => {
            updateEmbedControls(overlay);
            if (sidebar.style.width !== '0px' && sidebar.style.width !== '') {
                updateEmbedSidebar();
            }
        };

        // Initial update
        updateEmbedControls(overlay);
    }

    // Update embed controls UI
    function updateEmbedControls(overlay) {
        if (!overlay) return;
        const sourceName = overlay.querySelector('.embed-source-name');
        const counter = overlay.querySelector('.embed-counter');
        const prevBtn = overlay.querySelector('.embed-prev');
        const nextBtn = overlay.querySelector('.embed-next');

        if (sourceName) {
            sourceName.textContent = PlaybackState.getActiveSourceName();
        }

        if (counter) {
            counter.textContent = PlaybackState.getPositionInfo() || '';
        }

        const canPrev = PlaybackState.hasPrevious();
        const canNext = PlaybackState.hasNext();

        if (prevBtn) {
            prevBtn.disabled = !canPrev;
            prevBtn.style.opacity = canPrev ? '1' : '0.3';
        }
        if (nextBtn) {
            nextBtn.disabled = !canNext;
            nextBtn.style.opacity = canNext ? '1' : '0.3';
        }

        // Update shuffle/repeat button states
        const shuffleBtn = overlay.querySelector('.embed-shuffle');
        const repeatBtn = overlay.querySelector('.embed-repeat');
        if (shuffleBtn) {
            shuffleBtn.style.opacity = shuffleMode ? '1' : '0.5';
            shuffleBtn.classList.toggle('active', shuffleMode);
        }
        if (repeatBtn) {
            repeatBtn.style.opacity = repeatMode ? '1' : '0.5';
            repeatBtn.classList.toggle('active', repeatMode);
        }
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

    // --- Playlist Panel Import Buttons ---
    // Injects import buttons into YouTube's playlist panel on watch pages
    function injectPlaylistPanelButtons() {
        // Only run on watch pages
        if (!window.location.pathname.startsWith('/watch')) return;

        // Find the playlist panel
        const playlistPanel = document.querySelector('ytd-playlist-panel-renderer');
        if (!playlistPanel) return;

        // Check if we already injected buttons
        if (playlistPanel.querySelector('.yt-preview-import-btns')) return;

        // Find the header area to inject buttons
        const header = playlistPanel.querySelector('#header-contents, #header');
        if (!header) return;

        // Get playlist info
        const playlistTitleEl = playlistPanel.querySelector('#playlist-title, .title');
        const playlistName = playlistTitleEl?.textContent?.trim() || 'YouTube Playlist';

        // Count videos
        const videoItems = playlistPanel.querySelectorAll('ytd-playlist-panel-video-renderer');
        const videoCount = videoItems.length;

        if (videoCount === 0) return;

        // Create import buttons container
        const btnContainer = document.createElement('div');
        btnContainer.className = 'yt-preview-import-btns';
        btnContainer.style.cssText = `
            position: relative;
            display: flex;
            gap: 6px;
            padding: 8px 16px;
            border-top: 1px solid rgba(255, 255, 255, 0.1);
            background: rgba(0, 0, 0, 0.2);
        `;

        // Build lists HTML for dropdown
        function buildImportListsHTML() {
            let listsHTML = '';
            const lists = PlaybackState.lists || {};
            const listIds = Object.keys(lists);
            if (listIds.length > 0) {
                listsHTML = `<div class="yt-preview-dropdown-divider"></div>
                    <div class="yt-preview-dropdown-header">Add to list</div>`;
                for (const id of listIds) {
                    listsHTML += `<button class="yt-preview-dropdown-item" data-action="add-to-list" data-list-id="${id}">
                        + ${escapeHTML(lists[id].name)}
                    </button>`;
                }
            }
            return listsHTML;
        }

        btnContainer.innerHTML = `
            <button class="yt-preview-import-btn primary" id="yt-import-preview-btn" style="
                flex: 1;
                background: rgba(255, 0, 0, 0.3);
                border: 1px solid rgba(255, 0, 0, 0.4);
                border-radius: 18px;
                padding: 6px 12px;
                color: #fff;
                font-size: 11px;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                transition: background 0.2s;
            ">
                ▶ Preview
            </button>
            <div class="yt-preview-import-dropdown" style="
                display: none;
                position: absolute;
                top: 100%;
                left: 16px;
                right: 16px;
                background: #212121;
                border: 1px solid rgba(255, 255, 255, 0.2);
                border-radius: 8px;
                padding: 8px 0;
                z-index: 9999;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                max-height: 300px;
                overflow-y: auto;
            ">
                <button class="yt-preview-dropdown-item" data-action="add-queue" style="
                    display: block;
                    width: 100%;
                    padding: 8px 16px;
                    background: none;
                    border: none;
                    color: #fff;
                    font-size: 13px;
                    text-align: left;
                    cursor: pointer;
                ">
                    + Add to queue
                </button>
                <button class="yt-preview-dropdown-item" data-action="create-new" style="
                    display: block;
                    width: 100%;
                    padding: 8px 16px;
                    background: none;
                    border: none;
                    color: #fff;
                    font-size: 13px;
                    text-align: left;
                    cursor: pointer;
                ">
                    + Create list
                </button>
                ${buildImportListsHTML()}
            </div>
        `;

        const previewBtn = btnContainer.querySelector('#yt-import-preview-btn');
        const dropdown = btnContainer.querySelector('.yt-preview-import-dropdown');

        // Toggle dropdown on button click
        previewBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            const isVisible = dropdown.style.display === 'block';
            dropdown.style.display = isVisible ? 'none' : 'block';
            // Refresh lists when opening
            if (!isVisible) {
                const listsContainer = dropdown.querySelector('.yt-preview-dropdown-header')?.parentElement;
                if (listsContainer) {
                    // Remove old list items
                    dropdown.querySelectorAll('[data-action="add-to-list"]').forEach(el => el.remove());
                    const dividers = dropdown.querySelectorAll('.yt-preview-dropdown-divider');
                    if (dividers.length > 0) dividers[dividers.length - 1]?.remove();
                    const headers = dropdown.querySelectorAll('.yt-preview-dropdown-header');
                    if (headers.length > 0) headers[headers.length - 1]?.remove();
                }
                // Add fresh lists
                dropdown.insertAdjacentHTML('beforeend', buildImportListsHTML());
            }
        });

        // Hover effects for button
        previewBtn.addEventListener('mouseenter', (e) => {
            e.stopPropagation();
            previewBtn.style.background = 'rgba(255, 0, 0, 0.5)';
        });
        previewBtn.addEventListener('mouseleave', (e) => {
            e.stopPropagation();
            previewBtn.style.background = 'rgba(255, 0, 0, 0.3)';
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!btnContainer.contains(e.target)) {
                dropdown.style.display = 'none';
            }
        });

        // Stop propagation on container level
        btnContainer.addEventListener('mousedown', (e) => {
            e.stopPropagation();
        });

        // Handle dropdown item clicks
        dropdown.addEventListener('click', async (e) => {
            e.stopPropagation();
            e.preventDefault();

            const item = e.target.closest('.yt-preview-dropdown-item');
            if (!item) return;

            const action = item.dataset.action;
            dropdown.style.display = 'none';

            // Get all videos from the playlist panel
            const videos = getPlaylistPanelVideos(playlistPanel);
            if (videos.length === 0) {
                showNotification('No videos found in playlist');
                return;
            }

            // Save all video titles
            for (const v of videos) {
                if (v.title) {
                    PlaybackState.saveVideoTitle(v.videoId, v.title);
                }
            }

            switch (action) {
                case 'add-queue':
                    for (const v of videos) {
                        PlaybackState.queueAppend(v.videoId);
                    }
                    showNotification(`Added ${videos.length} videos to queue`);
                    break;

                case 'create-new':
                    const newListId = await PlaybackState.createList(playlistName);
                    for (const v of videos) {
                        await PlaybackState.listAppend(newListId, v.videoId);
                    }
                    PlaybackState.switchSource(`list:${newListId}`);
                    showNotification(`Created "${playlistName}" with ${videos.length} videos`);
                    refreshAllDropdowns();
                    break;

                case 'add-to-list':
                    const listId = item.dataset.listId;
                    if (listId && PlaybackState.lists[listId]) {
                        for (const v of videos) {
                            await PlaybackState.listAppend(listId, v.videoId);
                        }
                        showNotification(`Added ${videos.length} videos to ${PlaybackState.lists[listId].name}`);
                    }
                    break;
            }

            PlaybackState.notifyChange();
        });

        // Add hover effect to dropdown items
        dropdown.addEventListener('mouseover', (e) => {
            const item = e.target.closest('.yt-preview-dropdown-item');
            if (item) {
                item.style.background = 'rgba(255, 255, 255, 0.1)';
            }
        });
        dropdown.addEventListener('mouseout', (e) => {
            const item = e.target.closest('.yt-preview-dropdown-item');
            if (item) {
                item.style.background = 'none';
            }
        });

        // Insert after header
        header.insertAdjacentElement('afterend', btnContainer);
        console.log('[Playlist Panel] Injected import buttons for:', playlistName, '(' + videoCount + ' videos)');
    }

    // Get all videos from the playlist panel
    function getPlaylistPanelVideos(panel) {
        const items = panel.querySelectorAll('ytd-playlist-panel-video-renderer');
        const videos = [];

        items.forEach(item => {
            const titleEl = item.querySelector('#video-title, a#video-title');
            const href = titleEl?.getAttribute('href') || item.querySelector('a')?.getAttribute('href');

            if (href) {
                const videoId = extractVideoId(href);
                const title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim();

                if (videoId && !videos.some(v => v.videoId === videoId)) {
                    videos.push({ videoId, title });
                }
            }
        });

        return videos;
    }

    // Helper function to open preview using configured strategy
    function openPreviewWithStrategy(videoId) {
        console.log('[Preview] Opening video:', videoId, 'Strategy:', currentStrategy);
        if (currentStrategy === 'zen') {
            openZenPopup(videoId);
        } else if (currentStrategy === 'pip') {
            openPiPWindow(videoId);
        } else {
            openEmbeddedProxy(videoId);
        }
    }

    // Listen for messages from popup to open preview
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'openPreview') {
            playbackReady.then(() => {
                const { videoId, source, index } = message;

                if (source === 'queue') {
                    PlaybackState.activeSource = 'queue';
                    PlaybackState.currentIndex = index;
                } else if (source && source.startsWith('list:')) {
                    PlaybackState.activeSource = source;
                    PlaybackState.currentIndex = index;
                }

                PlaybackState.currentVideoId = videoId;
                PlaybackState.isPlaying = true;
                PlaybackState.commitPlayback();

                openPreviewWithStrategy(videoId);

                sendResponse({ success: true });
            }).catch(error => sendResponse({ success: false, error: error.message }));
        }
        return true;
    });

    // Check for auto-open from popup button
    const autoOpenParams = new URLSearchParams(window.location.search);
    const autoOpenVideoId = autoOpenParams.get('ytPreviewAutoOpen');
    if (autoOpenVideoId) {
        const source = decodeURIComponent(autoOpenParams.get('source') || 'queue');
        const index = parseInt(autoOpenParams.get('index') || '0', 10);

        // Wait for page to be ready, then open preview
        setTimeout(async () => {
            await playbackReady;
            // Set the playback state
            if (source === 'queue') {
                PlaybackState.activeSource = 'queue';
                PlaybackState.currentIndex = index;
            } else if (source && source.startsWith('list:')) {
                PlaybackState.activeSource = source;
                PlaybackState.currentIndex = index;
            }

            PlaybackState.currentVideoId = autoOpenVideoId;
            PlaybackState.isPlaying = true;
            PlaybackState.commitPlayback();

            // Open using configured strategy
            openPreviewWithStrategy(autoOpenVideoId);

            // Clean URL without reloading
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, '', cleanUrl);
        }, 1500);
    }
}
