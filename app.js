// nexus-version: 4.47.13
const appStorage = window.nexusStorage || window.localStorage;
// Game Stash is always available during a Games visit. Release its frame only
// while the lightweight game standby screen is active.
appStorage.setItem('tb_preload_stash', 'true');

const dbName = "GameStorageDB";
const NEXUS_SHARED_DATABASE_NAMES = new Set(['GameStorageDB', 'AIChatDB', 'NexusSidebarSettings']);
const NEXUS_APP_LOCAL_STORAGE_KEYS = new Set(['sidebar-game-order', 'sidebar-game-order-updated-at', 'nexus-updates-read-v1', 'nexus_popup_closed']);
const NEXUS_GAME_SNAPSHOT_META_STORE = 'gameSnapshotMeta';
const NEXUS_GAME_SNAPSHOT_ESTIMATE_VERSION = 2;
let db, games =[], currentGame = null;
// The same-origin Game Stash frame reads this list to avoid duplicate bookmarks.
Object.defineProperty(window, 'games', { configurable: true, get: () => games });
const popupMuteSources = new Set();
const loadingGames = new Map();
let defaultGamesPromise = null;
let dbReadyPromise = null;
let gameLoadToken = 0;
let gameAutosaveTimer = null;
const snapshotHashes = new Map();
const popupGameWindows = new Map();
const activeGameSessions = new Map();
let gameSessionSequence = 0;
let mainGameFramesSuspended = false;
let stashLoadPromise = null;
const sidebarOrderDbName = 'NexusSidebarSettings';
let sidebarOrderDbPromise = null;
let lastSidebarOrderSavedAt = 0;

function openSidebarOrderDB() {
    if (sidebarOrderDbPromise) return sidebarOrderDbPromise;
    sidebarOrderDbPromise = new Promise(resolve => {
        let request;
        try {
            request = indexedDB.open(sidebarOrderDbName, 1);
        } catch (error) {
            sidebarOrderDbPromise = null;
            resolve(null);
            return;
        }
        request.onupgradeneeded = event => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains('settings')) {
                database.createObjectStore('settings', { keyPath: 'key' });
            }
        };
        request.onsuccess = event => {
            const database = event.target.result;
            database.onversionchange = () => {
                database.close();
                sidebarOrderDbPromise = null;
            };
            resolve(database);
        };
        request.onerror = request.onblocked = () => {
            sidebarOrderDbPromise = null;
            resolve(null);
        };
    });
    return sidebarOrderDbPromise;
}

function parseSidebarOrder(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(id => String(id)) : null;
    } catch (error) {
        return null;
    }
}

async function readSavedSidebarOrder(localStorage) {
    const legacyOrder = parseSidebarOrder(localStorage.getItem('sidebar-game-order'));
    const legacyUpdatedAt = Number(localStorage.getItem('sidebar-game-order-updated-at')) || 0;
    const database = await openSidebarOrderDB();
    if (database) {
        try {
            const saved = await new Promise(resolve => {
                const transaction = database.transaction('settings', 'readonly');
                const request = transaction.objectStore('settings').get('sidebar-game-order');
                request.onsuccess = () => resolve(request.result || null);
                request.onerror = () => resolve(null);
            });
            if (legacyOrder && legacyUpdatedAt > Number(saved && saved.updatedAt || 0)) {
                persistSidebarOrder(legacyOrder, legacyUpdatedAt);
                lastSidebarOrderSavedAt = legacyUpdatedAt;
                return legacyOrder;
            }
            if (saved && Array.isArray(saved.order)) {
                const order = saved.order.map(id => String(id));
                lastSidebarOrderSavedAt = Number(saved.updatedAt) || 0;
                try {
                    localStorage.setItem('sidebar-game-order', JSON.stringify(order));
                    localStorage.setItem('sidebar-game-order-updated-at', String(lastSidebarOrderSavedAt));
                } catch (error) {}
                return order;
            }
        } catch (error) {}
    }

    // Migrate the existing localStorage value once, then keep both copies in sync.
    if (legacyOrder) {
        lastSidebarOrderSavedAt = legacyUpdatedAt || Date.now();
        persistSidebarOrder(legacyOrder, lastSidebarOrderSavedAt);
    }
    return legacyOrder;
}

function persistSidebarOrder(order, updatedAt = Date.now()) {
    openSidebarOrderDB().then(database => {
        if (!database) return;
        try {
            const transaction = database.transaction('settings', 'readwrite');
            transaction.objectStore('settings').put({
                key: 'sidebar-game-order',
                order: order.slice(),
                updatedAt
            });
        } catch (error) {}
    });
}

function saveSidebarOrderToStorage(localStorage, order) {
    const updatedAt = Math.max(Date.now(), lastSidebarOrderSavedAt + 1);
    lastSidebarOrderSavedAt = updatedAt;
    const serialized = JSON.stringify(order);
    try {
        localStorage.setItem('sidebar-game-order', serialized);
        localStorage.setItem('sidebar-game-order-updated-at', String(updatedAt));
    } catch (error) {}
    persistSidebarOrder(order, updatedAt);
}

function releaseIframe(frame) {
    if (!frame) return;
    try {
        if (frame.contentWindow && frame.contentWindow.localStorage) {
            frame.contentWindow.postMessage({ type: 'nexus-disarm-autosave' }, '*');
        }
    } catch (e) {}
    try {
        if (frame.src && frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
    } catch (e) {}
    frame.removeAttribute('srcdoc');
    frame.src = 'about:blank';
}

function updatePopupGameIndex(gameId) {
    if (!gameId) return;
    let latest = null;
    Array.from(activeGameSessions.values()).reverse().some(session => {
        if (session.gameId === gameId) {
            latest = session.win;
            return true;
        }
        return false;
    });
    if (latest) popupGameWindows.set(gameId, latest);
    else popupGameWindows.delete(gameId);
}

function getGameSaveSessionKey(gameId) {
    return 'tb_nexus_game_session:' + encodeURIComponent(String(gameId));
}

function ownsGameSaveSession(gameId, sessionId) {
    if (!sessionId) return true;
    try {
        const activeSessionId = window.localStorage.getItem(getGameSaveSessionKey(gameId));
        return activeSessionId === String(sessionId);
    } catch (error) {
        return true;
    }
}

function ensureTransitionOverlay(parent = document.body) {
    let overlay = document.getElementById('page-fade-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'page-fade-overlay';
        parent.appendChild(overlay);
    }
    if (!overlay.querySelector('.nexus-transition-content')) {
        overlay.innerHTML = '<div class="nexus-transition-content"><img src="Assets/loadingRoll.gif" alt=""><span class="nexus-transition-label"></span></div>';
    }
    return overlay;
}

function showTransitionOverlay(message, parent = document.body) {
    const overlay = ensureTransitionOverlay(parent);
    const label = overlay.querySelector('.nexus-transition-label');
    if (label) label.textContent = message;
    overlay.classList.remove('fade-out');
    overlay.classList.add('is-loading');
    return overlay;
}

function hideTransitionOverlay(overlay = document.getElementById('page-fade-overlay')) {
    if (!overlay) return;
    overlay.classList.remove('is-loading');
    overlay.classList.add('fade-out');
}

function enterGameStandbyScreen() {
    if (gameAutosaveTimer) clearInterval(gameAutosaveTimer);
    gameAutosaveTimer = null;
    window.dispatchEvent(new CustomEvent('nexus-game-standby-change', { detail: { active: true } }));

    // Decouple window.opener on popup references so Chromium's SiteInstance
    // scheduler does not lock the standby tab and the game popup into the same renderer process.
    if (activeGameSessions && activeGameSessions.size) {
        activeGameSessions.forEach(session => {
            try {
                if (session && session.win) session.win.opener = null;
            } catch (e) {}
        });
    }

    // Release cached memory and DOM nodes before document replacement
    if (Array.isArray(games)) {
        games.forEach(g => {
            if (g && g.content) g.content = null;
        });
    }
    suspendMainGameFrames();
    try {
        document.body.innerHTML = '';
    } catch (e) {}

    // Minimal document navigation
    window.location.replace('game-standby.html');
}

function suspendMainGameFrames() {
    if (!mainGameFramesSuspended) {
        mainGameFramesSuspended = true;
        requestCurrentGameAutosave();

        if (gameAutosaveTimer) clearInterval(gameAutosaveTimer);
        gameAutosaveTimer = null;
    }
    releaseIframe(document.getElementById('game-frame'));
    releaseIframe(document.getElementById('stash-frame'));
    currentGame = null;
    isStashPreloaded = false;
    stashLoadPromise = null;
}

function registerGameSession(game, win) {
    const sessionId = `game-${Date.now()}-${++gameSessionSequence}-${Math.random().toString(36).slice(2)}`;
    if (typeof window.setTemporaryGameCloak === 'function') {
        window.setTemporaryGameCloak(true);
    }
    const session = {
        sessionId,
        gameId: String(game.id),
        title: getSidebarTitle(game),
        win
    };
    activeGameSessions.set(sessionId, session);
    updatePopupGameIndex(session.gameId);
    suspendMainGameFrames();
    // Covers the short setup window before the main tab is replaced by the
    // minimal standby document. After that handoff, the popup itself notifies
    // game-standby.html when it closes.
    win.addEventListener('beforeunload', () => handleGamePopupClosed(sessionId), { once: true });
    return session;
}

function hibernateMainTabForGame() {
    if (activeGameSessions.size) enterGameStandbyScreen();
}

function handleGamePopupClosed(sessionId) {
    const session = activeGameSessions.get(sessionId);
    if (!session) return;
    activeGameSessions.delete(sessionId);
    updatePopupGameIndex(session.gameId);

    if (activeGameSessions.size) return;

    mainGameFramesSuspended = false;
    if (typeof window.setTemporaryGameCloak === 'function') window.setTemporaryGameCloak(false);
    if (isStashPreloaded) startGameAutosave();
    else {
        const overlay = showTransitionOverlay('Going back to Games...');
        const stash = games.find(game => game && game.id === 'ugs-stash');
        if (stash) {
            loadGame(stash, true, { suppressHostLoader: true }).finally(() => {
                startGameAutosave();
                hideTransitionOverlay(overlay);
            });
        } else hideTransitionOverlay(overlay);
    }
}

if (typeof BroadcastChannel === 'function') {
    try {
        const sessionChannel = new BroadcastChannel('nexus-game-session');
        sessionChannel.addEventListener('message', event => {
            if (event.data && event.data.type === 'nexus-game-storage-quota-error') {
                const matchesActiveSession = Array.from(activeGameSessions.values()).some(session =>
                    session.gameId === String(event.data.gameId || '') &&
                    (!event.data.saveSessionId || String(session.sessionId) === String(event.data.saveSessionId))
                );
                if (matchesActiveSession) {
                    handleSavesStorageQuotaFailure(String(event.data.storageType || 'browser storage'), event.data.gameId);
                }
                return;
            }
            if (event.data && event.data.type === 'nexus-popup-closed' && activeGameSessions.size) {
                for (const [sid, sess] of activeGameSessions.entries()) {
                    if (!event.data.gameId || sess.gameId === String(event.data.gameId)) {
                        handleGamePopupClosed(sid);
                        break;
                    }
                }
            }
        });
    } catch (e) {}
}
window.addEventListener('storage', event => {
    if (event.key === 'nexus_popup_closed' && activeGameSessions.size) {
        try {
            const data = JSON.parse(event.newValue || '{}');
            for (const [sid, sess] of activeGameSessions.entries()) {
                if (!data.gameId || sess.gameId === String(data.gameId)) {
                    handleGamePopupClosed(sid);
                    break;
                }
            }
        } catch (e) {}
    }
});


window.showAddingState = function(sourceKey, title) {
    loadingGames.set(sourceKey, title);
    renderGameList();
};

window.hideAddingState = function(sourceKey) {
    loadingGames.delete(sourceKey);
    renderGameList();
};


async function initDB() {
    if (db) return db;
    if (dbReadyPromise) return dbReadyPromise;
    dbReadyPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 4);
        req.onupgradeneeded = e => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('customGames')) {
                database.createObjectStore('customGames', { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains('gameSnapshots')) {
                database.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
            }
            if (!database.objectStoreNames.contains(NEXUS_GAME_SNAPSHOT_META_STORE)) {
                database.createObjectStore(NEXUS_GAME_SNAPSHOT_META_STORE, { keyPath: 'gameId' });
            }
        };
        req.onsuccess = e => { db = e.target.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error);
    });
    return dbReadyPromise;
}

const HIDDEN_SIDEBAR_GAMES_KEY = 'tb_hidden_sidebar_game_ids';
const STASH_POPULARITY_STORAGE_KEY = 'tb_stash_popularity_profile_id';
const STASH_POPULARITY_SUPABASE_URL = 'https://lprpobjgkohwuzvbkmdh.supabase.co';
const STASH_POPULARITY_SUPABASE_KEY = 'sb_publishable_nIWAou1a4B73EVVu3PqQcg_ZCcf3zCF';
let stashPopularitySyncTimer = null;

