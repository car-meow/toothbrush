const dbName = "GameStorageDB";
let db, games =[], currentGame = null;
const popupMuteSources = new Set();
const loadingGames = new Map();
let defaultGamesPromise = null;
let dbReadyPromise = null;
let gameLoadToken = 0;
let gameAutosaveTimer = null;
const loadedGameSnapshots = new WeakMap();
const snapshotHashes = new Map();
const popupGameWindows = new Map();


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
    const localStorage = window.nexusStorage;
    await initDB();
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
    const isLegacySurvivalRaceV2 = game => {
        const values = [game && game.id, game && game.sourceKey, game && game.sourceFile, game && game.title, game && game.url];
        return values.some(value => String(value || '').toLowerCase()
            .replace(/\.(?:html?|url)$/i, '')
            .replace(/[\s_-]+/g, '')
            .includes('survivalracev2'));
    };
    const legacyIds = custom.filter(isLegacySurvivalRaceV2).map(game => game.id);
    if (legacyIds.length) {
        const cleanupTx = db.transaction(['customGames', 'gameSnapshots'], 'readwrite');
        const cleanupStore = cleanupTx.objectStore('customGames');
        const snapshotStore = cleanupTx.objectStore('gameSnapshots');
        legacyIds.forEach(id => {
            cleanupStore.delete(id);
            snapshotStore.delete(id);
        });
        await new Promise(resolve => { cleanupTx.oncomplete = cleanupTx.onerror = cleanupTx.onabort = resolve; });
    }
    const activeCustom = custom.filter(game => !isLegacySurvivalRaceV2(game));
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
    const savedOrder = localStorage.getItem('sidebar-game-order');
    if (savedOrder) {
        try {
            const orderIds = JSON.parse(savedOrder);
            const gameMap = new Map(games.map(g => [g.id.toString(), g]));
            const ordered = [];
            // First place games in saved order
            orderIds.forEach(id => {
                if (gameMap.has(id)) {
                    ordered.push(gameMap.get(id));
                    gameMap.delete(id);
                }
            });
            // Append any new games not in the saved order
            gameMap.forEach(g => ordered.push(g));
            games = ordered;
        } catch(e) { /* ignore bad data */ }
    }

    if (pinMasterStash()) saveGameOrder();
    renderGameList();
    openDefaultGame();

    // Fade page in once list is loaded and rendered
    const overlay = document.getElementById('page-fade-overlay');
    if (overlay) overlay.classList.add('fade-out');

    initCarmeowTutorial();
}

function openDefaultGame() {
    if (currentGame || !document.getElementById('game-frame')) return;
    const preferredGame = games.find(g => g.id === "ugs-stash") || games[0];
    if (preferredGame) loadGame(preferredGame);
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
    const localStorage = window.nexusStorage;
    pinMasterStash();
    const orderIds = games.map(g => g.id.toString());
    localStorage.setItem('sidebar-game-order', JSON.stringify(orderIds));
}

/* =========================================
   SIDEBAR COLOR SCHEMES
   Each entry: { fill, border, text }
   fill = background, border = slightly darker, text = contrast label color
========================================= */
const SIDEBAR_COLOR_SCHEMES = [
    { id: 'blue',   fill: 'hsl(213,70%,28%)',  border: 'hsl(213,70%,18%)',  text: '#e8f0ff' },
    { id: 'green',  fill: 'hsl(140,55%,22%)',  border: 'hsl(140,55%,13%)',  text: '#d4f5e0' },
    { id: 'red',    fill: 'hsl(0,62%,30%)',    border: 'hsl(0,62%,19%)',    text: '#ffdada' },
    { id: 'orange', fill: 'hsl(28,72%,30%)',   border: 'hsl(28,72%,19%)',   text: '#ffe5c2' },
    { id: 'yellow', fill: 'hsl(48,72%,26%)',   border: 'hsl(48,72%,15%)',   text: '#fff8c0' },
    { id: 'purple', fill: 'hsl(275,55%,28%)',  border: 'hsl(275,55%,17%)',  text: '#f0daff' },
    { id: 'pink',   fill: 'hsl(335,60%,28%)',  border: 'hsl(335,60%,17%)',  text: '#ffdaea' },
    { id: 'teal',   fill: 'hsl(180,55%,22%)',  border: 'hsl(180,55%,13%)',  text: '#d0f5f5' },
    { id: 'indigo', fill: 'hsl(240,55%,30%)',  border: 'hsl(240,55%,19%)',  text: '#dce0ff' },
];

// Swatch fill colors (the circle itself) — vivid so they're recognizable
const SWATCH_COLORS = [
    'hsl(213,80%,50%)',
    'hsl(140,65%,38%)',
    'hsl(0,72%,50%)',
    'hsl(28,88%,50%)',
    'hsl(48,88%,50%)',
    'hsl(275,70%,55%)',
    'hsl(335,75%,55%)',
    'hsl(180,70%,38%)',
    'hsl(240,70%,58%)',
];

