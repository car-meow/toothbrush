// Register Service Worker for offline support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered successfully. Scope:', reg.scope))
            .catch(err => console.log('Service Worker registration failed:', err));
    });
}

// Nexus Custom Storage Wrapper (for URL cloaking storage proxy support)
(function() {
    let mockStore = null;
    let useProxy = false;
    let fallbackStore = {};

    try {
        // Parse storage from window.name synchronously
        if (window.name && window.name.startsWith('{') && window.name.includes('tb_')) {
            mockStore = JSON.parse(window.name);
            useProxy = true;
            console.log('Nexus Storage initialized from window.name');
        }
    } catch(e) {}

    let nativeStorage = null;
    try {
        nativeStorage = window.localStorage;
    } catch (e) {
        console.warn('Native localStorage is blocked.');
    }

    const storageObj = {
        getItem: function(key) {
            if (useProxy && mockStore) return mockStore[key] !== undefined ? mockStore[key] : null;
            if (nativeStorage) {
                try { return nativeStorage.getItem(key); } catch(e) {}
            }
            return fallbackStore[key] !== undefined ? fallbackStore[key] : null;
        },
        setItem: function(key, val) {
            const strVal = String(val);
            if (useProxy && mockStore) {
                mockStore[key] = strVal;
                window.name = JSON.stringify(mockStore);
                try {
                    window.parent.postMessage({ type: 'nexus-storage-save', key: key, value: strVal }, '*');
                } catch(e) {}
                return;
            }
            if (nativeStorage) {
                try { nativeStorage.setItem(key, strVal); return; } catch(e) {}
            }
            fallbackStore[key] = strVal;
        },
        removeItem: function(key) {
            if (useProxy && mockStore) {
                delete mockStore[key];
                window.name = JSON.stringify(mockStore);
                try {
                    window.parent.postMessage({ type: 'nexus-storage-delete', key: key }, '*');
                } catch(e) {}
                return;
            }
            if (nativeStorage) {
                try { nativeStorage.removeItem(key); return; } catch(e) {}
            }
            delete fallbackStore[key];
        },
        key: function(i) {
            if (useProxy && mockStore) return Object.keys(mockStore)[i] || null;
            if (nativeStorage) {
                try { return nativeStorage.key(i); } catch(e) {}
            }
            return Object.keys(fallbackStore)[i] || null;
        },
        clear: function() {
            if (useProxy && mockStore) {
                mockStore = {};
                window.name = JSON.stringify(mockStore);
                try {
                    window.parent.postMessage({ type: 'nexus-storage-clear' }, '*');
                } catch(e) {}
                return;
            }
            if (nativeStorage) {
                try { nativeStorage.clear(); return; } catch(e) {}
            }
            fallbackStore = {};
        }
    };

    Object.defineProperty(storageObj, 'length', {
        get: function() {
            if (useProxy && mockStore) return Object.keys(mockStore).length;
            if (nativeStorage) {
                try { return nativeStorage.length; } catch(e) {}
            }
            return Object.keys(fallbackStore).length;
        }
    });

    window.nexusStorage = storageObj;
})();

// App Cloaking Support
(function() {
    const localStorage = window.nexusStorage;
    let originalTitle = document.title;
    let originalFavicon = '';
    const origLink = document.querySelector("link[rel*='icon']");
    if (origLink) {
        originalFavicon = origLink.getAttribute('href');
    }

    function applyTabCloak() {
        const preset = localStorage.getItem('tb_cloak_preset');
        if (!preset || preset === 'none') {
            document.title = originalTitle;
            let link = document.querySelector("link[rel*='icon']");
            if (link && originalFavicon) {
                link.href = originalFavicon;
            }
            return;
        }

        const presets = {
            wikipedia: {
                title: 'Wikipedia, the free encyclopedia',
                icon: 'https://en.wikipedia.org/favicon.ico'
            },
            drive: {
                title: 'My Drive - Google Drive',
                icon: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png'
            },
            classroom: {
                title: 'Classes',
                icon: 'https://ssl.gstatic.com/images/branding/product/1x/classroom_2020q4_48dp.png'
            },
            canvas: {
                title: 'Dashboard',
                icon: 'https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e05d51a1d4.ico'
            }
        };

        const data = presets[preset];
        if (!data) return;

        document.title = data.title;
        let link = document.querySelector("link[rel*='icon']");
        if (!link) {
            link = document.createElement('link');
            link.type = 'image/x-icon';
            link.rel = 'shortcut icon';
            document.head.appendChild(link);
        }
        link.href = data.icon;
    }

    // Run immediately on parse
    applyTabCloak();

    // Also run on DOMContentLoaded to capture post-load title/favicon changes
    window.addEventListener('DOMContentLoaded', () => {
        if (!originalTitle || originalTitle === 'New Tab' || originalTitle === '') {
            originalTitle = document.title;
        }
        const currentLink = document.querySelector("link[rel*='icon']");
        if (currentLink && !originalFavicon) {
            originalFavicon = currentLink.getAttribute('href');
        }
        applyTabCloak();
    });

    window.applyTabCloak = applyTabCloak;
})();