function getStashPopularityProfileId() {
    const storage = window.nexusStorage || window.localStorage;
    let id = '';
    try { id = storage.getItem(STASH_POPULARITY_STORAGE_KEY) || ''; } catch (error) {}
    if (!id) {
        id = globalThis.crypto?.randomUUID
            ? globalThis.crypto.randomUUID()
            : `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        try { storage.setItem(STASH_POPULARITY_STORAGE_KEY, id); } catch (error) {}
    }
    return id;
}

function getStashPopularityGame(game) {
    if (!game || String(game.id) === 'ugs-stash') return null;
    let source = String(game.sourceFile || '').trim();
    if (!source && String(game.sourceKey || '').toLowerCase().startsWith('stash:')) {
        source = String(game.sourceKey).slice(6).trim();
    }
    if (!source) return null;
    source = source.replace(/^\/+/, '').toLowerCase();
    if (!source.includes('.')) source += '.html';
    return { game_id: source, title: String(game.title || source) };
}

async function callStashPopularityRpc(functionName, payload = {}) {
    const response = await fetch(`${STASH_POPULARITY_SUPABASE_URL}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
            apikey: STASH_POPULARITY_SUPABASE_KEY,
            Authorization: `Bearer ${STASH_POPULARITY_SUPABASE_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error(`Supabase ${functionName} failed (${response.status}): ${await response.text()}`);
    const responseText = await response.text();
    return responseText ? JSON.parse(responseText) : null;
}

window.getStashSidebarPopularity = async function() {
    return await callStashPopularityRpc('get_stash_sidebar_popularity');
};

async function syncStashSidebarPopularity() {
    const uniqueGames = new Map();
    games.forEach(game => {
        const item = getStashPopularityGame(game);
        if (item) uniqueGames.set(item.game_id, item);
    });
    await callStashPopularityRpc('sync_stash_sidebar_games', {
        p_profile_id: getStashPopularityProfileId(),
        p_games: Array.from(uniqueGames.values())
    });

    try {
        const frame = document.getElementById('stash-frame');
        if (frame?.contentWindow && typeof frame.contentWindow.refreshStashPopularGames === 'function') {
            frame.contentWindow.refreshStashPopularGames();
        }
    } catch (error) {}
}

function queueStashSidebarPopularitySync() {
    clearTimeout(stashPopularitySyncTimer);
    stashPopularitySyncTimer = setTimeout(() => {
        syncStashSidebarPopularity().catch(error => {
            console.warn('Stash sidebar popularity could not be updated:', error);
        });
    }, 120);
}

window.addEventListener('online', queueStashSidebarPopularitySync);

function getHiddenSidebarGameIds(storage = window.nexusStorage || window.localStorage) {
    try {
        const parsed = JSON.parse(storage.getItem(HIDDEN_SIDEBAR_GAMES_KEY) || '[]');
        return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch (error) {
        return new Set();
    }
}

function writeHiddenSidebarGameIds(gameIds, storage = window.nexusStorage || window.localStorage) {
    try {
        storage.setItem(HIDDEN_SIDEBAR_GAMES_KEY, JSON.stringify(Array.from(gameIds, String)));
        return true;
    } catch (error) {
        return false;
    }
}

async function loadGames() {
    const localStorage = window.nexusStorage || window.localStorage;
    const stashPreloadOnEntry = ensureStashPreloaded();
    await initDB();
    const savedOrder = await readSavedSidebarOrder(localStorage);
    const tx = db.transaction("customGames", "readonly");
    const custom = await new Promise((resolve, reject) => {
        const metadata = [];
        const req = tx.objectStore("customGames").openCursor();
        req.onsuccess = e => {
            const cursor = e.target.result;
            if (!cursor) return resolve(metadata);
            const { content, ...gameMetadata } = cursor.value;
            metadata.push(gameMetadata);
            cursor.continue();
        };
        req.onerror = () => reject(req.error);
    });
    const activeCustom = custom;
    try {
        // Default games do not change while the page is open. Reusing this request avoids
        // a network round-trip and JSON parsing every time a Stash item is added.
        if (!defaultGamesPromise) {
            defaultGamesPromise = fetch('games.json').then(res => {
                if (!res.ok) throw new Error(`Unable to load games (${res.status})`);
                return res.json();
            });
        }
        const defaults = await defaultGamesPromise;
        games = [...defaults, ...activeCustom];
    } catch { games = [...activeCustom]; }

    const hiddenSidebarGameIds = getHiddenSidebarGameIds(localStorage);
    games = games.filter(game => game && (String(game.id) === 'ugs-stash' || !hiddenSidebarGameIds.has(String(game.id))));

    // Apply saved order
    if (savedOrder) {
        const gameMap = new Map();
        games.forEach(g => {
            const key = String(g.id);
            if (!gameMap.has(key)) gameMap.set(key, g);
        });
        const ordered = [];
        const seen = new Set();
        savedOrder.forEach(id => {
            if (gameMap.has(id) && !seen.has(id)) {
                ordered.push(gameMap.get(id));
                seen.add(id);
                gameMap.delete(id);
            }
        });
        // Keep newly added games and deterministically append IDs absent from the saved order.
        gameMap.forEach(g => ordered.push(g));
        games = ordered;
    }

    pinMasterStash();
    saveGameOrder();
    renderGameList();
    queueStashSidebarPopularitySync();
    const initialGameLoad = openDefaultGame();
    Promise.all([stashPreloadOnEntry, initialGameLoad]).catch(() => {}).finally(async () => {
        if (typeof window.nexusFinishPageTransition === 'function') window.nexusFinishPageTransition();
        else hideTransitionOverlay();
        const storageStatus = await refreshSavesStorageMeter();
        showSavesStorageWarningOnPageEntry(storageStatus);
    });

    initCarmeowTutorial();
}

function openDefaultGame() {
    if (currentGame || !document.getElementById('game-frame')) return Promise.resolve();
    const preferredGame = games.find(g => g.id === "ugs-stash") || games[0];
    if (preferredGame) return loadGame(preferredGame, true, { suppressHostLoader: true });
    return Promise.resolve();
}

function releaseInactiveGameContent(activeGame) {
    games.forEach(game => {
        if (game !== activeGame && game.type === 'file' && game.content) game.content = null;
    });
}

function pinMasterStash() {
    const stashIndex = games.findIndex(g => g.id === "ugs-stash");
    if (stashIndex <= 0) return false;

    const [stash] = games.splice(stashIndex, 1);
    games.unshift(stash);
    return true;
}

function getFirstMovableIndex() {
    return games.some(g => g.id === "ugs-stash") ? 1 : 0;
}

function saveGameOrder() {
    const localStorage = window.nexusStorage || window.localStorage;
    pinMasterStash();
    const orderIds = games.map(g => g.id.toString());
    saveSidebarOrderToStorage(localStorage, orderIds);
}

/* =========================================
   SIDEBAR COLOR SCHEMES
   Each entry: { fill, border, text }
   fill = background, border = slightly darker, text = contrast label color
========================================= */
const SIDEBAR_COLOR_SCHEMES = [
    {
        id: 'blue',
        dark:  { fill: 'hsl(213,70%,28%)', border: 'hsl(213,70%,18%)', text: '#e8f0ff', swatch: 'hsl(213,80%,50%)' },
        light: { fill: 'hsl(213,85%,88%)', border: 'hsl(213,65%,68%)', text: 'hsl(213,85%,22%)', swatch: 'hsl(213,85%,65%)' }
    },
    {
        id: 'green',
        dark:  { fill: 'hsl(140,55%,22%)', border: 'hsl(140,55%,13%)', text: '#d4f5e0', swatch: 'hsl(140,65%,38%)' },
        light: { fill: 'hsl(140,60%,86%)', border: 'hsl(140,45%,62%)', text: 'hsl(140,75%,18%)', swatch: 'hsl(140,65%,52%)' }
    },
    {
        id: 'red',
        dark:  { fill: 'hsl(0,62%,30%)',   border: 'hsl(0,62%,19%)',   text: '#ffdada', swatch: 'hsl(0,72%,50%)' },
        light: { fill: 'hsl(0,80%,90%)',   border: 'hsl(0,60%,70%)',   text: 'hsl(0,75%,24%)',   swatch: 'hsl(0,80%,65%)' }
    },
    {
        id: 'orange',
        dark:  { fill: 'hsl(28,72%,30%)',  border: 'hsl(28,72%,19%)',  text: '#ffe5c2', swatch: 'hsl(28,88%,50%)' },
        light: { fill: 'hsl(28,85%,88%)',  border: 'hsl(28,65%,65%)',  text: 'hsl(28,85%,22%)',  swatch: 'hsl(28,88%,62%)' }
    },
    {
        id: 'yellow',
        dark:  { fill: 'hsl(48,72%,26%)',  border: 'hsl(48,72%,15%)',  text: '#fff8c0', swatch: 'hsl(48,88%,50%)' },
        light: { fill: 'hsl(48,85%,86%)',  border: 'hsl(48,60%,58%)',  text: 'hsl(48,85%,18%)',  swatch: 'hsl(48,88%,58%)' }
    },
    {
        id: 'purple',
        dark:  { fill: 'hsl(275,55%,28%)', border: 'hsl(275,55%,17%)', text: '#f0daff', swatch: 'hsl(275,70%,55%)' },
        light: { fill: 'hsl(275,70%,90%)', border: 'hsl(275,50%,70%)', text: 'hsl(275,70%,24%)', swatch: 'hsl(275,70%,68%)' }
    },
    {
        id: 'pink',
        dark:  { fill: 'hsl(335,60%,28%)', border: 'hsl(335,60%,17%)', text: '#ffdaea', swatch: 'hsl(335,75%,55%)' },
        light: { fill: 'hsl(335,75%,90%)', border: 'hsl(335,55%,70%)', text: 'hsl(335,75%,24%)', swatch: 'hsl(335,75%,68%)' }
    },
    {
        id: 'teal',
        dark:  { fill: 'hsl(180,55%,22%)', border: 'hsl(180,55%,13%)', text: '#d0f5f5', swatch: 'hsl(180,70%,38%)' },
        light: { fill: 'hsl(180,60%,86%)', border: 'hsl(180,45%,60%)', text: 'hsl(180,75%,18%)', swatch: 'hsl(180,65%,50%)' }
    },
    {
        id: 'indigo',
        dark:  { fill: 'hsl(240,55%,30%)', border: 'hsl(240,55%,19%)', text: '#dce0ff', swatch: 'hsl(240,70%,58%)' },
        light: { fill: 'hsl(240,75%,90%)', border: 'hsl(240,55%,70%)', text: 'hsl(240,75%,24%)', swatch: 'hsl(240,70%,70%)' }
    }
];

function getGameColorScheme(colorId) {
    const scheme = SIDEBAR_COLOR_SCHEMES.find(s => s.id === colorId);
    if (!scheme) return null;
    const isLight = document.documentElement.classList.contains('light-mode');
    return isLight ? scheme.light : scheme.dark;
}

function applyGameColorToLi(li, game) {
    if (!game || !game.sidebarColor) {
        li.style.removeProperty('background-color');
        li.style.removeProperty('border-color');
        li.style.removeProperty('color');
        li.style.removeProperty('--li-bg');
        return;
    }
    if (li.classList.contains('is-deleting')) return;
    const colors = getGameColorScheme(game.sidebarColor);
    if (!colors) return;
    li.style.setProperty('background-color', colors.fill);
    li.style.setProperty('border-color', colors.border);
    li.style.setProperty('color', colors.text);
    li.style.setProperty('--li-bg', colors.fill);
}

async function saveGameRecord(game) {
    if (!game || !game.id) return;
    await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("customGames", "readwrite");
        const store = tx.objectStore("customGames");
        const getReq = store.get(game.id);
        getReq.onsuccess = () => {
            const existing = getReq.result || {};
            const recordToSave = { ...existing };
            for (const [key, value] of Object.entries(game)) {
                if (key === 'content' && (value === null || value === undefined)) {
                    continue;
                }
                recordToSave[key] = value;
            }
            if (!recordToSave.content && existing && existing.content) {
                recordToSave.content = existing.content;
            }
            const putReq = store.put(recordToSave);
            putReq.onerror = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

// Called by Game Stash after it has fetched a game. Keeping the write in the
// parent page avoids competing IndexedDB versions between the iframe and app.
const sidebarExistingHighlightTimeouts = new WeakMap();

window.highlightSidebarGame = function(gameId) {
    const list = document.getElementById('game-list');
    if (!list) return false;

    const target = Array.from(list.querySelectorAll('li[data-game-id]'))
        .find(item => item.dataset.gameId === String(gameId));
    if (!target) return false;

    target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

    const previousTimeout = sidebarExistingHighlightTimeouts.get(target);
    if (previousTimeout) clearTimeout(previousTimeout);
    target.classList.remove('sidebar-already-added-highlight');
    void target.offsetWidth;
    target.classList.add('sidebar-already-added-highlight');

    const timeout = setTimeout(() => {
        target.classList.remove('sidebar-already-added-highlight');
        sidebarExistingHighlightTimeouts.delete(target);
    }, 2000);
    sidebarExistingHighlightTimeouts.set(target, timeout);
    return true;
};

window.addStashGameToSidebar = async function(game) {
    if (!game || !game.id) throw new Error('Invalid game record');

    await saveGameRecord(game);
    const hiddenGameIds = getHiddenSidebarGameIds();
    if (hiddenGameIds.delete(String(game.id))) writeHiddenSidebarGameIds(hiddenGameIds);

    // Keep the sidebar lightweight: retrieve a game's HTML only when it is opened.
    const sidebarGame = { ...game };
    delete sidebarGame.content;

    const existingIndex = games.findIndex(item => String(item.id) === String(sidebarGame.id));
    if (existingIndex !== -1) {
        // Game already exists on the sidebar; preserve its existing position!
        games[existingIndex] = { ...games[existingIndex], ...sidebarGame };
        renderGameList();
        window.highlightSidebarGame(sidebarGame.id);
        notifyStashBookmarkAvailability();
        queueStashSidebarPopularitySync();
        return;
    }

    const stashIndex = games.findIndex(item => item.id === 'ugs-stash');
    games.splice(stashIndex === -1 ? 0 : stashIndex + 1, 0, sidebarGame);
    saveGameOrder();
    renderGameList();
    notifyStashBookmarkAvailability();
    queueStashSidebarPopularitySync();
};

function isSaveManagerTitleUnique(game) {
    const title = String(game && game.title || '').trim().toLowerCase();
    if (!title) return false;
    const gameId = String(game.id || '').toLowerCase();
    const cleanTitle = title.replace(/[^a-z0-9]/g, '');
    return !(games || []).some(other => other && String(other.id || '').toLowerCase() !== gameId &&
        (String(other.title || '').trim().toLowerCase() === title ||
            (cleanTitle && String(other.title || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') === cleanTitle)));
}

function isSaveManagerSourceLeafUnique(game) {
    const sourceFile = String(game && game.sourceFile || '').replace(/\\/g, '/');
    const leaf = sourceFile.split('/').pop().toLowerCase();
    if (!leaf) return false;
    const gameId = String(game.id || '').toLowerCase();
    return !(games || []).some(other => {
        if (!other || String(other.id || '').toLowerCase() === gameId || !other.sourceFile) return false;
        const otherPath = String(other.sourceFile).replace(/\\/g, '/');
        return otherPath.split('/').pop().toLowerCase() === leaf && otherPath.toLowerCase() !== sourceFile.toLowerCase();
    });
}

function findGameByIdOrSource(idOrKey) {
    if (!idOrKey) return null;
    const lower = String(idOrKey).toLowerCase();
    return games.find(g => {
        if (!g) return false;
        if (g.id === idOrKey || String(g.id).toLowerCase() === lower) return true;
        if (g.sourceKey && String(g.sourceKey).toLowerCase() === lower) return true;
        if (g.sourceFile) {
            const sf = String(g.sourceFile).toLowerCase();
            if (sf === lower || sf.replace(/\.html$/, '') === lower) return true;
        }
        if (g.title && isSaveManagerTitleUnique(g) && (String(g.title).toLowerCase() === lower || String(g.title).toLowerCase().replace(/[^a-z0-9]/g, '') === lower)) return true;
        return false;
    }) || null;
}

function doesSnapshotBelongToGame(snapshot, game) {
    if (!snapshot || !game) return false;
    const snapId = String(snapshot.gameId || '').toLowerCase();
    const gId = String(game.id || '').toLowerCase();
    if (snapId === gId) return true;
    if (game.sourceKey && snapId === String(game.sourceKey).toLowerCase()) return true;
    if (game.sourceFile) {
        const sf = String(game.sourceFile).toLowerCase();
        const sfBase = sf.replace(/\.html$/, '');
        if (snapId === sf || snapId === sfBase) return true;
        const filename = sf.split('/').pop();
        if (filename && isSaveManagerSourceLeafUnique(game) && (snapId === filename || snapId === filename.replace(/\.html$/, ''))) return true;
    }
    if (game.title && isSaveManagerTitleUnique(game)) {
        const titleLower = String(game.title).toLowerCase();
        const titleClean = titleLower.replace(/[^a-z0-9]/g, '');
        if (snapId === titleLower || (titleClean && snapId === titleClean)) return true;
    }
    return false;
}

async function getGameSnapshot(gameId) {
    if (!gameId) return null;
    await initDB();
    const idsToCheck = [gameId];
    const matched = findGameByIdOrSource(gameId);
    if (matched) {
        if (matched.id && !idsToCheck.includes(matched.id)) idsToCheck.push(matched.id);
        if (matched.sourceKey && !idsToCheck.includes(matched.sourceKey)) idsToCheck.push(matched.sourceKey);
        if (matched.sourceFile) {
            if (!idsToCheck.includes(matched.sourceFile)) idsToCheck.push(matched.sourceFile);
            const base = matched.sourceFile.replace(/\.html$/, '');
            if (!idsToCheck.includes(base)) idsToCheck.push(base);
        }
    }
    return new Promise(resolve => {
        try {
            const tx = db.transaction('gameSnapshots', 'readonly');
            const store = tx.objectStore('gameSnapshots');
            let found = null;
            let foundSavedAt = -1;
            let foundRank = Infinity;
            let checksLeft = idsToCheck.length;
            idsToCheck.forEach((id, rank) => {
                const req = store.get(id);
                req.onsuccess = () => {
                    if (req.result) {
                        const res = req.result;
                        if (res.localStorage || res.fsData || res.idbData) {
                            const savedAt = Number(res.savedAt) || 0;
                            // Alias records can complete in any order. Select
                            // the newest one rather than whichever IndexedDB
                            // callback happens to win the race.
                            if (!found || savedAt > foundSavedAt || (savedAt === foundSavedAt && rank < foundRank)) {
                                found = {
                                    localStorage: (res.localStorage && typeof res.localStorage === 'object') ? res.localStorage : {},
                                    fsData: (res.fsData && typeof res.fsData === 'object') ? res.fsData : null,
                                    idbData: (res.idbData && typeof res.idbData === 'object') ? res.idbData : null,
                                    indexedDBNames: Array.isArray(res.indexedDBNames) ? res.indexedDBNames.slice() : [],
                                    localStorageComplete: res.localStorageComplete === true,
                                    fsDataComplete: res.fsDataComplete === true,
                                    idbDataComplete: res.idbDataComplete === true,
                                    savedAt
                                };
                                foundSavedAt = savedAt;
                                foundRank = rank;
                            }
                        }
                    }
                    checksLeft--;
                    if (checksLeft === 0) resolve(found);
                };
                req.onerror = () => {
                    checksLeft--;
                    if (checksLeft === 0) resolve(found);
                };
            });
        } catch (e) {
            resolve(null);
        }
    });
}

function getSaveManagerSnapshotIdentity(gameId) {
    const id = String(gameId || '');
    let decoded = id;
    if (id.toLowerCase().startsWith('bookmark_')) {
        try { decoded = decodeURIComponent(id.slice('bookmark_'.length)); } catch (error) {}
    }

    let sourceKey = null;
    let sourceFile = null;
    if (decoded.toLowerCase().startsWith('stash:')) {
        sourceKey = decoded;
        sourceFile = decoded.slice(decoded.indexOf(':') + 1);
    } else if (id.toLowerCase().startsWith('stash:')) {
        sourceKey = id;
        sourceFile = id.slice(id.indexOf(':') + 1);
    } else if (decoded.includes('/') || /\.html?$/i.test(decoded)) {
        sourceFile = decoded;
        sourceKey = `stash:${decoded.toLowerCase()}`;
    }

    const aliases = new Set([id]);
    if (!sourceFile) {
        const title = typeof humanizeBookmarkDisplayName === 'function'
            ? humanizeBookmarkDisplayName(id, true) || id
            : id;
        return { key: `id:${id.toLowerCase()}`, title, aliases };
    }

    sourceFile = sourceFile.replace(/\\/g, '/').replace(/^\/+/, '');
    const sourceBase = sourceFile.replace(/\.html?$/i, '');
    sourceKey = sourceKey || `stash:${sourceFile.toLowerCase()}`;
    aliases.add(decoded);
    aliases.add(sourceKey);
    aliases.add(sourceFile);
    aliases.add(sourceBase);
    aliases.add(`bookmark_${encodeURIComponent(sourceKey)}`);

    const leaf = sourceFile.split('/').pop() || sourceFile;
    let title = leaf.replace(/\.html?$/i, '');
    if (typeof humanizeBookmarkDisplayName === 'function') {
        title = humanizeBookmarkDisplayName(leaf, true) || title;
    }
    return { key: `stash:${sourceFile.toLowerCase()}`, title, aliases };
}

async function getSavedGamesOutsideSidebar(sidebarGames) {
    await initDB();
    const snapshotIds = await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('gameSnapshots', 'readonly');
            const req = tx.objectStore('gameSnapshots').openKeyCursor();
            const ids = [];
            req.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return resolve(ids);
                ids.push(String(cursor.key));
                cursor.continue();
            };
            req.onerror = () => reject(req.error || new Error('Could not read saved game names.'));
            tx.onabort = () => reject(tx.error || new Error('Could not read saved game names.'));
        } catch (error) {
            reject(error);
        }
    });

    const savedIdSet = new Set(snapshotIds);
    const journalPrefix = 'tb_nexus_game_autosave:';
    try {
        const storage = window.nexusStorage || window.localStorage;
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key || !key.startsWith(journalPrefix)) continue;
            const encodedId = key.slice(journalPrefix.length);
            try { savedIdSet.add(decodeURIComponent(encodedId)); } catch (error) { savedIdSet.add(encodedId); }
        }
    } catch (error) {}

    const allSavedIds = Array.from(savedIdSet);
    const idsByLowercase = new Map(allSavedIds.map(id => [id.toLowerCase(), id]));
    const parents = new Map(allSavedIds.map(id => [id, id]));
    const findRoot = id => {
        let root = id;
        while (parents.get(root) !== root) root = parents.get(root);
        while (parents.get(id) !== id) {
            const next = parents.get(id);
            parents.set(id, root);
            id = next;
        }
        return root;
    };
    const join = (left, right) => {
        const leftRoot = findRoot(left);
        const rightRoot = findRoot(right);
        if (leftRoot !== rightRoot) parents.set(rightRoot, leftRoot);
    };
    const identities = new Map(allSavedIds.map(id => [id, getSaveManagerSnapshotIdentity(id)]));

    allSavedIds.forEach(id => {
        identities.get(id).aliases.forEach(alias => {
            const matchingId = idsByLowercase.get(String(alias).toLowerCase());
            if (matchingId) join(id, matchingId);
        });
    });

    const groups = new Map();
    allSavedIds.forEach(id => {
        const root = findRoot(id);
        let group = groups.get(root);
        if (!group) {
            group = { id, title: '', aliases: new Set() };
            groups.set(root, group);
        }
        const identity = identities.get(id);
        if (!group.title || identity.title.length > group.title.length) group.title = identity.title;
        identity.aliases.forEach(alias => group.aliases.add(String(alias)));
        group.aliases.add(id);
    });

    return Array.from(groups.values())
        .filter(group => !Array.from(group.aliases).some(id =>
            (sidebarGames || []).some(game => doesSnapshotBelongToGame({ gameId: id }, game))
        ))
        .map(group => ({
            id: group.id,
            title: group.title || group.id,
            aliases: Array.from(group.aliases),
            offSidebar: true
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
}

function estimateSaveStringBytes(value) {
    const text = String(value ?? '');
    let bytes = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
            const next = text.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                index++;
            } else {
                bytes += 3;
            }
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

function estimateSavePayloadBytes(value) {
    try {
        const seen = new WeakSet();
        let bytes = 0;
        const add = item => {
            if (item === null || item === undefined) {
                bytes += 4;
                return;
            }
            if (typeof item === 'string') {
                bytes += estimateSaveStringBytes(item);
                return;
            }
            if (typeof item === 'number' || typeof item === 'bigint') {
                bytes += 8;
                return;
            }
            if (typeof item === 'boolean') {
                bytes += 4;
                return;
            }
            if (typeof item !== 'object') return;
            if (typeof Blob === 'function' && item instanceof Blob) {
                bytes += item.size;
                return;
            }
            if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) {
                bytes += item.byteLength;
                return;
            }
            if (item instanceof Date) {
                bytes += 8;
                return;
            }
            if (seen.has(item)) return;
            seen.add(item);
            if (item instanceof Map) {
                item.forEach((entryValue, entryKey) => { add(entryKey); add(entryValue); });
                return;
            }
            if (item instanceof Set) {
                item.forEach(add);
                return;
            }
            if (Array.isArray(item)) {
                bytes += 16;
                item.forEach(add);
                return;
            }
            for (const key in item) {
                if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
                bytes += estimateSaveStringBytes(key) + 8;
                add(item[key]);
            }
        };
        add(value);
        return Number.isFinite(bytes) ? bytes : null;
    } catch (error) {
        return null;
    }
}

function getSaveManagerGameAliases(game) {
    const aliases = new Set();
    if (!game) return aliases;
    const candidates = [game.id, game.sourceKey, game.sourceFile, isSaveManagerTitleUnique(game) ? game.title : null].filter(Boolean).map(String);
    candidates.forEach(candidate => {
        aliases.add(candidate.toLowerCase());
        const identity = getSaveManagerSnapshotIdentity(candidate);
        identity.aliases.forEach(alias => aliases.add(String(alias).toLowerCase()));
    });
    if (game.sourceFile) {
        const sourceFile = String(game.sourceFile).replace(/\\/g, '/').replace(/^\/+/, '');
        aliases.add(sourceFile.toLowerCase());
        aliases.add(sourceFile.replace(/\.html?$/i, '').toLowerCase());
        const leaf = sourceFile.split('/').pop() || sourceFile;
        if (isSaveManagerSourceLeafUnique(game)) {
            aliases.add(leaf.toLowerCase());
            aliases.add(leaf.replace(/\.html?$/i, '').toLowerCase());
        }
    }
    if (game.sourceKey) {
        const sourceKey = String(game.sourceKey);
        aliases.add(`bookmark_${sourceKey}`.toLowerCase());
        aliases.add(`bookmark_${encodeURIComponent(sourceKey)}`.toLowerCase());
    }
    return aliases;
}

async function getSaveManagerSizeEstimates(sidebarGames, offSidebarGames) {
    await initDB();
    const bytesById = new Map();
    const savedAtById = new Map();
    const metadataIds = new Set();
    const metadataSizeIds = new Set();
    const metadataNamesById = new Map();
    const addSize = (gameId, bytes, savedAt = null) => {
        if (!gameId) return;
        const key = String(gameId).toLowerCase();
        if (!Number.isFinite(bytes) || bytes < 0) {
            bytesById.set(key, null);
        } else if (bytesById.get(key) !== null) {
            bytesById.set(key, (bytesById.get(key) || 0) + bytes);
        }
        const timestamp = Number(savedAt);
        if (Number.isFinite(timestamp) && timestamp > (savedAtById.get(key) || 0)) savedAtById.set(key, timestamp);
    };

    // New saves keep a compact size/ownership index beside the full snapshot.
    // This avoids cloning large save records just to display their sizes.
    await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(NEXUS_GAME_SNAPSHOT_META_STORE, 'readonly');
            const request = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE).openCursor();
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return resolve();
                const gameId = String(cursor.primaryKey || cursor.key || '');
                metadataIds.add(gameId.toLowerCase());
                const metadata = cursor.value || {};
                metadataNamesById.set(gameId.toLowerCase(), Array.isArray(metadata.indexedDBNames)
                    ? metadata.indexedDBNames.map(String).filter(name => name && !NEXUS_SHARED_DATABASE_NAMES.has(name))
                    : []);
                const estimate = metadata.estimatedBytes === null || metadata.estimatedBytes === undefined
                    ? null : Number(metadata.estimatedBytes);
                if (Number(metadata.estimatedBytesVersion) === NEXUS_GAME_SNAPSHOT_ESTIMATE_VERSION && Number.isFinite(estimate) && estimate >= 0) {
                    metadataSizeIds.add(gameId.toLowerCase());
                    addSize(gameId, estimate, metadata.savedAt);
                }
                cursor.continue();
            };
            request.onerror = () => reject(request.error || tx.error || new Error('Could not read saved game size metadata.'));
            tx.onabort = () => reject(tx.error || new Error('Could not read saved game size metadata.'));
        } catch (error) {
            reject(error);
        }
    });

    // Legacy snapshots have no size index. Read one at a time as a migration
    // fallback; a single unreadable record only affects that game's label.
    const legacyMetadataToPersist = [];
    await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('gameSnapshots', 'readonly');
            const store = tx.objectStore('gameSnapshots');
            const request = store.openKeyCursor();
            request.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return resolve();
                const gameId = String(cursor.primaryKey || cursor.key || '');
                if (metadataSizeIds.has(gameId.toLowerCase())) {
                    cursor.continue();
                    return;
                }
                const valueRequest = store.get(cursor.primaryKey);
                valueRequest.onsuccess = () => {
                    const key = gameId.toLowerCase();
                    const snapshot = valueRequest.result;
                    const size = estimateSavePayloadBytes(snapshot);
                    if (size !== null) {
                        bytesById.delete(key);
                        savedAtById.delete(key);
                        addSize(gameId, size, snapshot && snapshot.savedAt);
                        const databaseNames = new Set([
                            ...(metadataNamesById.get(key) || []),
                            ...(Array.isArray(snapshot && snapshot.indexedDBNames) ? snapshot.indexedDBNames : []),
                            ...(snapshot && snapshot.idbData && typeof snapshot.idbData === 'object' ? Object.keys(snapshot.idbData) : [])
                        ].map(String).filter(name => name && !NEXUS_SHARED_DATABASE_NAMES.has(name)));
                        metadataNamesById.set(key, Array.from(databaseNames));
                        legacyMetadataToPersist.push({
                            gameId,
                            indexedDBNames: Array.from(databaseNames),
                            estimatedBytes: size,
                            estimatedBytesVersion: NEXUS_GAME_SNAPSHOT_ESTIMATE_VERSION,
                            savedAt: Number(snapshot && snapshot.savedAt) || 0
                        });
                    } else {
                        addSize(gameId, null);
                    }
                    cursor.continue();
                };
                valueRequest.onerror = errorEvent => {
                    // Keep one unmeasurable legacy record from making every
                    // game's size unavailable.
                    errorEvent.preventDefault();
                    bytesById.delete(gameId.toLowerCase());
                    addSize(gameId, null);
                    cursor.continue();
                };
            };
            request.onerror = () => reject(request.error || tx.error || new Error('Could not estimate saved game sizes.'));
            tx.onabort = () => reject(tx.error || new Error('Could not estimate saved game sizes.'));
        } catch (error) {
            reject(error);
        }
    });
    if (legacyMetadataToPersist.length) {
        try {
            await new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction(NEXUS_GAME_SNAPSHOT_META_STORE, 'readwrite');
                    const store = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE);
                    legacyMetadataToPersist.forEach(metadata => store.put(metadata));
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error || new Error('Could not save legacy game size metadata.'));
                    tx.onabort = () => reject(tx.error || new Error('Could not save legacy game size metadata.'));
                } catch (error) {
                    reject(error);
                }
            });
        } catch (error) {
            console.warn('Legacy game size estimates could not be cached.', error);
        }
    }
    metadataIds.forEach(gameId => {
        if (!metadataSizeIds.has(gameId) && !bytesById.has(gameId)) bytesById.set(gameId, null);
    });

    const journalPrefix = 'tb_nexus_game_autosave:';
    try {
        const storage = window.nexusStorage || window.localStorage;
        for (let index = 0; index < storage.length; index++) {
            const key = storage.key(index);
            if (!key || !key.startsWith(journalPrefix)) continue;
            let gameId = key.slice(journalPrefix.length);
            try { gameId = decodeURIComponent(gameId); } catch (error) {}
            const value = storage.getItem(key) || '';
            const bytes = estimateSavePayloadBytes({ key, value });
            const normalizedId = String(gameId).toLowerCase();
            let journalSavedAt = 0;
            try {
                const journal = JSON.parse(value);
                journalSavedAt = Number(journal && journal.savedAt) || 0;
            } catch (error) {}
            if (bytes === null) {
                addSize(normalizedId, null, journalSavedAt);
            } else if (bytesById.get(normalizedId) !== null) {
                addSize(normalizedId, bytes, journalSavedAt);
            }
        }
    } catch (error) {}

    let availableDatabaseNamesPromise = null;
    const databaseSizePromises = new Map();
    const getAvailableDatabaseNames = () => {
        if (!availableDatabaseNamesPromise) {
            availableDatabaseNamesPromise = typeof window.indexedDB.databases === 'function'
                ? window.indexedDB.databases().then(databases => new Set((databases || []).map(database => String(database && database.name || '')))).catch(() => null)
                : Promise.resolve(null);
        }
        return availableDatabaseNamesPromise;
    };
    const estimateOwnedDatabaseBytes = name => {
        if (databaseSizePromises.has(name)) return databaseSizePromises.get(name);
        const estimatePromise = (async () => {
            const availableNames = await getAvailableDatabaseNames();
            // Without database enumeration, opening an unknown name would create
            // an empty database and could report a false zero-size estimate.
            if (!availableNames) return null;
            if (!availableNames.has(name)) return 0;
            let gameDatabase = null;
            try {
                gameDatabase = await new Promise((resolve, reject) => {
                    const request = window.indexedDB.open(name);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error || new Error('Could not open a tracked game database.'));
                    request.onblocked = () => reject(new Error('A tracked game database is busy.'));
                });
                gameDatabase.onversionchange = () => { try { gameDatabase.close(); } catch (error) {} };
                let totalBytes = 0;
                for (const storeName of Array.from(gameDatabase.objectStoreNames)) {
                    await new Promise((resolve, reject) => {
                        try {
                            const tx = gameDatabase.transaction(storeName, 'readonly');
                            const request = tx.objectStore(storeName).openCursor();
                            request.onsuccess = event => {
                                const cursor = event.target.result;
                                if (!cursor) return resolve();
                                const recordBytes = estimateSavePayloadBytes({ key: cursor.primaryKey, value: cursor.value });
                                if (!Number.isFinite(recordBytes)) {
                                    reject(new Error('A tracked game database record could not be estimated.'));
                                    return;
                                }
                                totalBytes += recordBytes;
                                cursor.continue();
                            };
                            request.onerror = () => reject(request.error || tx.error || new Error('Could not read a tracked game database.'));
                            tx.onabort = () => reject(tx.error || new Error('Reading a tracked game database was interrupted.'));
                        } catch (error) {
                            reject(error);
                        }
                    });
                }
                return totalBytes;
            } catch (error) {
                console.warn(`Could not estimate tracked game database “${name}”.`, error);
                return null;
            } finally {
                if (gameDatabase) {
                    try { gameDatabase.close(); } catch (error) {}
                }
            }
        })();
        databaseSizePromises.set(name, estimatePromise);
        return estimatePromise;
    };

    const estimateForAliases = async aliases => {
        const matching = [];
        bytesById.forEach((bytes, gameId) => {
            const identityAliases = getSaveManagerSnapshotIdentity(gameId).aliases;
            if (aliases.has(gameId) || Array.from(identityAliases).some(alias => aliases.has(String(alias).toLowerCase()))) {
                matching.push({ gameId, bytes, savedAt: savedAtById.get(gameId) || 0 });
            }
        });
        if (!matching.length) return { bytes: 0, unknownDatabaseCount: 0, gameDatabaseCount: 0 };
        const newestSavedAt = Math.max(...matching.map(item => item.savedAt));
        const currentRecords = matching.filter(item => item.savedAt === newestSavedAt);
        if (currentRecords.some(item => item.bytes === null)) return { bytes: null, unknownDatabaseCount: 0, gameDatabaseCount: 0 };
        // Historical alias mirrors represent the same logical save. The newest
        // record is what restore uses, so do not add stale copies to its size.
        const snapshotBytes = currentRecords.reduce((largest, item) => Math.max(largest, item.bytes || 0), 0);
        const databaseNames = new Set(currentRecords.flatMap(item => metadataNamesById.get(item.gameId) || []));
        let gameDatabaseBytes = 0;
        let unknownDatabaseCount = 0;
        for (const name of databaseNames) {
            const bytes = await estimateOwnedDatabaseBytes(name);
            if (!Number.isFinite(bytes) || bytes < 0) unknownDatabaseCount++;
            else gameDatabaseBytes += bytes;
        }
        return {
            bytes: snapshotBytes + gameDatabaseBytes,
            unknownDatabaseCount,
            gameDatabaseCount: databaseNames.size
        };
    };

    const estimates = new Map();
    for (const game of sidebarGames || []) {
        const aliases = getSaveManagerGameAliases(game);
        const normalizedAliases = new Set(Array.from(aliases, alias => String(alias).toLowerCase()));
        estimates.set(String(game.id), await estimateForAliases(normalizedAliases));
    }
    for (const game of offSidebarGames || []) {
        const aliases = new Set([String(game.id), ...(game.aliases || []).map(String)].map(id => id.toLowerCase()));
        estimates.set(String(game.id), await estimateForAliases(aliases));
    }
    return estimates;
}

async function deleteGameSnapshotAlias(aliasId, canonicalId, maxSavedAt = Infinity) {
    if (!aliasId || !canonicalId || String(aliasId).toLowerCase() === String(canonicalId).toLowerCase()) return false;
    await initDB();
    const storage = window.nexusStorage || window.localStorage;
    const journalKey = `tb_nexus_game_autosave:${encodeURIComponent(String(aliasId))}`;
    const readJournal = () => {
        try {
            const raw = storage.getItem(journalKey);
            if (!raw) return { present: false, savedAt: 0 };
            const journal = JSON.parse(raw);
            const savedAt = Number(journal && journal.savedAt);
            return { present: true, savedAt: Number.isFinite(savedAt) ? savedAt : null };
        } catch (error) {
            return { present: true, savedAt: null };
        }
    };
    const journalCanBeReclaimed = journal => !journal.present ||
        (Number.isFinite(journal.savedAt) && journal.savedAt <= Number(maxSavedAt));
    if (!journalCanBeReclaimed(readJournal())) return false;

    const aliasDeleted = await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(['gameSnapshots', NEXUS_GAME_SNAPSHOT_META_STORE], 'readwrite');
            const metaStore = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE);
            const values = {};
            let readsRemaining = 2;
            let didDelete = false;
            const finishRead = (key, request) => {
                request.onsuccess = () => {
                    values[key] = request.result || null;
                    readsRemaining--;
                    if (readsRemaining) return;
                    if (!journalCanBeReclaimed(readJournal())) return;

                    // Preserve ownership reports that arrived after the
                    // canonical mirror was written, without cloning the two
                    // potentially very large save snapshots.
                    const databaseNames = new Set([
                        ...(Array.isArray(values.aliasMetadata && values.aliasMetadata.indexedDBNames) ? values.aliasMetadata.indexedDBNames : []),
                        ...(Array.isArray(values.canonicalMetadata && values.canonicalMetadata.indexedDBNames) ? values.canonicalMetadata.indexedDBNames : [])
                    ].map(String).filter(name => name && !NEXUS_SHARED_DATABASE_NAMES.has(name)));
                    if (values.canonicalMetadata || databaseNames.size) {
                        const metadata = values.canonicalMetadata || { gameId: canonicalId };
                        metadata.indexedDBNames = Array.from(databaseNames);
                        metaStore.put(metadata);
                    }
                    metaStore.delete(aliasId);
                    tx.objectStore('gameSnapshots').delete(aliasId);
                    didDelete = true;
                };
                request.onerror = () => reject(request.error || tx.error || new Error('Could not consolidate the duplicate game snapshot.'));
            };
            finishRead('aliasMetadata', metaStore.get(aliasId));
            finishRead('canonicalMetadata', metaStore.get(canonicalId));
            tx.oncomplete = () => resolve(didDelete);
            tx.onerror = () => reject(tx.error || new Error('Could not consolidate the duplicate game snapshot.'));
            tx.onabort = () => reject(tx.error || new Error('Could not consolidate the duplicate game snapshot.'));
        } catch (error) {
            reject(error);
        }
    });
    if (!aliasDeleted) return false;
    const latestJournal = readJournal();
    if (journalCanBeReclaimed(latestJournal) && latestJournal.present) {
        try { storage.removeItem(journalKey); } catch (error) {}
    }
    return true;
}

async function saveGameSnapshot(gameId, payload, skipMirror = false) {
    if (!gameId || !payload || typeof payload !== 'object') return;
    if (!ownsGameSaveSession(gameId, payload.saveSessionId)) return;
    await initDB();

    // A popup can still deliver a save after a newer one has already been
    // committed. Keep the time assigned by the game document so an older
    // asynchronous IndexedDB request can never roll progress back.
    const payloadSavedAt = Number(payload.savedAt);
    const incomingSavedAt = Number.isFinite(payloadSavedAt) && payloadSavedAt > 0
        ? payloadSavedAt
        : Date.now();

    let incomingLs = {};
    let incomingFs = null;
    let incomingIdb = null;
    const incomingLsIsComplete = payload.localStorageComplete === true;
    const incomingFsIsComplete = payload.fsDataComplete === true;
    const incomingIdbIsComplete = payload.idbDataComplete === true;

    if (payload.localStorage || payload.fsData || payload.idbData || payload.indexedDBNames) {
        incomingLs = (payload.localStorage && typeof payload.localStorage === 'object') ? payload.localStorage : {};
        incomingFs = (payload.fsData && typeof payload.fsData === 'object') ? payload.fsData : null;
        incomingIdb = (payload.idbData && typeof payload.idbData === 'object') ? payload.idbData : null;
    } else {
        incomingLs = payload;
    }
    const incomingIndexedDBNames = Array.isArray(payload.indexedDBNames)
        ? payload.indexedDBNames.map(name => String(name || '')).filter(name => name && name.length <= 120 && !NEXUS_SHARED_DATABASE_NAMES.has(name))
        : [];

    // Read, compare, merge, and write in one readwrite transaction. Doing the
    // read in a separate transaction lets two concurrent saves both compare
    // against the same old record, so the older payload can commit last.
    return new Promise((resolve, reject) => {
        let snapshotRecord = null;
        let signature = null;
        let didSave = false;
        let tx;
        try {
            tx = db.transaction(['gameSnapshots', NEXUS_GAME_SNAPSHOT_META_STORE], 'readwrite');
            const store = tx.objectStore('gameSnapshots');
            const metaStore = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE);
            const metaGetReq = metaStore.get(gameId);
            const getReq = store.get(gameId);
            getReq.onsuccess = () => {
                if (!ownsGameSaveSession(gameId, payload.saveSessionId)) return;
                const existing = getReq.result || null;
                if (existing && Number(existing.savedAt) > incomingSavedAt) return;

                const incomingKeys = Object.keys(incomingLs);
                const existingData = (existing && existing.localStorage && typeof existing.localStorage === 'object') ? existing.localStorage : {};
                const existingKeys = Object.keys(existingData);

                // Protection: If incoming localStorage snapshot is empty but existing snapshot has valid progress, preserve existing
                let lsToSave = { ...incomingLs };
                if (!incomingLsIsComplete && incomingKeys.length === 0 && existingKeys.length > 0) {
                    lsToSave = { ...existingData };
                } else if (!incomingLsIsComplete && incomingKeys.length > 0 && existingKeys.length > 0) {
                    lsToSave = { ...existingData, ...incomingLs };
                }

                // Protection: Never overwrite non-empty virtual FS files with null or empty
                let fsToSave = incomingFsIsComplete
                    ? (incomingFs && Object.keys(incomingFs).length ? { ...incomingFs } : null)
                    : (existing && existing.fsData ? { ...existing.fsData } : null);
                if (!incomingFsIsComplete && incomingFs && Object.keys(incomingFs).length > 0) {
                    fsToSave = { ...(fsToSave || {}), ...incomingFs };
                }

                // Protection: Never overwrite non-empty IndexedDB records with null or empty
                let idbToSave = incomingIdbIsComplete
                    ? (incomingIdb && Object.keys(incomingIdb).length ? { ...incomingIdb } : null)
                    : (existing && existing.idbData ? { ...existing.idbData } : null);
                if (!incomingIdbIsComplete && incomingIdb && Object.keys(incomingIdb).length > 0) {
                    idbToSave = { ...(idbToSave || {}), ...incomingIdb };
                }
                const existingMetadata = metaGetReq.result || null;
                const indexedDBNames = Array.from(new Set([
                    ...(Array.isArray(existing && existing.indexedDBNames) ? existing.indexedDBNames : []),
                    ...(Array.isArray(existingMetadata && existingMetadata.indexedDBNames) ? existingMetadata.indexedDBNames : []),
                    ...incomingIndexedDBNames
                ]));

                // Keep a real content signature. The previous length-only signature treated
                // equally-sized progress values as unchanged, which silently skipped saves.
                const signatureForValue = value => {
                    const encoded = typeof value === 'string' ? value : JSON.stringify(value);
                    const text = typeof encoded === 'string' ? encoded : String(value ?? '');
                    let hash = 2166136261;
                    for (let index = 0; index < text.length; index++) {
                        hash ^= text.charCodeAt(index);
                        hash = Math.imul(hash, 16777619);
                    }
                    return `${text.length}:${hash >>> 0}`;
                };
                let sig = `LC${incomingLsIsComplete ? 1 : 0}|FC${incomingFsIsComplete ? 1 : 0}|IC${incomingIdbIsComplete ? 1 : 0}`;
                if (lsToSave) {
                    const lsKeys = Object.keys(lsToSave);
                    sig += 'L' + lsKeys.length;
                    for (let i = 0; i < lsKeys.length; i++) {
                        const key = lsKeys[i];
                        sig += ':' + key + '=' + signatureForValue(lsToSave[key]);
                    }
                }
                if (fsToSave) {
                    const fsKeys = Object.keys(fsToSave);
                    sig += '|F' + fsKeys.length;
                    for (let i = 0; i < fsKeys.length; i++) {
                        const f = fsToSave[fsKeys[i]];
                        sig += ':' + fsKeys[i] + '=' + signatureForValue(f && f.data ? f.data : '');
                    }
                }
                if (idbToSave) {
                    const idbKeys = Object.keys(idbToSave);
                    sig += '|I' + idbKeys.length;
                    for (let i = 0; i < idbKeys.length; i++) {
                        const ent = idbToSave[idbKeys[i]];
                        sig += ':' + idbKeys[i] + '=' + signatureForValue(ent && ent.contents ? ent.contents : '');
                    }
                }
                if (indexedDBNames.length) {
                    sig += '|D' + indexedDBNames.slice().sort().join(',');
                }
                if (snapshotHashes.get(gameId) === sig && existing && Number(existing.savedAt) >= incomingSavedAt) return;

                const savedAt = incomingSavedAt;
                snapshotRecord = {
                    gameId,
                    localStorage: lsToSave,
                    fsData: fsToSave,
                    idbData: idbToSave,
                    indexedDBNames,
                    localStorageComplete: incomingLsIsComplete,
                    fsDataComplete: incomingFsIsComplete || existing && existing.fsDataComplete === true,
                    idbDataComplete: incomingIdbIsComplete || existing && existing.idbDataComplete === true,
                    savedAt
                };
                signature = sig;
                didSave = true;
                store.put(snapshotRecord);
                metaStore.put({
                    gameId,
                    indexedDBNames,
                    estimatedBytes: estimateSavePayloadBytes(snapshotRecord),
                    estimatedBytesVersion: NEXUS_GAME_SNAPSHOT_ESTIMATE_VERSION,
                    savedAt
                });
            };
            getReq.onerror = () => reject(getReq.error || tx.error || new Error('Could not read the saved game snapshot.'));
            tx.oncomplete = () => {
                if (didSave) {
                    snapshotHashes.set(gameId, signature);
                    refreshSavesStorageMeter();

                    // IndexedDB is the durable source of truth. Avoid retaining these full
                    // filesystem/IndexedDB snapshots in a page-level cache after the write;
                    // some game saves contain large binary payloads.
                    if (!skipMirror) {
                        const matched = findGameByIdOrSource(gameId);
                        if (matched && matched.id && matched.id !== gameId) {
                            saveGameSnapshot(matched.id, {
                                localStorage: snapshotRecord.localStorage,
                                fsData: snapshotRecord.fsData,
                                idbData: snapshotRecord.idbData,
                                indexedDBNames: snapshotRecord.indexedDBNames,
                                localStorageComplete: snapshotRecord.localStorageComplete === true,
                                fsDataComplete: snapshotRecord.fsDataComplete === true,
                                idbDataComplete: snapshotRecord.idbDataComplete === true,
                                savedAt: snapshotRecord.savedAt,
                                saveSessionId: payload.saveSessionId
                            }, true).catch(error => {
                                if (isStorageQuotaError(error)) handleSavesStorageQuotaFailure('indexedDB', matched.id);
                            }).then(canonicalRecord => {
                                if (canonicalRecord) {
                                    return deleteGameSnapshotAlias(gameId, matched.id, canonicalRecord.savedAt).catch(error => {
                                        console.warn('A duplicate game snapshot could not be reclaimed yet.', error);
                                    });
                                }
                            });
                        }
                    }
                }
                resolve(snapshotRecord);
            };
            tx.onerror = () => reject(tx.error || new Error('Could not save the game snapshot.'));
            tx.onabort = () => reject(tx.error || new Error('Game snapshot save was interrupted.'));
        } catch (error) {
            reject(error);
        }
    });
}

async function recordGameIndexedDBUse(gameId, databaseName, saveSessionId = null) {
    const name = String(databaseName || '');
    if (!gameId || !name || name.length > 120 || NEXUS_SHARED_DATABASE_NAMES.has(name) || !ownsGameSaveSession(gameId, saveSessionId)) return;
    await initDB();
    return new Promise((resolve, reject) => {
        let tx;
        let didWrite = false;
        try {
            tx = db.transaction(NEXUS_GAME_SNAPSHOT_META_STORE, 'readwrite');
            const store = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE);
            const request = store.get(gameId);
            request.onsuccess = () => {
                if (!ownsGameSaveSession(gameId, saveSessionId)) return;
                const metadata = request.result || { gameId, estimatedBytes: null };
                const names = new Set(Array.isArray(metadata.indexedDBNames) ? metadata.indexedDBNames : []);
                names.add(name);
                metadata.indexedDBNames = Array.from(names);
                if (!Number.isFinite(Number(metadata.savedAt))) metadata.savedAt = Date.now();
                store.put(metadata);
                didWrite = true;
            };
            request.onerror = () => reject(request.error || tx.error || new Error('Could not track the game database.'));
            tx.oncomplete = () => resolve(didWrite);
            tx.onerror = () => reject(tx.error || new Error('Could not track the game database.'));
            tx.onabort = () => reject(tx.error || new Error('Could not track the game database.'));
        } catch (error) {
            reject(error);
        }
    });
}

function requestCurrentGameAutosave() {
    const frame = document.getElementById('game-frame');
    if (frame && frame.contentWindow) {
        try { frame.contentWindow.postMessage({ type: 'nexus-request-game-save' }, '*'); } catch (e) {}
    }
    // Also message every active popup, including duplicate launches of one game.
    activeGameSessions.forEach(session => {
        const win = session.win;
        if (win && !win.closed) {
            try { win.postMessage({ type: 'nexus-request-game-save' }, '*'); } catch (e) {}
        }
    });
}

function startGameAutosave() {
    if (gameAutosaveTimer) clearInterval(gameAutosaveTimer);
    // Continuous periodic sync heartbeat (15s throttled to reduce CPU/RAM thrashing)
    gameAutosaveTimer = setInterval(() => {
        if (currentGame && currentGame.id !== 'ugs-stash') requestCurrentGameAutosave();
    }, 15000);
}

window.addEventListener('message', event => {
    const message = event.data;
    if (!message) return;

    if (message.type === 'nexus-popup-closed' && message.sessionId) {
        handleGamePopupClosed(message.sessionId);
        return;
    }

    const frame = document.getElementById('game-frame');
    const isEmbeddedGame = frame && event.source === frame.contentWindow;
    let isKnownPopup = false;
    if (message.gameId && popupGameWindows.has(message.gameId)) {
        const win = popupGameWindows.get(message.gameId);
        if (win === event.source || (win && win.closed)) isKnownPopup = true;
    }
    for (const session of activeGameSessions.values()) {
        if (session.win === event.source) { isKnownPopup = true; break; }
    }
    if (message.type === 'nexus-popup-closed' && message.gameId) {
        for (const session of activeGameSessions.values()) {
            if (session.gameId === String(message.gameId) && session.win === event.source) {
                handleGamePopupClosed(session.sessionId);
                return;
            }
        }
    }

    const originSafe = !event.origin || event.origin === 'null' || event.origin === window.location.origin || window.location.protocol === 'file:';
    if (!originSafe && !isEmbeddedGame && !isKnownPopup) return;

    if (message.type === 'nexus-game-storage-quota-error') {
        const gameId = String(message.gameId || '');
        if (!gameId || !ownsGameSaveSession(gameId, message.saveSessionId)) return;
        handleSavesStorageQuotaFailure(String(message.storageType || 'browser storage'), gameId);
        return;
    }

    if (message.type === 'nexus-game-database-use') {
        const gameId = String(message.gameId || '');
        if (!gameId || !ownsGameSaveSession(gameId, message.saveSessionId)) return;
        recordGameIndexedDBUse(gameId, message.databaseName, message.saveSessionId).catch(error => {
            if (isStorageQuotaError(error)) handleSavesStorageQuotaFailure('indexedDB', gameId);
        });
        return;
    }

    if (message.type === 'nexus-game-save') {
        const gameId = message.gameId || (currentGame && currentGame.id ? currentGame.id : null);
        if (gameId && (message.localStorage || message.fsData || message.idbData || message.indexedDBNames)) {
            saveGameSnapshot(gameId, {
                localStorage: message.localStorage,
                fsData: message.fsData,
                idbData: message.idbData,
                indexedDBNames: message.indexedDBNames,
                localStorageComplete: message.localStorageComplete === true,
                fsDataComplete: message.fsDataComplete === true,
                idbDataComplete: message.idbDataComplete === true,
                savedAt: message.savedAt,
                saveSessionId: message.saveSessionId
            }).catch(error => {
                if (isStorageQuotaError(error)) handleSavesStorageQuotaFailure('indexedDB', gameId);
            });
        }
    } else if (message.type === 'nexus-request-game-restore') {
        const gameId = message.gameId || (currentGame && currentGame.id ? currentGame.id : null);
        if (gameId && event.source) {
            getGameSnapshot(gameId).then(snapshot => {
                if (snapshot && event.source) {
                    try {
                        event.source.postMessage({
                            type: 'nexus-apply-game-restore',
                            gameId: gameId,
                            localStorage: snapshot.localStorage || {},
                            localStorageComplete: snapshot.localStorageComplete === true,
                            fsData: snapshot.fsData || null,
                            fsDataComplete: snapshot.fsDataComplete === true,
                            idbData: snapshot.idbData || null,
                            idbDataComplete: snapshot.idbDataComplete === true
                        }, '*');
                    } catch (e) {}
                }
            });
        }
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) requestCurrentGameAutosave();
}, { passive: true });

window.addEventListener('pagehide', requestCurrentGameAutosave, { passive: true });
window.addEventListener('beforeunload', requestCurrentGameAutosave, { passive: true });
window.addEventListener('storage', event => {
    if (event.key === 'tb_system_backup_flush') requestCurrentGameAutosave();
}, { passive: true });

startGameAutosave();

async function setGameColor(gameId, colorId) {
    const game = games.find(g => g.id === gameId);
    if (!game) return;
    if (colorId === null) {
        delete game.sidebarColor;
    } else {
        game.sidebarColor = colorId;
    }
    saveGameRecord(game).catch(() => {});
    // Update the sidebar li immediately (no full re-render needed)
    const li = document.querySelector(`#game-list li[data-game-id="${gameId}"]`);
    if (li) applyGameColorToLi(li, game);
    // Refresh the active-color highlight in the open swatch row
    refreshSwatchActiveState(colorId);
}

function renderGameList() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = '';
    const fragment = document.createDocumentFragment();
    games.forEach((game, i) => {
        const li = document.createElement('li');
        li.dataset.gameId = game.id;
        
        if (game.id === "ugs-stash") li.classList.add('ugs-item');
        if (game.isNew) {
            li.classList.add('new-game');
            li.style.setProperty('--li-bg', '#2f972c');
        } else if (game.id !== "ugs-stash" && game.sidebarColor) {
            applyGameColorToLi(li, game);
        }
        
        const t = document.createElement('span');
        t.className = "game-title";
        if (game.id === "ugs-stash") t.classList.add("game-title-single-line");
        t.textContent = game.id === "ugs-stash" ? getSidebarTitle(game) : addSoftBreaks(getSidebarTitle(game), 13);

        li.onclick = () => {
            if (game.isNew) {
                game.isNew = false;
                saveGameRecord(game).catch(() => {});
                li.classList.remove('new-game');
                if (game.sidebarColor) {
                    applyGameColorToLi(li, game);
                } else {
                    li.style.removeProperty('--li-bg');
                }
            }
            loadGame(game);
            // Hold expanded state for 500ms after click, then slide back
            if (game.id !== 'ugs-stash' && !document.documentElement.classList.contains('performance-mode')) {
                li.classList.add('post-click');
                setTimeout(() => li.classList.remove('post-click'), 500);
            }
        };

        if (game.id !== 'ugs-stash') {
            // Wrap in a clipping container that slides open on hover
            const wrapper = document.createElement('div');
            wrapper.className = 'game-title-wrapper';
            wrapper.appendChild(t);
            li.appendChild(wrapper);
        } else {
            li.appendChild(t);
        }

        if (isUserManagedGame(game)) {
            const rename = document.createElement('span');
            rename.innerHTML = '<img src="Assets/Rename.svg" alt="Edit" style="width:18px;height:18px;filter:var(--icon-filter);vertical-align:middle;">';
            rename.className = "app-action-btn rename-btn";
            rename.title = "Edit app";
            rename.addEventListener('pointerdown', (e) => e.stopPropagation());
            rename.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                openRenamePrompt(game);
            });
            li.appendChild(rename);

            const del = document.createElement('span');
            del.innerHTML = '<img src="Assets/Delete.svg" alt="Delete" style="width:18px;height:18px;filter:var(--icon-filter);vertical-align:middle;">';
            del.className = "app-action-btn trash-btn";
            del.style.marginRight = "22px";

            // A short press gives guidance; a continuous 1.5s press deletes.
            {
                const HOLD_MS = 1500;
                let holdRAF = null;
                let holdStart = null;
                let didDelete = false;

                function startHold(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    if (holdRAF) return;
                    didDelete = false;
                    holdStart = performance.now();
                    del.classList.add('holding');
                    li.classList.add('is-deleting');
                    li.style.setProperty('background-color', '#b71c1c', 'important');
                    li.style.setProperty('border-color', '#b71c1c', 'important');
                    li.style.setProperty('color', '#ffffff', 'important');
                    li.style.setProperty('--li-bg', '#b71c1c');

                    function tick(now) {
                        const progress = Math.min((now - holdStart) / HOLD_MS, 1);
                        del.style.setProperty('--hold-progress', `${progress * 360}deg`);
                        if (progress >= 1) {
                            endHold();
                            didDelete = true;
                            deleteGame(game.id, i);
                        } else {
                            holdRAF = requestAnimationFrame(tick);
                        }
                    }
                    holdRAF = requestAnimationFrame(tick);
                }

                function endHold() {
                    if (holdRAF) { cancelAnimationFrame(holdRAF); holdRAF = null; }
                    holdStart = null;
                    del.classList.remove('holding');
                    del.style.removeProperty('--hold-progress');
                    li.classList.remove('is-deleting');
                    if (game.isNew) {
                        li.style.setProperty('background-color', '#2f972c', 'important');
                        li.style.setProperty('border-color', '#1a5e18', 'important');
                        li.style.setProperty('color', '#ffffff', 'important');
                        li.style.setProperty('--li-bg', '#2f972c');
                    } else if (game.sidebarColor) {
                        applyGameColorToLi(li, game);
                    } else {
                        li.style.removeProperty('background-color');
                        li.style.removeProperty('border-color');
                        li.style.removeProperty('color');
                        li.style.removeProperty('--li-bg');
                    }
                }

                del.addEventListener('pointerdown', startHold);
                del.addEventListener('pointerup', (e) => {
                    e.stopPropagation();
                    const wasHolding = Boolean(holdRAF);
                    endHold();
                    if (wasHolding && !didDelete) showSidebarPointerMessage('Hold to delete!', e.clientX, e.clientY);
                });
                del.addEventListener('pointerleave', endHold);
                del.addEventListener('pointercancel', endHold);
                del.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); endHold(); });
                // Prevent the sidebar item's click handler from opening the game after any delete-button press.
                del.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
            }

            li.appendChild(del);
        }

        // Add drag handle for all items EXCEPT Master Stash (ugs-stash)
        if (game.id !== "ugs-stash") {
            const dragZone = document.createElement('div');
            dragZone.className = 'drag-handle-zone';
            dragZone.setAttribute('title', 'Drag to reorder');
            dragZone.innerHTML = '<svg class="drag-handle-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M360-160q-33 0-56.5-23.5T280-240q0-33 23.5-56.5T360-320q33 0 56.5 23.5T440-240q0 33-23.5 56.5T360-160Zm240 0q-33 0-56.5-23.5T520-240q0-33 23.5-56.5T600-320q33 0 56.5 23.5T680-240q0 33-23.5 56.5T600-160ZM360-400q-33 0-56.5-23.5T280-480q0-33 23.5-56.5T360-560q33 0 56.5 23.5T440-480q0 33-23.5 56.5T360-400Zm240 0q-33 0-56.5-23.5T520-480q0-33 23.5-56.5T600-560q33 0 56.5 23.5T680-480q0 33-23.5 56.5T600-400ZM360-640q-33 0-56.5-23.5T280-720q0-33 23.5-56.5T360-800q33 0 56.5 23.5T440-720q0 33-23.5 56.5T360-640Zm240 0q-33 0-56.5-23.5T520-720q0-33 23.5-56.5T600-800q33 0 56.5 23.5T680-720q0 33-23.5 56.5T600-640Z"/></svg>';
            dragZone.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();
                startDrag(e, li, i);
            });
            li.appendChild(dragZone);
        }

        fragment.appendChild(li);
    });

    // Render loading states directly beneath Game Stash, matching where a
    // successfully added game will appear.
    const loadingItems = [];
    loadingGames.forEach((title, sourceKey) => {
        const li = document.createElement('li');
        li.style.cursor = 'default';
        li.style.pointerEvents = 'none';
        
        const loader = document.createElement('div');
        loader.className = 'sidebar-loading-text';
        loader.innerHTML = `Adding <div class="spinner"></div>`;
        
        li.appendChild(loader);
        loadingItems.push(li);
    });

    if (loadingItems.length) {
        const stashItem = fragment.querySelector ? fragment.querySelector('li[data-game-id="ugs-stash"]') : null;
        if (stashItem) {
            const allItems = Array.from(fragment.childNodes);
            fragment.textContent = '';
            allItems.forEach(item => {
                fragment.appendChild(item);
                if (item === stashItem) loadingItems.forEach(loading => fragment.appendChild(loading));
            });
        } else {
            loadingItems.forEach(li => fragment.insertBefore(li, fragment.firstChild));
        }
    }

    list.appendChild(fragment);

    notifyStashBookmarkAvailability();
    checkTitleOverflows();
}