function applyGameColorToLi(li, game) {
    if (!game || !game.sidebarColor) {
        li.style.removeProperty('background-color');
        li.style.removeProperty('border-color');
        li.style.removeProperty('color');
        li.style.removeProperty('--li-bg');
        return;
    }
    const scheme = SIDEBAR_COLOR_SCHEMES.find(s => s.id === game.sidebarColor);
    if (!scheme) return;
    li.style.setProperty('background-color', scheme.fill, 'important');
    li.style.setProperty('border-color', scheme.border, 'important');
    li.style.setProperty('color', scheme.text, 'important');
    li.style.setProperty('--li-bg', scheme.fill);
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

    const existingIndex = games.findIndex(item => item.id === sidebarGame.id);
    if (existingIndex !== -1) games.splice(existingIndex, 1);

    const stashIndex = games.findIndex(item => item.id === 'ugs-stash');
    games.splice(stashIndex === -1 ? 0 : stashIndex + 1, 0, sidebarGame);
    saveGameOrder();
    renderGameList();
    notifyStashBookmarkAvailability();
};

async function getGameSnapshot(gameId) {
    if (!gameId) return null;
    await initDB();
    return new Promise(resolve => {
        const tx = db.transaction('gameSnapshots', 'readonly');
        const req = tx.objectStore('gameSnapshots').get(gameId);
        req.onsuccess = () => resolve(req.result ? req.result.localStorage : null);
        req.onerror = () => resolve(null);
    });
}