(function () {
    const localStorage = window.nexusStorage;
    const TRACKS_COUNT = 12;
    let bgmAudio = new Audio();
    bgmAudio.loop = false; // We use 'ended' event to advance to the next track sequentially
    bgmAudio.volume = 0.3;

    // Expose globally so cookie-engine can bind to it
    window.globalBGM = bgmAudio;

    let bgmStarted = false;
    let isNavigating = false;

    function isMuted() {
        try {
            const raw = localStorage.getItem('tb_cookie_save');
            if (raw) {
                const d = JSON.parse(raw);
                return !!d.muted;
            }
        } catch (e) {}
        return false;
    }

    function setMuted(muted) {
        try {
            const raw = localStorage.getItem('tb_cookie_save');
            let d = raw ? JSON.parse(raw) : {};
            d.muted = muted;
            localStorage.setItem('tb_cookie_save', JSON.stringify(d));
            // Trigger storage event manually for this page
            window.dispatchEvent(new Event('storage'));
        } catch (e) {}
    }

    function isStoppedByMedia() {
        const stoppedTime = localStorage.getItem('tb_bgm_stopped_by_media');
        if (!stoppedTime) return false;
        const isActivelyOpen = (Date.now() - Number(stoppedTime)) < 4000;
        if (!isActivelyOpen) {
            localStorage.removeItem('tb_bgm_stopped_by_media');
            return false;
        }
        return true;
    }

    function isStopped() {
        return isStoppedByMedia() || localStorage.getItem('tb_bgm_stopped_by_game') === 'true';
    }

    function getSavedTrackInfo() {
        const track = Number(localStorage.getItem('tb_bgm_track'));
        const time = Number(localStorage.getItem('tb_bgm_time')) || 0;
        const timestamp = Number(localStorage.getItem('tb_bgm_timestamp')) || 0;
        const playing = localStorage.getItem('tb_bgm_playing') !== 'false';

        if (!track || track < 1 || track > TRACKS_COUNT) {
            // Select random track if none is saved
            const randomTrack = Math.floor(Math.random() * TRACKS_COUNT) + 1;
            return { track: randomTrack, time: 0, timestamp: Date.now(), playing: true };
        }
        return { track, time, timestamp, playing };
    }

    function saveTrackInfo(navigating) {
        if (!bgmStarted || isMuted() || isStopped() || (document.hidden && !navigating)) {
            localStorage.setItem('tb_bgm_playing', 'false');
            return;
        }
        localStorage.setItem('tb_bgm_track', localStorage.getItem('tb_bgm_track') || '1');
        localStorage.setItem('tb_bgm_time', bgmAudio.currentTime.toString());
        localStorage.setItem('tb_bgm_timestamp', Date.now().toString());
        localStorage.setItem('tb_bgm_playing', 'true');
    }

    function loadTrack(trackNum, time, shouldPlay) {
        bgmAudio.src = 'Sound/bgm' + trackNum + '.mp3';
        bgmAudio.currentTime = time;
        localStorage.setItem('tb_bgm_track', trackNum.toString());
        if (shouldPlay && !isMuted() && !isStopped() && (!document.hidden || isNavigating)) {
            playBGM();
        }
    }

    function playBGM() {
        if (isMuted() || isStopped() || (document.hidden && !isNavigating)) return;
        bgmAudio.play().then(() => {
            bgmStarted = true;
            localStorage.setItem('tb_bgm_playing', 'true');
        }).catch(() => {
            console.log("BGM autoplay blocked or interrupted.");
        });
    }

    function pauseBGM() {
        bgmAudio.pause();
        localStorage.setItem('tb_bgm_playing', 'false');
    }

    function toggleMute() {
        const currentMute = isMuted();
        setMuted(!currentMute);
        updateState();
    }

    function playNextTrack() {
        let trackNum = Number(localStorage.getItem('tb_bgm_track')) || 1;
        trackNum = (trackNum % TRACKS_COUNT) + 1;
        loadTrack(trackNum, 0, true);
        saveTrackInfo();
    }

    function updateState() {
        const muted = isMuted();
        const stopped = isStopped();

        if (muted || stopped || (document.hidden && !isNavigating)) {
            bgmAudio.pause();
        } else {
            const playing = localStorage.getItem('tb_bgm_playing') !== 'false';
            if (playing) {
                playBGM();
            }
        }
    }

    function handleVisibilityChange() {
        if (isNavigating) return;
        if (document.hidden) {
            pauseBGM();
            saveTrackInfo();
        } else {
            const info = getSavedTrackInfo();
            let resumeTime = info.time;
            if (info.playing && info.timestamp > 0) {
                const elapsed = (Date.now() - info.timestamp) / 1000;
                if (elapsed > 0 && elapsed < 5) {
                    resumeTime += elapsed;
                }
            }

            const currentSrc = 'Sound/bgm' + info.track + '.mp3';
            if (!bgmAudio.src.endsWith(currentSrc)) {
                loadTrack(info.track, resumeTime, info.playing);
            } else {
                bgmAudio.currentTime = resumeTime;
                updateState();
            }
        }
    }

    // Initialize track
    const info = getSavedTrackInfo();
    localStorage.setItem('tb_bgm_track', info.track.toString());

    // Calculate elapsed time for seamless resume
    let resumeTime = info.time;
    if (info.playing && info.timestamp > 0) {
        const elapsed = (Date.now() - info.timestamp) / 1000;
        if (elapsed > 0 && elapsed < 5) {
            resumeTime += elapsed;
        }
    }

    if (!document.hidden) {
        loadTrack(info.track, resumeTime, info.playing);
    } else {
        loadTrack(info.track, resumeTime, false);
    }

    // Sync state periodically
    setInterval(() => {
        if (bgmStarted && !bgmAudio.paused && !document.hidden) {
            saveTrackInfo();
        }
    }, 300);

    // Auto-advance to next track when it finishes
    bgmAudio.addEventListener('ended', () => {
        playNextTrack();
    });

    // Cleanup and Sync stopped_by_game
    if (!window.location.pathname.endsWith('carmeow.html')) {
        localStorage.removeItem('tb_bgm_stopped_by_game');
    } else {
        window.addEventListener('pagehide', () => {
            localStorage.removeItem('tb_bgm_stopped_by_game');
        });
    }

    // Unload listeners to save state on page navigation
    window.addEventListener('beforeunload', () => {
        isNavigating = true;
        saveTrackInfo(true);
    });
    window.addEventListener('pagehide', () => {
        isNavigating = true;
        saveTrackInfo(true);
    });

    // Listen to interaction for autoplay fallback
    const startBgmOnInteraction = () => {
        if (!bgmStarted && !isMuted() && !isStopped() && !document.hidden) {
            playBGM();
        }
        if (bgmStarted || isMuted() || isStopped() || document.hidden) {
            cleanupInteractionListeners();
        }
    };
    const interactionEvents = ['click', 'mousedown', 'touchstart', 'keydown'];
    const cleanupInteractionListeners = () => {
        interactionEvents.forEach(evt => {
            document.removeEventListener(evt, startBgmOnInteraction);
        });
    };
    interactionEvents.forEach(evt => {
        document.addEventListener(evt, startBgmOnInteraction, { once: true, passive: true });
    });

    // Storage event syncing across tabs
    window.addEventListener('storage', (e) => {
        if (e.key === 'tb_cookie_save' || e.key === 'tb_bgm_stopped_by_media' || e.key === 'tb_bgm_stopped_by_game') {
            updateState();
        }
        if (e.key === 'tb_bgm_track' || e.key === 'tb_bgm_playing') {
            const currentTrack = Number(localStorage.getItem('tb_bgm_track')) || 1;
            const currentSrc = 'Sound/bgm' + currentTrack + '.mp3';
            const playing = localStorage.getItem('tb_bgm_playing') !== 'false';

            // Check if track changed in another tab
            if (!bgmAudio.src.endsWith(currentSrc)) {
                loadTrack(currentTrack, 0, playing);
            } else {
                updateState();
            }
        }
    });

    // Visibility change listener
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Keybind registration for other pages
    if (!window.location.pathname.endsWith('index.html') && !window.location.pathname.endsWith('/')) {
        document.addEventListener('keydown', (e) => {
            if ((e.key === 'm' || e.key === 'M') && !e.target.matches('input, textarea, select, [contenteditable]')) {
                toggleMute();
            }
        });
    }

    // Expose manager interface
    window.BGMManager = {
        toggleMute: toggleMute,
        updateState: updateState,
        playNextTrack: playNextTrack
    };
})();