// Show the fade-out gradient only for titles that genuinely overflow one line
function checkTitleOverflows() {
    const list = document.getElementById('game-list');
    if (!list) return;
    // rAF ensures layout is complete before measuring
    requestAnimationFrame(() => {
        list.querySelectorAll('.game-title-wrapper').forEach(wrapper => {
            const title = wrapper.querySelector('.game-title');
            if (!title) return;
            // scrollWidth = full natural width of text; clientWidth = visible clip area
            wrapper.classList.toggle('title-overflows', title.scrollWidth > wrapper.clientWidth);
        });
    });
}

function showSidebarPointerMessage(text, clientX, clientY) {
    const message = document.createElement('div');
    message.className = 'floating-sidebar-warning';
    message.textContent = text;
    message.style.left = `${clientX}px`;
    message.style.top = `${clientY}px`;
    document.body.appendChild(message);
    let removed = false;
    const remove = () => {
        if (!removed) {
            removed = true;
            if (message.parentNode) message.remove();
        }
    };
    message.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 1050);
}

function isUserManagedGame(game) {
    const id = game && game.id ? game.id.toString() : "";
    return id.startsWith("custom_") || id.startsWith("bookmark_");
}

function getSidebarTitle(game) {
    if (game && game.preserveStashTitle) return game.title;
    const sourceFile = String(game && game.sourceFile || '').replace(/\\/g, '/').toLowerCase();
    if (game && !game.userRenamed && sourceFile.split(/[?#]/, 1)[0].split('/').pop() === 'cldasharena.html') {
        return 'Survival Race';
    }
    if (game && game.sourceKey && !game.userRenamed && typeof humanizeBookmarkDisplayName === "function") {
        if (game.title && game.sourceFile && (game.sourceFile.includes('/') || game.sourceFile.endsWith('index.html') || game.sourceFile.endsWith('sfs.html'))) {
            return game.title;
        }
        return humanizeBookmarkDisplayName(game.sourceFile || game.title, true);
    }
    return game.title;
}

function addSoftBreaks(value, every = 12) {
    return (value || "").replace(new RegExp(`(\\S{${every}})`, "g"), "$1\u200b");
}

function notifyStashBookmarkAvailability() {
    // The Stash can live in either frame (and can be preloaded while another game is open).
    // Refresh both so a deletion or addition is recognized immediately without navigating away and back.
    ['game-frame', 'stash-frame'].forEach(frameId => {
        const frame = document.getElementById(frameId);
        if (!frame || !frame.contentWindow) return;
        try {
            if (typeof frame.contentWindow.refreshBookmarkAvailability === "function") {
                frame.contentWindow.refreshBookmarkAvailability();
            }
            frame.contentWindow.postMessage({ type: 'nexus-refresh-bookmarks' }, '*');
        } catch (err) {
            // Cross-origin app; nothing to sync.
        }
    });
}

/* =========================================
   DRAG-TO-REORDER SYSTEM
========================================= */
let dragState = null;

function startDrag(e, li, index) {
    const list = document.getElementById('game-list');
    const liRect = li.getBoundingClientRect();

    // Create a placeholder/indicator line
    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    indicator.style.setProperty('--drop-space', `${liRect.height + 8}px`);
    
    // Dynamically match drop indicator color to the dragged item's color / theme
    const game = games.find(g => String(g.id) === String(li.dataset.gameId));
    const isLight = document.documentElement.classList.contains('light-mode');
    let indicatorColor = null;
    if (game && game.sidebarColor) {
        const colors = getGameColorScheme(game.sidebarColor);
        if (colors) indicatorColor = colors.swatch || colors.fill;
    } else if (li.classList.contains('new-game')) {
        indicatorColor = '#2f972c';
    }
    if (indicatorColor) {
        indicator.style.setProperty('--drop-indicator-color', indicatorColor);
        indicator.style.setProperty('--drop-indicator-glow', indicatorColor + (isLight ? '66' : '99'));
        li.style.setProperty('--drop-indicator-color', indicatorColor);
    }

    // Calculate offset from mouse to top of the li
    const offsetY = e.clientY - liRect.top;

    // Fix the li's dimensions and position it absolutely
    li.style.position = 'fixed';
    li.style.width = liRect.width + 'px';
    li.style.left = liRect.left + 'px';
    li.style.top = liRect.top + 'px';
    li.style.margin = '0';
    li.classList.add('dragging');
    document.body.classList.add('app-is-dragging');

    // Insert the indicator where the li was
    list.insertBefore(indicator, li.nextSibling);

    dragState = {
        li,
        gameId: li.dataset.gameId,
        index,
        currentDropIndex: index,
        offsetY,
        indicator,
        list
    };

    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e) {
    if (!dragState) return;
    const { li, offsetY, indicator, list } = dragState;

    // Move the dragged item vertically (strictly vertical — keep horizontal fixed)
    const newTop = e.clientY - offsetY;
    li.style.top = newTop + 'px';

    // Determine where the indicator should go
    const items = Array.from(list.querySelectorAll('li:not(.dragging)'));
    let dropIndex = items.length; // default: end

    for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
            dropIndex = i;
            break;
        }
    }

    const firstMovableIndex = getFirstMovableIndex();
    dropIndex = Math.max(firstMovableIndex, Math.min(dropIndex, items.length));

    if (dropIndex !== dragState.currentDropIndex) {
        dragState.currentDropIndex = dropIndex;
        // Move the indicator
        if (indicator.parentNode) indicator.parentNode.removeChild(indicator);
        if (dropIndex >= items.length) {
            list.appendChild(indicator);
        } else {
            list.insertBefore(indicator, items[dropIndex]);
        }
    }
}

function onDragEnd(e) {
    if (!dragState) return;
    onDragMove(e);
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);

    const { li, gameId, indicator, list } = dragState;

    // Determine target insertion index by checking which game li comes after indicator
    let nextGameId = null;
    let nextSibling = indicator.nextElementSibling;
    while (nextSibling) {
        if (nextSibling.dataset && nextSibling.dataset.gameId && !nextSibling.classList.contains('dragging')) {
            nextGameId = nextSibling.dataset.gameId;
            break;
        }
        nextSibling = nextSibling.nextElementSibling;
    }

    const firstMovableIndex = getFirstMovableIndex();
    const currentIdx = games.findIndex(g => String(g.id) === String(gameId));
    let targetIdx;
    if (nextGameId) {
        targetIdx = games.findIndex(g => String(g.id) === String(nextGameId));
        if (targetIdx === -1) targetIdx = games.length;
    } else {
        targetIdx = games.length;
    }

    // Clean up the dragged element styles
    li.style.position = '';
    li.style.width = '';
    li.style.left = '';
    li.style.top = '';
    li.style.margin = '';
    li.style.removeProperty('--drop-indicator-color');
    li.classList.remove('dragging');
    document.body.classList.remove('app-is-dragging');

    // Remove indicator
    if (indicator.parentNode) indicator.parentNode.removeChild(indicator);

    // Move in the games array
    if (currentIdx >= firstMovableIndex && currentIdx !== -1) {
        const [moved] = games.splice(currentIdx, 1);
        let insertIdx = currentIdx < targetIdx ? targetIdx - 1 : targetIdx;
        insertIdx = Math.max(firstMovableIndex, Math.min(insertIdx, games.length));
        games.splice(insertIdx, 0, moved);
        pinMasterStash();
        saveGameOrder();
    }

    dragState = null;
    renderGameList();
}

function createNexusLoadingOverlay(parentDoc = document, customBgUrl = 'Assets/loading_screen.png') {
    try {
        const existing = parentDoc.getElementById('nexus-loading-screen');
        if (existing) existing.remove();

        const overlay = parentDoc.createElement('div');
        overlay.id = 'nexus-loading-screen';
        overlay.innerHTML = `
            <style>
                #nexus-loading-screen {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100vw;
                    height: 100vh;
                    z-index: 999999;
                    background-color: #050505;
                    background-image: url('${customBgUrl}');
                    background-size: cover;
                    background-position: center;
                    background-repeat: no-repeat;
                    display: flex;
                    flex-direction: column;
                    justify-content: flex-end;
                    align-items: center;
                    pointer-events: auto;
                    opacity: 1;
                    transition: opacity 0.4s ease;
                }
                .nexus-loader-bar-container {
                    width: clamp(260px, 36vw, 440px);
                    height: 16px;
                    background: rgba(255, 255, 255, 0.15);
                    border: 1.5px solid rgba(255, 255, 255, 0.3);
                    border-radius: 10px;
                    overflow: hidden;
                    margin-bottom: clamp(60px, 12vh, 100px);
                    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6);
                }
                .nexus-loader-bar-fill {
                    height: 100%;
                    width: 0%;
                    background-color: #ffffff;
                    border-radius: 10px;
                    transition: width 0.2s ease-out;
                }
                @keyframes nexus-stripes-backward {
                    0% { background-position: 56px 0; }
                    100% { background-position: 0 0; }
                }
                .nexus-bar-busy {
                    background-image: repeating-linear-gradient(
                        -45deg,
                        #ffffff 0px,
                        #ffffff 14px,
                        #a8a8a8 14px,
                        #a8a8a8 28px
                    ) !important;
                    background-size: 39.6px 100% !important;
                    animation: nexus-stripes-backward 0.75s linear infinite !important;
                }
            </style>
            <div class="nexus-loader-bar-container">
                <div id="nexus-loader-bar" class="nexus-loader-bar-fill"></div>
            </div>
        `;

        (parentDoc.body || parentDoc.documentElement).appendChild(overlay);
        const bar = overlay.querySelector('#nexus-loader-bar');
        let progress = 0;
        let isDone = false;
        let creepTimer = null;

        const busyTimer = setTimeout(() => {
            if (!isDone && bar) bar.classList.add('nexus-bar-busy');
        }, 2000);

        const creepStartTimer = setTimeout(() => {
            if (isDone) return;
            creepTimer = setInterval(() => {
                if (isDone) {
                    clearInterval(creepTimer);
                    return;
                }
                if (progress < 99) {
                    const remaining = 99 - progress;
                    const step = Math.max(0.08, remaining * 0.04);
                    progress = Math.min(99, progress + step);
                    if (bar) bar.style.width = progress + '%';
                }
            }, 120);
        }, 4000);

        return {
            setProgress(pct) {
                if (isDone || !bar) return;
                progress = Math.max(progress, Math.min(99, pct));
                bar.style.width = progress + '%';
            },
            complete() {
                if (isDone) return;
                isDone = true;
                clearTimeout(busyTimer);
                clearTimeout(creepStartTimer);
                if (creepTimer) clearInterval(creepTimer);
                if (bar) bar.style.width = '100%';
                overlay.style.opacity = '0';
                overlay.style.pointerEvents = 'none';
                setTimeout(() => {
                    try { overlay.remove(); } catch(e) {}
                }, 400);
            }
        };
    } catch(e) {
        return { setProgress: () => {}, complete: () => {} };
    }
}

function getGameRestoreScript(gameId, snapshot = {}, saveSessionId = null) {
    const savedStorage = snapshot && snapshot.localStorage && typeof snapshot.localStorage === 'object'
        ? snapshot.localStorage
        : snapshot;
    const snapshotJson = JSON.stringify(savedStorage || {}).replace(/</g, '\\u003c');
    const snapshotIsComplete = !!(snapshot && snapshot.localStorageComplete === true);
    const journalKey = `tb_nexus_game_autosave:${encodeURIComponent(String(gameId))}`;
    const snapshotSavedAt = Number(snapshot && snapshot.savedAt) || 0;
    return `<script>(function(){try{
        var gameId=${JSON.stringify(String(gameId))};
        function reportQuotaFailure(error){if(!error||!(error.name==='QuotaExceededError'||error.code===22||error.code===1014||/quota exceeded|storage full|disk full/i.test(String(error.message||''))))return;var message={type:'nexus-game-storage-quota-error',gameId:gameId,saveSessionId:${JSON.stringify(saveSessionId)},storageType:'localStorage'};try{if(window.parent&&window.parent!==window)window.parent.postMessage(message,'*');}catch(e){}try{if(window.opener)window.opener.postMessage(message,'*');}catch(e){}}
        var saved=${snapshotJson};
        var nexusInternalStorageKeys=new Set(${JSON.stringify(Array.from(NEXUS_APP_LOCAL_STORAGE_KEYS))});
        var savedIsComplete=${JSON.stringify(snapshotIsComplete)};
        var snapshotSavedAt=${snapshotSavedAt};
        var journal=null;
        try{journal=JSON.parse(localStorage.getItem(${JSON.stringify(journalKey)})||'null');}catch(e){}
        if(journal&&Number(journal.savedAt)>=snapshotSavedAt&&journal.localStorage&&typeof journal.localStorage==='object'){
            // The journal is written synchronously by the game itself, so it
            // always wins over an older asynchronous IndexedDB snapshot.
            if(journal.complete===false){
                // A partially readable localStorage area must not erase keys
                // from the last complete snapshot or trigger stale-key cleanup.
                saved=Object.assign({},saved,journal.localStorage);
                savedIsComplete=false;
            }else{
                // Journals created before the completeness flag were full
                // captures, so keep treating them as complete for compatibility.
                saved=Object.assign({},journal.localStorage);
                savedIsComplete=true;
            }
            snapshotSavedAt=Number(journal.savedAt)||snapshotSavedAt;
        }else if(journal&&snapshotSavedAt>0&&Number(journal.savedAt)<=snapshotSavedAt){
            // The parent already has this journal (or a newer save) in its
            // committed snapshot, so this duplicate can be safely reclaimed.
            try{localStorage.removeItem(${JSON.stringify(journalKey)});}catch(e){}
        }
        if(savedIsComplete){
            var staleKeys=[];
            for(var i=0;i<localStorage.length;i++){
                var existingKey=localStorage.key(i);
                if(existingKey&&existingKey.indexOf('tb_')!==0&&!nexusInternalStorageKeys.has(existingKey)&&!Object.prototype.hasOwnProperty.call(saved,existingKey))staleKeys.push(existingKey);
            }
            staleKeys.forEach(function(k){try{localStorage.removeItem(k);}catch(e){}});
        }
        Object.keys(saved).forEach(function(k){
                if(k.indexOf('tb_')!==0&&!nexusInternalStorageKeys.has(k))try{localStorage.setItem(k,saved[k]);}catch(e){reportQuotaFailure(e);}
        });
    }catch(e){}})();<\/script>`;
}

function getUniversalAutosaveBridge(gameId, saveSessionId = null) {
    return `<script>
(function() {
    var gameId = ${JSON.stringify(gameId)};
    var saveSessionId = ${JSON.stringify(saveSessionId)};
    var nexusInternalStorageKeys = new Set(${JSON.stringify(Array.from(NEXUS_APP_LOCAL_STORAGE_KEYS))});
    var saveSessionKey = 'tb_nexus_game_session:' + encodeURIComponent(String(gameId));
    var syncing = false;
    var syncQueued = false;
    var queuedImmediate = false;
    var syncTimer = null;
    var lastSavedHash = '';
    var lastSavedAt = 0;
    var autosaveDisarmed = false;
    var journalKey = 'tb_nexus_game_autosave:' + encodeURIComponent(String(gameId));
    window.__nexusGameSaveSessionId = saveSessionId;

    function reportIndexedDBUse(name) {
        name = String(name || '');
        if (!name || name.length > 120 || ['GameStorageDB', 'AIChatDB', 'NexusSidebarSettings'].indexOf(name) !== -1 || autosaveDisarmed || !isCurrentSession()) return;
        var message = {
            type: 'nexus-game-database-use',
            gameId: gameId,
            databaseName: name,
            saveSessionId: saveSessionId
        };
        try { if (window.parent && window.parent !== window) window.parent.postMessage(message, '*'); } catch(e) {}
        try { if (window.opener && !window.opener.closed) window.opener.postMessage(message, '*'); } catch(e) {}
    }

    try {
        var idbFactoryPrototype = window.IDBFactory && IDBFactory.prototype;
        var originalOpenDatabase = idbFactoryPrototype && idbFactoryPrototype.open;
        if (originalOpenDatabase && !originalOpenDatabase._nexusGameDatabaseTracked) {
            var trackedOpenDatabase = function(name) {
                reportIndexedDBUse(name);
                var request = originalOpenDatabase.apply(this, arguments);
                if (request && typeof request.addEventListener === 'function') {
                    request.addEventListener('success', function() {
                        try {
                            var openedDatabase = request.result;
                            if (openedDatabase && typeof openedDatabase.addEventListener === 'function') {
                                openedDatabase.addEventListener('versionchange', function() {
                                    try { openedDatabase.close(); } catch(e) {}
                                });
                            }
                        } catch(e) {}
                    }, { once: true });
                }
                return request;
            };
            trackedOpenDatabase._nexusGameDatabaseTracked = true;
            idbFactoryPrototype.open = trackedOpenDatabase;
        }
    } catch(e) {}

    function isCurrentSession() {
        if (!saveSessionId) return true;
        try {
            var activeSessionId = localStorage.getItem(saveSessionKey);
            return activeSessionId === String(saveSessionId);
        } catch(e) { return true; }
    }

    function isQuotaError(error) {
        return !!error && (error.name === 'QuotaExceededError' || error.code === 22 || error.code === 1014 || /quota exceeded|storage full|disk full/i.test(String(error.message || '')));
    }

    function reportQuotaFailure(storageType, error) {
        if (!isCurrentSession() || !isQuotaError(error)) return;
        var message = {
            type: 'nexus-game-storage-quota-error',
            gameId: gameId,
            saveSessionId: saveSessionId,
            storageType: storageType,
            errorName: error && error.name || 'QuotaExceededError'
        };
        try { if (window.parent && window.parent !== window) window.parent.postMessage(message, '*'); } catch(e) {}
        try {
            var opener = (window.parent && window.parent.opener) || window.opener;
            if (opener) opener.postMessage(message, '*');
        } catch(e) {}
    }

    try {
        var originalTransaction = IDBDatabase.prototype.transaction;
        if (!originalTransaction._nexusQuotaHooked) {
            var hookedTransaction = function() {
                var transaction;
                try {
                    transaction = originalTransaction.apply(this, arguments);
                } catch(error) {
                    reportQuotaFailure('indexedDB', error);
                    throw error;
                }
                var isNexusSnapshotTransaction = this.name === 'GameStorageDB' &&
                    transaction && transaction.objectStoreNames && transaction.objectStoreNames.contains('gameSnapshots');
                if (!isNexusSnapshotTransaction && transaction && typeof transaction.addEventListener === 'function') {
                    transaction.addEventListener('error', function(event) {
                        reportQuotaFailure('indexedDB', event.target && event.target.error || transaction.error);
                    }, true);
                }
                return transaction;
            };
            hookedTransaction._nexusQuotaHooked = true;
            IDBDatabase.prototype.transaction = hookedTransaction;
        }
    } catch(e) {}

    function saveSnapshotDirectToDB(targetId, snapshotData, onComplete) {
        var completed = false;
        function finish(success, error) {
            if (completed) return;
            completed = true;
            if (error) reportQuotaFailure('indexedDB', error);
            if (typeof onComplete === 'function') onComplete(success, error || null);
        }
        if (autosaveDisarmed || !isCurrentSession() || !snapshotData || !targetId) {
            finish(false);
            return;
        }
        var incomingLs = snapshotData.localStorage || {};
        var incomingFs = snapshotData.fsData || null;
        var incomingIdb = snapshotData.idbData || null;
        var incomingLsIsComplete = snapshotData.localStorageComplete === true;
        var incomingFsIsComplete = snapshotData.fsDataComplete === true;
        var incomingIdbIsComplete = snapshotData.idbDataComplete === true;
        var payloadSavedAt = Number(snapshotData.savedAt);
        var incomingSavedAt = isFinite(payloadSavedAt) && payloadSavedAt > 0 ? payloadSavedAt : Date.now();
        try {
            var req = indexedDB.open("GameStorageDB", 4);
            req.onupgradeneeded = function(e) {
                var d = e.target.result;
                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
                if (!d.objectStoreNames.contains('gameSnapshotMeta')) d.createObjectStore('gameSnapshotMeta', { keyPath: 'gameId' });
            };
            req.onerror = function() { finish(false, req.error); };
            req.onsuccess = function(e) {
                var db = e.target.result;
                db.onversionchange = function() { try { db.close(); } catch(err) {} };
                try {
                    if (autosaveDisarmed || !isCurrentSession() || !db.objectStoreNames.contains('gameSnapshots') || !db.objectStoreNames.contains('gameSnapshotMeta')) {
                        finish(false);
                        return;
                    }
                    var tx = db.transaction(['gameSnapshots', 'gameSnapshotMeta'], 'readwrite');
                    var store = tx.objectStore('gameSnapshots');
                    var metaStore = tx.objectStore('gameSnapshotMeta');
                    tx.oncomplete = function() { finish(true); };
                    tx.onerror = function(event) { finish(false, event.target && event.target.error || tx.error); };
                    tx.onabort = function(event) { finish(false, event.target && event.target.error || tx.error); };
                    var metaGetReq = metaStore.get(targetId);
                    var getReq = store.get(targetId);
                    getReq.onerror = function() { finish(false, getReq.error); };
                    getReq.onsuccess = function() {
                        if (autosaveDisarmed || !isCurrentSession()) return;
                        var existing = getReq.result || null;
                        if (existing && Number(existing.savedAt) > incomingSavedAt) return;
                        var existingData = (existing && existing.localStorage && typeof existing.localStorage === 'object') ? existing.localStorage : {};
                        var incomingKeys = Object.keys(incomingLs);
                        var existingKeys = Object.keys(existingData);

                        var lsToSave = Object.assign({}, incomingLs);
                        if (!incomingLsIsComplete && incomingKeys.length === 0 && existingKeys.length > 0) {
                            lsToSave = Object.assign({}, existingData);
                        } else if (!incomingLsIsComplete && incomingKeys.length > 0 && existingKeys.length > 0) {
                            lsToSave = Object.assign({}, existingData, incomingLs);
                        }

                        var fsToSave = incomingFsIsComplete
                            ? (incomingFs && Object.keys(incomingFs).length ? Object.assign({}, incomingFs) : null)
                            : ((existing && existing.fsData) ? Object.assign({}, existing.fsData) : null);
                        if (!incomingFsIsComplete && incomingFs && Object.keys(incomingFs).length > 0) {
                            fsToSave = Object.assign({}, fsToSave || {}, incomingFs);
                        }

                        var idbToSave = incomingIdbIsComplete
                            ? (incomingIdb && Object.keys(incomingIdb).length ? Object.assign({}, incomingIdb) : null)
                            : ((existing && existing.idbData) ? Object.assign({}, existing.idbData) : null);
                        if (!incomingIdbIsComplete && incomingIdb && Object.keys(incomingIdb).length > 0) {
                            idbToSave = Object.assign({}, idbToSave || {}, incomingIdb);
                        }

                        var existingMetadata = metaGetReq.result || null;
                        var indexedDBNames = Array.from(new Set([
                            ...(Array.isArray(existing && existing.indexedDBNames) ? existing.indexedDBNames : []),
                            ...(Array.isArray(existingMetadata && existingMetadata.indexedDBNames) ? existingMetadata.indexedDBNames : [])
                        ]));
                        var savedAt = incomingSavedAt;
                        var record = {
                            gameId: targetId,
                            localStorage: lsToSave,
                            fsData: fsToSave,
                            idbData: idbToSave,
                            indexedDBNames: indexedDBNames,
                            localStorageComplete: incomingLsIsComplete,
                            fsDataComplete: incomingFsIsComplete || existing && existing.fsDataComplete === true,
                            idbDataComplete: incomingIdbIsComplete || existing && existing.idbDataComplete === true,
                            savedAt: savedAt
                        };
                        try {
                            var putReq = store.put(record);
                            putReq.onsuccess = function() {
                                var metadata = metaGetReq.result || { gameId: targetId, indexedDBNames: [] };
                                metadata.indexedDBNames = Array.from(new Set([
                                    ...(Array.isArray(metadata.indexedDBNames) ? metadata.indexedDBNames : []),
                                    ...indexedDBNames
                                ]));
                                metadata.estimatedBytes = null;
                                metadata.estimatedBytesVersion = 0;
                                metadata.savedAt = savedAt;
                                metaStore.put(metadata);
                            };
                            putReq.onerror = function() { finish(false, putReq.error); };
                        } catch(err) { finish(false, err); }
                    };
                } catch(txErr) { finish(false, txErr); }
            };
        } catch(err) { finish(false, err); }
    }

    function getStorageSnapshot() {
        var s = {};
        var complete = true;
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('tb_') !== 0 && !nexusInternalStorageKeys.has(k)) {
                    s[k] = localStorage.getItem(k);
                }
            }
        } catch(e) { complete = false; }
        return { data: s, complete: complete };
    }

    function writeJournal(data, savedAt, complete) {
        // localStorage is synchronous. This tiny write-ahead record survives
        // tab shutdown, including when the Nexus tab is no longer open.
        try {
            localStorage.setItem(journalKey, JSON.stringify({ version: 1, savedAt: savedAt, complete: complete === true, localStorage: data }));
            return true;
        } catch(e) {
            // This journal is a temporary write-ahead copy. A failed journal
            // write alone does not mean the game's save failed; the IndexedDB
            // snapshot and parent mirror are still attempted below.
            return false;
        }
    }

    function clearCommittedJournal(savedAt) {
        try {
            var journal = JSON.parse(localStorage.getItem(journalKey) || 'null');
            if (journal && Number(journal.savedAt) <= Number(savedAt)) {
                localStorage.removeItem(journalKey);
            }
        } catch(e) {}
    }

    function sendSave(immediate) {
        if (autosaveDisarmed || !isCurrentSession()) return;
        try {
            var capture = getStorageSnapshot();
            var data = capture.data;
            var currentHash = JSON.stringify(data);
            if (!immediate && currentHash === lastSavedHash) return;
            var savedAt = Math.max(Date.now(), lastSavedAt + 1);
            lastSavedAt = savedAt;
            writeJournal(data, savedAt, capture.complete);

            var msg = { type: 'nexus-game-save', gameId: gameId, localStorage: data, localStorageComplete: capture.complete, savedAt: savedAt, saveSessionId: saveSessionId };
            saveSnapshotDirectToDB(gameId, msg, function(success) {
                if (success) clearCommittedJournal(savedAt);
                lastSavedHash = success ? currentHash : '';
            });
            if (window.parent && window.parent !== window) {
                try { window.parent.postMessage(msg, '*'); } catch(e) {}
            }
            var opener = (window.parent && window.parent.opener) || window.opener;
            if (opener) {
                try { opener.postMessage(msg, '*'); } catch(e) {}
            }
        } catch(e) {}
    }

    function syncAndSend(immediate) {
        if (autosaveDisarmed || !isCurrentSession()) return;
        if (syncing) {
            syncQueued = true;
            queuedImmediate = queuedImmediate || !!immediate;
            return;
        }
        syncing = true;
        function finishSync() {
            syncing = false;
            sendSave(immediate);
            if (syncQueued) {
                var nextImmediate = queuedImmediate;
                syncQueued = false;
                queuedImmediate = false;
                syncAndSend(nextImmediate);
            }
        }
        try {
            var fs = window.FS || (window.Module && window.Module.FS);
            if (fs && typeof fs.syncfs === 'function') {
                fs.syncfs(false, function() {
                    var err = arguments[0];
                    if (err && /quota|storage full|disk full|no space/i.test(String(err.message || err))) {
                        reportQuotaFailure('game filesystem', err.name ? err : { name: 'QuotaExceededError', message: String(err) });
                    }
                    finishSync();
                });
                return;
            }
        } catch(e) {}
        finishSync();
    }

    function debounceSync(delay) {
        if (autosaveDisarmed || !isCurrentSession()) return;
        if (syncTimer) clearTimeout(syncTimer);
        syncTimer = setTimeout(function() {
            syncTimer = null;
            syncAndSend(false);
        }, delay || 300);
    }

    // Active Storage Traps: catch localStorage modifications immediately
    try {
        var origSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(k, v) {
            var res;
            try {
                res = origSetItem.apply(this, arguments);
            } catch(err) {
                if (this === localStorage && k && k.indexOf('tb_') !== 0) reportQuotaFailure('localStorage', err);
                throw err;
            }
            if (!autosaveDisarmed && isCurrentSession() && this === localStorage && k && k.indexOf('tb_') !== 0) {
                debounceSync(300);
            }
            return res;
        };
        var origRemoveItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(k) {
            var res = origRemoveItem.apply(this, arguments);
            if (!autosaveDisarmed && isCurrentSession() && this === localStorage && k && k.indexOf('tb_') !== 0) {
                debounceSync(300);
            }
            return res;
        };
        var origClear = Storage.prototype.clear;
        Storage.prototype.clear = function() {
            var res = origClear.apply(this, arguments);
            if (!autosaveDisarmed && isCurrentSession() && this === localStorage) {
                debounceSync(300);
            }
            return res;
        };
    } catch(e) {}

    // Emscripten / WASM Filesystem Sync Hook
    var hookAttempts = 0;
    var hookTimer = null;
    function hookFS() {
        try {
            var fs = window.FS || (window.Module && window.Module.FS);
            if (fs && typeof fs.syncfs === 'function' && !fs._nexusHooked) {
                fs._nexusHooked = true;
                if (hookTimer) { clearInterval(hookTimer); hookTimer = null; }
                var origSyncfs = fs.syncfs;
                fs.syncfs = function(populate, callback) {
                    return origSyncfs.call(this, populate, function(err) {
                        if (typeof callback === 'function') callback(err);
                        if (!populate && !autosaveDisarmed && isCurrentSession()) {
                            debounceSync(1000);
                        }
                    });
                };
            } else if (++hookAttempts > 30 && hookTimer) {
                clearInterval(hookTimer);
                hookTimer = null;
            }
        } catch(e) {}
    }
    hookFS();
    hookTimer = setInterval(hookFS, 2000);

    // Multi-Trigger Auto-Sync & Clear Handlers
    window.addEventListener('storage', function() { if (!autosaveDisarmed && isCurrentSession()) debounceSync(200); }, { passive: true });
    window.addEventListener('message', function(e) {
        if (!e.data) return;
        if (e.data.type === 'nexus-disarm-autosave') {
            autosaveDisarmed = true;
            if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
        }
        if (e.data.type === 'nexus-wipe-game-storage') {
            autosaveDisarmed = true;
            if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
            try {
                var preserveKeys = new Set(Array.isArray(e.data.preserveKeys) ? e.data.preserveKeys.map(String) : []);
                var clearKeys = new Set(Array.isArray(e.data.clearKeys) ? e.data.clearKeys.map(String) : []);
                var toDel = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('tb_') !== 0 && !nexusInternalStorageKeys.has(k) && clearKeys.has(k) && !preserveKeys.has(k)) toDel.push(k);
                }
                toDel.forEach(function(k) { localStorage.removeItem(k); });
            } catch(err) {}
            try { localStorage.removeItem(journalKey); } catch(err) {}
        }
        if (e.data.type === 'nexus-apply-game-restore' && e.data.localStorage) {
            // A late parent restore should only fill absent values; replacing
            // existing values here can undo progress made while a tab loads.
            try { Object.keys(e.data.localStorage).forEach(function(k) {
                if (k.indexOf('tb_') !== 0 && localStorage.getItem(k) === null) {
                    try { localStorage.setItem(k, e.data.localStorage[k]); }
                    catch(err) { reportQuotaFailure('localStorage', err); }
                }
            }); } catch(err) {}
        }
        if (e.data.type === 'nexus-request-game-save') {
            if (!autosaveDisarmed && isCurrentSession()) syncAndSend(true);
        }
    });
    document.addEventListener('visibilitychange', function() {
        if (document.hidden && !autosaveDisarmed && isCurrentSession()) syncAndSend(true);
    }, { passive: true });
    window.addEventListener('blur', function() { if (!autosaveDisarmed && isCurrentSession()) syncAndSend(false); }, { passive: true });
    window.addEventListener('pagehide', function() { if (!autosaveDisarmed && isCurrentSession()) syncAndSend(true); }, { passive: true });
    window.addEventListener('beforeunload', function() { if (!autosaveDisarmed && isCurrentSession()) syncAndSend(true); }, { passive: true });

    setInterval(function() { if (!autosaveDisarmed && isCurrentSession()) syncAndSend(false); }, 15000);
})();
<\/script>`;
}