async function saveGameSnapshot(gameId, localStorageData) {
    if (!gameId || !localStorageData || typeof localStorageData !== 'object') return;
    await initDB();

    const existing = await new Promise(resolve => {
        try {
            const req = db.transaction('gameSnapshots', 'readonly').objectStore('gameSnapshots').get(gameId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });

    const incomingKeys = Object.keys(localStorageData);
    const existingData = (existing && existing.localStorage && typeof existing.localStorage === 'object') ? existing.localStorage : {};
    const existingKeys = Object.keys(existingData);

    // Protection: If incoming snapshot is empty ({}) or only transient, but existing snapshot has valid progress,
    // do NOT wipe out existing progress data.
    let dataToSave = { ...localStorageData };
    if (incomingKeys.length === 0 && existingKeys.length > 0) {
        dataToSave = { ...existingData };
    } else if (incomingKeys.length > 0 && existingKeys.length > 0) {
        dataToSave = { ...existingData, ...localStorageData };
    }

    const hash = JSON.stringify(dataToSave);
    if (snapshotHashes.get(gameId) === hash && existing) return;

    const savedAt = Date.now();
    const history = Array.isArray(existing && existing.history) ? existing.history.slice(-4) : [];
    if (existing && existing.localStorage && Object.keys(existing.localStorage).length > 0) {
        history.push({ localStorage: existing.localStorage, savedAt: existing.savedAt || savedAt });
    }

    const tx = db.transaction('gameSnapshots', 'readwrite');
    const store = tx.objectStore('gameSnapshots');
    store.put({ gameId, localStorage: dataToSave, savedAt, history });
    snapshotHashes.set(gameId, hash);

    // Immediately synchronize in-memory caches across all references
    games.forEach(g => {
        if (g && g.id === gameId) {
            loadedGameSnapshots.set(g, dataToSave);
        }
    });
    if (currentGame && currentGame.id === gameId) {
        loadedGameSnapshots.set(currentGame, dataToSave);
    }

    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function requestCurrentGameAutosave() {
    const frame = document.getElementById('game-frame');
    if (frame && frame.contentWindow) {
        try { frame.contentWindow.postMessage({ type: 'nexus-request-game-save' }, '*'); } catch (e) {}
    }
    // Also message active popup windows
    popupGameWindows.forEach((win) => {
        if (win && !win.closed) {
            try { win.postMessage({ type: 'nexus-request-game-save' }, '*'); } catch (e) {}
        }
    });
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function encodeBackupValue(value) {
    if (value instanceof ArrayBuffer) {
        return { __nexusBinary: 'ArrayBuffer', data: bytesToBase64(new Uint8Array(value)) };
    }
    if (ArrayBuffer.isView(value)) {
        return { __nexusBinary: value.constructor.name, data: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    }
    if (Array.isArray(value)) return value.map(encodeBackupValue);
    if (value && typeof value === 'object') {
        const copy = {};
        Object.keys(value).forEach(key => { copy[key] = encodeBackupValue(value[key]); });
        return copy;
    }
    return value;
}

function decodeBackupValue(value) {
    if (value && value.__nexusBinary) {
        const bytes = base64ToBytes(value.data || '');
        if (value.__nexusBinary === 'ArrayBuffer') return bytes.buffer;
        const constructors = { Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array };
        const Ctor = constructors[value.__nexusBinary] || Uint8Array;
        const elementSize = Ctor.BYTES_PER_ELEMENT || 1;
        return new Ctor(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / elementSize));
    }
    if (Array.isArray(value)) return value.map(decodeBackupValue);
    if (value && typeof value === 'object') {
        const copy = {};
        Object.keys(value).forEach(key => { copy[key] = decodeBackupValue(value[key]); });
        return copy;
    }
    return value;
}

function startGameAutosave() {
    if (gameAutosaveTimer) clearInterval(gameAutosaveTimer);
    // Continuous periodic sync heartbeat
    gameAutosaveTimer = setInterval(requestCurrentGameAutosave, 5000);
}

window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'nexus-game-save') return;

    const frame = document.getElementById('game-frame');
    const isEmbeddedGame = frame && event.source === frame.contentWindow;
    let isKnownPopup = false;
    if (message.gameId && popupGameWindows.has(message.gameId)) {
        const win = popupGameWindows.get(message.gameId);
        if (win === event.source || (win && win.closed)) isKnownPopup = true;
    }
    for (const [, win] of popupGameWindows.entries()) {
        if (win === event.source) { isKnownPopup = true; break; }
    }

    const originSafe = !event.origin || event.origin === 'null' || event.origin === window.location.origin || window.location.protocol === 'file:';
    if (!originSafe && !isEmbeddedGame && !isKnownPopup) return;

    const gameId = message.gameId || (currentGame && currentGame.id ? currentGame.id : null);
    if (gameId && message.localStorage) {
        saveGameSnapshot(gameId, message.localStorage).catch(() => {});
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) requestCurrentGameAutosave();
}, { passive: true });

window.addEventListener('pagehide', requestCurrentGameAutosave, { passive: true });
window.addEventListener('beforeunload', requestCurrentGameAutosave, { passive: true });

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
        if (game.isNew) li.classList.add('new-game');

        // Apply saved color scheme
        if (game.id !== "ugs-stash" && game.sidebarColor) {
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
            rename.innerHTML = '<img src="Assets/Rename.svg" alt="Edit" style="width:18px;height:18px;filter:brightness(0) invert(1);vertical-align:middle;">';
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
            del.innerHTML = '<img src="Assets/Delete.svg" alt="Delete" style="width:18px;height:18px;filter:brightness(0) invert(1);vertical-align:middle;">';
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
            dragZone.innerHTML = '<img src="Assets/drag.svg" alt="drag">';
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
    message.addEventListener('animationend', () => message.remove(), { once: true });
}

function isUserManagedGame(game) {
    const id = game && game.id ? game.id.toString() : "";
    return id.startsWith("custom_") || id.startsWith("bookmark_");
}

function getSidebarTitle(game) {
    if (game && game.sourceKey && !game.userRenamed && typeof humanizeBookmarkDisplayName === "function") {
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

    const { li, index, indicator, list } = dragState;

    let actualNewIndex = 0;
    for (let sibling = indicator.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.matches('li:not(.dragging)')) actualNewIndex++;
    }

    const firstMovableIndex = getFirstMovableIndex();
    const maxInsertIndex = Math.max(firstMovableIndex, games.length - 1);
    actualNewIndex = Math.max(firstMovableIndex, Math.min(actualNewIndex, maxInsertIndex));

    // Clean up the dragged element styles
    li.style.position = '';
    li.style.width = '';
    li.style.left = '';
    li.style.top = '';
    li.style.margin = '';
    li.classList.remove('dragging');
    document.body.classList.remove('app-is-dragging');

    // Remove indicator
    if (indicator.parentNode) indicator.parentNode.removeChild(indicator);

    // Move in the games array
    if (index >= firstMovableIndex && index !== actualNewIndex) {
        const [moved] = games.splice(index, 1);
        games.splice(actualNewIndex, 0, moved);
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

function getUniversalAutosaveBridge(gameId) {
    return `<script>
(function() {
    var gameId = ${JSON.stringify(gameId)};
    var syncing = false;
    var syncTimer = null;
    var lastSavedHash = '';

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

    function sendSave(immediate) {
        try {
            var data = getStorageSnapshot();
            var currentHash = JSON.stringify(data);
            if (!immediate && currentHash === lastSavedHash) return;
            lastSavedHash = currentHash;

            var msg = { type: 'nexus-game-save', gameId: gameId, localStorage: data };
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
        if (syncing) return;
        syncing = true;
        try {
            var fs = window.FS || (window.Module && window.Module.FS);
            if (fs && typeof fs.syncfs === 'function') {
                fs.syncfs(false, function() {
                    syncing = false;
                    sendSave(immediate);
                });
                return;
            }
        } catch(e) {}
        syncing = false;
        sendSave(immediate);
    }

    function debounceSync(delay) {
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
            if (this === localStorage && k && k.indexOf('tb_') !== 0) {
                debounceSync(300);
            }
            return res;
        };
        var origRemoveItem = Storage.prototype.removeItem;
        Storage.prototype.removeItem = function(k) {
            var res = origRemoveItem.apply(this, arguments);
            if (this === localStorage && k && k.indexOf('tb_') !== 0) {
                debounceSync(300);
            }
            return res;
        };
        var origClear = Storage.prototype.clear;
        Storage.prototype.clear = function() {
            var res = origClear.apply(this, arguments);
            if (this === localStorage) {
                debounceSync(300);
            }
            return res;
        };
    } catch(e) {}

    // Emscripten / WASM Filesystem Sync Hook
    function hookFS() {
        try {
            var fs = window.FS || (window.Module && window.Module.FS);
            if (fs && typeof fs.syncfs === 'function' && !fs._nexusHooked) {
                fs._nexusHooked = true;
                var origSyncfs = fs.syncfs;
                fs.syncfs = function(populate, callback) {
                    return origSyncfs.call(this, populate, function(err) {
                        if (typeof callback === 'function') callback(err);
                        if (!populate) {
                            debounceSync(200);
                        }
                    });
                };
            }
        } catch(e) {}
    }
    hookFS();
    setInterval(hookFS, 1000);

    // Multi-Trigger Auto-Sync
    window.addEventListener('storage', function() { debounceSync(200); }, { passive: true });
    window.addEventListener('message', function(e) {
        if (e.data && e.data.type === 'nexus-request-game-save') syncAndSend(true);
    });
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) syncAndSend(true);
    }, { passive: true });
    window.addEventListener('blur', function() { syncAndSend(false); }, { passive: true });
    window.addEventListener('pagehide', function() { syncAndSend(true); }, { passive: true });
    window.addEventListener('beforeunload', function() { syncAndSend(true); }, { passive: true });

    setInterval(function() { syncAndSend(false); }, 3000);
    window.addEventListener('pointerup', function() { debounceSync(1500); }, { passive: true });
    window.addEventListener('keyup', function() { debounceSync(1500); }, { passive: true });
})();
<\/script>`;
}

function launchGameFullscreen(game) {
    if (!game || game.id === "ugs-stash") return;

    // Open about:blank synchronously on the user click gesture to avoid browser popup blocking
    const win = window.open('about:blank', '_blank');
    if (!win) {
        nexusAlert("Pop-up blocked! Please allow pop-ups to open games.");
        return;
    }
    if (game && game.id) popupGameWindows.set(game.id, win);
    try { win.focus(); } catch(e) {}

    // Apply Cloaking Preset
    try {
        const localStorage = window.nexusStorage;
        const preset = localStorage.getItem('tb_cloak_preset');
        if (preset === 'drive') {
            win.document.title = "My Drive - Google Drive";
            const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'Assets/drive_cloak.png';
            win.document.head.appendChild(link);
        } else if (preset === 'wikipedia') {
            win.document.title = "Wikipedia, the free encyclopedia";
            const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'https://en.wikipedia.org/favicon.ico';
            win.document.head.appendChild(link);
        } else if (preset === 'canvas') {
            win.document.title = "Dashboard";
            const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'Assets/canvas_cloak.png';
            win.document.head.appendChild(link);
        } else {
            win.document.title = game.title || "Game";
            const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'data:,';
            win.document.head.appendChild(link);
        }
    } catch(e) {}

    // Asynchronously load content/snapshots and initialize game document inside about:blank
    (async () => {
        try {
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
                const latestSnapshot = await getGameSnapshot(game.id);
                loadedGameSnapshots.set(game, latestSnapshot || {});

                const rawHtml = atob(game.content.split(',')[1]);
                const isUnityRuntime = /(?:createUnityInstance|UnityLoader|unity-container|unity-canvas)/i.test(rawHtml);
                const unityCompatibility = isUnityRuntime
                    ? `<script>(function(){var nativeAlert=window.alert;window.alert=function(message){var text=String(message||'');if(text.indexOf('timestamp.getTime is not a function')!==-1){console.warn('Ignored Unity IndexedDB timestamp warning.');return;}return nativeAlert.apply(this,arguments);};})();<\/script>`
                    : '';
                const snapshot = loadedGameSnapshots.get(game) || {};
                const snapshotJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');
                const popupBridge = getUniversalAutosaveBridge(game.id);
                const popupRestore = `<script>(function(){try{var s=${snapshotJson};Object.keys(s).forEach(function(k){if(k.indexOf('tb_')!==0)localStorage.setItem(k,s[k]);});}catch(e){}})();<\/script>`;
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

                const gameSrcDoc = injectGameBootstrap(rawHtml, unityCompatibility + popupRestore + popupBridge + autoFocusScript);
                win.document.open();
                win.document.write(gameSrcDoc);
                win.document.close();
                setTimeout(() => { try { win.focus(); } catch (e) {} }, 100);
            } else {
                const ifr = win.document.createElement('iframe');
                Object.assign(ifr.style, { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', border: 'none' });
                ifr.setAttribute('allow', 'allow-storage-access-by-user-activation; storage-access; fullscreen; autoplay');
                ifr.src = game.url;
                win.document.body.style.margin = '0';
                win.document.body.style.padding = '0';
                win.document.body.style.overflow = 'hidden';
                win.document.body.appendChild(ifr);

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
            }
        } catch(err) {
            console.error("Error launching game in fullscreen window:", err);
        }
    })();
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
    if (!html.includes('nexus-loading-screen')) {
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

    // Max wait timer failsafe
    maxWaitTimer = setTimeout(function() {
        if (!isDone) completeLoading();
    }, 8000);

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

function updateGameStatusUI(state) {
    const container = document.getElementById('game-status-container');
    const icon = document.getElementById('game-status-icon');
    const text = document.getElementById('game-status-text');

    if (!container || !icon || !text) return;

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

function ensureStashPreloaded() {
    const localStorage = window.nexusStorage;
    const isPreloadEnabled = localStorage.getItem('tb_preload_stash') === 'true';
    const stashFrame = document.getElementById('stash-frame');

    if (isPreloadEnabled && stashFrame && !isStashPreloaded) {
        stashFrame.src = 'clSINGLEFILE.html';
        stashFrame.onload = () => {
            isStashPreloaded = true;
        };
    }
}

async function loadGame(game, forceInternal = false) {
    if (!game) return;

    if (game.isNew) {
        game.isNew = false;
        saveGameRecord(game).catch(() => {});
        const li = document.querySelector(`li[data-game-id="${game.id}"]`);
        if (li) li.classList.remove('new-game');
    }

    const localStorage = window.nexusStorage;
    const isDebugFS = localStorage.getItem('tb_debug_fullscreen') === 'true';
    const isPreloadEnabled = localStorage.getItem('tb_preload_stash') === 'true';

    // If Debug Fullscreen is OFF (default) and launching a non-stash game from sidebar,
    // open the fullscreen window immediately on the synchronous user click event!
    if (!isDebugFS && !forceInternal && game && game.id !== "ugs-stash") {
        launchGameFullscreen(game);
        return;
    }

    const requestedLoadToken = ++gameLoadToken;

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
        loadedGameSnapshots.set(game, latestSnapshot || {});

        if (requestedLoadToken !== gameLoadToken) return;
    }

    releaseInactiveGameContent(game);
    currentGame = game;
    const cloakBtn = document.getElementById('cloak-btn');
    if (cloakBtn) {
        if (isDebugFS && game && game.id !== "ugs-stash") {
            cloakBtn.style.display = 'inline-flex';
        } else {
            cloakBtn.style.display = 'none';
        }
    }

    const frame = document.getElementById('game-frame');
    const stashFrame = document.getElementById('stash-frame');
    const emergencyBtn = document.getElementById('emergency-open-btn');
    const emptyState = document.getElementById('empty-state');

    if (emptyState) emptyState.style.display = 'none';
    if (emergencyBtn) emergencyBtn.style.display = 'inline-flex';

    // Handle Game Stash loading with Preload support
    if (game && game.id === "ugs-stash" && isPreloadEnabled && stashFrame) {
        if (frame) frame.style.setProperty('display', 'none', 'important');
        stashFrame.style.setProperty('display', 'block', 'important');
        stashFrame.style.setProperty('visibility', 'visible', 'important');
        stashFrame.style.opacity = '1';

        if (!isStashPreloaded || !stashFrame.src || stashFrame.src.endsWith('about:blank')) {
            updateGameStatusUI('loading');
            stashFrame.src = 'clSINGLEFILE.html';
            stashFrame.onload = () => {
                isStashPreloaded = true;
                updateGameStatusUI('loaded');
            };
        } else {
            updateGameStatusUI('loaded');
        }
        return;
    }

    // Standard Game Loading
    if (stashFrame) stashFrame.style.setProperty('display', 'none', 'important');
    if (frame) {
        try {
            if (frame.src && frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
        } catch (e) {}
        frame.removeAttribute('src');
        frame.removeAttribute('srcdoc');
        frame.style.setProperty('display', 'block', 'important');
        frame.style.setProperty('visibility', 'hidden', 'important');
        frame.style.opacity = '0';
        frame.style.transition = 'opacity 0.25s ease';
        frame.removeAttribute('sandbox'); // Allow full storage & WebAssembly capabilities

        updateGameStatusUI('loading');

        frame.onload = () => {
            updateGameStatusUI('loaded');
            frame.style.setProperty('visibility', 'visible', 'important');
            frame.style.opacity = '1';
        };

        if (game.type === 'file') {
            const base64Data = game.content.split(',')[1];
            let htmlContent;
            try { htmlContent = atob(base64Data); } catch(e) { nexusAlert("File corrupted."); return; }

            const isUnityRuntime = /(?:createUnityInstance|UnityLoader|unity-container|unity-canvas)/i.test(htmlContent);
            const snapshot = loadedGameSnapshots.get(game) || {};
            const snapshotJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');
            const unityCompatibility = isUnityRuntime
                ? `<script>(function(){var nativeAlert=window.alert;window.alert=function(message){var text=String(message||'');if(text.indexOf('timestamp.getTime is not a function')!==-1){console.warn('Ignored Unity IndexedDB timestamp warning.');return;}return nativeAlert.apply(this,arguments);};})();<\/script>`
                : '';
            const restoreScript = `<script>(function(){try{var s=${snapshotJson};Object.keys(s).forEach(function(k){if(k.indexOf('tb_')!==0)localStorage.setItem(k,s[k]);});}catch(e){}})();<\/script>`;
            const autosaveBridge = getUniversalAutosaveBridge(game.id);
            const persistenceScript = `<script>try{window.localStorage.setItem('p','1');}catch(e){}<\/script>`;
            const finalHTML = injectGameBootstrap(htmlContent, unityCompatibility + restoreScript + persistenceScript + autosaveBridge);

            try {
                const blob = new Blob([finalHTML], { type: 'text/html' });
                frame.removeAttribute('srcdoc');
                frame.src = URL.createObjectURL(blob);
            } catch (err1) {
                try {
                    frame.srcdoc = finalHTML;
                } catch (err2) {
                    frame.src = game.content; 
                }
            }
        } else {
            frame.removeAttribute('srcdoc');
            if (game.url.endsWith('.pdf')) frame.removeAttribute('sandbox');
            frame.src = game.url;
        }
    }

    if (isPreloadEnabled) {
        ensureStashPreloaded();
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
            games.push(newG); renderGameList();
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
    SIDEBAR_COLOR_SCHEMES.forEach((scheme, idx) => {
        const btn = document.createElement('button');
        btn.className = 'color-swatch-btn';
        btn.dataset.colorId = scheme.id;
        btn.title = scheme.id.charAt(0).toUpperCase() + scheme.id.slice(1);
        btn.style.background = SWATCH_COLORS[idx];
        btn.style.setProperty('--swatch-border', scheme.border);
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

const exportBtn = document.getElementById('export-btn');
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
function openBackupSelection(gameList, title, hint) {
    const overlay = document.getElementById('backup-select-overlay');
    const list = document.getElementById('backup-game-list');
    if (!overlay || !list) return Promise.resolve(null);
    document.getElementById('backup-select-title').textContent = title;
    document.getElementById('backup-select-hint').textContent = hint;
    list.innerHTML = '';
    gameList.forEach(game => {
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--border-color);border-radius:8px;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.value = game.id; checkbox.checked = true;
        const text = document.createElement('span');
        text.textContent = game.title || game.id;
        label.append(checkbox, text);
        list.appendChild(label);
    });
    const settings = document.getElementById('backup-include-settings');
    settings.checked = false;
    overlay.style.display = 'flex';
    if (window.setGamePopupState) window.setGamePopupState('backup-select-overlay', true);
    return new Promise(resolve => {
        const finish = value => {
            overlay.style.display = 'none';
            if (window.setGamePopupState) window.setGamePopupState('backup-select-overlay', false);
            resolve(value);
        };
        document.getElementById('backup-select-all').onclick = () => list.querySelectorAll('input').forEach(input => input.checked = true);
        document.getElementById('backup-select-none').onclick = () => list.querySelectorAll('input').forEach(input => input.checked = false);
        document.getElementById('backup-select-cancel').onclick = () => finish(null);
        document.getElementById('backup-select-confirm').onclick = () => finish({
            ids: new Set(Array.from(list.querySelectorAll('input:checked')).map(input => input.value)),
            includeSettings: settings.checked
        });
    });
}

if (exportBtn) {
    exportBtn.onclick = async () => {
        const selection = await openBackupSelection(
            games.filter(game => game.id !== 'ugs-stash' && isUserManagedGame(game)),
            'Select Games to Back Up',
            'Only selected games and their saves will be included.'
        );
        if (!selection) return;
        const originalText = exportBtn.textContent;
        exportBtn.disabled = true;
        exportBtn.textContent = "Saving...";

        let fileHandle = null;
        try {
            // Try to open the modern Save File Picker instantly to capture user gesture
            if ('showSaveFilePicker' in window) {
                fileHandle = await window.showSaveFilePicker({
                    suggestedName: 'nexus_backup.json',
                    types: [{
                        description: 'JSON Backup Files',
                        accept: {
                            'application/json': ['.json']
                        }
                    }]
                });
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                // User cancelled the file picker dialog
                exportBtn.disabled = false;
                exportBtn.textContent = originalText;
                return;
            }
            console.warn("File System Access API failed or unsupported:", err);
        }

        try {
            const localStorage = window.nexusStorage;
            // Gather custom games
            const tx = db.transaction('customGames', 'readonly');
            const customGames = await new Promise(r => {
                const req = tx.objectStore('customGames').getAll();
                req.onsuccess = () => r(req.result);
                req.onerror = () => r([]);
            });
            const snapshotTx = db.transaction('gameSnapshots', 'readonly');
            const gameSnapshots = await new Promise(r => {
                const req = snapshotTx.objectStore('gameSnapshots').getAll();
                req.onsuccess = () => r(req.result || []);
                req.onerror = () => r([]);
            });

            // Gather all saves from localStorage
            const allSaves = {};
            if (selection.includeSettings) {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    allSaves[key] = localStorage.getItem(key);
                }
            }

            // Gather IndexedDB databases
            const idbData = {};
            if (window.indexedDB.databases) {
                const dbs = await window.indexedDB.databases();
                for (let dbInfo of dbs) {
                    if (dbInfo.name === "GameStorageDB") continue;
                    
                    const gameDB = await new Promise(res => {
                        const req = indexedDB.open(dbInfo.name);
                        req.onsuccess = () => res(req.result);
                        req.onerror = () => res(null);
                        req.onblocked = () => res(null);
                    });
                    if (!gameDB) continue;

                    const dbContent = { __version: gameDB.version };
                    for (let storeName of gameDB.objectStoreNames) {
                        const storeTx = gameDB.transaction(storeName, 'readonly');
                        const store = storeTx.objectStore(storeName);
                        
                        // Extract schema metadata
                        const keyPath = store.keyPath;
                        const autoIncrement = store.autoIncrement;
                        const indexes = Array.from(store.indexNames).map(indexName => {
                            const index = store.index(indexName);
                            return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                        });

                        // Use a cursor to preserve both key and value
                        const records = [];
                        await new Promise(res => {
                            const reqCursor = store.openCursor();
                            reqCursor.onsuccess = e => {
                                const cursor = e.target.result;
                                if (cursor) {
                                    records.push({ key: cursor.key, value: encodeBackupValue(cursor.value) });
                                    cursor.continue();
                                } else {
                                    res();
                                }
                            };
                            reqCursor.onerror = () => res();
                        });

                        dbContent[storeName] = {
                            keyPath: keyPath,
                            autoIncrement: autoIncrement,
                            indexes,
                            records: records
                        };
                    }
                    idbData[dbInfo.name] = dbContent;
                    gameDB.close();
                }
            }

            const sidebarOrder = localStorage.getItem('sidebar-game-order');
            const selectedGames = customGames.filter(game => selection.ids.has(game.id));
            const selectedIds = new Set(selectedGames.map(game => game.id));
            const selectedSnapshots = gameSnapshots.filter(snapshot => selectedIds.has(snapshot.gameId));
            const selectedTokens = selectedGames.flatMap(game => [String(game.id), String(game.title || '')].map(value => value.toLowerCase().replace(/[^a-z0-9]/g, '')));
            const selectedIndexedData = Object.fromEntries(Object.entries(idbData).filter(([name]) => {
                const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
                return selectedTokens.some(token => token.length > 3 && normalized.includes(token));
            }));
            const colors = {};
            selectedGames.forEach(game => {
                if (game && game.sidebarColor) colors[game.id] = game.sidebarColor;
            });
            const backupData = {
                version: 3,
                scope: { type: 'selective', gameIds: Array.from(selectedIds), includeGlobalSettings: selection.includeSettings },
                saves: allSaves,
                indexedData: selectedIndexedData,
                games: selectedGames,
                gameLibrary: { games: selectedGames, sidebarOrder, colors },
                gameSnapshots: selectedSnapshots
            };
            const jsonStr = JSON.stringify(backupData);

            if (fileHandle) {
                const writable = await fileHandle.createWritable();
                await writable.write(jsonStr);
                await writable.close();
            } else {
                // Fallback to traditional link download
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'nexus_backup.json';
                a.click();
            }
        } catch (e) {
            console.error("Backup failed:", e);
            nexusAlert("Backup failed: " + e.message);
        } finally {
            exportBtn.disabled = false;
            exportBtn.textContent = originalText;
        }
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

const importBtn = document.getElementById('import-btn');
if (importBtn) {
    async function releaseGameFramesForRestore() {
        currentGame = null;
        gameLoadToken++;
        [document.getElementById('game-frame'), document.getElementById('stash-frame')].forEach(frame => {
            if (!frame) return;
            try {
                if (frame.src && frame.src.startsWith('blob:')) URL.revokeObjectURL(frame.src);
            } catch (e) {}
            frame.removeAttribute('srcdoc');
            frame.src = 'about:blank';
        });
        isStashPreloaded = false;
        // Give embedded games a chance to close their IndexedDB connections.
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    importBtn.onchange = (e) => {
        const localStorage = window.nexusStorage;
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (ev) => {
            let data;
            try {
                data = JSON.parse(ev.target.result);
            } catch (err) {
                nexusAlert("Invalid backup file: " + err.message);
                return;
            }

            try {
                const backupLibrary = data.gameLibrary || {};
                const backupGames = Array.isArray(backupLibrary.games) ? backupLibrary.games : (Array.isArray(data.games) ? data.games : []);
                const restoreSelection = await openBackupSelection(
                    backupGames,
                    'Select Games to Restore',
                    'Unselected games already on this device will remain unchanged.'
                );
                if (!restoreSelection) return;
                const selectedRestoreIds = restoreSelection.ids;
                await releaseGameFramesForRestore();
                // Restore localStorage
                if (restoreSelection.includeSettings && data.saves) {
                    Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
                }

                // Restore the complete custom library, including file payloads and colors.
                const library = data.gameLibrary || {};
                const restoredGames = (Array.isArray(library.games) ? library.games : (Array.isArray(data.games) ? data.games : []))
                    .filter(game => selectedRestoreIds.has(game.id));
                if (restoredGames.length || data.gameLibrary || data.games) {
                    const tx = db.transaction('customGames', 'readwrite');
                    const store = tx.objectStore('customGames');
                    selectedRestoreIds.forEach(id => store.delete(id));
                    restoredGames.forEach(g => {
                        const color = library.colors && library.colors[g.id];
                        store.put(color && !g.sidebarColor ? { ...g, sidebarColor: color } : g);
                    });
                    await new Promise(resolve => {
                        tx.oncomplete = resolve;
                        tx.onerror = resolve;
                    });
                }
                if (typeof library.sidebarOrder === 'string') {
                    let incomingOrder = [];
                    let currentOrder = [];
                    try { incomingOrder = JSON.parse(library.sidebarOrder); } catch (e) {}
                    try { currentOrder = JSON.parse(localStorage.getItem('sidebar-game-order') || '[]'); } catch (e) {}
                    const mergedOrder = currentOrder.filter(id => !selectedRestoreIds.has(id));
                    const stashIndex = mergedOrder.indexOf('ugs-stash');
                    const insertAt = stashIndex >= 0 ? stashIndex + 1 : 0;
                    mergedOrder.splice(insertAt, 0, ...incomingOrder.filter(id => selectedRestoreIds.has(id)));
                    localStorage.setItem('sidebar-game-order', JSON.stringify(mergedOrder));
                }
                if (Array.isArray(data.gameSnapshots)) {
                    const tx = db.transaction('gameSnapshots', 'readwrite');
                    const store = tx.objectStore('gameSnapshots');
                    selectedRestoreIds.forEach(id => store.delete(id));
                    data.gameSnapshots.filter(snapshot => selectedRestoreIds.has(snapshot.gameId)).forEach(snapshot => store.put(snapshot));
                    await new Promise(resolve => {
                        tx.oncomplete = resolve;
                        tx.onerror = resolve;
                    });
                }

                // Restore IndexedDB databases
                if (data.indexedData) {
                    for (let dbName in data.indexedData) {
                        const backupDb = data.indexedData[dbName];
                        const restoreVersion = Number(backupDb && backupDb.__version) || 1;
                        // Delete the database first to wipe any existing schemas/records cleanly
                        await new Promise((resolve) => {
                            const reqDel = indexedDB.deleteDatabase(dbName);
                            reqDel.onsuccess = () => resolve();
                            reqDel.onerror = () => resolve();
                            reqDel.onblocked = () => {
                                console.warn(`Deletion of ${dbName} blocked, continuing...`);
                                resolve();
                            };
                        });

                        // Recreate the database with correct schemas in onupgradeneeded
                        const dbRequest = indexedDB.open(dbName, restoreVersion);
                        dbRequest.onupgradeneeded = (event) => {
                            const targetDB = event.target.result;
                            for (let storeName in backupDb) {
                                if (storeName === '__version') continue;
                                const storeInfo = backupDb[storeName];
                                const options = {};
                                
                                if (storeInfo && !Array.isArray(storeInfo)) {
                                    if (storeInfo.keyPath !== undefined && storeInfo.keyPath !== null) {
                                        options.keyPath = storeInfo.keyPath;
                                    }
                                    if (storeInfo.autoIncrement !== undefined) {
                                        options.autoIncrement = storeInfo.autoIncrement;
                                    }
                                }
                                const restoredStore = targetDB.createObjectStore(storeName, options);
                                if (storeInfo && !Array.isArray(storeInfo) && Array.isArray(storeInfo.indexes)) {
                                    storeInfo.indexes.forEach(index => {
                                        try {
                                            restoredStore.createIndex(index.name, index.keyPath, {
                                                unique: !!index.unique,
                                                multiEntry: !!index.multiEntry
                                            });
                                        } catch (err) {}
                                    });
                                }
                            }
                        };

                        const openedDB = await new Promise(resolve => {
                            dbRequest.onsuccess = () => resolve(dbRequest.result);
                            dbRequest.onerror = () => resolve(null);
                        });
                        if (!openedDB) continue;

                        // Insert records
                        for (let storeName in backupDb) {
                            if (storeName === '__version') continue;
                            const storeInfo = backupDb[storeName];
                            let records = [];
                            
                            // Backwards compatibility for old format backups
                            if (storeInfo && Array.isArray(storeInfo)) {
                                records = storeInfo;
                            } else if (storeInfo && Array.isArray(storeInfo.records)) {
                                records = storeInfo.records;
                            }

                            if (records.length === 0) continue;

                            const storeTx = openedDB.transaction(storeName, 'readwrite');
                            const objectStore = storeTx.objectStore(storeName);

                            for (let item of records) {
                                let key = null;
                                let value = item;

                                if (item && item.hasOwnProperty('key') && item.hasOwnProperty('value')) {
                                    key = item.key;
                                    value = item.value;
                                }
                                value = decodeBackupValue(value);

                                try {
                                    if (objectStore.keyPath !== null && objectStore.keyPath !== undefined) {
                                        // In-line key: key is part of value, must not provide key argument
                                        objectStore.put(value);
                                    } else {
                                        // Out-of-line key: must provide key argument if not null
                                        if (key !== null && key !== undefined) {
                                            objectStore.put(value, key);
                                        } else {
                                            objectStore.put(value);
                                        }
                                    }
                                } catch (err) {
                                    console.error(`Error restoring record in store ${storeName}:`, err);
                                }
                            }

                            await new Promise(resolve => {
                                storeTx.oncomplete = resolve;
                                storeTx.onerror = resolve;
                            });
                        }
                        openedDB.close();
                    }
                }

                await nexusAlert("Successfully loaded. Press OK to apply.");
                location.reload();
            } catch (err) {
                console.error("Restoration failed:", err);
                nexusAlert("Restoration failed: " + err.message);
            }
        };
        reader.readAsText(file);
    };
}

loadGames();

/* =========================================
   GAMES PAGE TUTORIAL SYSTEM
   ========================================= */
let carmeowResizeListener = null;

function initCarmeowTutorial() {
    const localStorage = window.nexusStorage;
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
    const localStorage = window.nexusStorage;
    const popup = document.getElementById('tutorial-popup');
    if (!popup) return;

    popup.classList.remove('centered');
    popup.innerHTML = `
        <div class="tutorial-content">These icons are useful. Fullscreen opens the current game in a blank tab. Backup and Restore are used if you want to transfer saves to another device. Custom allows you to add any file as a sidebar icon. And Home goes back to the home screen.</div>
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
    const localStorage = window.nexusStorage;
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
