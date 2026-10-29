// nexus-version: 4.46.22
const appStorage = window.nexusStorage || window.localStorage;
// Game Stash is always available during a Games visit. Release its frame only
// while the lightweight game standby screen is active.
appStorage.setItem('tb_preload_stash', 'true');

const dbName = "GameStorageDB";
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
        const req = indexedDB.open(dbName, 3);
        req.onupgradeneeded = e => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('customGames')) {
                database.createObjectStore('customGames', { keyPath: 'id' });
            }
            if (!database.objectStoreNames.contains('gameSnapshots')) {
                database.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
            }
        };
        req.onsuccess = e => { db = e.target.result; db.onversionchange = () => db.close(); resolve(db); };
        req.onerror = () => reject(req.error);
    });
    return dbReadyPromise;
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
    const initialGameLoad = openDefaultGame();
    Promise.all([stashPreloadOnEntry, initialGameLoad]).catch(() => {}).finally(() => {
        if (typeof window.nexusFinishPageTransition === 'function') window.nexusFinishPageTransition();
        else hideTransitionOverlay();
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
window.addStashGameToSidebar = async function(game) {
    if (!game || !game.id) throw new Error('Invalid game record');

    await saveGameRecord(game);

    // Keep the sidebar lightweight: retrieve a game's HTML only when it is opened.
    const sidebarGame = { ...game };
    delete sidebarGame.content;

    const existingIndex = games.findIndex(item => String(item.id) === String(sidebarGame.id));
    if (existingIndex !== -1) {
        // Game already exists on the sidebar; preserve its existing position!
        games[existingIndex] = { ...games[existingIndex], ...sidebarGame };
        renderGameList();
        notifyStashBookmarkAvailability();
        return;
    }

    const stashIndex = games.findIndex(item => item.id === 'ugs-stash');
    games.splice(stashIndex === -1 ? 0 : stashIndex + 1, 0, sidebarGame);
    saveGameOrder();
    renderGameList();
    notifyStashBookmarkAvailability();
};

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
        if (g.title && (String(g.title).toLowerCase() === lower || String(g.title).toLowerCase().replace(/[^a-z0-9]/g, '') === lower)) return true;
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
        if (filename && (snapId === filename || snapId === filename.replace(/\.html$/, ''))) return true;
    }
    if (game.title) {
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

    if (payload.localStorage || payload.fsData || payload.idbData) {
        incomingLs = (payload.localStorage && typeof payload.localStorage === 'object') ? payload.localStorage : {};
        incomingFs = (payload.fsData && typeof payload.fsData === 'object') ? payload.fsData : null;
        incomingIdb = (payload.idbData && typeof payload.idbData === 'object') ? payload.idbData : null;
    } else {
        incomingLs = payload;
    }

    // Read, compare, merge, and write in one readwrite transaction. Doing the
    // read in a separate transaction lets two concurrent saves both compare
    // against the same old record, so the older payload can commit last.
    return new Promise((resolve, reject) => {
        let snapshotRecord = null;
        let signature = null;
        let didSave = false;
        let tx;
        try {
            tx = db.transaction('gameSnapshots', 'readwrite');
            const store = tx.objectStore('gameSnapshots');
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
                if (incomingKeys.length === 0 && existingKeys.length > 0) {
                    lsToSave = { ...existingData };
                } else if (incomingKeys.length > 0 && existingKeys.length > 0) {
                    lsToSave = { ...existingData, ...incomingLs };
                }

                // Protection: Never overwrite non-empty virtual FS files with null or empty
                let fsToSave = existing && existing.fsData ? { ...existing.fsData } : null;
                if (incomingFs && Object.keys(incomingFs).length > 0) {
                    fsToSave = { ...(fsToSave || {}), ...incomingFs };
                }

                // Protection: Never overwrite non-empty IndexedDB records with null or empty
                let idbToSave = existing && existing.idbData ? { ...existing.idbData } : null;
                if (incomingIdb && Object.keys(incomingIdb).length > 0) {
                    idbToSave = { ...(idbToSave || {}), ...incomingIdb };
                }

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
                let sig = '';
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
                if (snapshotHashes.get(gameId) === sig && existing && Number(existing.savedAt) >= incomingSavedAt) return;

                const savedAt = incomingSavedAt;
                const history = Array.isArray(existing && existing.history) ? existing.history.slice(-2) : [];
                if (existing && existing.localStorage) {
                    history.push({
                        localStorage: existing.localStorage,
                        savedAt: existing.savedAt || savedAt
                    });
                }

                snapshotRecord = {
                    gameId,
                    localStorage: lsToSave,
                    fsData: fsToSave,
                    idbData: idbToSave,
                    savedAt,
                    history
                };
                signature = sig;
                didSave = true;
                store.put(snapshotRecord);
            };
            getReq.onerror = () => reject(getReq.error || tx.error || new Error('Could not read the saved game snapshot.'));
            tx.oncomplete = () => {
                if (didSave) {
                    snapshotHashes.set(gameId, signature);

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
                                savedAt: snapshotRecord.savedAt,
                                saveSessionId: payload.saveSessionId
                            }, true).catch(() => {});
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

    if (message.type === 'nexus-game-save') {
        const gameId = message.gameId || (currentGame && currentGame.id ? currentGame.id : null);
        if (gameId && (message.localStorage || message.fsData || message.idbData)) {
            saveGameSnapshot(gameId, {
                localStorage: message.localStorage,
                fsData: message.fsData,
                idbData: message.idbData,
                savedAt: message.savedAt,
                saveSessionId: message.saveSessionId
            }).catch(() => {});
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
                            fsData: snapshot.fsData || null,
                            idbData: snapshot.idbData || null
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

function getGameRestoreScript(gameId, snapshot = {}) {
    const savedStorage = snapshot && snapshot.localStorage && typeof snapshot.localStorage === 'object'
        ? snapshot.localStorage
        : snapshot;
    const snapshotJson = JSON.stringify(savedStorage || {}).replace(/</g, '\\u003c');
    const journalKey = `tb_nexus_game_autosave:${encodeURIComponent(String(gameId))}`;
    const snapshotSavedAt = Number(snapshot && snapshot.savedAt) || 0;
    return `<script>(function(){try{
        var saved=${snapshotJson};
        var snapshotSavedAt=${snapshotSavedAt};
        var journal=null;
        try{journal=JSON.parse(localStorage.getItem(${JSON.stringify(journalKey)})||'null');}catch(e){}
        if(journal&&Number(journal.savedAt)>=snapshotSavedAt&&journal.localStorage&&typeof journal.localStorage==='object'){
            // The journal is written synchronously by the game itself, so it
            // always wins over an older asynchronous IndexedDB snapshot.
            saved=Object.assign({},saved,journal.localStorage);
        }
        Object.keys(saved).forEach(function(k){
            if(k.indexOf('tb_')!==0&&k!=='sidebar-game-order'&&k!=='sidebar-game-order-updated-at')localStorage.setItem(k,saved[k]);
        });
    }catch(e){}})();<\/script>`;
}

function getUniversalAutosaveBridge(gameId, saveSessionId = null) {
    return `<script>
(function() {
    var gameId = ${JSON.stringify(gameId)};
    var saveSessionId = ${JSON.stringify(saveSessionId)};
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

    function isCurrentSession() {
        if (!saveSessionId) return true;
        try {
            var activeSessionId = localStorage.getItem(saveSessionKey);
            return activeSessionId === String(saveSessionId);
        } catch(e) { return true; }
    }

    function saveSnapshotDirectToDB(targetId, snapshotData) {
        if (autosaveDisarmed || !isCurrentSession() || !snapshotData || !targetId) return;
        var incomingLs = snapshotData.localStorage || {};
        var incomingFs = snapshotData.fsData || null;
        var incomingIdb = snapshotData.idbData || null;
        var payloadSavedAt = Number(snapshotData.savedAt);
        var incomingSavedAt = isFinite(payloadSavedAt) && payloadSavedAt > 0 ? payloadSavedAt : Date.now();
        try {
            var req = indexedDB.open("GameStorageDB", 3);
            req.onupgradeneeded = function(e) {
                var d = e.target.result;
                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
            };
            req.onsuccess = function(e) {
                var db = e.target.result;
                db.onversionchange = function() { try { db.close(); } catch(err) {} };
                try {
                    if (autosaveDisarmed || !isCurrentSession() || !db.objectStoreNames.contains('gameSnapshots')) return;
                    var tx = db.transaction('gameSnapshots', 'readwrite');
                    var store = tx.objectStore('gameSnapshots');
                    var getReq = store.get(targetId);
                    getReq.onsuccess = function() {
                        if (autosaveDisarmed || !isCurrentSession()) return;
                        var existing = getReq.result || null;
                        if (existing && Number(existing.savedAt) > incomingSavedAt) return;
                        var existingData = (existing && existing.localStorage && typeof existing.localStorage === 'object') ? existing.localStorage : {};
                        var incomingKeys = Object.keys(incomingLs);
                        var existingKeys = Object.keys(existingData);

                        var lsToSave = Object.assign({}, incomingLs);
                        if (incomingKeys.length === 0 && existingKeys.length > 0) {
                            lsToSave = Object.assign({}, existingData);
                        } else if (incomingKeys.length > 0 && existingKeys.length > 0) {
                            lsToSave = Object.assign({}, existingData, incomingLs);
                        }

                        var fsToSave = (existing && existing.fsData) ? Object.assign({}, existing.fsData) : null;
                        if (incomingFs && Object.keys(incomingFs).length > 0) {
                            fsToSave = Object.assign({}, fsToSave || {}, incomingFs);
                        }

                        var idbToSave = (existing && existing.idbData) ? Object.assign({}, existing.idbData) : null;
                        if (incomingIdb && Object.keys(incomingIdb).length > 0) {
                            idbToSave = Object.assign({}, idbToSave || {}, incomingIdb);
                        }

                        var savedAt = incomingSavedAt;
                        var history = Array.isArray(existing && existing.history) ? existing.history.slice(-2) : [];
                        if (existing && existing.localStorage) {
                            history.push({
                                localStorage: existing.localStorage,
                                savedAt: existing.savedAt || savedAt
                            });
                        }

                        var record = {
                            gameId: targetId,
                            localStorage: lsToSave,
                            fsData: fsToSave,
                            idbData: idbToSave,
                            savedAt: savedAt,
                            history: history
                        };
                        try { store.put(record); } catch(err) {}
                    };
                } catch(txErr) {}
            };
        } catch(err) {}
    }

    function getStorageSnapshot() {
        var s = {};
        try {
            for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && k.indexOf('tb_') !== 0) {
                    s[k] = localStorage.getItem(k);
                }
            }
        } catch(e) {}
        return s;
    }

    function writeJournal(data, savedAt) {
        // localStorage is synchronous. This tiny write-ahead record survives
        // tab shutdown, including when the Nexus tab is no longer open.
        try {
            localStorage.setItem(journalKey, JSON.stringify({ version: 1, savedAt: savedAt, localStorage: data }));
        } catch(e) {}
    }

    function sendSave(immediate) {
        if (autosaveDisarmed || !isCurrentSession()) return;
        try {
            var data = getStorageSnapshot();
            var currentHash = JSON.stringify(data);
            if (!immediate && currentHash === lastSavedHash) return;
            lastSavedHash = currentHash;
            var savedAt = Math.max(Date.now(), lastSavedAt + 1);
            lastSavedAt = savedAt;
            writeJournal(data, savedAt);

            var msg = { type: 'nexus-game-save', gameId: gameId, localStorage: data, savedAt: savedAt, saveSessionId: saveSessionId };
            saveSnapshotDirectToDB(gameId, msg);
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
            var res = origSetItem.apply(this, arguments);
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
                var toDel = [];
                for (var i = 0; i < localStorage.length; i++) {
                    var k = localStorage.key(i);
                    if (k && k.indexOf('tb_') !== 0) toDel.push(k);
                }
                toDel.forEach(function(k) { localStorage.removeItem(k); });
            } catch(err) {}
            try { localStorage.removeItem(journalKey); } catch(err) {}
        }
        if (e.data.type === 'nexus-apply-game-restore' && e.data.localStorage) {
            // A late parent restore should only fill absent values; replacing
            // existing values here can undo progress made while a tab loads.
            try { Object.keys(e.data.localStorage).forEach(function(k) {
                if (k.indexOf('tb_') !== 0 && localStorage.getItem(k) === null) localStorage.setItem(k, e.data.localStorage[k]);
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

function isMrMineGame(game) {
    const identity = [game && game.id, game && game.sourceKey, game && game.sourceFile, game && game.url]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return /clmrmine(?:\.html)?/.test(identity);
}

function getMrMineMirrorHtml(html, attempt) {
    const mirrorBases = [
        'https://fastly.jsdelivr.net/gh/bubbls/UGS-Assets@main/mr-mine/',
        'https://gcore.jsdelivr.net/gh/bubbls/UGS-Assets@main/mr-mine/',
        'https://raw.githubusercontent.com/bubbls/UGS-Assets/main/mr-mine/'
    ];
    const mirrorBase = mirrorBases[attempt];
    if (!html || !mirrorBase) return null;
    const basePattern = /https:\/\/(?:cdn|fastly|gcore)\.jsdelivr\.net\/gh\/bubbls\/UGS-Assets@main\/mr-mine\/|https:\/\/raw\.githubusercontent\.com\/bubbls\/UGS-Assets\/main\/mr-mine\//ig;
    const mirroredHtml = String(html).replace(basePattern, mirrorBase);
    return mirroredHtml === html ? null : mirroredHtml;
}

function shouldInjectGamePersistence(game, url) {
    if (!game || !url) return false;
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
    return getGameRestoreScript(gameId, snapshot) + getUniversalAutosaveBridge(gameId, saveSessionId);
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
                var host=parsed.hostname.toLowerCase();
                var supportedHost=host==='cdn.jsdelivr.net'||host==='fastly.jsdelivr.net'||host==='gcore.jsdelivr.net'||host==='raw.githubusercontent.com';
                return supportedHost&&parsed.pathname.toLowerCase().indexOf('/mr-mine/')!==-1;
            }catch(e){return false;}
        }
        if(captureMrMineAssets){
            window.__nexusReportMrMineAssetFailure=function(url,reason){
                if(mrMineAssetFailureReported)return;
                mrMineAssetFailureReported=true;
                var message='Required Mr. Mine asset failed after all mirror attempts: '+String(url||'unknown asset')+(reason?' ('+String(reason)+')':'');
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
    const baseHref = new URL('.', new URL(url, window.location.href)).href
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    const baseTag = '<base href="' + baseHref + '">';
    const existingBase = /<base\b[^>]*>/i;
    let documentHtml = html;
    // A page may deliberately host its assets from a different base path.
    // Preserve that declared path; use the source document directory only
    // when the HTML does not specify a base URL.
    if (!existingBase.test(documentHtml)) {
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

function applyGameRunMode(game) {
    if (!game || !game.sourceFile) return game;
    // Standalone Nexus pages registered as extra stash entries already have
    // their own local URL and must not be rewritten to the UGS CDN.
    if (game.nexusKeepLocalUrl) return game;

    const storage = window.nexusStorage || window.localStorage;
    if (storage.getItem('tb_game_run_mode') !== 'external') return game;

    // Only Game Stash entries carry a sourceFile/sourceKey pair. Leave user-added
    // URLs and local custom files on their existing launch paths.
    if (!game.sourceKey && !String(game.id || '').startsWith('stash_')) return game;

    const externalUrl = getVerifiedGameFallbackUrl(game);
    if (!externalUrl) return game;
    if (game.type === 'url' && game.url === externalUrl && game.nexusExternalSource) return game;

    return {
        ...game,
        type: 'url',
        url: externalUrl,
        content: undefined,
        nexusExternalSource: true
    };
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
    game = applyGameRunMode(game);
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
        let mrMineMirrorAttempt = 0;
        const showPopupLoadError = (detail = '') => {
            if (!win.document || !win.document.body) return;
            let panel = win.document.getElementById('nexus-game-load-error');
            if (panel && detail && isMrMineGame(game)) {
                const label = panel.firstElementChild;
                const match = String(detail).match(/https?:\/\/([^/\s)]+)/i);
                if (label) {
                    label.textContent = 'Mr. Mine graphics failed (' + (match ? match[1] : 'asset CDN') + ').';
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
                    label.textContent = 'Mr. Mine graphics failed (' + (match ? match[1] : 'asset CDN') + ').';
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
                const mirrorHtml = getMrMineMirrorHtml(unmodifiedHtml, mrMineMirrorAttempt);
                if (mirrorHtml && launchFrame) {
                    mrMineMirrorAttempt += 1;
                    console.warn('Mr. Mine startup hit an asset error; retrying on an alternate asset route:', detail.message);
                    launchFrame.removeAttribute('src');
                    launchFrame.srcdoc = mirrorHtml;
                    return;
                }
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
                const popupRestore = getGameRestoreScript(game.id, latestSnapshot);
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
                    function saveToIDB(incomingData) {
                        if (!incomingData || !isCurrentSession() || String(incomingData.saveSessionId) !== String(saveSessionId)) return;
                        var ids = gameAliases.slice();
                        if (incomingData.gameId && ids.indexOf(incomingData.gameId) === -1) {
                            ids.push(incomingData.gameId);
                        }
                        var incomingLs = incomingData.localStorage || {};
                        var incomingFs = incomingData.fsData || null;
                        var incomingIdb = incomingData.idbData || null;
                        var payloadSavedAt = Number(incomingData.savedAt);
                        var incomingSavedAt = isFinite(payloadSavedAt) && payloadSavedAt > 0 ? payloadSavedAt : Date.now();
                        try {
                            var req = indexedDB.open("GameStorageDB", 3);
                            req.onupgradeneeded = function(e) {
                                var d = e.target.result;
                                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
                            };
                            req.onsuccess = function(e) {
                                var db = e.target.result;
                                db.onversionchange = function() { try { db.close(); } catch(err) {} };
                                try {
                                    if (!db.objectStoreNames.contains('gameSnapshots')) return;
                                    var tx = db.transaction('gameSnapshots', 'readwrite');
                                    var store = tx.objectStore('gameSnapshots');
                                    var getReq = store.get(ids[0]);
                                    getReq.onsuccess = function() {
                                        var existing = getReq.result || null;
                                        if (existing && Number(existing.savedAt) > incomingSavedAt) return;
                                        var existingData = (existing && existing.localStorage && typeof existing.localStorage === 'object') ? existing.localStorage : {};
                                        var incomingKeys = Object.keys(incomingLs);
                                        var existingKeys = Object.keys(existingData);

                                        var lsToSave = Object.assign({}, incomingLs);
                                        if (incomingKeys.length === 0 && existingKeys.length > 0) {
                                            lsToSave = Object.assign({}, existingData);
                                        } else if (incomingKeys.length > 0 && existingKeys.length > 0) {
                                            lsToSave = Object.assign({}, existingData, incomingLs);
                                        }

                                        var fsToSave = (existing && existing.fsData) ? Object.assign({}, existing.fsData) : null;
                                        if (incomingFs && Object.keys(incomingFs).length > 0) {
                                            fsToSave = Object.assign({}, fsToSave || {}, incomingFs);
                                        }

                                        var idbToSave = (existing && existing.idbData) ? Object.assign({}, existing.idbData) : null;
                                        if (incomingIdb && Object.keys(incomingIdb).length > 0) {
                                            idbToSave = Object.assign({}, idbToSave || {}, incomingIdb);
                                        }

                                        var savedAt = incomingSavedAt;
                                        var history = Array.isArray(existing && existing.history) ? existing.history.slice(-2) : [];
                                        if (existing && existing.localStorage) {
                                            history.push({
                                                localStorage: existing.localStorage,
                                                savedAt: existing.savedAt || savedAt
                                            });
                                        }

                                        ids.forEach(function(targetId) {
                                            if (!targetId) return;
                                            var record = {
                                                gameId: targetId,
                                                localStorage: lsToSave,
                                                fsData: fsToSave,
                                                idbData: idbToSave,
                                                savedAt: savedAt,
                                                history: history
                                            };
                                            try { store.put(record); } catch(err) {}
                                        });
                                    };
                                } catch(txErr) {}
                            };
                        } catch(err) {}
                    }

                    function loadFromIDB(callback) {
                        try {
                            var req = indexedDB.open("GameStorageDB", 3);
                            req.onupgradeneeded = function(e) {
                                var d = e.target.result;
                                if (!d.objectStoreNames.contains('customGames')) d.createObjectStore('customGames', { keyPath: 'id' });
                                if (!d.objectStoreNames.contains('gameSnapshots')) d.createObjectStore('gameSnapshots', { keyPath: 'gameId' });
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
                        if (e.data.type === 'nexus-game-save' && isCurrentSession() && String(e.data.saveSessionId) === String(saveSessionId)) {
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
                                            fsData: snap.fsData || null,
                                            idbData: snap.idbData || null
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
        const mirrorHtml = getMrMineMirrorHtml(activeGameLaunch.bootstrapHtml || frame.srcdoc, activeGameLaunch.mrMineMirrorAttempt || 0);
        if (mirrorHtml) {
            activeGameLaunch.mrMineMirrorAttempt = (activeGameLaunch.mrMineMirrorAttempt || 0) + 1;
            console.warn('Mr. Mine startup hit an asset error; retrying on an alternate asset route:', detail.message);
            frame.removeAttribute('src');
            frame.srcdoc = mirrorHtml;
            return;
        }
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
        const host = match ? match[1] : 'asset CDN';
        text.textContent = 'Mr. Mine graphics failed (' + host + ') - Retry';
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

    game = applyGameRunMode(game);

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
            mrMineMirrorAttempt: 0,
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
                                fsData: snap.fsData || null,
                                idbData: snap.idbData || null
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
    // Auto-navigate back to Game Stash after deletion
    const stash = games.find(g => g.id === "ugs-stash");
    if (stash) loadGame(stash);
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
            if (matched.id) allAliases.add(String(matched.id));
            if (matched.sourceKey) allAliases.add(String(matched.sourceKey));
            if (matched.sourceFile) {
                allAliases.add(String(matched.sourceFile));
                allAliases.add(String(matched.sourceFile.replace(/\.html$/, '')));
                const sfName = String(matched.sourceFile).split('/').pop();
                if (sfName) {
                    allAliases.add(sfName);
                    allAliases.add(sfName.replace(/\.html$/, ''));
                }
            }
            if (matched.title) {
                allAliases.add(String(matched.title).toLowerCase());
                allAliases.add(String(matched.title).toLowerCase().replace(/[^a-z0-9]/g, ''));
            }
            if (matched.sourceKey) {
                allAliases.add('bookmark_' + matched.sourceKey);
                allAliases.add('bookmark_' + encodeURIComponent(matched.sourceKey));
            }
        }
    });

    // 1. Immediately disarm autosaves and issue wipe commands to active iframe and popups
    const disarmMsg = { type: 'nexus-disarm-autosave' };
    const wipeMsg = { type: 'nexus-wipe-game-storage' };

    const frame = document.getElementById('game-frame');
    if (frame && frame.contentWindow) {
        try {
            frame.contentWindow.postMessage(disarmMsg, '*');
            frame.contentWindow.postMessage(wipeMsg, '*');
        } catch (e) {}
    }

    activeGameSessions.forEach(session => {
        const win = session.win;
        if (win && !win.closed) {
            try {
                win.postMessage(disarmMsg, '*');
                win.postMessage(wipeMsg, '*');
            } catch (e) {}
        }
    });

    // Allow a short tick for disarm messages to be processed
    await new Promise(r => setTimeout(r, 60));

    // 2. Discover all snapshots in gameSnapshots belonging to these games
    const keysToRemoveFromLS = new Set();
    const idbDatabasesToWipe = new Set();

    // Check specific known game candidates
    const isBalatro = selectedGames.some(g => {
        const str = ((g.id || '') + ' ' + (g.title || '') + ' ' + (g.sourceFile || '')).toLowerCase();
        return str.includes('balatro');
    });
    if (isBalatro) {
        idbDatabasesToWipe.add('/home/web_user/love');
    }

    const snapshotsToDelete = [];
    await new Promise(resolve => {
        try {
            const tx = db.transaction('gameSnapshots', 'readonly');
            const store = tx.objectStore('gameSnapshots');
            const req = store.openCursor();
            req.onsuccess = e => {
                const cursor = e.target.result;
                if (!cursor) return resolve();
                const snap = cursor.value;
                const snapKey = String(cursor.key);
                const matches = selectedGames.some(g => doesSnapshotBelongToGame(snap, g)) ||
                                allAliases.has(String(snap.gameId)) ||
                                allAliases.has(snapKey);
                if (matches) {
                    snapshotsToDelete.push(cursor.key);
                    if (snap.localStorage && typeof snap.localStorage === 'object') {
                        Object.keys(snap.localStorage).forEach(k => {
                            if (k && !k.startsWith('tb_')) keysToRemoveFromLS.add(k);
                        });
                    }
                    if (snap.idbData && typeof snap.idbData === 'object') {
                        Object.keys(snap.idbData).forEach(dbN => {
                            if (dbN && dbN !== 'GameStorageDB') idbDatabasesToWipe.add(dbN);
                        });
                    }
                }
                cursor.continue();
            };
            req.onerror = () => resolve();
        } catch (e) {
            resolve();
        }
    });

    // 3. Delete all matching snapshots and alias keys from gameSnapshots
    await new Promise(resolve => {
        try {
            const tx = db.transaction('gameSnapshots', 'readwrite');
            const store = tx.objectStore('gameSnapshots');
            snapshotsToDelete.forEach(k => {
                try { store.delete(k); } catch (e) {}
            });
            allAliases.forEach(alias => {
                try { store.delete(alias); } catch (e) {}
            });
            tx.oncomplete = resolve;
            tx.onerror = resolve;
            tx.onabort = resolve;
        } catch (e) {
            resolve();
        }
    });

    // 4. Clear in-memory caches and hashes
    allAliases.forEach(alias => {
        snapshotHashes.delete(alias);
    });
    // 5. Clean localStorage
    try {
        const ls = window.nexusStorage || window.localStorage;
        allAliases.forEach(alias => {
            ls.removeItem(`tb_snap_${alias}`);
            ls.removeItem(`nexus_save_${alias}`);
            ls.removeItem(`save_${alias}`);
        });
        keysToRemoveFromLS.forEach(k => {
            if (k && !k.startsWith('tb_')) ls.removeItem(k);
        });
    } catch (e) {}

    // 6. Delete or clear game-specific IndexedDB databases
    for (const dbName of idbDatabasesToWipe) {
        try {
            window.indexedDB.deleteDatabase(dbName);
        } catch (e) {}
    }

    // 7. If currently loaded game in main frame was cleared, wipe iframe local storage and reload fresh
    const isCurrentGameCleared = currentGame && (
        allAliases.has(String(currentGame.id)) ||
        (currentGame.sourceKey && allAliases.has(String(currentGame.sourceKey))) ||
        (currentGame.sourceFile && allAliases.has(String(currentGame.sourceFile))) ||
        selectedGames.some(g => g.id === currentGame.id)
    );

    if (isCurrentGameCleared && frame) {
        try {
            if (frame.contentWindow && frame.contentWindow.localStorage) {
                const subLs = frame.contentWindow.localStorage;
                const toDel = [];
                for (let i = 0; i < subLs.length; i++) {
                    const k = subLs.key(i);
                    if (k && !k.startsWith('tb_')) toDel.push(k);
                }
                toDel.forEach(k => subLs.removeItem(k));
            }
        } catch (e) {}
        loadGame(currentGame, true);
    }

    // 8. If any popup is open for a cleared game, reload it
    activeGameSessions.forEach(session => {
        const win = session.win;
        const gameId = session.gameId;
        if (win && !win.closed && (allAliases.has(String(gameId)) || selectedGames.some(g => String(g.id) === String(gameId)))) {
            try {
                if (win.localStorage) {
                    const subLs = win.localStorage;
                    const toDel = [];
                    for (let i = 0; i < subLs.length; i++) {
                        const k = subLs.key(i);
                        if (k && !k.startsWith('tb_')) toDel.push(k);
                    }
                    toDel.forEach(k => subLs.removeItem(k));
                }
            } catch (e) {}
            try {
                win.location.reload();
            } catch (e) {}
        }
    });
}

function openSavesSelection(gameList) {
    const overlay = document.getElementById('saves-select-overlay');
    const list = document.getElementById('saves-game-list');
    if (!overlay || !list) return Promise.resolve(null);
    list.innerHTML = '';

    if (!gameList || gameList.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'padding: 16px; text-align: center; color: var(--muted-text, #9e93b8); font-size: 14px;';
        emptyMsg.textContent = 'No games in your sidebar.';
        list.appendChild(emptyMsg);
    } else {
        gameList.forEach(game => {
            const label = document.createElement('label');
            label.className = 'saves-item-label';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'saves-item-checkbox';
            checkbox.value = game.id;
            checkbox.checked = false;

            const text = document.createElement('span');
            text.className = 'saves-item-text';
            text.textContent = (typeof getSidebarTitle === 'function' ? getSidebarTitle(game) : '') || game.title || game.id;

            const updateVisual = () => {
                if (checkbox.checked) {
                    label.classList.add('saves-selected');
                } else {
                    label.classList.remove('saves-selected');
                }
            };

            checkbox.addEventListener('change', updateVisual);

            label.append(checkbox, text);
            list.appendChild(label);
        });
    }

    overlay.style.display = 'flex';
    if (window.setGamePopupState) window.setGamePopupState('saves-select-overlay', true);

    return new Promise(resolve => {
        const finish = value => {
            overlay.style.display = 'none';
            if (window.setGamePopupState) window.setGamePopupState('saves-select-overlay', false);
            resolve(value);
        };

        const selectAllBtn = document.getElementById('saves-select-all');
        if (selectAllBtn) {
            selectAllBtn.onclick = () => {
                list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = true;
                    cb.closest('.saves-item-label')?.classList.add('saves-selected');
                });
            };
        }

        const selectNoneBtn = document.getElementById('saves-select-none');
        if (selectNoneBtn) {
            selectNoneBtn.onclick = () => {
                list.querySelectorAll('input[type="checkbox"]').forEach(cb => {
                    cb.checked = false;
                    cb.closest('.saves-item-label')?.classList.remove('saves-selected');
                });
            };
        }

        const cancelBtn = document.getElementById('saves-select-cancel');
        if (cancelBtn) cancelBtn.onclick = () => finish(null);

        const confirmBtn = document.getElementById('saves-select-confirm');
        if (confirmBtn) {
            confirmBtn.onclick = () => {
                const checked = Array.from(list.querySelectorAll('input[type="checkbox"]:checked'));
                finish(checked.map(cb => cb.value));
            };
        }
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

const savesBtn = document.getElementById('saves-btn');
if (savesBtn) {
    savesBtn.onclick = async () => {
        // List games in the user's sidebar (excluding Game Stash)
        const sidebarGames = games.filter(g => g && g.id !== 'ugs-stash');
        const selectedIds = await openSavesSelection(sidebarGames);
        if (!selectedIds || selectedIds.length === 0) return;

        // Show red popup confirmation dialog
        const confirmed = await showRedConfirmDialog(
            "Hold up, these games' saves will be deleted forever (A long time!) Are you sure you want to proceed?"
        );

        if (!confirmed) return;

        await clearGameSaves(selectedIds);
        nexusAlert("Selected games' saves have been cleared.");
    };
}

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