function getCloakData() {
    try {
        const localStorage = window.nexusStorage || window.localStorage;
        const rawPreset = localStorage.getItem('tb_cloak_preset');
        const preset = (rawPreset === null || rawPreset === undefined || rawPreset === '' || rawPreset === 'default') ? 'canvas' : rawPreset;
        const newTabIcon = new URL('Assets/newtab.png', window.location.href).href;

        const cloaks = {
            canvas: {
                title: 'Dashboard',
                icon: 'https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e10d657a73.ico'
            },
            classroom: {
                title: 'Home',
                icon: 'https://ssl.gstatic.com/classroom/favicon.png'
            },
            wikipedia: {
                title: 'Wikipedia, the free encyclopedia',
                icon: 'https://en.wikipedia.org/favicon.ico'
            },
            desmos: {
                title: 'Desmos | Graphing Calculator',
                icon: 'https://www.desmos.com/favicon.ico'
            },
            drive: {
                title: 'My Drive - Google Drive',
                icon: 'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png'
            },
            docs: {
                title: 'Google Docs',
                icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico'
            },
            bing: {
                title: 'Bing',
                icon: 'https://www.bing.com/favicon.ico'
            },
            khan: {
                title: 'Dashboard | Khan Academy',
                icon: 'https://www.khanacademy.org/favicon.ico'
            },
            none: {
                title: 'New Tab',
                icon: newTabIcon
            },
            newtab: {
                title: 'New Tab',
                icon: newTabIcon
            }
        };

        return cloaks[preset] || cloaks.canvas;
    } catch (e) {
        return {
            title: 'Dashboard',
            icon: 'https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e10d657a73.ico'
        };
    }
}

function getVerifiedGameFallbackUrl(game) {
    if (!game || !game.sourceFile) return null;
    const sourceFile = String(game.sourceFile).replace(/^\/+/, '');
    if (!sourceFile || sourceFile.includes('..')) return null;
    const encodedPath = sourceFile.split('/').map(part => encodeURIComponent(part)).join('/');
    return 'https://cdn.jsdelivr.net/gh/bubbls/ugs-singlefile/UGS-Files/' + encodedPath;
}

