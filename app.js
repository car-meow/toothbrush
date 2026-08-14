const dbName = "GameStorageDB";
let db, games =[], currentGame = null;
const popupMuteSources = new Set();
const loadingGames = new Map();
let defaultGamesPromise = null;
let dbReadyPromise = null;
let gameLoadToken = 0;
let gameAutosaveTimer = null;
const loadedGameSnapshots = new WeakMap();


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
        const req = indexedDB.open(dbName, 2);
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
        games = [...defaults, ...custom];
    } catch { games = [...custom]; }

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
    await initDB();
    const tx = db.transaction("customGames", "readwrite");
    const store = tx.objectStore("customGames");
    const existing = await new Promise(resolve => {
        const req = store.get(game.id);
        req.onsuccess = () => resolve(req.result || {});
        req.onerror = () => resolve({});
    });
    store.put({ ...existing, ...game });
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
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
    await initDB();
    return new Promise(resolve => {
        const tx = db.transaction('gameSnapshots', 'readonly');
        const req = tx.objectStore('gameSnapshots').get(gameId);
        req.onsuccess = () => resolve(req.result ? req.result.localStorage : null);
        req.onerror = () => resolve(null);
    });
}

async function saveGameSnapshot(gameId, localStorageData) {
    if (!gameId || !localStorageData) return;
    await initDB();
    const tx = db.transaction('gameSnapshots', 'readwrite');
    tx.objectStore('gameSnapshots').put({ gameId, localStorage: localStorageData, savedAt: Date.now() });
    return new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

function requestCurrentGameAutosave() {
    const game = currentGame;
    const frame = document.getElementById('game-frame');
    if (!game || game.type !== 'file' || !frame || !frame.contentWindow) return;
    try { frame.contentWindow.postMessage({ type: 'nexus-request-game-save' }, '*'); } catch (e) {}
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
    // Save every 30 seconds for every local HTML game, including Balatro.
    gameAutosaveTimer = setInterval(requestCurrentGameAutosave, 30000);
}

window.addEventListener('message', event => {
    const message = event.data;
    const frame = document.getElementById('game-frame');
    if (!message || message.type !== 'nexus-game-save') return;
    const isEmbeddedGame = frame && event.source === frame.contentWindow;
    if (!isEmbeddedGame && !message.gameId) return;
    const gameId = message.gameId || (currentGame && currentGame.type === 'file' ? currentGame.id : null);
    if (gameId) saveGameSnapshot(gameId, message.localStorage || {}).catch(() => {});
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) requestCurrentGameAutosave();
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

        list.appendChild(li);
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
        const stashItem = list.querySelector('li[data-game-id="ugs-stash"]');
        const insertionPoint = stashItem ? stashItem.nextSibling : list.firstChild;
        loadingItems.forEach(li => list.insertBefore(li, insertionPoint));
    }

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
    // Refresh both so a deletion is recognized immediately without navigating away and back.
    ['game-frame', 'stash-frame'].forEach(frameId => {
        const frame = document.getElementById(frameId);
        if (!frame || !frame.contentWindow) return;
        try {
            if (typeof frame.contentWindow.refreshBookmarkAvailability === "function") {
                frame.contentWindow.refreshBookmarkAvailability();
            }
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

function launchGameFullscreen(game) {
    if (!game || game.id === "ugs-stash") return;
    const win = window.open('about:blank', '_blank');
    if (!win) {
        nexusAlert("Pop-up blocked! Please allow pop-ups to open games.");
        return;
    }
    
    // Focus tab instantly on launch
    try { win.focus(); } catch(e) {}

    let gameSrc;
    let gameSrcDoc = null;
    if (game.type === 'file') {
        const rawHtml = atob(game.content.split(',')[1]);
        const snapshotJson = JSON.stringify(loadedGameSnapshots.get(game) || {}).replace(/</g, '\\u003c');
        const popupBridge = `<script>(function(){let syncing=false;function send(){try{var s={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('tb_')!==0)s[k]=localStorage.getItem(k);}var opener=(window.parent&&window.parent.opener)||window.opener;if(opener)opener.postMessage({type:'nexus-game-save',gameId:${JSON.stringify(game.id)},localStorage:s},'*');}catch(e){}}function syncAndSend(){if(syncing)return;syncing=true;try{if(window.FS&&typeof FS.syncfs==='function'){FS.syncfs(false,function(){syncing=false;send();});return;}}catch(e){}syncing=false;send();}window.addEventListener('message',function(e){if(e.data&&e.data.type==='nexus-request-game-save')syncAndSend();});setInterval(syncAndSend,30000);})();<\/script>`;
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
                setTimeout(triggerClickFocus, 500);
            } else {
                window.addEventListener('load', function() { setTimeout(triggerClickFocus, 500); });
                setTimeout(triggerClickFocus, 500);
            }
        })();
        <\/script>`;
        // Use stable srcdoc loading for local games. Blob URLs get a new pathname on
        // every launch, which makes path-based game storage (including Balatro's IDBFS)
        // appear to be a different save location each time.
        gameSrcDoc = injectGameBootstrap(rawHtml, popupRestore + popupBridge + autoFocusScript);
    } else {
        gameSrc = game.url;
    }

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

    // Unity WebGL builds (including War the Knights and Survival Race v2) use
    // workers, compressed asset loaders, and IndexedDB. Loading the prepared
    // document directly in the about:blank popup avoids sandbox restrictions
    // that can leave their own Unity progress screen running forever.
    if (gameSrcDoc !== null) {
        try {
            win.document.open();
            win.document.write(gameSrcDoc);
            win.document.close();
            setTimeout(() => { try { win.focus(); } catch (e) {} }, 100);
        } catch (error) {
            console.error('Failed to launch local game:', error);
            try { win.close(); } catch (e) {}
            nexusAlert('This game could not be opened.');
        }
        return;
    }

    const ifr = win.document.createElement('iframe');
    Object.assign(ifr.style, { position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', border: 'none' });
    ifr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock');
    ifr.setAttribute('allow', 'allow-storage-access-by-user-activation; storage-access; fullscreen');
    if (gameSrcDoc !== null) ifr.srcdoc = gameSrcDoc;
    else ifr.src = gameSrc;
    win.document.body.style.margin = '0';
    win.document.body.style.padding = '0';
    win.document.body.style.overflow = 'hidden';
    win.document.body.appendChild(ifr);

    // Auto-focus and simulate mouse click 0.5 seconds after launch
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
    setTimeout(doFocusAndClick, 500); // 0.5s after launch
    setTimeout(doFocusAndClick, 1000);
}

// Keep the game's original doctype/html/head structure intact.  Putting helper
// scripts before <!doctype html> can make some WASM and module-based games fail
// during startup even though the original file is valid on its own.
function injectGameBootstrap(html, bootstrap) {
    if (!html || !bootstrap) return html;
    const headMatch = html.match(/<head(?:\s[^>]*)?>/i);
    if (headMatch && headMatch.index !== undefined) {
        const insertAt = headMatch.index + headMatch[0].length;
        return html.slice(0, insertAt) + bootstrap + html.slice(insertAt);
    }
    const bodyMatch = html.match(/<body(?:\s[^>]*)?>/i);
    if (bodyMatch && bodyMatch.index !== undefined) {
        const insertAt = bodyMatch.index + bodyMatch[0].length;
        return html.slice(0, insertAt) + bootstrap + html.slice(insertAt);
    }
    return bootstrap + html;
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

function loadGame(game, forceInternal = false) {
    const requestedLoadToken = ++gameLoadToken;
    if (game && game.type === 'file' && (!game.content || !loadedGameSnapshots.has(game))) {
        Promise.all([
            game.content ? Promise.resolve() : initDB().then(() => new Promise(resolve => {
                const req = db.transaction("customGames", "readonly").objectStore("customGames").get(game.id);
                req.onsuccess = () => { game.content = req.result && req.result.content; resolve(); };
                req.onerror = () => resolve();
            })),
            getGameSnapshot(game.id)
        ]).then(([, snapshot]) => {
            loadedGameSnapshots.set(game, snapshot || {});
            if (game.content && requestedLoadToken === gameLoadToken) loadGame(game, forceInternal);
            else if (!game.content) nexusAlert("File unavailable.");
        });
        return;
    }
    const localStorage = window.nexusStorage;
    const isDebugFS = localStorage.getItem('tb_debug_fullscreen') === 'true';
    const isPreloadEnabled = localStorage.getItem('tb_preload_stash') === 'true';

    // If Debug Fullscreen is OFF (default) and launching a non-stash game from sidebar
    if (!isDebugFS && !forceInternal && game && game.id !== "ugs-stash") {
        launchGameFullscreen(game);
        const stash = games.find(g => g.id === "ugs-stash");
        if (stash) loadGame(stash, true);
        return;
    }

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
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock');

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

            // Unity WebGL needs a real worker/storage-capable document when
            // Debug Fullscreen is enabled too. The normal launcher uses the
            // unrestricted about:blank popup above; this covers the embedded
            // debug path without relaxing other game documents.
            const isUnityRuntime = /(?:createUnityInstance|UnityLoader|unity-container|unity-canvas)/i.test(htmlContent);
            if (isUnityRuntime) frame.removeAttribute('sandbox');
            
            const snapshot = loadedGameSnapshots.get(game) || {};
            const snapshotJson = JSON.stringify(snapshot).replace(/</g, '\\u003c');
            const restoreScript = `<script>(function(){try{var s=${snapshotJson};Object.keys(s).forEach(function(k){if(k.indexOf('tb_')!==0)localStorage.setItem(k,s[k]);});}catch(e){}})();<\/script>`;
            const autosaveBridge = `<script>(function(){let syncing=false;function send(){try{var s={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(k&&k.indexOf('tb_')!==0)s[k]=localStorage.getItem(k);}parent.postMessage({type:'nexus-game-save',localStorage:s},'*');}catch(e){}}function syncAndSend(){if(syncing)return;syncing=true;try{if(window.FS&&typeof FS.syncfs==='function'){FS.syncfs(false,function(){syncing=false;send();});return;}}catch(e){}syncing=false;send();}window.addEventListener('message',function(e){if(e.data&&e.data.type==='nexus-request-game-save')syncAndSend();});})();<\/script>`;
            const persistenceScript = `<script>try{window.localStorage.setItem('p','1');}catch(e){}<\/script>`;
            const finalHTML = injectGameBootstrap(htmlContent, restoreScript + persistenceScript + autosaveBridge);

            try {
                frame.srcdoc = finalHTML;
            } catch (err1) {
                try {
                    const blob = new Blob([finalHTML], {type: 'text/html'});
                    frame.removeAttribute('srcdoc');
                    frame.src = URL.createObjectURL(blob);
                } catch (err2) {
                    frame.removeAttribute('srcdoc');
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
if (exportBtn) {
    exportBtn.onclick = async () => {
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
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                allSaves[key] = localStorage.getItem(key);
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
            const colors = {};
            customGames.forEach(game => {
                if (game && game.sidebarColor) colors[game.id] = game.sidebarColor;
            });
            const backupData = {
                version: 2,
                saves: allSaves,
                indexedData: idbData,
                games: customGames,
                gameLibrary: { games: customGames, sidebarOrder, colors },
                gameSnapshots
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
                await releaseGameFramesForRestore();
                // Restore localStorage
                if (data.saves) {
                    Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
                }

                // Restore the complete custom library, including file payloads and colors.
                const library = data.gameLibrary || {};
                const restoredGames = Array.isArray(library.games) ? library.games : (Array.isArray(data.games) ? data.games : []);
                if (restoredGames.length || data.gameLibrary || data.games) {
                    const tx = db.transaction('customGames', 'readwrite');
                    const store = tx.objectStore('customGames');
                    store.clear();
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
                    localStorage.setItem('sidebar-game-order', library.sidebarOrder);
                }
                if (Array.isArray(data.gameSnapshots)) {
                    const tx = db.transaction('gameSnapshots', 'readwrite');
                    const store = tx.objectStore('gameSnapshots');
                    store.clear();
                    data.gameSnapshots.forEach(snapshot => store.put(snapshot));
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
