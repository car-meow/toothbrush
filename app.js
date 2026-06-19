const dbName = "GameStorageDB";
let db, games =[], currentGame = null;
const popupMuteSources = new Set();
const loadingGames = new Map();


window.showAddingState = function(sourceKey, title) {
    loadingGames.set(sourceKey, title);
    renderGameList();
};

window.hideAddingState = function(sourceKey) {
    loadingGames.delete(sourceKey);
    renderGameList();
};


async function initDB() {
    return new Promise(r => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore("customGames", { keyPath: "id" });
        req.onsuccess = e => { db = e.target.result; r(); };
    });
}

async function loadGames() {
    await initDB();
    const tx = db.transaction("customGames", "readonly");
    const custom = await new Promise(r => {
        const req = tx.objectStore("customGames").getAll();
        req.onsuccess = () => r(req.result);
    });
    try {
        const res = await fetch('games.json?t=' + Date.now());
        const defaults = await res.json();
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
    pinMasterStash();
    const orderIds = games.map(g => g.id.toString());
    localStorage.setItem('sidebar-game-order', JSON.stringify(orderIds));
}

function renderGameList() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = '';
    games.forEach((game, i) => {
        const li = document.createElement('li');
        
        if (game.id === "ugs-stash") li.classList.add('ugs-item');
        if (game.isNew) li.classList.add('new-game');
        
        const t = document.createElement('span');
        t.className = "game-title";
        if (game.id === "ugs-stash") t.classList.add("game-title-single-line");
        t.textContent = game.id === "ugs-stash" ? getSidebarTitle(game) : addSoftBreaks(getSidebarTitle(game), 12);
        
        li.onclick = () => {
            if (game.isNew) {
                game.isNew = false;
                const tx = db.transaction("customGames", "readwrite");
                tx.objectStore("customGames").put(game);
                li.classList.remove('new-game');
            }
            loadGame(game);
        };
        li.appendChild(t);

        if (isUserManagedGame(game)) {
            const rename = document.createElement('span');
            rename.innerHTML = '<img src="Assets/Rename.svg" alt="Rename" style="width:18px;height:18px;filter:brightness(0) invert(1);vertical-align:middle;">';
            rename.className = "app-action-btn rename-btn";
            rename.title = "Rename app";
            rename.onclick = (e) => { e.stopPropagation(); openRenamePrompt(game); };
            li.appendChild(rename);

            const del = document.createElement('span');
            del.innerHTML = '<img src="Assets/Delete.svg" alt="Delete" style="width:18px;height:18px;filter:brightness(0) invert(1);vertical-align:middle;">'; del.className = "app-action-btn trash-btn";
            del.onclick = (e) => { e.stopPropagation(); deleteGame(game.id, i); };
            del.style.marginRight = "22px"; // keep close to the drag handle
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

    // Render loading states
    loadingGames.forEach((title, sourceKey) => {
        const li = document.createElement('li');
        li.style.cursor = 'default';
        li.style.pointerEvents = 'none';
        
        const loader = document.createElement('div');
        loader.className = 'sidebar-loading-text';
        loader.innerHTML = `Adding <div class="spinner"></div>`;
        
        li.appendChild(loader);
        list.appendChild(li);
    });

    notifyStashBookmarkAvailability();
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
    const frame = document.getElementById('game-frame');
    if (!frame || !frame.contentWindow) return;
    try {
        if (typeof frame.contentWindow.refreshBookmarkAvailability === "function") {
            frame.contentWindow.refreshBookmarkAvailability();
        }
    } catch (err) {
        // Cross-origin app; nothing to sync.
    }
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

function loadGame(game) {
    currentGame = game;
    const frame = document.getElementById('game-frame');
    const emergencyBtn = document.getElementById('emergency-open-btn');
    const emptyState = document.getElementById('empty-state');
    const statusContainer = document.getElementById('game-status-container');
    const statusText = document.getElementById('game-status-text');

    // 1. UI Updates: Hide empty state, show frame, show emergency btn
    if (emptyState) emptyState.style.display = 'none';
    if (emergencyBtn) emergencyBtn.style.display = 'inline-flex';
    
    frame.style.setProperty('display', 'block', 'important');
    frame.style.setProperty('visibility', 'hidden', 'important');
    frame.style.opacity = '0';
    frame.style.transition = 'opacity 0.25s ease';
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock');
	
    // 2. Set Status to Loading (Yellow)
    const statusDot = document.getElementById('game-status-dot');
    if (statusContainer && statusDot) {
        statusContainer.style.display = 'flex';
        statusDot.style.background = '#FFEB3B';
        statusDot.style.boxShadow = '0 0 8px #FFEB3B';
        statusText.textContent = 'Loading...';
    }

    // 3. Listen for Iframe to finish loading (Set Status to Green)
    frame.onload = () => {
        if (statusContainer && statusDot) {
            statusDot.style.background = '#4CAF50';
            statusDot.style.boxShadow = '0 0 8px #4CAF50';
            statusText.textContent = 'Loaded';
        }
        frame.style.setProperty('visibility', 'visible', 'important');
        frame.style.opacity = '1';
    };

    // 4. Inject Game Content
    if (game.type === 'file') {
        const base64Data = game.content.split(',')[1];
        let htmlContent;
        try { htmlContent = atob(base64Data); } catch(e) { return alert("File corrupted."); }
        
        const persistenceScript = `<script>try{window.localStorage.setItem('p','1');}catch(e){}<\/script>`;
        const finalHTML = persistenceScript + htmlContent;

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

const emgBtn = document.getElementById('emergency-open-btn');
if (emgBtn) {
    emgBtn.onclick = () => {
        if (!currentGame) return;
        const win = window.open();
        if (!win) return alert("Allow popups for emergency open!");
        if (currentGame.type === 'file') win.document.write(atob(currentGame.content.split(',')[1]));
        else win.location.href = currentGame.url;
    };
}

const addGameBtn = document.getElementById('add-game-btn');
if (addGameBtn) {
    addGameBtn.onclick = () => {
        const title = document.getElementById('new-game-title').value;
        const file = document.getElementById('new-game-file').files[0];
        if (!title || !file) return alert("Missing data");
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
    if (!confirm("Delete? You can always re-bookmark app, and progress will not be removed.")) return;
    const tx = db.transaction("customGames", "readwrite");
    await tx.objectStore("customGames").delete(id);
    games.splice(index, 1); 
    saveGameOrder();
    renderGameList();
    // Auto-navigate back to Game Stash after deletion
    const stash = games.find(g => g.id === "ugs-stash");
    if (stash) loadGame(stash);
}

let renameTargetId = null;

function openRenamePrompt(game) {
    const overlay = document.getElementById('rename-overlay');
    const input = document.getElementById('rename-app-title');
    if (!overlay || !input) return;

    renameTargetId = game.id;
    input.value = game.title;
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
    const tx = db.transaction("customGames", "readwrite");
    tx.objectStore("customGames").put(game);
    await new Promise(resolve => {
        tx.oncomplete = resolve;
        tx.onerror = resolve;
    });

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
        if (!currentGame) return alert("Select game");
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
        const win = window.open('about:blank', '_blank');
        const gameSrc = currentGame.type === 'file' ? URL.createObjectURL(new Blob([atob(currentGame.content.split(',')[1])], {type:'text/html'})) : currentGame.url;
        win.document.title = "My Drive - Google Drive";
        const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png';
        win.document.head.appendChild(link);
        const ifr = win.document.createElement('iframe');
        Object.assign(ifr.style, { position:'fixed', top:0, left:0, width:'100%', height:'100%', border:'none' });
        ifr.src = gameSrc; win.document.body.appendChild(ifr);
        killMainTab();
        // Navigate main tab back to Game Stash
        const stash = games.find(g => g.id === "ugs-stash");
        if (stash) loadGame(stash);
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
            // Gather custom games
            const tx = db.transaction('customGames', 'readonly');
            const customGames = await new Promise(r => {
                const req = tx.objectStore('customGames').getAll();
                req.onsuccess = () => r(req.result);
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

                    const dbContent = {};
                    for (let storeName of gameDB.objectStoreNames) {
                        const storeTx = gameDB.transaction(storeName, 'readonly');
                        const store = storeTx.objectStore(storeName);
                        
                        // Extract schema metadata
                        const keyPath = store.keyPath;
                        const autoIncrement = store.autoIncrement;

                        // Use a cursor to preserve both key and value
                        const records = [];
                        await new Promise(res => {
                            const reqCursor = store.openCursor();
                            reqCursor.onsuccess = e => {
                                const cursor = e.target.result;
                                if (cursor) {
                                    records.push({ key: cursor.key, value: cursor.value });
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
                            records: records
                        };
                    }
                    idbData[dbInfo.name] = dbContent;
                    gameDB.close();
                }
            }

            const backupData = { saves: allSaves, indexedData: idbData, games: customGames };
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
            alert("Backup failed: " + e.message);
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
            alert('Pop-up blocked! Please allow pop-ups to open the proxy.');
        }
    };
}

const importBtn = document.getElementById('import-btn');
if (importBtn) {
    importBtn.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = async (ev) => {
            let data;
            try {
                data = JSON.parse(ev.target.result);
            } catch (err) {
                alert("Invalid backup file: " + err.message);
                return;
            }

            try {
                // Restore localStorage
                if (data.saves) {
                    Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
                }

                // Restore custom games list
                if (data.games) {
                    const tx = db.transaction('customGames', 'readwrite');
                    data.games.forEach(g => tx.objectStore('customGames').put(g));
                    await new Promise(resolve => {
                        tx.oncomplete = resolve;
                        tx.onerror = resolve;
                    });
                }

                // Restore IndexedDB databases
                if (data.indexedData) {
                    for (let dbName in data.indexedData) {
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
                        const dbRequest = indexedDB.open(dbName, 1);
                        dbRequest.onupgradeneeded = (event) => {
                            const targetDB = event.target.result;
                            for (let storeName in data.indexedData[dbName]) {
                                const storeInfo = data.indexedData[dbName][storeName];
                                const options = {};
                                
                                if (storeInfo && !Array.isArray(storeInfo)) {
                                    if (storeInfo.keyPath !== undefined && storeInfo.keyPath !== null) {
                                        options.keyPath = storeInfo.keyPath;
                                    }
                                    if (storeInfo.autoIncrement !== undefined) {
                                        options.autoIncrement = storeInfo.autoIncrement;
                                    }
                                }
                                targetDB.createObjectStore(storeName, options);
                            }
                        };

                        const openedDB = await new Promise(resolve => {
                            dbRequest.onsuccess = () => resolve(dbRequest.result);
                            dbRequest.onerror = () => resolve(null);
                        });
                        if (!openedDB) continue;

                        // Insert records
                        for (let storeName in data.indexedData[dbName]) {
                            const storeInfo = data.indexedData[dbName][storeName];
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

                alert("Successfully loaded. Press OK to apply.");
                location.reload();
            } catch (err) {
                console.error("Restoration failed:", err);
                alert("Restoration failed: " + err.message);
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
    
    // Position to the left of the header controls
    const left = rect.left - popup.offsetWidth - 40 + window.scrollX;
    const top = rect.top + (rect.height / 2) + window.scrollY;

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.transform = 'translateY(-50%)';

    // Draw curved line connecting them
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

    const px1 = popupRect.right + window.scrollX;
    const py1 = popupRect.top + popupRect.height / 2 + window.scrollY;

    const px2 = targetRect.left + window.scrollX;
    const py2 = targetRect.top + targetRect.height / 2 + window.scrollY;

    const cx = (px1 + px2) / 2;
    const cy = (py1 + py2) / 2 - 25;

    svg.innerHTML = `
        <path d="M ${px1} ${py1} Q ${cx} ${cy} ${px2} ${py2}" 
              fill="none" 
              stroke="rgba(255, 255, 255, 0.45)" 
              stroke-width="3" 
              stroke-linecap="round" />
    `;
}

function endCarmeowTutorial() {
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