function isTagC3Game(game) {
    const sourceFile = String(game && (game.sourceFile || game.url) || '').replace(/\\/g, '/').toLowerCase();
    const fileName = sourceFile.split(/[?#]/, 1)[0];
    const gameId = String(game && game.id || '').toLowerCase();
    return fileName === 'cltagc3.html' || fileName.endsWith('/cltagc3.html') || gameId.includes('cltagc3');
}

function isCrossyRoadGame(game) {
    const sourceFile = String(game && (game.sourceFile || game.url) || '').replace(/\\/g, '/').toLowerCase();
    const fileName = sourceFile.split(/[?#]/, 1)[0];
    const gameId = String(game && game.id || '').toLowerCase();
    return fileName === 'clcrossyroad.html' || fileName.endsWith('/clcrossyroad.html') || gameId.includes('crossyroad');
}

function isBrotatoGame(game) {
    const sourceFile = String(game && (game.sourceFile || game.url) || '').replace(/\\/g, '/').toLowerCase();
    const fileName = sourceFile.split(/[?#]/, 1)[0];
    const gameId = String(game && game.id || '').toLowerCase();
    return fileName === 'clbrotato.html' || fileName.endsWith('/clbrotato.html') || gameId.includes('brotato');
}

function isSnowRiderGame(game) {
    const sourceFile = String(game && (game.sourceFile || game.url) || '').replace(/\\/g, '/').toLowerCase();
    const fileName = sourceFile.split(/[?#]/, 1)[0].split('/').pop().replace(/\.html?$/, '');
    const identity = [game && game.id, game && game.sourceKey, game && game.sourceFile, game && game.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return fileName === 'clsnowriderrrr' || identity.includes('clsnowriderrrr');
}

function isMrMineGame(game) {
    const identity = [game && game.id, game && game.sourceKey, game && game.sourceFile, game && game.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return /clmrmine(?:\.html)?/.test(identity);
}

function getMrMineLocalAssetBaseUrl() {
    return new URL('singlefile-bubbls/UGS-Files/mr-mine/', getAppBaseUrl()).href;
}

function shouldInjectGamePersistence(game, url) {
    if (!game || !url) return false;
    // This Unity WebGL build relies on its real document URL during startup.
    // Wrapping it in about:srcdoc makes its runtime requests resolve against
    // the Nexus page and leaves the canvas black, so preserve its native URL.
    if (isSnowRiderGame(game)) return false;
    // Brotato installs a cross-origin-isolation service worker. Keep its real
    // document URL so the worker and Godot's large PCK request load natively.
    if (isBrotatoGame(game)) return false;
    if (game.nexusExternalSource || isTagC3Game(game) || isCrossyRoadGame(game)) return true;
    try {
        // Every local Stash page can be fetched into srcdoc before it starts.
        // That lets the save bridge run before a game writes its first save.
        return new URL(url, window.location.href).origin === window.location.origin;
    } catch (error) {
        return false;
    }
}

function getGamePersistenceBootstrap(gameId, snapshot = {}, saveSessionId = null) {
    return getGameRestoreScript(gameId, snapshot, saveSessionId) + getUniversalAutosaveBridge(gameId, saveSessionId);
}

function getGameLaunchDiagnostics(gameId, loadToken, options = {}) {
    return `<script>(function(){
        var gameId=${JSON.stringify(String(gameId))};
        var loadToken=${Number(loadToken) || 0};
        var captureMrMineAssets=${Boolean(options.captureMrMineAssets)};
        var reported=false;
        var mrMineAssetFailureReported=false;
        var gameReady=false;
        window.addEventListener('nexus-game-ready',function(){gameReady=true;});
        window.addEventListener('load',function(){setTimeout(function(){gameReady=true;},30000);},{once:true});
        function report(kind,message){
            if(reported||gameReady)return;
            reported=true;
            try{window.parent.postMessage({type:'nexus-game-launch-error',gameId:gameId,loadToken:loadToken,kind:kind,message:String(message||'Game startup failed').slice(0,500)},'*');}catch(e){}
        }
        function isMrMineAssetUrl(url){
            try{
                var parsed=new URL(String(url||''),document.baseURI);
                return parsed.origin===window.location.origin&&parsed.pathname.toLowerCase().indexOf('/singlefile-bubbls/ugs-files/mr-mine/')!==-1;
            }catch(e){return false;}
        }
        if(captureMrMineAssets){
            window.__nexusReportMrMineAssetFailure=function(url,reason){
                if(mrMineAssetFailureReported)return;
                mrMineAssetFailureReported=true;
                var message='Required local Mr. Mine file failed to load: '+String(url||'unknown asset')+(reason?' ('+String(reason)+')':'');
                try{window.parent.postMessage({type:'nexus-game-launch-error',gameId:gameId,loadToken:loadToken,kind:'resource-exhausted',message:message.slice(0,500)},'*');}catch(e){}
            };
        }
        if(captureMrMineAssets&&window.MutationObserver){
            var trackedAssets=new WeakSet();
            function trackAsset(node){
                if(!node||trackedAssets.has(node))return;
                var tagName=String(node.tagName||'').toUpperCase();
                var url=String(node.currentSrc||node.src||node.href||'');
                var isCoreScript=tagName==='SCRIPT'&&!!node.src;
                var isCoreStyle=tagName==='LINK'&&String(node.rel||'').toLowerCase().indexOf('stylesheet')!==-1&&!!node.href;
                if((!isCoreScript&&!isCoreStyle)||!isMrMineAssetUrl(url))return;
                trackedAssets.add(node);
                var timer=setTimeout(function(){report('resource-timeout',url);},25000);
                var clearTimer=function(){clearTimeout(timer);};
                node.addEventListener('load',clearTimer,{once:true});
                node.addEventListener('error',clearTimer,{once:true});
            }
            function trackAssetTree(root){
                if(!root)return;
                if(root.nodeType===1)trackAsset(root);
                if(root.querySelectorAll){
                    Array.prototype.forEach.call(root.querySelectorAll('script[src],link[rel~="stylesheet"][href]'),trackAsset);
                }
            }
            var assetRoot=document.documentElement||document;
            trackAssetTree(assetRoot);
            new MutationObserver(function(records){
                records.forEach(function(record){Array.prototype.forEach.call(record.addedNodes||[],trackAssetTree);});
            }).observe(assetRoot,{childList:true,subtree:true});
        }
        window.addEventListener('error',function(event){
            var target=event.target;
            if(captureMrMineAssets&&target&&target!==window){
                var resourceUrl=String(target.currentSrc||target.src||target.href||'');
                var isCoreResource=target.tagName==='SCRIPT'||(target.tagName==='LINK'&&String(target.rel||'').toLowerCase().indexOf('stylesheet')!==-1);
                if(isCoreResource&&isMrMineAssetUrl(resourceUrl)){
                    report('resource',resourceUrl);
                }
                return;
            }
            if(target&&target!==window)return;
            report('script',event.message||event.error&&event.error.message||'Game script failed');
        },true);
        window.addEventListener('unhandledrejection',function(event){
            var reason=event.reason;
            report('promise',reason&&reason.message||reason||'Game startup failed');
        });
    })();<\/script>`;
}

async function fetchExternalGameHtml(url, bootstrap = '', options = {}) {
    const requestUrl = new URL(url, window.location.href);
    if (!options.preferLocalCache) requestUrl.searchParams.set('t', String(Date.now()));

    const controller = options.timeoutMs > 0 ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    let response;
    try {
        response = await fetch(requestUrl.href, {
            cache: options.preferLocalCache ? 'default' : 'no-store',
            ...(controller ? { signal: controller.signal } : {})
        });
    } finally {
        if (timeout) clearTimeout(timeout);
    }
    if (!response.ok) {
        throw new Error('External game request failed (' + response.status + ')');
    }

    const html = await response.text();
    if (!/<(?:!doctype\s+html|html|head|body)\b/i.test(html)) {
        throw new Error('The external source did not return a game HTML document.');
    }

    // jsDelivr may serve HTML files as text/plain. Build a real HTML document
    // and resolve its relative resources from the directory that served it.
    const sourceUrl = new URL(url, window.location.href);
    const isLocalMrMineDocument = isMrMineGame({ url });
    const baseHref = (isLocalMrMineDocument ? getMrMineLocalAssetBaseUrl() : new URL('.', sourceUrl).href)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    const baseTag = '<base href="' + baseHref + '">';
    const existingBase = /<base\b[^>]*>/i;
    let documentHtml = html;
    // A page may deliberately host its assets from a different base path.
    // Preserve that declared path; use the source document directory only
    // when the HTML does not specify a base URL.
    if (isLocalMrMineDocument && existingBase.test(documentHtml)) {
        documentHtml = documentHtml.replace(existingBase, baseTag);
    } else if (!existingBase.test(documentHtml)) {
        if (/<head(?:\s[^>]*)?>/i.test(documentHtml)) {
            documentHtml = documentHtml.replace(/<head(?:\s[^>]*)?>/i, head => head + baseTag);
        } else {
            documentHtml = baseTag + documentHtml;
        }
    }

    // Construct's offline worker is optional for gameplay. This export loads
    // its runtime from a separate CDN origin, so its worker cannot register
    // against Nexus's GitHub Pages origin.
    if (options.disableServiceWorker) {
        documentHtml = documentHtml.replace(
            /<script\b(?=[^>]*\bsrc\s*=\s*["'][^"']*register-sw\.js(?:[?#][^"']*)?["'])[^>]*>\s*<\/script\s*>/gi,
            ''
        );
        const swShim = '<script>window.C3_RegisterSW=function(){return Promise.resolve(null);};</script>';
        if (/<head(?:\s[^>]*)?>/i.test(documentHtml)) {
            documentHtml = documentHtml.replace(/<head(?:\s[^>]*)?>/i, head => head + swShim);
        } else {
            documentHtml = swShim + documentHtml;
        }
    }
    if (options.disableRemotePokiSdk) {
        // Nexus injects a local, non-networking Poki-compatible stub before
        // game scripts. The export's remote SDK loader pulls a text/plain
        // core script from jsDelivr, which browsers correctly refuse to run.
        documentHtml = documentHtml.replace(
            /<script\b(?=[^>]*\bsrc\s*=\s*["'][^"']*poki-sdk\.js(?:[?#][^"']*)?["'])[^>]*>\s*<\/script\s*>/gi,
            ''
        );
    }
    if (options.adaptYouTubePlayable) {
        // The YouTube Playables SDK expects a YouTube host frame and origin.
        // This game only needs a small subset of its API to run outside YouTube.
        documentHtml = documentHtml.replace(
            /<script\b(?=[^>]*\bsrc\s*=\s*["'][^"']*ytgame\.js(?:[?#][^"']*)?["'])[^>]*>\s*<\/script\s*>/gi,
            ''
        );
        // bootstrap.min.js loads this itself; the source HTML's copy causes a
        // duplicate top-level isYouTubeAudioEnabled declaration.
        documentHtml = documentHtml.replace(
            /<script\b(?=[^>]*\bsrc\s*=\s*["'][^"']*game\.min\.js(?:[?#][^"']*)?["'])[^>]*>\s*<\/script\s*>/gi,
            ''
        );
        const sdkShim = [
            '<script>',
            'window.ytgame = {',
            'IN_PLAYABLES_ENV: false,',
            'game: { firstFrameReady: function() {}, gameReady: function() {}, loadData: function() { return Promise.resolve(null); }, saveData: function() { return Promise.resolve(); } },',
            'system: { isAudioEnabled: function() { return true; }, onAudioEnabledChange: function(callback) { if (typeof callback === "function") callback(true); return function() {}; } },',
            'engagement: { sendScore: function() { return Promise.resolve(); } }',
            '};',
            '</script>'
        ].join('');
        if (/<head(?:\s[^>]*)?>/i.test(documentHtml)) {
            documentHtml = documentHtml.replace(/<head(?:\s[^>]*)?>/i, head => head + sdkShim);
        } else {
            documentHtml = sdkShim + documentHtml;
        }
    }

    // Unity loader builds commonly call new URL(streamingAssetsUrl) without
    // providing a base URL. A bare value such as "StreamingAssets" is valid
    // in the original hosted page but throws when the game is launched from
    // an about:srcdoc document. Resolve the configured path against the
    // source page's <base> before any game scripts execute. Absolute URLs stay
    // unchanged after URL resolution, and computed config expressions work
    // the same way as literal paths.
    documentHtml = documentHtml.replace(
        /(\bstreamingAssetsUrl\s*:\s*)([^,\r\n}]+)/gi,
        (_match, property, value) => property + 'new URL((' + value.trim() + '), document.baseURI).href'
    );

    return injectGameBootstrap(documentHtml, bootstrap);
}

async function resolveGameUrl(game) {
    const localUrl = game && game.url;
    const fallbackUrl = getVerifiedGameFallbackUrl(game);
    if (!localUrl || !fallbackUrl || !/^singlefile-bubbls\/UGS-Files\//i.test(localUrl)) {
        return { url: localUrl, usedFallback: false };
    }
    // Mr. Mine's bundled HTML is present locally. Avoid a cache-bypassing HEAD
    // request before the real HTML fetch.
    if (isMrMineGame(game)) return { url: localUrl, usedFallback: false };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
        let response = await fetch(localUrl, {
            method: 'HEAD',
            cache: 'no-store',
            signal: controller.signal
        });
        if (response.status === 405 || response.status === 501) {
            response = await fetch(localUrl, {
                headers: { Range: 'bytes=0-0' },
                cache: 'no-store',
                signal: controller.signal
            });
        }
        if (response.ok) return { url: localUrl, usedFallback: false };
        if (response.status !== 404 && response.status !== 410) return { url: localUrl, usedFallback: false };
        return { url: fallbackUrl, usedFallback: true };
    } catch (error) {
        // Network errors must not turn an offline local game into a promised CDN fallback.
        return { url: localUrl, usedFallback: false };
    } finally {
        clearTimeout(timeout);
    }
}

async function getLaunchSnapshot(gameId) {
    try {
        return await getGameSnapshot(gameId) || {};
    } catch (error) {
        // Save restoration is best-effort; storage errors should not block launch.
        console.warn(`Could not load saved state for ${gameId}; launching without restore data.`, error);
        return {};
    }
}

function launchGameFullscreen(game) {
    if (!game || game.id === "ugs-stash") return;
    const existingWindow = popupGameWindows.get(String(game.id));
    if (existingWindow && !existingWindow.closed) {
        try { existingWindow.focus(); } catch (error) {}
        return;
    }
    // Fullscreen launches bypass loadGame's normal inactive-content cleanup.
    // Release cached file payloads from earlier game visits before opening
    // another game window.
    releaseInactiveGameContent(game);

    const startLaunch = win => {
        if (win.closed) return;
        const gameSession = registerGameSession(game, win);
        try {
            window.localStorage.setItem(getGameSaveSessionKey(game.id), gameSession.sessionId);
        } catch (error) {}
        const launchToken = Date.now() + Math.random();
        let launchFrame = null;
        let injectedLaunch = false;
        let directFallbackTried = false;
        let directFallbackUrl = null;
        let unmodifiedHtml = null;
        const showPopupLoadError = (detail = '') => {
            if (!win.document || !win.document.body) return;
            let panel = win.document.getElementById('nexus-game-load-error');
            if (panel && detail && isMrMineGame(game)) {
                const label = panel.firstElementChild;
                const match = String(detail).match(/https?:\/\/([^/\s)]+)/i);
                if (label) {
                    label.textContent = 'Mr. Mine local files failed to load (' + (match ? match[1] : 'local assets') + ').';
                    label.title = String(detail).slice(0, 500);
                }
                return;
            }
            if (!panel) {
                panel = win.document.createElement('div');
                panel.id = 'nexus-game-load-error';
                panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#10131c;color:#fff;font:600 16px system-ui;text-align:center;padding:24px;box-sizing:border-box';
                const label = win.document.createElement('div');
                if (detail && isMrMineGame(game)) {
                    const match = String(detail).match(/https?:\/\/([^/\s)]+)/i);
                    label.textContent = 'Mr. Mine local files failed to load (' + (match ? match[1] : 'local assets') + ').';
                    label.title = String(detail).slice(0, 500);
                } else {
                    label.textContent = 'This game could not start.';
                }
                const retry = win.document.createElement('button');
                retry.textContent = 'Retry game';
                retry.style.cssText = 'padding:10px 22px;border:0;border-radius:8px;background:#fff;color:#111;font:700 15px system-ui;cursor:pointer';
                retry.onclick = () => {
                    panel.remove();
                    if (!launchFrame) return;
                    if (directFallbackUrl) launchFrame.src = directFallbackUrl;
                    else if (unmodifiedHtml) launchFrame.srcdoc = unmodifiedHtml;
                };
                panel.append(label, retry);
                win.document.body.appendChild(panel);
            }
        };
        win.addEventListener('message', event => {
            const detail = event.data;
            if (!detail || detail.type !== 'nexus-game-launch-error' || String(detail.gameId) !== String(game.id) || Number(detail.loadToken) !== launchToken) return;
            if (isMrMineGame(game)) {
                if (detail.kind === 'resource' || detail.kind === 'resource-timeout' || detail.kind === 'resource-exhausted') {
                    showPopupLoadError(detail.message);
                    return;
                }
            }
            if (injectedLaunch && !directFallbackTried && launchFrame) {
                directFallbackTried = true;
                injectedLaunch = false;
                if (directFallbackUrl) launchFrame.src = directFallbackUrl;
                else if (unmodifiedHtml) launchFrame.srcdoc = unmodifiedHtml;
                else showPopupLoadError();
                return;
            }
            showPopupLoadError();
        });
        try { win.focus(); } catch(e) {}

        // Keep the selected cloak on the game tab while the Nexus tab is
        // temporarily hidden as New Tab for the duration of the game session.
        const cloak = getCloakData();
        const newTabIcon = new URL('Assets/newtab.png', window.location.href).href;

        // Apply the selected title and favicon to the popup shell.
        try {
            win.document.title = cloak.title;
            let link = win.document.querySelector("link[rel*='icon']");
            if (!link) {
                link = win.document.createElement('link');
                win.document.head.appendChild(link);
            }
            link.rel = 'icon';
            if (cloak.icon) link.removeAttribute('type');
            else link.type = 'image/svg+xml';
            link.href = cloak.icon || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
        } catch(e) {}

    const titleEnforceScript = `<script>
    (function() {
        var ct = ${JSON.stringify(cloak.title)};
        var ci = ${JSON.stringify(cloak.icon)};
        function syncTitle() {
            var titleEl = document.querySelector('title');
            if (!titleEl) { titleEl = document.createElement('title'); document.head.appendChild(titleEl); }
            titleEl.textContent = ct;
        }
        syncTitle();
        function syncFavicon() {
            var links = Array.prototype.slice.call(document.querySelectorAll('link[rel]'));
            var icons = links.filter(function(link) {
                return (link.getAttribute('rel') || '').toLowerCase().split(/\s+/).indexOf('icon') !== -1;
            });
            var fl = icons[0];
            if (!fl) { fl = document.createElement('link'); document.head.appendChild(fl); }
            fl.rel = 'icon';
            if (ci) fl.removeAttribute('type');
            else fl.type = 'image/svg+xml';
            fl.href = ci || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
            icons.slice(1).forEach(function(link) { link.remove(); });
        }
        syncFavicon();
        function updatePreset(preset) {
            var presets = {
                canvas: { title: 'Dashboard', icon: 'https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e10d657a73.ico' },
                classroom: { title: 'Home', icon: 'https://ssl.gstatic.com/classroom/favicon.png' },
                wikipedia: { title: 'Wikipedia, the free encyclopedia', icon: 'https://en.wikipedia.org/favicon.ico' },
                desmos: { title: 'Desmos | Graphing Calculator', icon: 'https://www.desmos.com/favicon.ico' },
                drive: { title: 'My Drive - Google Drive', icon: 'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png' },
                docs: { title: 'Google Docs', icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico' },
                bing: { title: 'Bing', icon: 'https://www.bing.com/favicon.ico' },
                khan: { title: 'Dashboard | Khan Academy', icon: 'https://www.khanacademy.org/favicon.ico' },
                none: { title: 'New Tab', icon: ${JSON.stringify(newTabIcon)} },
                newtab: { title: 'New Tab', icon: ${JSON.stringify(newTabIcon)} }
            };
            var next = presets[preset] || presets.canvas;
            ct = next.title;
            ci = next.icon;
            syncTitle();
            syncFavicon();
        }
        window.addEventListener('storage', function(event) {
            if (event.key === 'tb_cloak_preset') updatePreset(event.newValue || 'canvas');
        });
        if (typeof BroadcastChannel === 'function') {
            try {
                var cloakChannel = new BroadcastChannel('nexus-cloak-preset');
                cloakChannel.addEventListener('message', function(event) {
                    if (event.data && event.data.type === 'nexus-cloak-preset') updatePreset(event.data.preset);
                });
            } catch(e) {}
        }
        try {
            Object.defineProperty(document, 'title', {
                get: function() { return ct; },
                set: function() { return ct; }
            });
        } catch(e) {}
        if (window.MutationObserver) {
            var titleEl = document.querySelector('title');
            if (titleEl) {
                new MutationObserver(function() {
                    if (titleEl.textContent !== ct) syncTitle();
                }).observe(titleEl, { childList: true, characterData: true, subtree: true });
            }
        }
        setInterval(function() {
            if (document.title !== ct) syncTitle();
            syncFavicon();
        }, 3000);
    })();
    <\/script>`;

    // Asynchronously load content/snapshots and initialize game document inside about:blank
    (async () => {
        try {
            let ifr;
            if (game.type === 'file') {
                if (!game.content) {
                    await initDB();
                    const stored = await new Promise(resolve => {
                        const req = db.transaction("customGames", "readonly").objectStore("customGames").get(game.id);
                        req.onsuccess = () => resolve(req.result && req.result.content);
                        req.onerror = () => resolve(null);
                    });
                    if (stored) game.content = stored;
                    else {
                        try { win.close(); } catch(e) {}
                        nexusAlert("Game data unavailable.");
                        return;
                    }
                }
                const latestSnapshot = await getLaunchSnapshot(game.id);
                let rawHtml = atob(game.content.split(',')[1]);
                // The file is persisted in IndexedDB; do not retain its base64
                // copy on the parent page after decoding it for this launch.
                game.content = null;
                rawHtml = rawHtml.replace(/<title>[\s\S]*?<\/title>/gi, `<title>${cloak.title}</title>`);
                const isUnityRuntime = /(?:createUnityInstance|UnityLoader|unity-container|unity-canvas)/i.test(rawHtml);
                const unityCompatibility = isUnityRuntime
                    ? `<script>(function(){var nativeAlert=window.alert;window.alert=function(message){var text=String(message||'');if(text.indexOf('timestamp.getTime is not a function')!==-1){console.warn('Ignored Unity IndexedDB timestamp warning.');return;}return nativeAlert.apply(this,arguments);};})();<\/script>`
                    : '';
                const popupBridge = getUniversalAutosaveBridge(game.id, gameSession.sessionId);
                const popupRestore = getGameRestoreScript(game.id, latestSnapshot, gameSession.sessionId);
                const autoFocusScript = `<script>
                (function(){
                    function triggerClickFocus() {
                        try {
                            window.focus();
                            const target = document.body || document.documentElement;
                            if (target) {
                                target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                                target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                                target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                            }
                        } catch(e){}
                    }
                    if (document.readyState === 'complete') {
                        setTimeout(triggerClickFocus, 300);
                    } else {
                        window.addEventListener('load', function() { setTimeout(triggerClickFocus, 300); });
                        setTimeout(triggerClickFocus, 300);
                    }
                })();
                <\/script>`;

                const gameSrcDoc = injectGameBootstrap(rawHtml, getGameLaunchDiagnostics(game.id, launchToken, { captureMrMineAssets: isMrMineGame(game) }) + unityCompatibility + popupRestore + popupBridge + autoFocusScript + titleEnforceScript);
                win.document.body.innerHTML = '';
                win.document.body.style.margin = '0';
                win.document.body.style.padding = '0';
                win.document.body.style.overflow = 'hidden';
                ifr = win.document.createElement('iframe');
                ifr.onerror = showPopupLoadError;
                Object.assign(ifr.style, { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', border: 'none' });
                ifr.setAttribute('allow', 'storage-access; fullscreen');
                launchFrame = ifr;
                injectedLaunch = true;
                unmodifiedHtml = gameSrcDoc;
                ifr.srcdoc = gameSrcDoc;
                win.document.body.appendChild(ifr);
            } else {
                ifr = win.document.createElement('iframe');
                ifr.onerror = showPopupLoadError;
                Object.assign(ifr.style, { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', border: 'none' });
                ifr.setAttribute('allow', 'storage-access; fullscreen');
                const resolved = await resolveGameUrl(game);
                let resolvedUrl = resolved.url || game.url;
                try {
                    resolvedUrl = new URL(game.url, window.location.href).href;
                } catch (e) {}
                if (resolved.usedFallback) resolvedUrl = resolved.url;
                if (resolved.usedFallback) game = { ...game, nexusExternalSource: true };
                if (shouldInjectGamePersistence(game, resolvedUrl)) {
                    const snapshot = await getLaunchSnapshot(game.id);
                    const persistenceBootstrap = getGameLaunchDiagnostics(game.id, launchToken, { captureMrMineAssets: isMrMineGame(game) }) + getGamePersistenceBootstrap(game.id, snapshot, gameSession.sessionId);
                    try {
                        launchFrame = ifr;
                        injectedLaunch = true;
                        directFallbackUrl = resolvedUrl;
                        const gameHtml = await fetchExternalGameHtml(
                            resolvedUrl,
                            persistenceBootstrap + titleEnforceScript,
                            {
                                disableServiceWorker: isTagC3Game(game),
                                disableRemotePokiSdk: isTagC3Game(game),
                                adaptYouTubePlayable: isCrossyRoadGame(game),
                                preferLocalCache: new URL(resolvedUrl, window.location.href).origin === window.location.origin,
                                timeoutMs: 15000
                            }
                        );
                        unmodifiedHtml = gameHtml;
                        ifr.srcdoc = gameHtml;
                    } catch (bootstrapError) {
                        // The source page may still load in a frame when a fetch for
                        // save/compatibility injection is blocked or times out.
                        console.warn('External game bootstrap failed; trying direct load.', bootstrapError);
                        injectedLaunch = false;
                        ifr.src = resolvedUrl;
                    }
                } else {
                    launchFrame = ifr;
                    directFallbackUrl = resolvedUrl;
                    ifr.src = resolvedUrl;
                }
                win.document.body.style.margin = '0';
                win.document.body.style.padding = '0';
                win.document.body.style.overflow = 'hidden';
                win.document.body.appendChild(ifr);
            }

                const targetGameAliases = [game.id];
                if (game.sourceKey && !targetGameAliases.includes(game.sourceKey)) targetGameAliases.push(game.sourceKey);
                if (game.sourceFile) {
                    if (!targetGameAliases.includes(game.sourceFile)) targetGameAliases.push(game.sourceFile);
                    const base = game.sourceFile.replace(/\.html$/, '');
                    if (!targetGameAliases.includes(base)) targetGameAliases.push(base);
                }
                const matchedGame = findGameByIdOrSource(game.id);
                if (matchedGame) {
                    if (matchedGame.id && !targetGameAliases.includes(matchedGame.id)) targetGameAliases.push(matchedGame.id);
                    if (matchedGame.sourceKey && !targetGameAliases.includes(matchedGame.sourceKey)) targetGameAliases.push(matchedGame.sourceKey);
                    if (matchedGame.sourceFile) {
                        if (!targetGameAliases.includes(matchedGame.sourceFile)) targetGameAliases.push(matchedGame.sourceFile);
                        const base = matchedGame.sourceFile.replace(/\.html$/, '');
                        if (!targetGameAliases.includes(base)) targetGameAliases.push(base);
                    }
                }

                const controllerScriptEl = win.document.createElement('script');
                controllerScriptEl.textContent = `
                (function() {
                    var ct = ${JSON.stringify(cloak.title)};
                    var ci = ${JSON.stringify(cloak.icon)};
                    var gameAliases = ${JSON.stringify(targetGameAliases)};
                    var primaryGameId = ${JSON.stringify(game.id)};
                    var saveSessionId = ${JSON.stringify(gameSession.sessionId)};
                    var saveSessionKey = 'tb_nexus_game_session:' + encodeURIComponent(String(primaryGameId));
                    function isCurrentSession() {
                        try { return localStorage.getItem(saveSessionKey) === String(saveSessionId); } catch(err) { return true; }
                    }
                    function reportQuotaFailure(storageType, error) {
                        if (!error || !(error.name === 'QuotaExceededError' || error.code === 22 || error.code === 1014 || /quota exceeded|storage full|disk full/i.test(String(error.message || '')))) return;
                        var message = { type: 'nexus-game-storage-quota-error', gameId: primaryGameId, saveSessionId: saveSessionId, storageType: storageType };
                        try {
                            if (typeof BroadcastChannel === 'function') {
                                var quotaChannel = new BroadcastChannel('nexus-game-session');
                                quotaChannel.postMessage(message);
                                quotaChannel.close();
                            }
                        } catch(err) {}
                        try { if (window.opener && !window.opener.closed) window.opener.postMessage(message, '*'); } catch(err) {}
                    }
                    var blankFavicon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E";
                    function syncTitle() {
                        var titleEl = document.querySelector('title');
                        if (!titleEl) { titleEl = document.createElement('title'); document.head.appendChild(titleEl); }
                        titleEl.textContent = ct;
                    }
                    function syncFavicon() {
                        var links = Array.prototype.slice.call(document.querySelectorAll('link[rel]'));
                        var icons = links.filter(function(link) {
                            return (link.getAttribute('rel') || '').toLowerCase().split(/\\s+/).indexOf('icon') !== -1;
                        });
                        var fl = icons[0];
                        if (!fl) { fl = document.createElement('link'); document.head.appendChild(fl); }
                        fl.rel = 'icon';
                        if (ci) fl.removeAttribute('type');
                        else fl.type = 'image/svg+xml';
                        fl.href = ci || blankFavicon;
                        icons.slice(1).forEach(function(link) { link.remove(); });
                    }
                    function updatePreset(preset) {
                        var presets = {
                            canvas: { title: 'Dashboard', icon: 'https://du11hjcvx0uqb.cloudfront.net/dist/images/favicon-e10d657a73.ico' },
                            classroom: { title: 'Home', icon: 'https://ssl.gstatic.com/classroom/favicon.png' },
                            wikipedia: { title: 'Wikipedia, the free encyclopedia', icon: 'https://en.wikipedia.org/favicon.ico' },
                            desmos: { title: 'Desmos | Graphing Calculator', icon: 'https://www.desmos.com/favicon.ico' },
                            drive: { title: 'My Drive - Google Drive', icon: 'https://ssl.gstatic.com/docs/doclist/images/drive_2022q3_32dp.png' },
                            docs: { title: 'Google Docs', icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico' },
                            bing: { title: 'Bing', icon: 'https://www.bing.com/favicon.ico' },
                            khan: { title: 'Dashboard | Khan Academy', icon: 'https://www.khanacademy.org/favicon.ico' },
                            none: { title: 'New Tab', icon: ${JSON.stringify(newTabIcon)} },
                            newtab: { title: 'New Tab', icon: ${JSON.stringify(newTabIcon)} }
                        };
                        var next = presets[preset] || presets.canvas;
                        ct = next.title;
                        ci = next.icon;
                        syncTitle();
                        syncFavicon();
                    }
                    syncTitle();
                    syncFavicon();
                    window.addEventListener('storage', function(event) {
                        if (event.key === 'tb_cloak_preset') updatePreset(event.newValue || 'canvas');
                    });
                    if (typeof BroadcastChannel === 'function') {
                        try {
                            var cloakChannel = new BroadcastChannel('nexus-cloak-preset');
                            cloakChannel.addEventListener('message', function(event) {
                                if (event.data && event.data.type === 'nexus-cloak-preset') updatePreset(event.data.preset);
                            });
                        } catch(e) {}
                    }
                    try {
                        Object.defineProperty(document, 'title', {
                            get: function() { return ct; },
                            set: function() { return ct; }
                        });
                    } catch(e) {}
                    var titleTimer = setInterval(function() {
                        if (document.title !== ct) syncTitle();
                    }, 2000);
                    var popupClosedNotified = false;
                    function notifyGameClosed() {
                        if (popupClosedNotified) return;
                        popupClosedNotified = true;
                        clearInterval(titleTimer);
                        try {
                            if (typeof BroadcastChannel === 'function') {
                                var bc = new BroadcastChannel('nexus-game-session');
                                bc.postMessage({ type: 'nexus-popup-closed', gameId: primaryGameId });
                                bc.close();
                            }
                        } catch(err) {}
                        try {
                            localStorage.setItem('nexus_popup_closed', JSON.stringify({ gameId: primaryGameId, time: Date.now() }));
                        } catch(err) {}
                        try {
                            if (window.opener && !window.opener.closed) {
                                window.opener.postMessage({ type: 'nexus-popup-closed', gameId: primaryGameId }, '*');
                            }
                        } catch(err) {}
                    }
                    window.addEventListener('beforeunload', notifyGameClosed, { once: true });
                    window.addEventListener('pagehide', notifyGameClosed, { once: true });

                    // Standalone IndexedDB snapshot persistence engine for about:blank popup
                    function recordGameDatabaseUse(data) {
                        if (!data || !isCurrentSession() || String(data.saveSessionId) !== String(saveSessionId)) return;
                        var databaseName = String(data.databaseName || '');
                        if (!databaseName || databaseName.length > 120 || ['GameStorageDB', 'AIChatDB', 'NexusSidebarSettings'].indexOf(databaseName) !== -1) return;
                        var ids = [primaryGameId || gameAliases[0]].filter(Boolean);
                        try {
                            var req = indexedDB.open('GameStorageDB', 4);
                            req.onupgradeneeded = function(e) {
                                var d = e.target.result;
                                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
                                if (!d.objectStoreNames.contains('gameSnapshotMeta')) d.createObjectStore('gameSnapshotMeta', { keyPath: 'gameId' });
                            };
                            req.onerror = function() { reportQuotaFailure('indexedDB', req.error); };
                            req.onsuccess = function(e) {
                                var database = e.target.result;
                                database.onversionchange = function() { try { database.close(); } catch(err) {} };
                                try {
                                    var tx = database.transaction('gameSnapshotMeta', 'readwrite');
                                    var store = tx.objectStore('gameSnapshotMeta');
                                    tx.onerror = function(event) { reportQuotaFailure('indexedDB', event.target && event.target.error || tx.error); };
                                    tx.onabort = function(event) { reportQuotaFailure('indexedDB', event.target && event.target.error || tx.error); };
                                    ids.forEach(function(id) {
                                        if (!id) return;
                                        var getReq = store.get(id);
                                        getReq.onsuccess = function() {
                                            var metadata = getReq.result || { gameId: id, estimatedBytes: null };
                                            var names = new Set(Array.isArray(metadata.indexedDBNames) ? metadata.indexedDBNames : []);
                                            names.add(databaseName);
                                            metadata.indexedDBNames = Array.from(names);
                                            if (!isFinite(Number(metadata.savedAt))) metadata.savedAt = Date.now();
                                            store.put(metadata);
                                        };
                                    });
                                } catch(err) { reportQuotaFailure('indexedDB', err); }
                            };
                        } catch(err) { reportQuotaFailure('indexedDB', err); }
                    }
                    function saveToIDB(incomingData) {
                        if (!incomingData || !isCurrentSession() || String(incomingData.saveSessionId) !== String(saveSessionId)) return;
                        var ids = [primaryGameId || gameAliases[0]].filter(Boolean);
                        var incomingLs = incomingData.localStorage || {};
                        var incomingLsIsComplete = incomingData.localStorageComplete === true;
                        var incomingFs = incomingData.fsData || null;
                        var incomingIdb = incomingData.idbData || null;
                        var incomingFsIsComplete = incomingData.fsDataComplete === true;
                        var incomingIdbIsComplete = incomingData.idbDataComplete === true;
                        var payloadSavedAt = Number(incomingData.savedAt);
                        var incomingSavedAt = isFinite(payloadSavedAt) && payloadSavedAt > 0 ? payloadSavedAt : Date.now();
                        try {
                            var req = indexedDB.open("GameStorageDB", 4);
                            req.onupgradeneeded = function(e) {
                                var d = e.target.result;
                                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
                                if (!d.objectStoreNames.contains('gameSnapshotMeta')) d.createObjectStore('gameSnapshotMeta', { keyPath: 'gameId' });
                            };
                            req.onerror = function() { reportQuotaFailure('indexedDB', req.error); };
                            req.onsuccess = function(e) {
                                var db = e.target.result;
                                db.onversionchange = function() { try { db.close(); } catch(err) {} };
                                try {
                                    if (!db.objectStoreNames.contains('gameSnapshots')) return;
                                    var tx = db.transaction(['gameSnapshots', 'gameSnapshotMeta'], 'readwrite');
                                    var store = tx.objectStore('gameSnapshots');
                                    var metaStore = tx.objectStore('gameSnapshotMeta');
                                    tx.onerror = function(event) { reportQuotaFailure('indexedDB', event.target && event.target.error || tx.error); };
                                    tx.onabort = function(event) { reportQuotaFailure('indexedDB', event.target && event.target.error || tx.error); };
                                    var getReq = store.get(ids[0]);
                                    getReq.onerror = function() { reportQuotaFailure('indexedDB', getReq.error); };
                                    getReq.onsuccess = function() {
                                        var existing = getReq.result || null;
                                        if (existing && Number(existing.savedAt) > incomingSavedAt) return;
                                        var existingData = (existing && existing.localStorage && typeof existing.localStorage === 'object') ? existing.localStorage : {};
                                        var incomingKeys = Object.keys(incomingLs);
                                        var existingKeys = Object.keys(existingData);

                                        var lsToSave = Object.assign({}, incomingLs);
                                        if (!incomingLsIsComplete && incomingKeys.length === 0 && existingKeys.length > 0) {
                                            lsToSave = Object.assign({}, existingData);
                                        } else if (!incomingLsIsComplete && incomingKeys.length > 0 && existingKeys.length > 0) {
                                            lsToSave = Object.assign({}, existingData, incomingLs);
                                        }

                                        var fsToSave = incomingFsIsComplete
                                            ? (incomingFs && Object.keys(incomingFs).length ? Object.assign({}, incomingFs) : null)
                                            : ((existing && existing.fsData) ? Object.assign({}, existing.fsData) : null);
                                        if (!incomingFsIsComplete && incomingFs && Object.keys(incomingFs).length > 0) {
                                            fsToSave = Object.assign({}, fsToSave || {}, incomingFs);
                                        }

                                        var idbToSave = incomingIdbIsComplete
                                            ? (incomingIdb && Object.keys(incomingIdb).length ? Object.assign({}, incomingIdb) : null)
                                            : ((existing && existing.idbData) ? Object.assign({}, existing.idbData) : null);
                                        if (!incomingIdbIsComplete && incomingIdb && Object.keys(incomingIdb).length > 0) {
                                            idbToSave = Object.assign({}, idbToSave || {}, incomingIdb);
                                        }

                                        var savedAt = incomingSavedAt;
                                        var targetId = ids[0];
                                        if (!targetId) return;
                                        var record = {
                                            gameId: targetId,
                                            localStorage: lsToSave,
                                            fsData: fsToSave,
                                            idbData: idbToSave,
                                            localStorageComplete: incomingLsIsComplete,
                                            fsDataComplete: incomingFsIsComplete || existing && existing.fsDataComplete === true,
                                            idbDataComplete: incomingIdbIsComplete || existing && existing.idbDataComplete === true,
                                            savedAt: savedAt
                                        };
                                        try {
                                            var putReq = store.put(record);
                                            putReq.onsuccess = function() {
                                                var metaReq = metaStore.get(targetId);
                                                metaReq.onsuccess = function() {
                                                    var metadata = metaReq.result || { gameId: targetId, indexedDBNames: [] };
                                                    metadata.estimatedBytes = null;
                                                    metadata.estimatedBytesVersion = 0;
                                                    metadata.savedAt = savedAt;
                                                    metaStore.put(metadata);
                                                };
                                            };
                                            putReq.onerror = function() { reportQuotaFailure('indexedDB', putReq.error); };
                                        } catch(err) { reportQuotaFailure('indexedDB', err); }
                                    };
                                } catch(txErr) { reportQuotaFailure('indexedDB', txErr); }
                            };
                        } catch(err) { reportQuotaFailure('indexedDB', err); }
                    }

                    function loadFromIDB(callback) {
                        try {
                            var req = indexedDB.open("GameStorageDB", 4);
                            req.onupgradeneeded = function(e) {
                                var d = e.target.result;
                                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
                                if (!d.objectStoreNames.contains('gameSnapshotMeta')) d.createObjectStore('gameSnapshotMeta', { keyPath: 'gameId' });
                            };
                            req.onsuccess = function(e) {
                                var db = e.target.result;
                                db.onversionchange = function() { try { db.close(); } catch(err) {} };
                                try {
                                    if (!db.objectStoreNames.contains('gameSnapshots')) {
                                        if (callback) callback(null);
                                        return;
                                    }
                                    var tx = db.transaction('gameSnapshots', 'readonly');
                                    var store = tx.objectStore('gameSnapshots');
                                    var idx = 0;
                                    function checkNext() {
                                        if (idx >= gameAliases.length) {
                                            if (callback) callback(null);
                                            return;
                                        }
                                        var curId = gameAliases[idx++];
                                        var getReq = store.get(curId);
                                        getReq.onsuccess = function() {
                                            var res = getReq.result;
                                            if (res && (res.localStorage || res.fsData || res.idbData)) {
                                                if (callback) callback(res);
                                            } else {
                                                checkNext();
                                            }
                                        };
                                        getReq.onerror = function() { checkNext(); };
                                    }
                                    checkNext();
                                } catch(txErr) {
                                    if (callback) callback(null);
                                }
                            };
                            req.onerror = function() { if (callback) callback(null); };
                        } catch(err) {
                            if (callback) callback(null);
                        }
                    }

                    // Autonomous Message Bus: persists even if opener tab was closed
                    window.addEventListener('message', function(e) {
                        if (!e.data) return;
                        if (e.data.type === 'nexus-game-storage-quota-error' && isCurrentSession() && String(e.data.saveSessionId) === String(saveSessionId)) {
                            try {
                                if (typeof BroadcastChannel === 'function') {
                                    var quotaChannel = new BroadcastChannel('nexus-game-session');
                                    quotaChannel.postMessage(e.data);
                                    quotaChannel.close();
                                }
                            } catch(err) {}
                            try {
                                if (window.opener && !window.opener.closed) window.opener.postMessage(e.data, '*');
                            } catch(err) {}
                        } else if (e.data.type === 'nexus-game-database-use' && isCurrentSession() && String(e.data.saveSessionId) === String(saveSessionId)) {
                            recordGameDatabaseUse(e.data);
                        } else if (e.data.type === 'nexus-game-save' && isCurrentSession() && String(e.data.saveSessionId) === String(saveSessionId)) {
                            saveToIDB(e.data);
                            try {
                                if (window.opener && !window.opener.closed) {
                                    window.opener.postMessage(e.data, '*');
                                }
                            } catch(err) {}
                        } else if (e.data.type === 'nexus-request-game-restore') {
                            loadFromIDB(function(snap) {
                                if (snap && e.source) {
                                    try {
                                        e.source.postMessage({
                                            type: 'nexus-apply-game-restore',
                                            gameId: e.data.gameId || primaryGameId,
                                            localStorage: snap.localStorage || {},
                                            localStorageComplete: snap.localStorageComplete === true,
                                            fsData: snap.fsData || null,
                                            fsDataComplete: snap.fsDataComplete === true,
                                            idbData: snap.idbData || null,
                                            idbDataComplete: snap.idbDataComplete === true
                                        }, '*');
                                    } catch(err) {}
                                }
                            });
                            try {
                                if (window.opener && !window.opener.closed) {
                                    window.opener.postMessage(e.data, '*');
                                }
                            } catch(err) {}
                        }
                    });

                    // Flush saves on tab exit / hide
                    function triggerAutosaveFlush() {
                        var frame = document.querySelector('iframe');
                        if (frame && frame.contentWindow) {
                            try {
                                frame.contentWindow.postMessage({ type: 'nexus-request-game-save' }, '*');
                            } catch(err) {}
                        }
                    }
                    window.addEventListener('pagehide', triggerAutosaveFlush, { passive: true });
                    window.addEventListener('beforeunload', triggerAutosaveFlush, { passive: true });
                    document.addEventListener('visibilitychange', function() {
                        if (document.hidden) triggerAutosaveFlush();
                    }, { passive: true });
                    try {
                        window.opener = null;
                    } catch(err) {}
                })();
                `;
                win.document.head.appendChild(controllerScriptEl);
                try {
                    win.opener = null;
                } catch(err) {}
                hibernateMainTabForGame();

                function doFocusAndClick() {
                    try {
                        win.focus();
                        ifr.focus();
                        if (ifr.contentWindow) {
                            ifr.contentWindow.focus();
                            try {
                                const doc = ifr.contentDocument || ifr.contentWindow.document;
                                if (doc && doc.body) {
                                    doc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: ifr.contentWindow }));
                                    doc.body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: ifr.contentWindow }));
                                    doc.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: ifr.contentWindow }));
                                }
                            } catch(e) {}
                        }
                    } catch(e) {}
                }
                setTimeout(doFocusAndClick, 100);
                setTimeout(doFocusAndClick, 500);
                setTimeout(doFocusAndClick, 1000);
        } catch(err) {
            console.error("Error launching game in fullscreen window:", err);
            try { win.close(); } catch (e) {}
            handleGamePopupClosed(gameSession.sessionId);
            const message = 'Nexus could not start this game. Check your connection and try again. The raw error is available below if needed.';
            if (typeof window.nexusError === 'function') window.nexusError(message, err, 'Game launch failed');
            else nexusAlert('Nexus could not start this game. Check your connection and try again.');
        }
        })();
    };

    if (activeGameSessions.size) {
        showRedConfirmDialog(
            'Opening multiple games can cause low performance or bugs. Are you sure you want to continue?',
            {
                greenCancel: true,
                onConfirm: () => window.open('about:blank', '_blank')
            }
        ).then(reservedWindow => {
            if (reservedWindow === false) return;
            if (!reservedWindow) {
                nexusAlert("Pop-up blocked! Please allow pop-ups to open games.");
                return;
            }
            startLaunch(reservedWindow);
        });
        return;
    }

    // Open about:blank synchronously on the user click gesture to avoid browser popup blocking.
    const win = window.open('about:blank', '_blank');
    if (!win) {
        nexusAlert("Pop-up blocked! Please allow pop-ups to open games.");
        return;
    }
    startLaunch(win);
}

function getAppBaseUrl() {
    try {
        const origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
        let path = window.location.pathname || '';
        path = path.substring(0, path.lastIndexOf('/') + 1);
        return origin + path;
    } catch(e) {
        return './';
    }
}

function getLoadingScreenBgUrl() {
    try {
        const base = getAppBaseUrl();
        return base.endsWith('/') ? base + 'Assets/loading_screen.png' : base + '/Assets/loading_screen.png';
    } catch(e) {
        return 'Assets/loading_screen.png';
    }
}

// Universal Game Bootstrap Injection with Accurate Loading Detection & Non-Invasive Overlay
function injectGameBootstrap(html, bootstrap) {
    if (!html) return html;
    let finalBootstrap = bootstrap || '';
    const bgUrl = getLoadingScreenBgUrl();
    const baseUrl = getAppBaseUrl();
    const baseTag = !/<base(?:\s[^>]*)?>/i.test(html) ? `<base href="${baseUrl}">` : '';

    // Universal Instant Ad Reward Bypass Engine
    const adBypassBootstrap = `<script>
(function() {
    window.PokiSDK = window.PokiSDK || {};
    window.PokiSDK.init = function() { return Promise.resolve(); };
    window.PokiSDK.initWithVideoHB = function() { return Promise.resolve(); };
    window.PokiSDK.commercialBreak = function() { return Promise.resolve(); };
    window.PokiSDK.rewardedBreak = function(fn) {
        if (typeof fn === 'function') { try { fn(true); } catch(e) {} }
        return Promise.resolve(true);
    };
    window.PokiSDK.displayAd = function() { return Promise.resolve(); };
    window.PokiSDK.destroyAd = function() {};
    window.PokiSDK.gameLoadingStart = function() {};
    window.PokiSDK.gameLoadingFinished = function() {};
    window.PokiSDK.gameLoadingProgress = function() {};
    window.PokiSDK.gameplayStart = function() {};
    window.PokiSDK.gameplayStop = function() {};
    window.PokiSDK.happyTime = function() {};
    window.PokiSDK.setDebug = function() {};

    var crazyAdMock = {
        requestAd: function(type, callbacks) {
            if (callbacks) {
                if (callbacks.adStarted) try { callbacks.adStarted(); } catch(e) {}
                if (callbacks.adFinished) try { callbacks.adFinished(); } catch(e) {}
                if (callbacks.reward) try { callbacks.reward(); } catch(e) {}
                if (callbacks.adCompleted) try { callbacks.adCompleted(); } catch(e) {}
            }
            return Promise.resolve(true);
        },
        hasAdblock: function() { return Promise.resolve(false); },
        checkAdblock: function() { return Promise.resolve(false); }
    };
    window.CrazyGames = window.CrazyGames || {};
    window.CrazyGames.SDK = window.CrazyGames.SDK || {
        ad: crazyAdMock,
        banner: { requestBanner: function() { return Promise.resolve(); }, clearAll: function() {} },
        game: { gameplayStart: function() {}, gameplayStop: function() {}, happytime: function() {}, inviteLink: function() { return ""; } }
    };
    window.crazygames = window.CrazyGames;

    window.aiptag = window.aiptag || {};
    window.aiptag.cmd = window.aiptag.cmd || {};
    window.aiptag.cmd.player = window.aiptag.cmd.player || [];
    window.aiptag.cmd.display = window.aiptag.cmd.display || [];
    window.aiptag.cmd.player.push = function(cfg) {
        if (cfg && typeof cfg === 'object') {
            if (typeof cfg.callback === 'function') { setTimeout(function() { try { cfg.callback(true); } catch(e) {} }, 10); return 1; }
            if (typeof cfg.onComplete === 'function') { setTimeout(function() { try { cfg.onComplete(true); } catch(e) {} }, 10); return 1; }
        }
        return 1;
    };

    window.GamePix = window.GamePix || {};
    window.GamePix.rewardAd = function() { return Promise.resolve({ success: true }); };
    window.GamePix.interstitialAd = function() { return Promise.resolve({ success: true }); };

    window.rewardedBreak = function() {
        if (window.unityGame && window.pokiBridge) {
            try { window.unityGame.SendMessage(window.pokiBridge, "rewardedBreakCompleted", "true"); } catch(e) {}
        }
        return Promise.resolve(true);
    };
    window.commercialBreak = function() {
        if (window.unityGame && window.pokiBridge) {
            try { window.unityGame.SendMessage(window.pokiBridge, "commercialBreakCompleted"); } catch(e) {}
        }
        return Promise.resolve();
    };
})();
<\/script>`;

    // Inject loading screen styles & safe overlay creator if not already present in the custom game HTML
    let loadingScripts = '';
    // Loading is owned by the Nexus host shell; game documents must not receive a second loader.
    if (false && !html.includes('nexus-loading-screen')) {
        loadingScripts = `<style>
#nexus-loading-screen {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    z-index: 2147483647 !important;
    background-color: #08080c !important;
    background: radial-gradient(circle at 50% 40%, #1a1a24 0%, #08080c 70%, #000000 100%) !important;
    background-image: url('${bgUrl}') !important;
    background-size: cover !important;
    background-position: center !important;
    background-repeat: no-repeat !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: flex-end !important;
    align-items: center !important;
    pointer-events: auto !important;
    opacity: 1 !important;
    transition: opacity 0.4s ease !important;
    margin: 0 !important;
    padding: 0 !important;
    box-sizing: border-box !important;
}
.nexus-loader-bar-container {
    width: clamp(260px, 36vw, 440px) !important;
    height: 16px !important;
    background: rgba(255, 255, 255, 0.15) !important;
    border: 1.5px solid rgba(255, 255, 255, 0.3) !important;
    border-radius: 10px !important;
    overflow: hidden !important;
    margin-bottom: clamp(60px, 12vh, 100px) !important;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.6) !important;
    box-sizing: border-box !important;
}
.nexus-loader-bar-fill {
    height: 100% !important;
    width: 0% !important;
    background-color: #ffffff !important;
    border-radius: 10px !important;
    transition: width 0.25s cubic-bezier(0.25, 1, 0.5, 1) !important;
    box-sizing: border-box !important;
}
@keyframes nexus-stripes-backward {
    0% { background-position: 56px 0; }
    100% { background-position: 0 0; }
}
.nexus-bar-busy {
    background-image: repeating-linear-gradient(
        -45deg,
        #ffffff 0px,
        #ffffff 14px,
        #b8b8b8 14px,
        #b8b8b8 28px
    ) !important;
    background-size: 39.6px 100% !important;
    animation: nexus-stripes-backward 0.75s linear infinite !important;
}
</style>
<script>
(function() {
    var isDone = false;
    var progress = 20;
    var bar = null;
    var overlay = null;
    var busyTimer = null;
    var creepTimer = null;
    var creepStartTimer = null;
    var stepTimer1 = null;
    var stepTimer2 = null;
    var maxWaitTimer = null;

    function createOverlay() {
        if (overlay || document.getElementById('nexus-loading-screen')) {
            overlay = document.getElementById('nexus-loading-screen');
            if (overlay && !bar) bar = overlay.querySelector('#nexus-loader-bar');
            return;
        }
        overlay = document.createElement('div');
        overlay.id = 'nexus-loading-screen';
        overlay.innerHTML = '<div class="nexus-loader-bar-container"><div id="nexus-loader-bar" class="nexus-loader-bar-fill"></div></div>';
        (document.body || document.documentElement).appendChild(overlay);
        bar = overlay.querySelector('#nexus-loader-bar');

        // Initial bar position
        updateProgress(20);

        // Smooth initial progress glide
        stepTimer1 = setTimeout(function() { updateProgress(45); }, 180);
        stepTimer2 = setTimeout(function() { updateProgress(65); }, 420);

        // Within 0.7 seconds: backward moving stripes appear
        busyTimer = setTimeout(function() {
            if (!isDone && bar) bar.classList.add('nexus-bar-busy');
        }, 700);

        // Within 2.0 seconds: slow forward crawl ensues towards 99%
        creepStartTimer = setTimeout(function() {
            if (isDone) return;
            creepTimer = setInterval(function() {
                if (isDone) {
                    clearInterval(creepTimer);
                    return;
                }
                if (progress < 99) {
                    var remaining = 99 - progress;
                    var step = Math.max(0.12, remaining * 0.045);
                    progress = Math.min(99, progress + step);
                    if (bar) bar.style.setProperty('width', progress + '%', 'important');
                }
            }, 80);
        }, 2000);
    }

    function updateProgress(pct) {
        if (isDone) return;
        progress = Math.max(progress, Math.min(99, pct));
        if (bar) bar.style.setProperty('width', progress + '%', 'important');
    }

    function completeLoading() {
        if (isDone) return;
        isDone = true;
        if (stepTimer1) clearTimeout(stepTimer1);
        if (stepTimer2) clearTimeout(stepTimer2);
        if (busyTimer) clearTimeout(busyTimer);
        if (creepStartTimer) clearTimeout(creepStartTimer);
        if (creepTimer) clearInterval(creepTimer);
        if (maxWaitTimer) clearTimeout(maxWaitTimer);

        // Quickly glide to 100% full
        if (bar) {
            bar.style.setProperty('transition', 'width 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)', 'important');
            bar.style.setProperty('width', '100%', 'important');
        }

        // As the bar reaches full, smoothly execute the fade-out
        setTimeout(function() {
            if (overlay) {
                overlay.style.setProperty('transition', 'opacity 0.4s ease', 'important');
                overlay.style.setProperty('opacity', '0', 'important');
                overlay.style.setProperty('pointer-events', 'none', 'important');
                setTimeout(function() {
                    try {
                        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    } catch(e) {}
                    overlay = null;
                    bar = null;
                }, 450);
            }
        }, 120);
    }

    window.updateNexusProgress = updateProgress;
    window.completeNexusLoading = completeLoading;

    // Attach overlay immediately
    if (document.body) createOverlay();
    else document.addEventListener('DOMContentLoaded', createOverlay);

    function onInteractive() {
        createOverlay();
        updateProgress(65);
    }

    function onDocumentComplete() {
        createOverlay();
        updateProgress(85);

        var frameCount = 0;
        function checkGameRender() {
            if (isDone) return;
            frameCount++;
            updateProgress(85 + Math.min(10, frameCount * 2));

            // Wait 5 animation frames after completion so game graphics render to screen before fade
            if (frameCount >= 5) {
                completeLoading();
                return;
            }
            requestAnimationFrame(checkGameRender);
        }
        requestAnimationFrame(checkGameRender);
    }

    // Handle all document states (including about:blank document.write)
    if (document.readyState === 'complete') {
        onDocumentComplete();
    } else if (document.readyState === 'interactive') {
        onInteractive();
        document.addEventListener('readystatechange', function() {
            if (document.readyState === 'complete') onDocumentComplete();
        });
        window.addEventListener('load', onDocumentComplete);
    } else {
        document.addEventListener('DOMContentLoaded', onInteractive);
        document.addEventListener('readystatechange', function() {
            if (document.readyState === 'interactive') onInteractive();
            else if (document.readyState === 'complete') onDocumentComplete();
        });
        window.addEventListener('load', onDocumentComplete);
    }

    // Long, bounded failure state: ordinary slow games are not treated as failed at 8 seconds.
    maxWaitTimer = setTimeout(function() {
        if (isDone) return;
        isDone = true;
        if (stepTimer1) clearTimeout(stepTimer1);
        if (stepTimer2) clearTimeout(stepTimer2);
        if (busyTimer) clearTimeout(busyTimer);
        if (creepStartTimer) clearTimeout(creepStartTimer);
        if (creepTimer) clearInterval(creepTimer);
        if (overlay) {
            overlay.style.justifyContent = 'center';
            overlay.style.gap = '14px';
            var notice = document.createElement('div');
            notice.textContent = 'This game is taking longer than expected.';
            notice.style.cssText = 'color:#fff;font-size:15px;font-weight:600;font-family:var(--app-font, sans-serif);text-align:center;padding:0 20px;';
            var retry = document.createElement('button');
            retry.textContent = 'Retry';
            retry.style.cssText = 'padding:9px 20px;border:2px solid #fff;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font-size:14px;font-weight:700;font-family:var(--app-font, sans-serif);cursor:pointer;';
            retry.onclick = function() { location.reload(); };
            overlay.appendChild(notice);
            overlay.appendChild(retry);
        }
    }, 45000);

    window.addEventListener('message', function(e) {
        if (e.data === 'bonk' || (e.data && e.data.type === 'nexus-game-ready')) {
            completeLoading();
        }
    });

    try {
        if (window.PokiSDK) {
            var origDone = window.PokiSDK.gameLoadingFinished;
            window.PokiSDK.gameLoadingFinished = function() {
                completeLoading();
                if (typeof origDone === 'function') origDone.apply(this, arguments);
            };
        }
    } catch(e) {}
})();
<\/script>`;
    }

    finalBootstrap = baseTag + adBypassBootstrap + loadingScripts + finalBootstrap;

    // Inject scripts safely into <head> or at start of document
    const headMatch = html.match(/<head(?:\s[^>]*)?>/i);
    if (headMatch && headMatch.index !== undefined) {
        const insertAt = headMatch.index + headMatch[0].length;
        return html.slice(0, insertAt) + finalBootstrap + html.slice(insertAt);
    }
    const bodyMatch = html.match(/<body(?:\s[^>]*)?>/i);
    if (bodyMatch && bodyMatch.index !== undefined) {
        const insertAt = bodyMatch.index + bodyMatch[0].length;
        return html.slice(0, insertAt) + finalBootstrap + html.slice(insertAt);
    }
    return finalBootstrap + html;
}

let gameStatusFadeTimer = null;
let isStashPreloaded = false;
let activeHostLoader = null;
let activeGameLaunch = null;

window.addEventListener('message', event => {
    const detail = event.data;
    if (!detail || detail.type !== 'nexus-game-launch-error' || !activeGameLaunch) return;
    if (String(detail.gameId) !== String(activeGameLaunch.gameId) || Number(detail.loadToken) !== activeGameLaunch.loadToken) return;

    const frame = document.getElementById('game-frame');
    if (!frame || activeGameLaunch.loadToken !== gameLoadToken) return;

    if (isMrMineGame(activeGameLaunch.game)) {
        if (detail.kind === 'resource' || detail.kind === 'resource-timeout' || detail.kind === 'resource-exhausted') {
            completeHostLoader();
            showGameLoadError(activeGameLaunch.game, frame, detail.message);
            return;
        }
    }

    if (activeGameLaunch.injected && !activeGameLaunch.directFallbackTried) {
        activeGameLaunch.directFallbackTried = true;
        activeGameLaunch.injected = false;
        console.warn('Injected game startup failed; retrying the source page directly.', detail.message);
        completeHostLoader();
        updateGameStatusUI('loading');
        beginHostLoader(document);
        frame.onload = () => {
            if (activeGameLaunch && activeGameLaunch.loadToken === gameLoadToken) {
                completeHostLoader();
                updateGameStatusUI('loaded');
                frame.style.setProperty('visibility', 'visible', 'important');
                frame.style.opacity = '1';
            }
        };
        frame.onerror = () => {
            completeHostLoader();
            showGameLoadError(activeGameLaunch.game, frame);
        };
        frame.removeAttribute('srcdoc');
        if (activeGameLaunch.url) frame.src = activeGameLaunch.url;
        else if (activeGameLaunch.fallbackHtml) frame.srcdoc = activeGameLaunch.fallbackHtml;
        else showGameLoadError(activeGameLaunch.game, frame);
        return;
    }

    completeHostLoader();
    showGameLoadError(activeGameLaunch.game, frame);
});

function beginHostLoader(parentDoc = document) {
    if (activeHostLoader) activeHostLoader.complete();
    activeHostLoader = createNexusLoadingOverlay(parentDoc);
    return activeHostLoader;
}

function completeHostLoader() {
    if (!activeHostLoader) return;
    activeHostLoader.complete();
    activeHostLoader = null;
}

function updateGameStatusUI(state) {
    const container = document.getElementById('game-status-container');
    const icon = document.getElementById('game-status-icon');
    const text = document.getElementById('game-status-text');

    if (!container || !icon || !text) return;

    if (state !== 'error') container.onclick = null;

    if (gameStatusFadeTimer) {
        clearTimeout(gameStatusFadeTimer);
        gameStatusFadeTimer = null;
    }

    if (state === 'loading') {
        icon.src = 'Assets/loadingRoll.gif';
        text.textContent = 'Loading...';
        container.style.opacity = '1';
        container.style.visibility = 'visible';
        container.classList.add('active');
    } else if (state === 'loaded') {
        icon.src = 'Assets/Game.svg';
        text.textContent = 'Loaded';
        container.style.opacity = '1';
        container.style.visibility = 'visible';
        container.classList.add('active');

        gameStatusFadeTimer = setTimeout(() => {
            container.style.opacity = '0';
            container.style.visibility = 'hidden';
            setTimeout(() => {
                container.classList.remove('active');
            }, 400);
        }, 1800);
    } else if (state === 'hidden') {
        container.style.opacity = '0';
        container.style.visibility = 'hidden';
        container.classList.remove('active');
    }
}

function showGameLoadError(game, frame, detail = '') {
    const container = document.getElementById('game-status-container');
    const icon = document.getElementById('game-status-icon');
    const text = document.getElementById('game-status-text');
    if (!container || !icon || !text) return;
    if (gameStatusFadeTimer) clearTimeout(gameStatusFadeTimer);
    icon.src = 'Assets/Delete.svg';
    if (detail && isMrMineGame(game)) {
        const match = String(detail).match(/https?:\/\/([^/\s)]+)/i);
        const host = match ? match[1] : 'local assets';
        text.textContent = 'Mr. Mine local files failed to load (' + host + ') - Retry';
        text.title = String(detail).slice(0, 500);
    } else {
        text.textContent = 'Load failed - Retry';
        text.removeAttribute('title');
    }
    container.style.opacity = '1';
    container.style.visibility = 'visible';
    container.classList.add('active');
    container.onclick = () => {
        container.onclick = null;
        if (frame) releaseIframe(frame);
        loadGame(game, true);
    };
}

function ensureStashPreloaded() {
    const stashFrame = document.getElementById('stash-frame');
    if (!stashFrame) return Promise.resolve(false);
    if (isStashPreloaded && stashFrame.src && !stashFrame.src.endsWith('about:blank')) return Promise.resolve(true);
    if (stashLoadPromise) return stashLoadPromise;

    stashFrame.style.setProperty('display', 'none', 'important');
    stashLoadPromise = new Promise(resolve => {
        let complete = false;
        const timeout = setTimeout(() => finish(false), 30000);
        const finish = loaded => {
            if (complete) return;
            complete = true;
            clearTimeout(timeout);
            stashFrame.removeEventListener('load', onLoad);
            stashFrame.removeEventListener('error', onError);
            isStashPreloaded = loaded;
            stashLoadPromise = null;
            resolve(loaded);
        };
        const onLoad = () => finish(true);
        const onError = () => finish(false);
        stashFrame.addEventListener('load', onLoad, { once: true });
        stashFrame.addEventListener('error', onError, { once: true });

        if (!stashFrame.src || stashFrame.src.endsWith('about:blank')) {
            stashFrame.src = 'clSINGLEFILE.html';
        } else {
            try {
                if (stashFrame.contentDocument && stashFrame.contentDocument.readyState === 'complete') finish(true);
            } catch (error) {}
        }
    });
    return stashLoadPromise;
}

async function loadGame(game, forceInternal = false, options = {}) {
    if (!game) return;

    if (game.isNew) {
        game.isNew = false;
        saveGameRecord(game).catch(() => {});
        const li = document.querySelector(`li[data-game-id="${game.id}"]`);
        if (li) li.classList.remove('new-game');
    }

    const localStorage = window.nexusStorage || window.localStorage;

    // Launch non-stash game from sidebar straight to new tab in fullscreen
    if (!forceInternal && game && game.id !== "ugs-stash") {
        launchGameFullscreen(game);
        return;
    }

    const requestedLoadToken = ++gameLoadToken;
    let resolvedGameUrl = game.url;

    let fileSnapshot = {};
    if (game.type === 'file') {
        if (!game.content) {
            await initDB();
            const stored = await new Promise(resolve => {
                const req = db.transaction("customGames", "readonly").objectStore("customGames").get(game.id);
                req.onsuccess = () => resolve(req.result && req.result.content);
                req.onerror = () => resolve(null);
            });
            if (stored) game.content = stored;
            else { nexusAlert("File unavailable."); return; }
        }

        // Always fetch freshest snapshot directly from IndexedDB
        const latestSnapshot = await getGameSnapshot(game.id);
        fileSnapshot = latestSnapshot || {};

        if (requestedLoadToken !== gameLoadToken) return;
    } else if (game.type === 'url') {
        const resolved = await resolveGameUrl(game);
        if (requestedLoadToken !== gameLoadToken) return;
        resolvedGameUrl = resolved.url || game.url;
        if (resolved.usedFallback) game = { ...game, nexusExternalSource: true };
    }

    releaseInactiveGameContent(game);
    currentGame = game;
    window.dispatchEvent(new CustomEvent('nexus-active-game-change', {
        detail: { active: game.id !== 'ugs-stash' }
    }));

    // Stop background tasks and pause video to free CPU/GPU for Chromebooks
    try {
        const bgVid = document.querySelector('.home-bg-video') || document.getElementById('bg-video');
        if (bgVid && !bgVid.paused) bgVid.pause();
    } catch (e) {}

    const cloakBtn = document.getElementById('cloak-btn');
    if (cloakBtn) {
        cloakBtn.style.display = 'none';
    }

    const frame = document.getElementById('game-frame');
    const stashFrame = document.getElementById('stash-frame');
    const emergencyBtn = document.getElementById('emergency-open-btn');
    const emptyState = document.getElementById('empty-state');

    if (emptyState) emptyState.style.display = 'none';
    if (emergencyBtn) emergencyBtn.style.display = 'inline-flex';

    // Handle Game Stash loading with Preload support
    if (game && game.id === "ugs-stash") {
        if (frame) frame.style.setProperty('display', 'none', 'important');
        updateGameStatusUI('loading');
        if (!options.suppressHostLoader) beginHostLoader(document);
        const stashLoaded = await ensureStashPreloaded();
        completeHostLoader();
        if (!stashLoaded) {
            if (stashFrame) showGameLoadError(game, stashFrame);
            return;
        }
        stashFrame.style.setProperty('display', 'block', 'important');
        stashFrame.style.setProperty('visibility', 'visible', 'important');
        stashFrame.style.opacity = '1';
        updateGameStatusUI('loaded');
        return;
    }

    // Keep the preloaded Stash available while other games use the main frame.
    if (stashFrame) stashFrame.style.setProperty('display', 'none', 'important');
    if (frame) {
        requestCurrentGameAutosave();
        releaseIframe(frame);
        activeGameLaunch = {
            game,
            gameId: String(game.id),
            loadToken: requestedLoadToken,
            url: resolvedGameUrl,
            injected: false,
            directFallbackTried: false,
            bootstrapHtml: null
        };
        frame.style.setProperty('display', 'block', 'important');
        frame.style.setProperty('visibility', 'hidden', 'important');
        frame.style.opacity = '0';
        frame.style.transition = 'opacity 0.25s ease';
        frame.removeAttribute('sandbox'); // Allow full storage & WebAssembly capabilities

        updateGameStatusUI('loading');
        if (!game.nexusSkipLoadingScreen) beginHostLoader(document);

        frame.onload = () => {
            completeHostLoader();
            updateGameStatusUI('loaded');
            frame.style.setProperty('visibility', 'visible', 'important');
            frame.style.opacity = '1';
            if (game.type !== 'file') {
                getGameSnapshot(game.id).then(snap => {
                    if (snap && frame.contentWindow) {
                        try {
                            frame.contentWindow.postMessage({
                                type: 'nexus-apply-game-restore',
                                gameId: game.id,
                                localStorage: snap.localStorage || {},
                                localStorageComplete: snap.localStorageComplete === true,
                                fsData: snap.fsData || null,
                                fsDataComplete: snap.fsDataComplete === true,
                                idbData: snap.idbData || null,
                                idbDataComplete: snap.idbDataComplete === true
                            }, '*');
                        } catch (e) {}
                    }
                });
            }
        };
        frame.onerror = () => { completeHostLoader(); showGameLoadError(game, frame); };

        if (game.type === 'file') {
            const base64Data = game.content.split(',')[1];
            let htmlContent;
            try { htmlContent = atob(base64Data); } catch(e) { nexusAlert("File corrupted."); return; }

            const isUnityRuntime = /(?:createUnityInstance|UnityLoader|unity-container|unity-canvas)/i.test(htmlContent);
            const snapshot = fileSnapshot;
            const unityCompatibility = isUnityRuntime
                ? `<script>(function(){var nativeAlert=window.alert;window.alert=function(message){var text=String(message||'');if(text.indexOf('timestamp.getTime is not a function')!==-1){console.warn('Ignored Unity IndexedDB timestamp warning.');return;}return nativeAlert.apply(this,arguments);};})();<\/script>`
                : '';
            const restoreScript = getGameRestoreScript(game.id, snapshot);
            const autosaveBridge = getUniversalAutosaveBridge(game.id);
            const persistenceScript = `<script>try{window.localStorage.setItem('p','1');}catch(e){}<\/script>`;
            const finalHTML = injectGameBootstrap(htmlContent, getGameLaunchDiagnostics(game.id, requestedLoadToken, { captureMrMineAssets: isMrMineGame(game) }) + unityCompatibility + restoreScript + persistenceScript + autosaveBridge);
            activeGameLaunch.injected = true;
            activeGameLaunch.fallbackHtml = htmlContent;
            activeGameLaunch.bootstrapHtml = finalHTML;

            try {
                const blob = new Blob([finalHTML], { type: 'text/html' });
                frame.removeAttribute('srcdoc');
                frame.src = URL.createObjectURL(blob);
            } catch (err1) {
                activeGameLaunch.injected = false;
                try {
                    frame.srcdoc = finalHTML;
                } catch (err2) {
                    frame.src = game.content; 
                }
            }
        } else if (shouldInjectGamePersistence(game, resolvedGameUrl)) {
            try {
                const snapshot = await getGameSnapshot(game.id);
                if (requestedLoadToken !== gameLoadToken) return;

                const persistenceBootstrap = getGameLaunchDiagnostics(game.id, requestedLoadToken, { captureMrMineAssets: isMrMineGame(game) }) + getGamePersistenceBootstrap(game.id, snapshot);
                const gameHtml = await fetchExternalGameHtml(
                    resolvedGameUrl,
                    persistenceBootstrap,
                    {
                        disableServiceWorker: isTagC3Game(game),
                        disableRemotePokiSdk: isTagC3Game(game),
                        adaptYouTubePlayable: isCrossyRoadGame(game),
                        preferLocalCache: new URL(resolvedGameUrl, window.location.href).origin === window.location.origin
                    }
                );
                if (requestedLoadToken !== gameLoadToken) return;

                activeGameLaunch.injected = true;
                activeGameLaunch.bootstrapHtml = gameHtml;
                frame.removeAttribute('src');
                frame.srcdoc = gameHtml;
            } catch (error) {
                // Save injection is best-effort for a source that cannot be
                // fetched (for example, an offline uncached custom URL).
                // Preserve the old direct launch path rather than preventing
                // the game from opening.
                console.warn('Game persistence bootstrap failed; trying direct load.', error);
                frame.removeAttribute('srcdoc');
                frame.src = resolvedGameUrl;
            }
        } else {
            frame.removeAttribute('srcdoc');
            if (game.url.endsWith('.pdf')) frame.removeAttribute('sandbox');
            frame.src = resolvedGameUrl;
        }
    }

}

const emgBtn = document.getElementById('emergency-open-btn');
if (emgBtn) {
    emgBtn.onclick = () => {
        if (!currentGame) return;
        const win = window.open();
        if (!win) return nexusAlert("Allow popups for emergency open!");
        if (currentGame.type === 'file') win.document.write(atob(currentGame.content.split(',')[1]));
        else win.location.href = currentGame.url;
    };
}

const addGameBtn = document.getElementById('add-game-btn');
if (addGameBtn) {
    addGameBtn.onclick = () => {
        // If in URL mode, the carmeow.html handler manages everything — skip here.
        if (typeof _customMode !== 'undefined' && _customMode === 'url') return;
        const title = document.getElementById('new-game-title').value;
        const file = document.getElementById('new-game-file').files[0];
        if (!title || !file) return nexusAlert("Missing data");
        const reader = new FileReader();
        reader.onload = async e => {
            const newG = { id: 'custom_' + Date.now(), title, type: 'file', content: e.target.result };
            const tx = db.transaction("customGames", "readwrite");
            tx.objectStore("customGames").put(newG);
            games.push(newG);
            saveGameOrder();
            renderGameList();
        };
        reader.readAsDataURL(file);
    };
}

async function deleteGame(id, index) {
    // Instantly remove — no confirmation dialog
    const currentIndex = games.findIndex(game => game.id === id);
    if (currentIndex === -1) return;
    const game = games[currentIndex];

    // Free memory: if this game was loaded, clear the frame and drop the reference
    if (currentGame && currentGame.id === id) {
        const frame = document.getElementById('game-frame');
        if (frame) {
            // Revoke any blob URL we may have set as the src
            try {
                if (frame.src && frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
            } catch(e) {}
            frame.removeAttribute('src');
            frame.removeAttribute('srcdoc');
        }
        currentGame = null;
    }

    // Drop the base64 content from memory if it's a file game
    if (game && game.content) game.content = null;

    const tx = db.transaction("customGames", "readwrite");
    tx.objectStore("customGames").delete(id);
    await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
    games.splice(currentIndex, 1);
    saveGameOrder();
    renderGameList();
    notifyStashBookmarkAvailability();
    queueStashSidebarPopularitySync();
    // Auto-navigate back to Game Stash after deletion
    const stash = games.find(g => g.id === "ugs-stash");
    if (stash) loadGame(stash);
}

async function removeSidebarGamesFromSaveManager(gameIds) {
    const selectedIds = new Set((gameIds || []).map(String));
    if (selectedIds.size === 0) return [];

    const removedGames = games.filter(game => game && selectedIds.has(String(game.id)));
    if (!removedGames.length) return [];

    await initDB();
    const hiddenGameIds = getHiddenSidebarGameIds();
    removedGames.forEach(game => hiddenGameIds.add(String(game.id)));
    writeHiddenSidebarGameIds(hiddenGameIds);

    try {
        const tx = db.transaction('customGames', 'readwrite');
        const store = tx.objectStore('customGames');
        removedGames.forEach(game => store.delete(game.id));
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Could not remove selected games from the sidebar.'));
            tx.onabort = () => reject(tx.error || new Error('Could not remove selected games from the sidebar.'));
        });
    } catch (error) {
        console.warn('A removed sidebar game could not be erased from its custom game record.', error);
    }

    const removedCurrentGame = currentGame && selectedIds.has(String(currentGame.id));
    if (removedCurrentGame) {
        gameLoadToken += 1;
        const frame = document.getElementById('game-frame');
        if (frame) {
            try {
                if (frame.src && frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
            } catch (error) {}
            frame.removeAttribute('src');
            frame.removeAttribute('srcdoc');
        }
        currentGame = null;
    }

    removedGames.forEach(game => {
        if (game.content) game.content = null;
    });
    games = games.filter(game => !selectedIds.has(String(game.id)));
    saveGameOrder();
    renderGameList();
    notifyStashBookmarkAvailability();
    queueStashSidebarPopularitySync();

    if (removedCurrentGame) {
        const fallbackGame = games.find(game => game.id === 'ugs-stash') || games[0];
        if (fallbackGame) loadGame(fallbackGame, true);
    }

    return removedGames;
}

let renameTargetId = null;

function buildRenameSwatches(game) {
    const container = document.getElementById('rename-color-swatches');
    if (!container) return;
    container.innerHTML = '';

    // Reset button — black circle with a red slash
    const resetBtn = document.createElement('button');
    resetBtn.className = 'color-swatch-btn color-swatch-reset';
    resetBtn.title = 'Default color';
    if (!game.sidebarColor) resetBtn.classList.add('color-swatch-active');
    resetBtn.onclick = () => setGameColor(game.id, null);
    container.appendChild(resetBtn);

    // 9 color swatches
    const isLight = document.documentElement.classList.contains('light-mode');
    SIDEBAR_COLOR_SCHEMES.forEach((scheme) => {
        const variant = isLight ? scheme.light : scheme.dark;
        const btn = document.createElement('button');
        btn.className = 'color-swatch-btn';
        btn.dataset.colorId = scheme.id;
        btn.title = scheme.id.charAt(0).toUpperCase() + scheme.id.slice(1);
        btn.style.background = variant.swatch;
        btn.style.setProperty('--swatch-border', variant.border);
        if (game.sidebarColor === scheme.id) btn.classList.add('color-swatch-active');
        btn.onclick = () => setGameColor(game.id, scheme.id);
        container.appendChild(btn);
    });
}

function refreshSwatchActiveState(activeColorId) {
    const container = document.getElementById('rename-color-swatches');
    if (!container) return;
    container.querySelectorAll('.color-swatch-btn').forEach(btn => {
        const isReset = btn.classList.contains('color-swatch-reset');
        btn.classList.toggle('color-swatch-active',
            isReset ? (activeColorId === null || activeColorId === undefined)
                     : btn.dataset.colorId === activeColorId
        );
    });
}

function openRenamePrompt(game) {
    const overlay = document.getElementById('rename-overlay');
    const input = document.getElementById('rename-app-title');
    if (!overlay || !input) return;

    if (!overlay.dataset.outsideDismissBound) {
        overlay.addEventListener('nexus:backdrop-dismiss', (event) => {
            event.preventDefault();
            closeRenamePrompt();
        });
        overlay.dataset.outsideDismissBound = 'true';
    }

    renameTargetId = game.id;
    input.value = game.title;
    buildRenameSwatches(game);
    overlay.style.display = 'flex';
    if (window.setGamePopupState) window.setGamePopupState('rename-overlay', true);
    setTimeout(() => {
        input.focus();
        input.select();
    }, 0);
}

function closeRenamePrompt() {
    const overlay = document.getElementById('rename-overlay');
    const input = document.getElementById('rename-app-title');
    if (overlay) overlay.style.display = 'none';
    if (input) input.value = '';
    renameTargetId = null;
    if (window.setGamePopupState) window.setGamePopupState('rename-overlay', false);
}

async function renameGame() {
    const input = document.getElementById('rename-app-title');
    const title = input ? input.value.trim() : '';
    if (!renameTargetId || !title) return;

    const game = games.find(g => g.id === renameTargetId);
    if (!game || !isUserManagedGame(game)) return closeRenamePrompt();

    game.title = title;
    game.userRenamed = true;
    await saveGameRecord(game);

    closeRenamePrompt();
    renderGameList();
    notifyStashBookmarkAvailability();
}

const renameDoneBtn = document.getElementById('rename-done-btn');
if (renameDoneBtn) {
    renameDoneBtn.onclick = renameGame;
    renameDoneBtn.addEventListener('rename-cancel', closeRenamePrompt);
}

const renameInput = document.getElementById('rename-app-title');
if (renameInput) {
    renameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') renameGame();
        if (e.key === 'Escape') closeRenamePrompt();
    });
}

document.addEventListener('keydown', (e) => {
    const overlay = document.getElementById('rename-overlay');
    if (!overlay || overlay.style.display !== 'flex') return;

    if (e.key === 'Escape') {
        e.preventDefault();
        closeRenamePrompt();
    }

    if (e.key === 'Enter') {
        e.preventDefault();
        renameGame();
    }
});

// Keep the main Nexus tab available after opening fullscreen or proxy windows.
function killMainTab() {
    return false;
}

function applyPopupMuteState(muted) {
    const frame = document.getElementById('game-frame');
    if (!frame) return;

    try {
        const frameDoc = frame.contentDocument || (frame.contentWindow && frame.contentWindow.document);
        if (!frameDoc) return;

        frameDoc.querySelectorAll('audio, video').forEach(media => {
            if (muted) {
                if (!media.dataset.tbPopupPrevMuted) media.dataset.tbPopupPrevMuted = media.muted ? "1" : "0";
                media.muted = true;
            } else if (media.dataset.tbPopupPrevMuted) {
                media.muted = media.dataset.tbPopupPrevMuted === "1";
                delete media.dataset.tbPopupPrevMuted;
            }
        });
    } catch (err) {
        // Cross-origin games cannot be muted from the parent page.
    }
}

window.setGamePopupState = function setGamePopupState(sourceId, isOpen) {
    if (!sourceId) return;
    if (isOpen) popupMuteSources.add(sourceId);
    else popupMuteSources.delete(sourceId);
    applyPopupMuteState(popupMuteSources.size > 0);
};

const cloakBtn = document.getElementById('cloak-btn');
if (cloakBtn) {
    cloakBtn.onclick = () => {
        if (!currentGame) return nexusAlert("Select game");
        // Block fullscreen for Game Stash — flash icon red and fade back
        if (currentGame.id === "ugs-stash") {
            const icon = cloakBtn.querySelector('img');
            if (icon) {
                icon.style.transition = 'filter 0.2s ease';
                icon.style.filter = 'brightness(0) saturate(100%) invert(18%) sepia(97%) saturate(7359%) hue-rotate(359deg) brightness(96%) contrast(114%)';
                setTimeout(() => {
                    icon.style.filter = '';
                }, 400);
            }
            return;
        }
        launchGameFullscreen(currentGame);
        killMainTab();
        // Navigate main tab back to Game Stash
        const stash = games.find(g => g.id === "ugs-stash");
        if (stash) loadGame(stash, true);
    };
}

const healthBtn = document.getElementById('game-health-btn');
if (healthBtn) {
    healthBtn.onclick = async () => {
        const game = currentGame && currentGame.id !== 'ugs-stash' ? currentGame : games.find(item => item.id !== 'ugs-stash');
        if (!game) return nexusAlert('No custom game is available to check.');
        let record = game;
        if (!record.content && game.type === 'file') {
            await initDB();
            record = await new Promise(resolve => {
                const req = db.transaction('customGames', 'readonly').objectStore('customGames').get(game.id);
                req.onsuccess = () => resolve(req.result || game);
                req.onerror = () => resolve(game);
            });
        }
        const html = record.content ? atob(record.content.split(',')[1] || '') : '';
        const checks = [
            ['File data', !!html.length],
            ['HTML structure', /<html|<body/i.test(html)],
            ['External assets', /https?:\/\//i.test(html)],
            ['WebGL/WASM runtime', /unity|wasm|webgl/i.test(html)],
            ['Saved snapshot', !!(await getGameSnapshot(game.id))]
        ];
        const report = checks.map(([label, ok]) => `${ok ? '✓' : '⚠'} ${label}`).join('\n');
        nexusAlert(`${game.title || game.id}\n\n${report}`);
    };
}

function deleteGameIndexedDatabase(databaseName) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`The game database “${databaseName}” is still open. Close its other game tab or window, then try clearing the save again.`));
        }, 10000);
        const finish = error => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timeout);
            if (error) reject(error);
            else resolve();
        };
        try {
            const request = window.indexedDB.deleteDatabase(databaseName);
            request.onsuccess = () => finish();
            request.onerror = () => finish(request.error || new Error(`Could not remove the game database “${databaseName}”.`));
            // A tracked game connection closes on versionchange. Keep waiting
            // briefly for that close instead of treating `blocked` as success.
            request.onblocked = () => {};
        } catch (error) {
            finish(error);
        }
    });
}

async function clearGameSaves(gameIds) {
    if (!gameIds || gameIds.length === 0) return;
    await initDB();

    const selectedGames = [];
    const allAliases = new Set();
    gameIds.forEach(id => {
        const sId = String(id);
        allAliases.add(sId);
        const matched = findGameByIdOrSource(id);
        if (matched) {
            selectedGames.push(matched);
            getSaveManagerGameAliases(matched).forEach(alias => allAliases.add(alias));
            if (matched.id) allAliases.add(String(matched.id));
            if (matched.sourceKey) allAliases.add(String(matched.sourceKey));
            if (matched.sourceFile) {
                allAliases.add(String(matched.sourceFile));
                allAliases.add(String(matched.sourceFile.replace(/\.html$/, '')));
                const sfName = String(matched.sourceFile).split('/').pop();
                if (sfName && isSaveManagerSourceLeafUnique(matched)) {
                    allAliases.add(sfName);
                    allAliases.add(sfName.replace(/\.html$/, ''));
                }
            }
            if (matched.title && isSaveManagerTitleUnique(matched)) {
                allAliases.add(String(matched.title).toLowerCase());
                allAliases.add(String(matched.title).toLowerCase().replace(/[^a-z0-9]/g, ''));
            }
            if (matched.sourceKey) {
                allAliases.add('bookmark_' + matched.sourceKey);
                allAliases.add('bookmark_' + encodeURIComponent(matched.sourceKey));
            }
        }
    });

    const matchesSelectedGameId = gameId => {
        const id = String(gameId || '');
        return Array.from(allAliases).some(alias => String(alias).toLowerCase() === id.toLowerCase()) ||
            selectedGames.some(game => doesSnapshotBelongToGame({ gameId: id }, game));
    };

    // 1. Keep the controls available for a later safe disarm/wipe.
    const disarmMsg = { type: 'nexus-disarm-autosave' };
    const wipeMsg = { type: 'nexus-wipe-game-storage' };
    const frame = document.getElementById('game-frame');

    // 2. Discover all snapshots in gameSnapshots belonging to these games
    const keysToRemoveFromLS = new Set();
    const keysUsedByOtherSaves = new Set();
    const idbDatabasesToWipe = new Set();
    const idbDatabasesUsedByOtherSaves = new Set();

    // Check specific known game candidates
    const isBalatro = Array.from(allAliases).some(id => String(id).toLowerCase().includes('balatro')) || selectedGames.some(g => {
        const str = ((g.id || '') + ' ' + (g.title || '') + ' ' + (g.sourceFile || '')).toLowerCase();
        return str.includes('balatro');
    });
    if (isBalatro) {
        idbDatabasesToWipe.add('/home/web_user/love');
    }

    const snapshotsToDelete = [];
    const metadataIds = new Set();
    const metadataDatabaseNamesById = new Map();
    let hasUnreadableLegacySnapshot = false;
    let hasUnreadableSnapshotData = false;
    const collectDatabaseNames = snap => new Set([
        ...(Array.isArray(snap && snap.indexedDBNames) ? snap.indexedDBNames : []),
        ...(snap && snap.idbData && typeof snap.idbData === 'object' ? Object.keys(snap.idbData) : [])
    ].map(String).filter(name => name && !NEXUS_SHARED_DATABASE_NAMES.has(name)));

    // Ownership metadata is small and can be read without deserializing saves.
    await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction(NEXUS_GAME_SNAPSHOT_META_STORE, 'readonly');
            const req = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE).openCursor();
            req.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return resolve();
                const gameId = String(cursor.primaryKey || cursor.key || '');
                metadataIds.add(gameId.toLowerCase());
                const names = collectDatabaseNames(cursor.value);
                metadataDatabaseNamesById.set(gameId.toLowerCase(), names);
                if (matchesSelectedGameId(gameId)) {
                    snapshotsToDelete.push(cursor.key);
                    names.forEach(name => idbDatabasesToWipe.add(name));
                } else {
                    names.forEach(name => idbDatabasesUsedByOtherSaves.add(name));
                }
                cursor.continue();
            };
            req.onerror = () => reject(req.error || tx.error || new Error('Could not find the selected game storage.'));
            tx.onabort = () => reject(tx.error || new Error('Could not find the selected game storage.'));
        } catch (error) {
            reject(error);
        }
    });

    // Key cursors let us remove a legacy snapshot even if its large value cannot
    // be cloned. Read only legacy records and selected records, one at a time.
    await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction('gameSnapshots', 'readonly');
            const store = tx.objectStore('gameSnapshots');
            const req = store.openKeyCursor();
            req.onsuccess = event => {
                const cursor = event.target.result;
                if (!cursor) return resolve();
                const gameId = String(cursor.primaryKey || cursor.key || '');
                const matches = matchesSelectedGameId(gameId);
                const hasMetadata = metadataIds.has(gameId.toLowerCase());
                const metadataNames = metadataDatabaseNamesById.get(gameId.toLowerCase()) || new Set();
                const valueReq = store.get(cursor.primaryKey);
                valueReq.onsuccess = () => {
                    const snap = valueReq.result || {};
                    const snapshotMatches = matches || selectedGames.some(game => doesSnapshotBelongToGame(snap, game));
                    const names = collectDatabaseNames(snap);
                    if (snapshotMatches) {
                        if (!snapshotsToDelete.some(key => String(key) === String(cursor.primaryKey))) snapshotsToDelete.push(cursor.primaryKey);
                        if (snap.localStorage && typeof snap.localStorage === 'object') {
                            Object.keys(snap.localStorage).forEach(key => {
                                if (key && !key.startsWith('tb_') && !NEXUS_APP_LOCAL_STORAGE_KEYS.has(key)) keysToRemoveFromLS.add(key);
                            });
                        }
                        names.forEach(name => idbDatabasesToWipe.add(name));
                    } else {
                        if (snap.localStorage && typeof snap.localStorage === 'object') {
                            Object.keys(snap.localStorage).forEach(key => {
                                if (key && !key.startsWith('tb_') && !NEXUS_APP_LOCAL_STORAGE_KEYS.has(key)) keysUsedByOtherSaves.add(key);
                            });
                        }
                        names.forEach(name => idbDatabasesUsedByOtherSaves.add(name));
                    }
                    cursor.continue();
                };
                valueReq.onerror = errorEvent => {
                    errorEvent.preventDefault();
                    hasUnreadableSnapshotData = true;
                    if (matches && !snapshotsToDelete.some(key => String(key) === String(cursor.primaryKey))) {
                        snapshotsToDelete.push(cursor.primaryKey);
                    }
                    if (!hasMetadata || metadataNames.size === 0) hasUnreadableLegacySnapshot = true;
                    cursor.continue();
                };
            };
            req.onerror = () => reject(req.error || tx.error || new Error('Could not find the selected game storage.'));
            tx.onabort = () => reject(tx.error || new Error('Could not find the selected game storage.'));
        } catch (error) {
            reject(error);
        }
    });

    // A key can back multiple games in the shared origin localStorage. Keep it
    // while any other save still contains that key; when the final owner is
    // cleared, the key becomes reclaimable.
    keysUsedByOtherSaves.forEach(key => keysToRemoveFromLS.delete(key));
    // If another large snapshot cannot be read, its key ownership is unknown.
    // Preserve localStorage entries in that case while still clearing snapshots
    // whose ownership is known.
    if (hasUnreadableSnapshotData) keysToRemoveFromLS.clear();
    wipeMsg.preserveKeys = Array.from(keysUsedByOtherSaves);
    wipeMsg.clearKeys = Array.from(keysToRemoveFromLS);

    // A shared database stays intact while any other saved game still claims it.
    idbDatabasesUsedByOtherSaves.forEach(name => idbDatabasesToWipe.delete(name));
    // If a legacy save cannot be read, its database ownership is unknown. Keep
    // both the database and its ownership record so a later clear can retry.
    // Also avoid disarming or wiping the active game when no cleanup is safe.
    if (hasUnreadableLegacySnapshot) {
        return { nativeDatabasesRetained: true, savesRetained: true };
    }

    // Disarm selected game contexts only after ownership checks succeed. This
    // prevents an autosave racing with deletion, while leaving games untouched
    // when the operation must abort or preserve uncertain data.
    if (frame && frame.contentWindow && currentGame && matchesSelectedGameId(currentGame.id)) {
        try { frame.contentWindow.postMessage(disarmMsg, '*'); } catch (error) {}
    }
    activeGameSessions.forEach(session => {
        if (session.win && !session.win.closed && matchesSelectedGameId(session.gameId)) {
            try { session.win.postMessage(disarmMsg, '*'); } catch (error) {}
        }
    });
    await new Promise(resolve => setTimeout(resolve, 60));

    const reloadSelectedGamesAfterFailedClear = () => {
        if (frame && currentGame && matchesSelectedGameId(currentGame.id)) {
            try { loadGame(currentGame, true); } catch (error) {}
        }
        activeGameSessions.forEach(session => {
            if (session.win && !session.win.closed && matchesSelectedGameId(session.gameId)) {
                try { session.win.location.reload(); } catch (error) {}
            }
        });
    };

    // Delete known game databases before removing their ownership records. If
    // an open game tab blocks deletion, keep the snapshot so the user can retry.
    try {
        for (const dbName of idbDatabasesToWipe) {
            await deleteGameIndexedDatabase(dbName);
        }
        if (idbDatabasesToWipe.size && typeof window.indexedDB.databases === 'function') {
            try {
                const remainingDatabases = await window.indexedDB.databases();
                const remainingNames = new Set((remainingDatabases || []).map(database => String(database && database.name || '')));
                const remainingOwned = Array.from(idbDatabasesToWipe).filter(name => remainingNames.has(name));
                if (remainingOwned.length) {
                    throw new Error(`Could not verify removal of ${remainingOwned.map(name => `“${name}”`).join(', ')}. Its save records were kept so no data is lost.`);
                }
            } catch (error) {
                if (/Could not verify removal/.test(String(error && error.message || error))) throw error;
                console.warn('The browser could not enumerate databases after deletion; successful delete requests were accepted.', error);
            }
        }
    } catch (error) {
        reloadSelectedGamesAfterFailedClear();
        throw error;
    }

    // 3. Delete all matching snapshots only after their game databases are gone.
    try {
        await new Promise((resolve, reject) => {
            try {
                const tx = db.transaction(['gameSnapshots', NEXUS_GAME_SNAPSHOT_META_STORE], 'readwrite');
                const store = tx.objectStore('gameSnapshots');
                const metaStore = tx.objectStore(NEXUS_GAME_SNAPSHOT_META_STORE);
                snapshotsToDelete.forEach(k => {
                    store.delete(k);
                    metaStore.delete(k);
                });
                allAliases.forEach(alias => {
                    store.delete(alias);
                    metaStore.delete(alias);
                });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error || new Error('Could not remove the selected game snapshots.'));
                tx.onabort = () => reject(tx.error || new Error('Could not remove the selected game snapshots.'));
            } catch (error) {
                reject(error);
            }
        });
    } catch (error) {
        reloadSelectedGamesAfterFailedClear();
        throw error;
    }

    // 4. Clear in-memory caches and hashes
    allAliases.forEach(alias => {
        snapshotHashes.delete(alias);
    });
    // 5. Clean localStorage
    try {
        const ls = window.nexusStorage || window.localStorage;
        allAliases.forEach(alias => {
            ls.removeItem(`tb_nexus_game_autosave:${encodeURIComponent(alias)}`);
            ls.removeItem(`tb_snap_${alias}`);
            ls.removeItem(`nexus_save_${alias}`);
            ls.removeItem(`save_${alias}`);
        });
        // Remove journals written under historical aliases too. They can hold a
        // full duplicate of the game save even when its IndexedDB snapshot was
        // already removed.
        for (let index = ls.length - 1; index >= 0; index--) {
            const key = ls.key(index);
            if (!key || !key.startsWith('tb_nexus_game_autosave:')) continue;
            let journalGameId = key.slice('tb_nexus_game_autosave:'.length);
            try { journalGameId = decodeURIComponent(journalGameId); } catch (error) {}
            if (matchesSelectedGameId(journalGameId)) ls.removeItem(key);
        }
        keysToRemoveFromLS.forEach(k => {
            if (k && !k.startsWith('tb_') && !NEXUS_APP_LOCAL_STORAGE_KEYS.has(k)) ls.removeItem(k);
        });
    } catch (e) {}

    // 6. If currently loaded game in main frame was cleared, wipe iframe local storage and reload fresh
    const isCurrentGameCleared = currentGame && matchesSelectedGameId(currentGame.id);

    if (isCurrentGameCleared && frame) {
        try {
            if (!hasUnreadableSnapshotData && frame.contentWindow) {
                frame.contentWindow.postMessage(wipeMsg, '*');
                await new Promise(resolve => setTimeout(resolve, 60));
            }
            if (!hasUnreadableSnapshotData && frame.contentWindow && frame.contentWindow.localStorage) {
                const subLs = frame.contentWindow.localStorage;
                const toDel = [];
                for (let i = 0; i < subLs.length; i++) {
                    const k = subLs.key(i);
                    if (k && keysToRemoveFromLS.has(k) && !keysUsedByOtherSaves.has(k)) toDel.push(k);
                }
                toDel.forEach(k => subLs.removeItem(k));
            }
        } catch (e) {}
        loadGame(currentGame, true);
    }

    // 7. If any popup is open for a cleared game, reload it
    for (const session of activeGameSessions.values()) {
        const win = session.win;
        const gameId = session.gameId;
        if (win && !win.closed && matchesSelectedGameId(gameId)) {
            try {
                if (!hasUnreadableSnapshotData) {
                    win.postMessage(wipeMsg, '*');
                    await new Promise(resolve => setTimeout(resolve, 60));
                }
                if (!hasUnreadableSnapshotData && win.localStorage) {
                    const subLs = win.localStorage;
                    const toDel = [];
                    for (let i = 0; i < subLs.length; i++) {
                        const k = subLs.key(i);
                        if (k && keysToRemoveFromLS.has(k) && !keysUsedByOtherSaves.has(k)) toDel.push(k);
                    }
                    toDel.forEach(k => subLs.removeItem(k));
                }
            } catch (e) {}
            try {
                win.location.reload();
            } catch (e) {}
        }
    }
    return {
        nativeDatabasesRetained: false,
        localStorageRetained: hasUnreadableSnapshotData
    };
}

let saveManagerSizeToken = 0;

function setSaveManagerSizeLabel(element, estimate) {
    const details = estimate && typeof estimate === 'object' ? estimate : { bytes: estimate, unknownDatabaseCount: 0, gameDatabaseCount: 0 };
    const bytes = details.bytes === null || details.bytes === undefined ? null : Number(details.bytes);
    const unknownDatabaseCount = Math.max(0, Number(details.unknownDatabaseCount) || 0);
    if (bytes === null || !Number.isFinite(bytes)) {
        element.textContent = 'Size unavailable';
        element.title = 'The saved snapshot or its size could not be estimated.';
        return;
    }
    if (bytes <= 0 && unknownDatabaseCount === 0) {
        element.textContent = 'No save data';
        element.title = 'No saved data found';
        return;
    }
    const formattedSize = formatSavesStorageSize(bytes);
    element.textContent = `≈ ${formattedSize}${unknownDatabaseCount ? ' + unknown' : ''}`;
    element.title = `Approximate Nexus snapshot and game-owned IndexedDB size: ${formattedSize}.` +
        (unknownDatabaseCount ? ` ${unknownDatabaseCount} tracked game database(s) could not be measured.` : '') +
        ' Browser storage encoding adds overhead, and a database shared by games may be counted for each owner.';
}

function openSavesSelection(gameList, offSidebarGames = [], offSidebarReadError = null) {
    const overlay = document.getElementById('saves-select-overlay');
    const sidebarList = document.getElementById('saves-sidebar-games');
    const offSidebarList = document.getElementById('saves-off-sidebar-games');
    if (!overlay || !sidebarList || !offSidebarList) return Promise.resolve(null);
    sidebarList.innerHTML = '';
    offSidebarList.innerHTML = '';

    const sidebarItems = gameList || [];
    const offSidebarItems = offSidebarGames || [];
    const aliasesById = new Map();
    const refreshColumnToggle = column => {
        const button = column.querySelector('.saves-column-select-all');
        const toggles = Array.from(column.querySelectorAll('.saves-item-delete-toggle'));
        const allSelected = toggles.length > 0 && toggles.every(toggle => toggle.getAttribute('aria-checked') === 'true');
        if (button) {
            button.textContent = allSelected ? 'Deselect All' : 'Select All';
            button.disabled = toggles.length === 0;
        }
    };
    const setSelected = (toggle, selected) => {
        const isSelected = Boolean(selected);
        const row = toggle.closest('.saves-item-label');
        const gameTitle = toggle.dataset.gameTitle || 'game';
        toggle.setAttribute('aria-checked', String(isSelected));
        toggle.setAttribute('aria-label', isSelected
            ? `Remove ${gameTitle} from the delete selection`
            : `Select ${gameTitle} for deletion`);
        row?.classList.toggle('saves-selected', isSelected);
        const column = toggle.closest('.saves-game-column');
        if (column) refreshColumnToggle(column);
        const confirmButton = document.getElementById('saves-select-confirm');
        if (confirmButton) {
            confirmButton.disabled = !overlay.querySelector('.saves-item-delete-toggle[aria-checked="true"]');
        }
    };
    const appendItems = (container, items, emptyText) => {
        if (!items.length) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'saves-list-empty';
            emptyMsg.textContent = emptyText;
            container.appendChild(emptyMsg);
            return;
        }

        items.forEach(game => {
            const row = document.createElement('div');
            row.className = 'saves-item-label';

            const gameId = String(game.id);
            const gameTitle = (typeof getSidebarTitle === 'function' ? getSidebarTitle(game) : '') || game.title || game.id;
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'saves-item-delete-toggle';
            toggle.value = gameId;
            toggle.dataset.gameTitle = String(gameTitle);
            toggle.dataset.sidebarGame = String(!game.offSidebar);
            toggle.setAttribute('role', 'checkbox');
            toggle.setAttribute('aria-checked', 'false');
            toggle.setAttribute('aria-label', `Select ${gameTitle} for deletion`);

            const icon = document.createElement('img');
            icon.src = 'Assets/Delete.svg';
            icon.alt = '';
            icon.draggable = false;
            toggle.appendChild(icon);

            aliasesById.set(gameId, game.offSidebar
                ? (game.aliases || [game.id]).map(String)
                : [String(game.id)]);

            const text = document.createElement('span');
            text.className = 'saves-item-text';
            text.textContent = gameTitle;

            const size = document.createElement('span');
            size.className = 'saves-item-size';
            size.dataset.gameId = gameId;
            size.textContent = 'Calculating…';

            toggle.addEventListener('click', () => {
                setSelected(toggle, toggle.getAttribute('aria-checked') !== 'true');
            });
            row.addEventListener('click', event => {
                if (event.target.closest('button')) return;
                setSelected(toggle, toggle.getAttribute('aria-checked') !== 'true');
            });
            row.append(text, size, toggle);
            container.appendChild(row);
        });
    };

    appendItems(sidebarList, sidebarItems, 'No games on the sidebar.');
    if (offSidebarReadError) {
        const errorMessage = document.createElement('div');
        errorMessage.className = 'saves-list-error';
        errorMessage.textContent = 'Saved games outside the sidebar could not be listed: ' + offSidebarReadError.message;
        offSidebarList.appendChild(errorMessage);
    } else {
        appendItems(offSidebarList, offSidebarItems, 'No saved games outside the sidebar.');
    }

    document.querySelectorAll('.saves-game-column').forEach(refreshColumnToggle);

    overlay.style.display = 'flex';
    updateSavesMeterDebugControls();
    updateSavesManagerStorageLock(savesStorageStatus.tier);
    setSavesMeterForeground(true);
    if (window.setGamePopupState) window.setGamePopupState('saves-select-overlay', true);

    if (!overlay.dataset.storageBackdropGuardBound) {
        overlay.addEventListener('nexus:backdrop-dismiss', event => {
            if (overlay.dataset.storageLocked === 'true') {
                event.preventDefault();
                event.stopImmediatePropagation();
            }
        });
        overlay.addEventListener('click', event => {
            if (event.target === overlay && overlay.dataset.storageLocked === 'true') {
                event.preventDefault();
                event.stopPropagation();
            }
        });
        overlay.dataset.storageBackdropGuardBound = 'true';
    }

    const sizeToken = ++saveManagerSizeToken;
    getSaveManagerSizeEstimates(sidebarItems, offSidebarItems).then(sizeEstimates => {
        if (sizeToken !== saveManagerSizeToken || overlay.style.display !== 'flex') return;
        overlay.querySelectorAll('.saves-item-size').forEach(element => {
            setSaveManagerSizeLabel(element, sizeEstimates.get(element.dataset.gameId));
        });
    }).catch(() => {
        if (sizeToken !== saveManagerSizeToken || overlay.style.display !== 'flex') return;
        overlay.querySelectorAll('.saves-item-size').forEach(element => setSaveManagerSizeLabel(element, null));
    });

    return new Promise(resolve => {
        const lockedKeyHandler = event => {
            if (overlay.style.display !== 'flex' || overlay.dataset.storageLocked !== 'true') return;
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                return;
            }
            if (event.key === 'Tab') {
                const focusable = Array.from(overlay.querySelectorAll('button:not([disabled]):not([hidden])'));
                if (!focusable.length) return;
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };
        document.addEventListener('keydown', lockedKeyHandler, true);
        const finish = value => {
            overlay.style.display = 'none';
            document.removeEventListener('keydown', lockedKeyHandler, true);
            saveManagerSizeToken += 1;
        updateSavesMeterDebugControls();
            setSavesMeterForeground(false);
            if (window.setGamePopupState) window.setGamePopupState('saves-select-overlay', false);
            resolve(value);
        };

        document.querySelectorAll('.saves-game-column').forEach(column => {
            const button = column.querySelector('.saves-column-select-all');
            if (!button) return;
            button.onclick = () => {
                const toggles = Array.from(column.querySelectorAll('.saves-item-delete-toggle'));
                const allSelected = toggles.length > 0 && toggles.every(toggle => toggle.getAttribute('aria-checked') === 'true');
                toggles.forEach(toggle => setSelected(toggle, !allSelected));
            };
        });

        const cancelBtn = document.getElementById('saves-select-cancel');
        if (cancelBtn) cancelBtn.onclick = () => {
            if (overlay.dataset.storageLocked === 'true') return;
            finish(null);
        };

        const confirmBtn = document.getElementById('saves-select-confirm');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.onclick = () => {
                const selectedToggles = Array.from(overlay.querySelectorAll('.saves-item-delete-toggle[aria-checked="true"]'));
                if (selectedToggles.length === 0) return;
                const selectedAliases = selectedToggles.flatMap(toggle => aliasesById.get(toggle.value) || [toggle.value]);
                const selectedSidebarIds = selectedToggles
                    .filter(toggle => toggle.dataset.sidebarGame === 'true')
                    .map(toggle => toggle.value);
                finish({
                    saveIds: Array.from(new Set(selectedAliases)),
                    sidebarGameIds: Array.from(new Set(selectedSidebarIds))
                });
            };
        }
        window.setTimeout(() => {
            const firstSelectable = overlay.querySelector('.saves-item-delete-toggle:not([disabled])');
            if (firstSelectable && overlay.dataset.storageLocked === 'true') firstSelectable.focus();
        }, 0);
    });
}

function showRedConfirmDialog(message, options = {}) {
    return new Promise((resolve) => {
        let overlay = document.getElementById('nexus-red-confirm-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'nexus-red-confirm-overlay';
            overlay.innerHTML = `
                <div class="red-confirm-box">
                    <div id="nexus-red-confirm-title">Warning</div>
                    <div id="nexus-red-confirm-msg"></div>
                    <div style="display:flex; gap:14px; justify-content:center; margin-top:8px;">
                        <button id="nexus-red-confirm-ok" class="red-dialog-ok-btn">OK</button>
                        <button id="nexus-red-confirm-cancel" class="red-dialog-cancel-btn">Cancel</button>
                    </div>
                </div>
            `;
            document.body.appendChild(overlay);
        }

        const msgEl = overlay.querySelector('#nexus-red-confirm-msg');
        const okBtn = overlay.querySelector('#nexus-red-confirm-ok');
        const cancelBtn = overlay.querySelector('#nexus-red-confirm-cancel');

        msgEl.textContent = message;
        cancelBtn.classList.toggle('green-game-cancel-btn', options.greenCancel === true);
        overlay.style.display = 'flex';
        setTimeout(() => okBtn.focus(), 50);

        const cleanup = () => {
            overlay.style.display = 'none';
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            document.removeEventListener('keydown', keyHandler);
        };

        const confirm = () => {
            let result = true;
            if (typeof options.onConfirm === 'function') {
                try { result = options.onConfirm(); } catch (error) { result = null; }
            }
            cleanup();
            resolve(result);
        };

        const keyHandler = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                confirm();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cleanup();
                resolve(false);
            }
        };

        document.addEventListener('keydown', keyHandler);

        okBtn.onclick = (e) => {
            e.preventDefault();
            confirm();
        };

        cancelBtn.onclick = (e) => {
            e.preventDefault();
            cleanup();
            resolve(false);
        };
    });
}

let savesStorageEstimateRequest = 0;

const SAVES_STORAGE_YELLOW_AT = 70;
const SAVES_STORAGE_ORANGE_AT = 85;
const SAVES_STORAGE_RED_AT = 95;
const SAVES_RED_CLEANUP_ACK_KEY = 'tb_nexus_red_storage_cleanup_acknowledged';
let savesStorageStatus = { tier: 'unknown', pressurePercent: null };
let savesOrangeWarningShown = false;
let savesRedWarningShown = false;
let savesStorageWarningOpen = false;
let savesManagerOpening = false;
let savesStorageDebugTier = null;
let savesRedCleanupAcknowledged = false;
let savesStorageLastFailure = null;

try { savesRedCleanupAcknowledged = window.sessionStorage.getItem(SAVES_RED_CLEANUP_ACK_KEY) === 'true'; } catch (error) {}
try {
    window.sessionStorage.removeItem('tb_nexus_save_quota_failure_v2');
    window.sessionStorage.removeItem('tb_nexus_save_quota_failure');
} catch (error) {}

function acknowledgeRedStorageCleanup() {
    savesRedCleanupAcknowledged = true;
    savesRedWarningShown = true;
    try { window.sessionStorage.setItem(SAVES_RED_CLEANUP_ACK_KEY, 'true'); } catch (error) {}
}

function resetRedStorageCleanupAcknowledgement() {
    savesRedCleanupAcknowledged = false;
    savesRedWarningShown = false;
    try { window.sessionStorage.removeItem(SAVES_RED_CLEANUP_ACK_KEY); } catch (error) {}
}

function formatSavesStorageSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let unitIndex = 0;
    while (amount >= 1000 && unitIndex < units.length - 1) {
        amount /= 1000;
        unitIndex += 1;
    }
    const digits = unitIndex === 0 || amount >= 10 ? 0 : 1;
    return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatSavesStorageDetailSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'unavailable';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let amount = bytes;
    let unitIndex = 0;
    while (amount >= 1000 && unitIndex < units.length - 1) {
        amount /= 1000;
        unitIndex += 1;
    }
    return `${amount.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function updateSavesStorageMeterDescription() {
    const control = document.getElementById('saves-btn');
    if (!control) return;

    const status = savesStorageStatus;
    const sourceDescription = status.limitingStore === 'origin'
        ? 'the approximate whole-site browser storage quota' : 'an unavailable browser storage estimate';
    control.title = `The bar indicates pressure against ${sourceDescription}. localStorage and game database limits can differ.`;
    control.setAttribute('aria-label', `Open Save Manager. The bar indicates ${status.tier} pressure against ${sourceDescription}.`);
}

function readSavesDevModeFlag() {
    try {
        return (window.nexusStorage || window.localStorage).getItem('tb_dev_mode') === 'true';
    } catch (error) {
        return false;
    }
}

let savesDevModeActive = readSavesDevModeFlag();

function isSavesDevModeActive() {
    return savesDevModeActive;
}

function renderSavesStorageMeterStatus(status = savesStorageStatus) {
    const control = document.getElementById('saves-btn');
    const fill = document.getElementById('saves-storage-fill');
    if (!control || !fill) return;

    if (!Number.isFinite(status.pressurePercent)) {
        fill.style.width = '0%';
        fill.style.minWidth = '0';
    } else {
        const visiblePressure = Math.max(0, Math.min(100, status.pressurePercent));
        fill.style.width = `${visiblePressure}%`;
        fill.style.minWidth = '0';
    }
    control.dataset.storageTier = status.tier;
    control.dataset.storageSource = status.limitingStore || 'unknown';
    control.removeAttribute('data-storage-debug-tier');
    updateSavesManagerStorageLock(status.tier);
    updateSavesStorageMeterDescription();
    updateSavesStorageDevReadout(status);
}

let savesStorageDevReadout = null;

function updateSavesStorageDevReadout(status = savesStorageStatus) {
    const control = document.getElementById('saves-btn');
    const devModeActive = isSavesDevModeActive();
    if (!control || !devModeActive) {
        if (savesStorageDevReadout) savesStorageDevReadout.remove();
        savesStorageDevReadout = null;
        return;
    }

    if (!savesStorageDevReadout) {
        savesStorageDevReadout = document.createElement('span');
        savesStorageDevReadout.id = 'saves-storage-dev-readout';
        savesStorageDevReadout.className = 'saves-storage-dev-readout';
        savesStorageDevReadout.setAttribute('aria-hidden', 'true');
        control.appendChild(savesStorageDevReadout);
    }

    const used = Number(status && status.usage);
    const capacity = Number(status && status.quota);
    savesStorageDevReadout.textContent = Number.isFinite(used) && used >= 0 && Number.isFinite(capacity) && capacity > 0
        ? `${formatSavesStorageDetailSize(used)}/${formatSavesStorageDetailSize(capacity)} used`
        : 'unavailable/unavailable used';
    savesStorageDevReadout.title = 'Approximate use and quota for all browser-managed storage on this site origin. It is not a per-save or drive-capacity measurement.';
}

function applySavesStorageMeterDebugPreview() {
    if (!isSavesDevModeActive()) return;
    const control = document.getElementById('saves-btn');
    const fill = document.getElementById('saves-storage-fill');
    const previews = {
        white: { tier: 'normal', percent: 45 },
        yellow: { tier: 'yellow', percent: SAVES_STORAGE_YELLOW_AT },
        orange: { tier: 'orange', percent: SAVES_STORAGE_ORANGE_AT },
        red: { tier: 'red', percent: SAVES_STORAGE_RED_AT }
    };
    const preview = previews[savesStorageDebugTier];
    if (!control || !fill || !preview) return;

    control.dataset.storageTier = preview.tier;
    control.dataset.storageDebugTier = savesStorageDebugTier;
    fill.style.width = `${preview.percent}%`;
    fill.style.minWidth = '0';
}

let savesMeterDebugClickHandler = null;

function updateSavesMeterDebugControls() {
    const overlay = document.getElementById('saves-select-overlay');
    const controls = document.getElementById('saves-meter-debug-controls');
    if (!overlay || !controls) return;

    const devModeActive = isSavesDevModeActive();
    const isVisible = overlay.style.display === 'flex' && devModeActive;
    controls.hidden = !isVisible;
    controls.querySelectorAll('[data-saves-debug-tier]').forEach(button => {
        button.disabled = !devModeActive;
    });

    if (isVisible && !savesMeterDebugClickHandler) {
        savesMeterDebugClickHandler = event => {
            const button = event.target.closest('[data-saves-debug-tier]');
            if (!button || controls.hidden) return;
            savesStorageDebugTier = button.dataset.savesDebugTier;
            controls.querySelectorAll('[data-saves-debug-tier]').forEach(item => {
                item.setAttribute('aria-pressed', String(item === button));
            });
            applySavesStorageMeterDebugPreview();
        };
        controls.addEventListener('click', savesMeterDebugClickHandler);
    } else if (!isVisible && savesMeterDebugClickHandler) {
        controls.removeEventListener('click', savesMeterDebugClickHandler);
        savesMeterDebugClickHandler = null;
    }

    if (!isVisible) {
        if (savesStorageDebugTier !== null) {
            savesStorageDebugTier = null;
            controls.querySelectorAll('[data-saves-debug-tier]').forEach(item => item.setAttribute('aria-pressed', 'false'));
            renderSavesStorageMeterStatus();
        }
        return;
    }

    if (savesStorageDebugTier !== null) applySavesStorageMeterDebugPreview();
}

window.addEventListener('storage', event => {
    if (event.key && event.key !== 'tb_dev_mode') return;
    savesDevModeActive = event.key === null ? false : event.newValue === 'true';
    updateSavesMeterDebugControls();
    updateSavesStorageDevReadout();
});

function isStorageQuotaError(error) {
    return Boolean(error && (
        error.name === 'QuotaExceededError' ||
        error.code === 22 ||
        error.code === 1014 ||
        /quota exceeded|storage full|disk full/i.test(String(error.message || ''))
    ));
}

function handleSavesStorageQuotaFailure(storageType, gameId = '') {
    savesStorageLastFailure = {
        storageType,
        gameId: String(gameId || ''),
        failedAt: Date.now()
    };
    console.warn('A game storage write was rejected.', savesStorageLastFailure);
    refreshSavesStorageMeter();
}

function updateSavesManagerStorageLock() {
    const overlay = document.getElementById('saves-select-overlay');
    if (!overlay || overlay.style.display !== 'flex') return;
    overlay.dataset.storageLocked = 'false';
    const cancelButton = document.getElementById('saves-select-cancel');
    if (cancelButton) {
        cancelButton.hidden = false;
        cancelButton.disabled = false;
    }
}

function showSavesStorageWarning(tier, failedStorageType = '') {
    const warningOverlay = document.getElementById('saves-storage-warning-overlay');
    const title = document.getElementById('saves-storage-warning-title');
    const message = document.getElementById('saves-storage-warning-message');
    const okButton = document.getElementById('saves-storage-warning-ok');
    const notNowButton = document.getElementById('saves-storage-warning-not-now');
    const continueButton = document.getElementById('saves-storage-warning-continue');
    if (!warningOverlay || !title || !message || !okButton || !notNowButton || !continueButton) return;

    const isRed = tier === 'red' && !failedStorageType;
    if (isRed && savesRedCleanupAcknowledged) {
        savesRedWarningShown = true;
        return Promise.resolve(true);
    }
    if (savesStorageWarningOpen) {
        return Promise.resolve(true);
    }
    if (isRed) savesRedWarningShown = true;
    else savesOrangeWarningShown = true;

    if (failedStorageType) {
        title.textContent = 'A game save could not be stored';
        message.textContent = /localstorage/i.test(failedStorageType)
            ? 'A game’s localStorage write was rejected. That area has a separate limit from the site-wide browser storage estimate. You can manage saved data or continue playing.'
            : 'A game’s IndexedDB write was rejected. The site-wide storage estimate is approximate and this error alone does not prove the entire site quota is full. You can manage saved data or continue playing.';
    } else {
        title.textContent = isRed ? 'This site’s storage is nearly full' : 'This site’s storage is getting low';
        message.textContent = isRed
            ? 'The browser estimates that storage for this site origin is critically close to its quota. The estimate includes site data beyond game saves. You can manage saves or continue playing.'
            : 'The browser estimates that storage for this site origin is getting close to its quota. This is an approximate site-wide estimate.';
    }
    okButton.hidden = false;
    notNowButton.hidden = false;
    continueButton.hidden = true;
    okButton.textContent = 'Open Save Manager';
    notNowButton.textContent = isRed ? 'Continue playing' : 'Not now';
    warningOverlay.dataset.storageTier = isRed ? 'red' : 'orange';
    warningOverlay.style.display = 'flex';
    if (window.setGamePopupState) window.setGamePopupState('saves-storage-warning-overlay', true);
    savesStorageWarningOpen = true;

    return new Promise(resolve => {
        let finished = false;
        const cleanup = () => {
            if (finished) return;
            finished = true;
            warningOverlay.style.display = 'none';
            document.removeEventListener('keydown', keyHandler, true);
            okButton.onclick = null;
            notNowButton.onclick = null;
            continueButton.onclick = null;
            if (window.setGamePopupState) window.setGamePopupState('saves-storage-warning-overlay', false);
            savesStorageWarningOpen = false;
        };
        const enterManager = () => {
            cleanup();
            resolve(true);
            openSavesManager();
        };
        const dismiss = () => {
            cleanup();
            resolve(false);
        };
        const keyHandler = event => {
            if (warningOverlay.style.display !== 'flex') return;
            if (event.key === 'Escape') {
                event.preventDefault();
                dismiss();
                return;
            }
            if (event.key === 'Tab') {
                const visibleButtons = [okButton, notNowButton, continueButton].filter(button => !button.hidden && !button.disabled);
                if (!visibleButtons.length) return;
                const first = visibleButtons[0];
                const last = visibleButtons[visibleButtons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };

        document.addEventListener('keydown', keyHandler, true);
        okButton.onclick = enterManager;
        continueButton.onclick = null;
        notNowButton.onclick = dismiss;
        window.setTimeout(() => okButton.focus(), 0);
    });
}

function showSavesStorageWarningOnPageEntry(status) {
    if (!status) return;
    if (status.tier === 'red' && !savesRedWarningShown && !savesRedCleanupAcknowledged) {
        savesStorageLastFailure = null;
        showSavesStorageWarning('red');
    } else if (savesStorageLastFailure && Date.now() - savesStorageLastFailure.failedAt < 5 * 60 * 1000) {
        const failedType = savesStorageLastFailure.storageType;
        savesStorageLastFailure = null;
        showSavesStorageWarning('orange', failedType);
    } else if (status.tier === 'orange' && !savesOrangeWarningShown) {
        showSavesStorageWarning('orange');
    }
}

async function refreshSavesStorageMeter() {
    const control = document.getElementById('saves-btn');
    const fill = document.getElementById('saves-storage-fill');
    if (!control || !fill) return savesStorageStatus;

    const requestId = ++savesStorageEstimateRequest;
    const storageManager = navigator.storage;
    let originUsage = null;
    let originQuota = null;
    let originUsageDetails = null;
    try {
        if (storageManager && typeof storageManager.estimate === 'function') {
            const estimate = await storageManager.estimate();
            const usage = Number(estimate.usage);
            const quota = Number(estimate.quota);
            if (Number.isFinite(usage) && usage >= 0) originUsage = usage;
            if (Number.isFinite(quota) && quota > 0) originQuota = quota;
            if (isSavesDevModeActive() && estimate.usageDetails && typeof estimate.usageDetails === 'object') {
                originUsageDetails = estimate.usageDetails;
            }
        }
    } catch (error) {}
    if (requestId !== savesStorageEstimateRequest) return savesStorageStatus;

    const pressurePercent = originUsage !== null && originQuota !== null
        ? Math.max(0, originUsage / originQuota * 100)
        : null;
    const tier = pressurePercent === null ? 'unknown'
        : pressurePercent >= SAVES_STORAGE_RED_AT ? 'red'
        : pressurePercent >= SAVES_STORAGE_ORANGE_AT ? 'orange'
        : pressurePercent >= SAVES_STORAGE_YELLOW_AT ? 'yellow'
        : 'normal';
    const status = {
        tier,
        pressurePercent,
        usage: originUsage,
        quota: originQuota,
        limitingStore: originUsage !== null && originQuota !== null ? 'origin' : null,
        originUsage,
        originQuota,
        originUsageDetails
    };
    savesStorageStatus = status;
    renderSavesStorageMeterStatus(status);
    if (savesStorageDebugTier !== null) applySavesStorageMeterDebugPreview();

    if (tier !== 'red' && savesRedCleanupAcknowledged) resetRedStorageCleanupAcknowledgement();
    return status;
}

let savesMeterOriginRect = null;
let savesMeterReturnTimer = null;

function moveSavesMeterAboveManager() {
    const control = document.getElementById('saves-btn');
    const overlay = document.getElementById('saves-select-overlay');
    const modal = overlay && overlay.querySelector('.saves-modal-box');
    if (!control || !modal || control.getAttribute('aria-expanded') !== 'true') return;

    const modalRect = modal.getBoundingClientRect();
    const width = savesMeterOriginRect ? savesMeterOriginRect.width : control.getBoundingClientRect().width;
    const height = savesMeterOriginRect ? savesMeterOriginRect.height : control.getBoundingClientRect().height;
    const minLeft = 12;
    const maxLeft = Math.max(minLeft, window.innerWidth - width - 12);
    const centeredLeft = modalRect.left + (modalRect.width - width) / 2;
    const targetLeft = Math.min(maxLeft, Math.max(minLeft, centeredLeft));
    const targetTop = Math.max(8, modalRect.top - height - 26);

    control.style.setProperty('--saves-meter-left', `${targetLeft}px`);
    control.style.setProperty('--saves-meter-top', `${targetTop}px`);
}

function setSavesMeterForeground(isForeground) {
    const control = document.getElementById('saves-btn');
    if (!control) return;

    if (isForeground) {
        if (savesMeterReturnTimer) {
            clearTimeout(savesMeterReturnTimer);
            savesMeterReturnTimer = null;
        }

        if (!control.classList.contains('saves-storage-foreground')) {
            const rect = control.getBoundingClientRect();
            savesMeterOriginRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
            control.style.setProperty('--saves-meter-left', `${rect.left}px`);
            control.style.setProperty('--saves-meter-top', `${rect.top}px`);
            control.style.setProperty('--saves-meter-width', `${rect.width}px`);
            control.style.setProperty('--saves-meter-height', `${rect.height}px`);
            control.classList.add('saves-storage-foreground');
            control.getBoundingClientRect();
        }

        control.setAttribute('aria-expanded', 'true');
        requestAnimationFrame(moveSavesMeterAboveManager);
        return;
    }

    control.setAttribute('aria-expanded', 'false');
    if (!control.classList.contains('saves-storage-foreground')) return;

    if (savesMeterOriginRect) {
        control.style.setProperty('--saves-meter-left', `${savesMeterOriginRect.left}px`);
        control.style.setProperty('--saves-meter-top', `${savesMeterOriginRect.top}px`);
    }

    if (savesMeterReturnTimer) clearTimeout(savesMeterReturnTimer);
    savesMeterReturnTimer = window.setTimeout(() => {
        if (control.getAttribute('aria-expanded') === 'true') return;
        control.classList.remove('saves-storage-foreground');
        control.style.removeProperty('--saves-meter-left');
        control.style.removeProperty('--saves-meter-top');
        control.style.removeProperty('--saves-meter-width');
        control.style.removeProperty('--saves-meter-height');
        savesMeterOriginRect = null;
        savesMeterReturnTimer = null;
    }, 280);
}

window.addEventListener('resize', () => {
    const control = document.getElementById('saves-btn');
    if (!control || !control.classList.contains('saves-storage-foreground')) return;
    control.classList.remove('saves-storage-foreground');
    const rect = control.getBoundingClientRect();
    savesMeterOriginRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    control.style.setProperty('--saves-meter-left', `${rect.left}px`);
    control.style.setProperty('--saves-meter-top', `${rect.top}px`);
    control.style.setProperty('--saves-meter-width', `${rect.width}px`);
    control.style.setProperty('--saves-meter-height', `${rect.height}px`);
    control.classList.add('saves-storage-foreground');
    control.getBoundingClientRect();
    if (control.getAttribute('aria-expanded') === 'true') requestAnimationFrame(moveSavesMeterAboveManager);
});

const savesBtn = document.getElementById('saves-btn');
async function openSavesManager() {
    const savesOverlay = document.getElementById('saves-select-overlay');
    if (savesManagerOpening || (savesOverlay && savesOverlay.style.display === 'flex')) return;
    savesManagerOpening = true;
    try {
        await refreshSavesStorageMeter();
        // List games in the user's sidebar (excluding Game Stash)
        const sidebarGames = games.filter(g => g && g.id !== 'ugs-stash');
        let offSidebarGames = [];
        let offSidebarReadError = null;
        try {
            // Use the indexed key cursor so listing saves does not load large save values into memory.
            offSidebarGames = await getSavedGamesOutsideSidebar(games);
        } catch (error) {
            offSidebarReadError = error;
        }
        const selection = await openSavesSelection(sidebarGames, offSidebarGames, offSidebarReadError);
        if (!selection || !selection.saveIds || selection.saveIds.length === 0) {
            return;
        }

        // Show red popup confirmation dialog
        const sidebarRemovalNotice = selection.sidebarGameIds.length
            ? '\n\nSelected games on the sidebar will also be removed from the sidebar.'
            : '';
        const confirmed = await showRedConfirmDialog(
            "Hold up, these games' saves will be deleted forever (A long time!) Are you sure you want to proceed?" + sidebarRemovalNotice
        );

        if (!confirmed) {
            return;
        }

        const clearResult = await clearGameSaves(selection.saveIds);
        const cleanupIncomplete = clearResult && (clearResult.nativeDatabasesRetained || clearResult.localStorageRetained);
        const removedSidebarGames = cleanupIncomplete
            ? []
            : await removeSidebarGamesFromSaveManager(selection.sidebarGameIds);
        if (!cleanupIncomplete) acknowledgeRedStorageCleanup();
        await refreshSavesStorageMeter();
        const completionMessage = clearResult && clearResult.nativeDatabasesRetained
            ? (clearResult.savesRetained
                ? "Nexus kept the selected saves because it could not safely determine whether an older saved record shares their game databases. No selected save data was removed."
                : "Nexus removed the selected snapshots but kept one or more game databases because it could not confirm that no other save uses them. This protects the other saves; try again after opening the affected game once.")
            : clearResult && clearResult.localStorageRetained
                ? "Nexus removed the selected snapshots and tracked databases, but kept game localStorage because an older saved record could not be read and may share those keys. This protects other saves; try clearing again after the affected save can be read."
            : removedSidebarGames.length
                ? "Selected saves have been cleared, and those games were removed from the sidebar."
                : "Selected games' saves have been cleared.";
        nexusAlert(completionMessage);
    } catch (error) {
        console.error('The Save Manager could not complete its storage operation.', error);
        try {
            await nexusAlert(error && error.message ? error.message : 'The selected game storage could not be cleared.');
        } catch (alertError) {}
    } finally {
        savesManagerOpening = false;
    }
}

if (savesBtn) {
    refreshSavesStorageMeter();
    window.setInterval(refreshSavesStorageMeter, 60000);
    savesBtn.onclick = openSavesManager;
}

window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    savesOrangeWarningShown = false;
    savesRedWarningShown = false;
    refreshSavesStorageMeter().then(showSavesStorageWarningOnPageEntry);
});

window.addEventListener('focus', () => {
    refreshSavesStorageMeter();
});
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        refreshSavesStorageMeter();
    }
});

const proxyBtn = document.getElementById('proxy-btn');
if (proxyBtn) {
    proxyBtn.onclick = () => {
        const win = window.open('about:blank', '_blank');
        if (win) {
            win.document.title = "GUST Browser";
            win.document.body.style.margin = '0';
            win.document.body.style.padding = '0';
            win.document.body.style.overflow = 'hidden';
            const iframe = win.document.createElement('iframe');
            iframe.style.position = 'fixed';
            iframe.style.top = '0';
            iframe.style.left = '0';
            iframe.style.width = '100%';
            iframe.style.height = '100%';
            iframe.style.border = 'none';
            iframe.src = window.location.href.substring(0, window.location.href.lastIndexOf('/') + 1) + 'gust.html';
            win.document.body.appendChild(iframe);
        } else {
            nexusAlert('Pop-up blocked! Please allow pop-ups to open the proxy.');
        }
    };
}

loadGames();

/* =========================================
   GAMES PAGE TUTORIAL SYSTEM
   ========================================= */
let carmeowResizeListener = null;

function initCarmeowTutorial() {
    const localStorage = window.nexusStorage || window.localStorage;
    const step = localStorage.getItem('tb_tutorial_step');
    if (step !== 'games_clicked') return;

    // Show Overlay
    let overlay = document.getElementById('tutorial-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'tutorial-overlay';
        overlay.className = 'tutorial-overlay';
        document.body.appendChild(overlay);
    }
    if (!overlay.dataset.outsideDismissBound) {
        overlay.addEventListener('nexus:backdrop-dismiss', (event) => {
            event.preventDefault();
            endCarmeowTutorial();
        });
        overlay.dataset.outsideDismissBound = 'true';
    }
    overlay.style.display = 'block';
    document.body.classList.add('tutorial-active');

    // Create popup (centered initially)
    let popup = document.getElementById('tutorial-popup');
    if (!popup) {
        popup = document.createElement('div');
        popup.id = 'tutorial-popup';
        popup.className = 'tutorial-popup centered';
        popup.innerHTML = `
            <div class="tutorial-content">This is where all your games are. Search through the Stash and click on a game to add it to sidebar. To play, click on the game in sidebar. Don't worry, your progress saves automatically.</div>
            <button id="tutorial-next-btn">Next</button>
            <span class="tutorial-skip" id="tutorial-skip-btn" style="display:block; text-align:right; margin-top:8px; color:#888; font-size:11px; cursor:pointer; text-decoration:underline;">Skip</span>
        `;
        document.body.appendChild(popup);

        document.getElementById('tutorial-skip-btn').onclick = (e) => {
            e.stopPropagation();
            endCarmeowTutorial();
        };

        document.getElementById('tutorial-next-btn').onclick = (e) => {
            e.stopPropagation();
            goToControlsStep();
        };
    }
}

function goToControlsStep() {
    const localStorage = window.nexusStorage || window.localStorage;
    const popup = document.getElementById('tutorial-popup');
    if (!popup) return;

    popup.classList.remove('centered');
    popup.innerHTML = `
        <div class="tutorial-content">These icons are useful. Fullscreen opens the current game in a blank tab. Saves lets you manage game-specific save files. System backups are in Settings. Custom allows you to add any file as a sidebar icon. And Home goes back to the home screen.</div>
        <button id="tutorial-happy-btn">Happy gaming!</button>
        <span class="tutorial-skip" id="tutorial-skip-btn" style="display:block; text-align:right; margin-top:8px; color:#888; font-size:11px; cursor:pointer; text-decoration:underline;">Skip</span>
    `;

    document.getElementById('tutorial-skip-btn').onclick = (e) => {
        e.stopPropagation();
        endCarmeowTutorial();
    };

    document.getElementById('tutorial-happy-btn').onclick = (e) => {
        e.stopPropagation();
        localStorage.setItem('tb_tutorial_played', 'true');
        endCarmeowTutorial();
    };

    // Highlight controls in header
    const controls = document.querySelector('header .controls');
    if (controls) {
        controls.classList.add('tutorial-highlight');
    }

    // Position popup next to header controls
    positionControlsPopup();
    carmeowResizeListener = () => positionControlsPopup();
    window.addEventListener('resize', carmeowResizeListener);
}

function positionControlsPopup() {
    const popup = document.getElementById('tutorial-popup');
    const controls = document.querySelector('header .controls');
    if (!popup || !controls) return;

    const rect = controls.getBoundingClientRect();
    
    // Position below the header controls, centered relative to them
    const left = rect.left + (rect.width / 2) - (popup.offsetWidth / 2) + window.scrollX;
    const top = rect.bottom + 25 + window.scrollY;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.transform = 'none'; // reset transform since it's centered directly

    // Draw curved line connecting them (from top edge of popup to bottom edge of controls)
    let svg = document.getElementById('tutorial-svg');
    if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.id = 'tutorial-svg';
        Object.assign(svg.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            zIndex: '100004',
            pointerEvents: 'none'
        });
        document.body.appendChild(svg);
    }

    const popupRect = popup.getBoundingClientRect();
    const targetRect = controls.getBoundingClientRect();

    const px1 = popupRect.left + popupRect.width / 2 + window.scrollX; // center X of popup
    const py1 = popupRect.top + window.scrollY; // top edge of popup

    const px2 = targetRect.left + targetRect.width / 2 + window.scrollX; // center X of controls
    const py2 = targetRect.bottom + window.scrollY; // bottom edge of controls

    const cx = (px1 + px2) / 2;
    const cy = (py1 + py2) / 2;

    svg.innerHTML = `
        <path d="M ${px1} ${py1} Q ${cx} ${cy} ${px2} ${py2}" 
              fill="none" 
              stroke="rgba(255, 255, 255, 0.45)" 
              stroke-width="3" 
              stroke-linecap="round" />
    `;
}

function endCarmeowTutorial() {
    const localStorage = window.nexusStorage || window.localStorage;
    localStorage.removeItem('tb_tutorial_step');
    document.body.classList.remove('tutorial-active');
    
    const overlay = document.getElementById('tutorial-overlay');
    if (overlay) overlay.style.display = 'none';

    const popup = document.getElementById('tutorial-popup');
    if (popup) popup.remove();

    const svg = document.getElementById('tutorial-svg');
    if (svg) svg.remove();

    const controls = document.querySelector('header .controls');
    if (controls) controls.classList.remove('tutorial-highlight');

    if (carmeowResizeListener) {
        window.removeEventListener('resize', carmeowResizeListener);
        carmeowResizeListener = null;
    }
}

// Keep sidebar item colors in sync with theme changes (light/dark mode)
if (window.MutationObserver) {
    new MutationObserver(() => {
        document.querySelectorAll('#game-list li[data-game-id]').forEach(li => {
            const game = games.find(g => String(g.id) === String(li.dataset.gameId));
            if (game) applyGameColorToLi(li, game);
        });
        const renameOverlay = document.getElementById('rename-overlay');
        if (renameOverlay && renameOverlay.style.display !== 'none' && renameTargetId) {
            const game = games.find(g => String(g.id) === String(renameTargetId));
            if (game) buildRenameSwatches(game);
        }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}


/* =========================================
   SURPRISE ME — SLOT MACHINE PICKER
========================================= */
(function initSurpriseMe() {
    let active = false;
    let devModeSession = false;
    let phase = 'idle';
    let selected = null;
    let stashTitles = [];
    let stashCandidates = [];
    let overlay = null;
    let keyHandler = null;
    let lightResizeHandler = null;
    let lightAnimationFrameId = null;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const spinningHeadlines = [
        'What will it be this time?',
        'Let’s see!',
        'Spinning the dice…',
        'Come on, come on…',
        'Spinning it…',
        'Rolling the wheel…',
        'Please land on one that’s good…',
        'Maybe it’s a good one!',
        'What’s coming up?',
        'Almost there…',
        'No peeking!',
        'One lucky game…',
        'Pick something fun!',
        'Maybe this one?',
        'The suspense is real!',
        'Let’s find a favorite!'
    ];

    function setMachineHeading(message) {
        if (!overlay) return;
        const heading = overlay.querySelector('.surprise-machine h2');
        if (!heading) return;
        heading.textContent = message;
        let size = window.innerWidth <= 560 ? 22 : 24;
        const minimumSize = 16;
        heading.style.fontSize = `${size}px`;
        while (heading.scrollHeight > heading.clientHeight + 1 && size > minimumSize) {
            size -= 1;
            heading.style.fontSize = `${size}px`;
        }
    }

    function buildMachine() {
        overlay = document.createElement('div');
        overlay.className = 'surprise-overlay';
        if (devModeSession) overlay.classList.add('is-dev-mode');
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Surprise Me slot machine');
        const lights = Array.from({length:64}, (_, index) => `<i class="surprise-light" data-light-index="${index}" aria-hidden="true"></i>`).join('');
        overlay.innerHTML = `
            <section class="surprise-machine" aria-live="polite">
                <div class="surprise-lights" aria-hidden="true">${lights}</div>
                <button id="surprise-close" class="surprise-close" type="button" aria-label="Close Surprise Me">×</button>
                <h2>Find your next favorite game!</h2>
                <div class="surprise-slot-shell">
                    <div class="surprise-slot-window"><div class="surprise-reel-track"></div><div class="surprise-slot-selector" aria-hidden="true"><i class="surprise-selector-left"></i><i class="surprise-selector-right"></i></div><div class="surprise-slot-curtains" aria-hidden="true"><i class="surprise-curtain-left"></i><i class="surprise-curtain-right"></i></div></div>
                </div>
                <div class="surprise-controls"><div class="surprise-ticket-slot" aria-hidden="true"></div><button id="surprise-spin-button" class="surprise-spin-button" type="button" aria-label="Spin the slot machine"><span>SPIN</span></button></div>
            </section>
            <div class="surprise-fly-card" aria-hidden="true"></div>`;
        document.body.appendChild(overlay);
        lightResizeHandler = () => layoutSurpriseLights();
        lightResizeHandler();
        window.addEventListener('resize', lightResizeHandler);
        overlay.querySelector('.surprise-close').addEventListener('click', closeMachine);
        overlay.querySelector('.surprise-spin-button').addEventListener('click', pullLever);
        overlay.addEventListener('click', e => {
            if (e.target === overlay) {
                e.preventDefault();
                e.stopPropagation();
                closeMachine();
                return;
            }
            if (phase !== 'result-wait' || devModeSession) return;
            e.preventDefault();
            e.stopPropagation();
            finishResult();
        }, true);
        keyHandler = e => {
            if (!active) return;
            if (e.code === 'Space' && !e.target.closest('.surprise-close')) { e.preventDefault(); if (phase === 'ready') pullLever(); }
            if (e.key === 'Escape' && phase === 'ready' && !devModeSession) closeMachine();
        };
        document.addEventListener('keydown', keyHandler, true);
        return overlay;
    }

    function layoutSurpriseLights() {
        if (!overlay) return;
        const machine = overlay.querySelector('.surprise-machine');
        if (!machine) return;
        const inset = 13;
        const width = Math.max(0, machine.clientWidth - inset * 2);
        const height = Math.max(0, machine.clientHeight - inset * 2);
        const radius = Math.min(16, width / 2, height / 2);
        const straightTop = Math.max(0, width - radius * 2);
        const straightSide = Math.max(0, height - radius * 2);
        const arc = Math.PI * radius / 2;
        const segments = [straightTop, arc, straightSide, arc, straightTop, arc, straightSide, arc];
        const perimeter = segments.reduce((sum, length) => sum + length, 0);
        const lights = overlay.querySelectorAll('.surprise-light');
        const rainbow = ['#ff3e3e', '#ff8a24', '#ffe34d', '#48dc74', '#38c8ff', '#536bff', '#aa55ff', '#ff55b9'];
        lights.forEach((light, index) => {
            let distance = perimeter * index / lights.length;
            let x = radius, y = 0;
            if (distance <= segments[0]) { x += distance; }
            else if ((distance -= segments[0]) <= segments[1]) {
                const angle = -Math.PI / 2 + distance / radius;
                x = width - radius + radius * Math.cos(angle); y = radius + radius * Math.sin(angle);
            } else if ((distance -= segments[1]) <= segments[2]) { x = width; y = radius + distance; }
            else if ((distance -= segments[2]) <= segments[3]) {
                const angle = distance / radius;
                x = width - radius + radius * Math.cos(angle); y = height - radius + radius * Math.sin(angle);
            } else if ((distance -= segments[3]) <= segments[4]) { x = width - radius - distance; y = height; }
            else if ((distance -= segments[4]) <= segments[5]) {
                const angle = Math.PI / 2 + distance / radius;
                x = radius + radius * Math.cos(angle); y = height - radius + radius * Math.sin(angle);
            } else if ((distance -= segments[5]) <= segments[6]) { x = 0; y = height - radius - distance; }
            else {
                distance -= segments[6];
                const angle = Math.PI + distance / radius;
                x = radius + radius * Math.cos(angle); y = radius + radius * Math.sin(angle);
            }
            light.style.left = `${inset + x}px`;
            light.style.top = `${inset + y}px`;
            light.style.setProperty('--light-index', index);
            light.style.setProperty('--rainbow-color', rainbow[Math.floor(index / 2) % rainbow.length]);
        });
    }

    function syncLightsToReel(track) {
        const lights = overlay ? overlay.querySelectorAll('.surprise-light') : [];
        if (!lights.length || phase !== 'spinning') return;
        const transform = getComputedStyle(track).transform;
        let translateY = 0;
        if (transform && transform !== 'none') {
            const values = transform.slice(transform.indexOf('(') + 1, -1).split(',').map(Number);
            translateY = values.length === 16 ? values[13] : values[5] || 0;
        }
        const reelIndex = Math.max(1, Math.min(39, (58 - translateY) / 58));
        const ringPosition = ((reelIndex - 1) / 38) * lights.length * 1.45;
        const firstLit = Math.floor(ringPosition) % lights.length;
        lights.forEach((light, index) => {
            const distance = (index - firstLit + lights.length) % lights.length;
            light.classList.toggle('is-rainbow-on', distance < lights.length * .75);
        });
        lightAnimationFrameId = requestAnimationFrame(() => syncLightsToReel(track));
    }

    function paintReel() {
        const track = overlay.querySelector('.surprise-reel-track');
        const pool = stashTitles.length ? stashTitles : [selected.title];
        const nearMisses = pool.filter(name => name !== selected.title);
        const nearMissTitle = nearMisses.length ? nearMisses[Math.floor(Math.random() * nearMisses.length)] : selected.title;
        const items = Array.from({ length: 52 }, (_, index) => index === 38 ? nearMissTitle : index === 39 ? selected.title : pool[Math.floor(Math.random() * pool.length)]);
        track.innerHTML = items.map(name => `<div class="surprise-reel-item">${escapeSurpriseText(name)}</div>`).join('');
        track.style.transform = 'translateY(0)';
        track.style.setProperty('--near-stop', `calc(87px - ${38 * 58 + 29}px)`);
        track.style.setProperty('--final-stop', `calc(87px - ${39 * 58 + 29}px)`);
        return track;
    }

    function escapeSurpriseText(value) {
        return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }

    async function start(options = {}) {
        if (active) return;
        // The Dev button is only shown by the stash while Dev Mode is active.
        // Trust its explicit request; the iframe and parent can observe storage differently.
        devModeSession = Boolean(options && options.devMode);
        const frame = document.getElementById('stash-frame');
        const stashWindow = frame && frame.contentWindow;
        stashTitles = [];
        let candidates = [];
        try {
            if (stashWindow && typeof stashWindow.getSurpriseGameCandidates === 'function') candidates = stashWindow.getSurpriseGameCandidates();
            if (stashWindow && typeof stashWindow.getSurpriseGameTitles === 'function') stashTitles = stashWindow.getSurpriseGameTitles();
        } catch (_) {}
        if (!candidates.length) {
            const stash = window.games && window.games.find(game => game && game.id === 'ugs-stash');
            if (stash && typeof ensureStashPreloaded === 'function') {
                await ensureStashPreloaded();
                try {
                    candidates = frame.contentWindow.getSurpriseGameCandidates();
                    stashTitles = frame.contentWindow.getSurpriseGameTitles();
                } catch (_) {}
            }
        }
        if (!candidates.length) {
            if (typeof showSidebarPointerMessage === 'function') showSidebarPointerMessage('All available games are already in your sidebar!', window.innerWidth / 2, window.innerHeight / 2);
            return;
        }
        stashCandidates = candidates.slice();
        selected = candidates[Math.floor(Math.random() * candidates.length)];
        active = true; phase = 'entering';
        buildMachine();
        paintReel();
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('is-visible')));
        await wait(1000);
        if (!active) return;
        phase = 'ready';
        overlay.classList.add('is-ready');
        overlay.querySelector('.surprise-spin-button').focus({ preventScroll: true });
    }

    async function pullLever() {
        if (!active || phase !== 'ready') return;
        if (devModeSession) {
            if (stashCandidates.length) selected = stashCandidates[Math.floor(Math.random() * stashCandidates.length)];
            const previousCard = overlay.querySelector('.surprise-fly-card');
            previousCard.getAnimations().forEach(animation => animation.cancel());
            previousCard.style.display = 'none';
            previousCard.style.transform = '';
            previousCard.style.clipPath = '';
            previousCard.classList.remove('is-ticket', 'is-flying');
            overlay.classList.remove('is-result-wait', 'is-result-flashing', 'is-awarding', 'is-result-curtains-closed');
        }
        phase = 'spinning';
        const spinButton = overlay.querySelector('.surprise-spin-button');
        spinButton.classList.add('is-clicking');
        spinButton.disabled = true;
        overlay.classList.add('is-revealing');
        await wait(100);
        if (!active) return;
        overlay.classList.remove('is-revealing');
        overlay.classList.add('is-spinning');
        const spinMessage = spinningHeadlines[Math.floor(Math.random() * spinningHeadlines.length)];
        setMachineHeading(spinMessage);
        const reelTrack = paintReel();
        reelTrack.getBoundingClientRect();
        lightAnimationFrameId = requestAnimationFrame(() => syncLightsToReel(reelTrack));
        await wait(4200);
        if (!active) return;
        if (lightAnimationFrameId !== null) cancelAnimationFrame(lightAnimationFrameId);
        lightAnimationFrameId = null;
        phase = 'awarding';
        overlay.classList.add('is-awarding');
        setMachineHeading('Game selected!');
        if (!devModeSession) overlay.classList.add('is-result-curtains-closed');
        const sidebarBefore = devModeSession ? null : new Map(Array.from(document.querySelectorAll('#game-list li[data-game-id]')).map(item => [item.dataset.gameId, item.getBoundingClientRect().top]));
        let game = null;
        if (devModeSession) {
            game = { title: selected.title, preserveStashTitle: true };
        } else {
            try {
                const frame = document.getElementById('stash-frame');
                await frame.contentWindow.addBookmarkToSidebar(selected.raw);
            } catch (error) {
                console.error('Surprise Me could not add the selected game:', error);
                setMachineHeading('Could not add that game');
                await wait(1500); closeMachine(); return;
            }
            for (let attempt = 0; attempt < 100 && !game; attempt++) {
                game = (window.games || []).find(item => item && (
                    String(item.sourceFile || '').toLowerCase() === String(selected.raw).toLowerCase() ||
                    String(item.title || '').toLowerCase() === String(selected.title).toLowerCase()
                ));
                if (!game) await wait(100);
            }
        }
        if (game) {
            if (!devModeSession) document.querySelectorAll('#game-list li[data-game-id]').forEach(item => {
                const oldTop = sidebarBefore.get(item.dataset.gameId);
                if (oldTop === undefined) return;
                const offset = oldTop - item.getBoundingClientRect().top;
                if (offset) item.animate(
                    [{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }],
                    { duration: 1000, easing: 'cubic-bezier(.2,.8,.2,1)' }
                );
            });
            const flyer = overlay.querySelector('.surprise-fly-card');
            const slot = overlay.querySelector('.surprise-ticket-slot').getBoundingClientRect();
            const machineRect = overlay.querySelector('.surprise-machine').getBoundingClientRect();
            const ticketCenterX = slot.left + slot.width / 2;
            flyer.textContent = getSidebarTitle(game);
            flyer.style.left = `${ticketCenterX}px`;
            flyer.style.display = 'block';
            flyer.classList.add('is-ticket');
            const cardWidth = flyer.getBoundingClientRect().width;
            const cardHeight = flyer.getBoundingClientRect().height;
            const revealStartHeight = Math.min(14, Math.max(8, slot.height * .24));
            // Put the first visible strip fully inside the slot: its upper edge aligns
            // with the slot's inner edge instead of floating just above the opening.
            const ticketCenterY = slot.top + 3 + revealStartHeight - cardWidth / 2;
            flyer.style.top = `${ticketCenterY}px`;
            const hiddenWidthPercent = Math.max(0, Math.min(96, (1 - revealStartHeight / cardWidth) * 100));
            // Rotated 90deg, the source card's right edge is its visible bottom edge.
            // Expand the clip toward the top while translating down by the same pixels.
            const ticketStartingClip = `inset(0 0 0 ${hiddenWidthPercent}%)`;
            const base = 'translate(-50%, -50%)';
            const vertical = `${base} translate(0px, 0px) rotate(90deg)`;
            const revealTravel = cardWidth - revealStartHeight;
            const revealedDown = `${base} translate(0px, ${revealTravel}px) rotate(90deg)`;
            const underX = machineRect.left + machineRect.width / 2 - ticketCenterX;
            const underY = machineRect.bottom + cardHeight / 2 + 74 - ticketCenterY;
            const horizontalRest = `${base} translate(${underX}px, ${underY}px) rotate(0deg)`;
            flyer.style.transform = vertical;
            const reveal = flyer.animate([
                { transform: vertical, clipPath: ticketStartingClip, offset: 0 },
                { transform: revealedDown, clipPath: 'inset(0)', offset: 1 }
            ], { duration: 1500, easing: 'linear', fill: 'forwards' });
            await reveal.finished;
            if (!active || phase !== 'awarding') return;
            flyer.style.clipPath = 'inset(0)';
            flyer.style.transform = revealedDown;
            reveal.cancel();
            const dropAndTurn = flyer.animate([
                { transform: revealedDown },
                { transform: horizontalRest }
            ], { duration: 1100, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'forwards' });
            await dropAndTurn.finished;
            if (!active || phase !== 'awarding') return;
            flyer.style.transform = horizontalRest;
            dropAndTurn.cancel();
            overlay.classList.add('is-result-flashing');
            if (devModeSession) {
                const reelTrack = overlay.querySelector('.surprise-reel-track');
                const stoppedReelTransform = getComputedStyle(reelTrack).transform;
                overlay.classList.add('is-dev-curtains-open');
                overlay.classList.remove('is-awarding', 'is-spinning', 'is-revealing');
                reelTrack.style.transform = stoppedReelTransform;
                overlay.classList.add('is-ready');
                overlay.querySelector('.surprise-spin-button').disabled = false;
                overlay.querySelector('.surprise-spin-button').classList.remove('is-clicking');
                phase = 'ready';
                overlay.setAttribute('aria-label', `${getSidebarTitle(game)} selected. Press Spin to choose again, or the close button to exit.`);
                return;
            }
            phase = 'result-wait';
            overlay.classList.add('is-result-wait');
            overlay.setAttribute('aria-label', devModeSession ? `${getSidebarTitle(game)} selected. Press the close button to exit.` : `${getSidebarTitle(game)} selected. Click anywhere to continue.`);
        } else {
            phase = 'result-wait';
        }
    }

    async function finishResult() {
        if (!active || phase !== 'result-wait') return;
        phase = 'exiting';
        const flyer = overlay.querySelector('.surprise-fly-card');
        const game = selected && (window.games || []).find(item => item && (
            String(item.sourceFile || '').toLowerCase() === String(selected.raw).toLowerCase() ||
            String(item.title || '').toLowerCase() === String(selected.title).toLowerCase()
        ));
        const target = game && document.querySelector(`#game-list li[data-game-id="${CSS.escape(String(game.id))}"]`);
        if (flyer && target) {
            const flyerRect = flyer.getBoundingClientRect();
            const to = target.getBoundingClientRect();
            flyer.getAnimations().forEach(animation => animation.cancel());
            const fromCenterX = flyerRect.left + flyerRect.width / 2;
            const fromCenterY = flyerRect.top + flyerRect.height / 2;
            flyer.style.left = `${fromCenterX}px`;
            flyer.style.top = `${fromCenterY}px`;
            flyer.style.transform = 'translate(-50%, -50%)';
            flyer.animate([
                { transform: 'translate(-50%, -50%)', opacity: 1 },
                { transform: `translate(-50%, -50%) translate(${to.left + to.width / 2 - fromCenterX}px, ${to.top + to.height / 2 - fromCenterY}px) scale(.72)`, opacity: 0 }
            ], { duration: 1000, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
            target.classList.add('surprise-arrival');
            setTimeout(() => target.classList.remove('surprise-arrival'), 1200);
        }
        overlay.classList.remove('is-result-wait');
        overlay.classList.add('is-exiting');
        await wait(500);
        if (!active) return;
        overlay.classList.add('is-interactive-through');
        await wait(500);
        closeMachine();
    }
    function closeMachine() {
        if (!active) return;
        active = false; phase = 'idle';
        if (keyHandler) document.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
        if (lightResizeHandler) window.removeEventListener('resize', lightResizeHandler);
        lightResizeHandler = null;
        if (lightAnimationFrameId !== null) cancelAnimationFrame(lightAnimationFrameId);
        lightAnimationFrameId = null;
        selected = null;
        stashTitles = [];
        stashCandidates = [];
        if (overlay) {
            overlay.classList.add('is-closing');
            const oldOverlay = overlay; overlay = null;
            setTimeout(() => oldOverlay.remove(), 500);
        }
    }

    window.launchSurpriseMe = start;
    document.addEventListener('click', e => {
        if (e.target.closest('#surprise-me-btn')) { e.preventDefault(); start(); }
    });
})();
