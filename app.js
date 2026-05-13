const dbName = "GameStorageDB";
let db, games =[], currentGame = null;
const popupMuteSources = new Set();
let recents = JSON.parse(localStorage.getItem('tb_recents') || '[]');

function addToRecents(game) {
    const limitStr = localStorage.getItem('tb_recents_limit') || '5';
    let limit = limitStr === 'unlimited' ? Infinity : parseInt(limitStr);
    
    // Check if it's already a bookmark. If so, don't add to recents.
    if (typeof buildBookmarkSourceKey === "function") {
        const sourceKey = buildBookmarkSourceKey(game.url);
        const bmId = buildBookmarkIdFromSourceKey(sourceKey);
        if (games.some(g => g.id === bmId)) {
            recents = recents.filter(r => r.url !== game.url);
            localStorage.setItem('tb_recents', JSON.stringify(recents));
            return;
        }
    }

    recents = recents.filter(r => r.url !== game.url); // Remove existing to move to top
    recents.unshift({ id: 'recent_' + Date.now(), title: game.title, type: 'url', url: game.url, isRecent: true });
    
    if (recents.length > limit) recents.length = limit;
    localStorage.setItem('tb_recents', JSON.stringify(recents));
    renderGameList();
}

async function addCurrentUGSToBookmarks(game) {
    const sourceFile = game.url;
    const sourceKey = buildBookmarkSourceKey(sourceFile);
    const bmId = buildBookmarkIdFromSourceKey(sourceKey);
    
    const bmBtn = document.getElementById('bookmark-active-btn');
    if (bmBtn) {
        bmBtn.textContent = 'Adding...';
        bmBtn.disabled = true;
    }

    try {
        const response = await fetch(sourceFile);
        if (!response.ok) throw new Error("Fetch failed");
        const text = await response.text();
        const reader = new FileReader();
        reader.onload = async function (e) {
            const dataUrl = e.target.result;
            const newG = {
                id: bmId,
                sourceKey,
                sourceFile,
                title: game.title,
                userRenamed: false,
                type: 'file',
                content: dataUrl
            };
            const tx = db.transaction("customGames", "readwrite");
            tx.objectStore("customGames").put(newG);
            games.push(newG);
            saveGameOrder();
            
            // Remove from recents if it's there
            recents = recents.filter(r => r.url !== sourceFile);
            localStorage.setItem('tb_recents', JSON.stringify(recents));
            
            renderGameList();
            
            if (bmBtn) {
                bmBtn.className = 'save-btn';
                bmBtn.style.background = '#555';
                bmBtn.textContent = 'Bookmarked';
                bmBtn.style.cursor = 'default';
            }
        };
        reader.readAsDataURL(new Blob([text], { type: 'text/html' }));
    } catch (err) {
        alert("Error fetching game for bookmarking.");
        if (bmBtn) {
            bmBtn.textContent = 'Bookmark';
            bmBtn.disabled = false;
        }
    }
}

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
        
        const t = document.createElement('span');
        t.className = "game-title";
        if (game.id === "ugs-stash") t.classList.add("game-title-single-line");
        t.textContent = game.id === "ugs-stash" ? getSidebarTitle(game) : addSoftBreaks(getSidebarTitle(game), 12);
        
        li.onclick = () => loadGame(game);
        li.appendChild(t);

        if (isUserManagedGame(game)) {
            const rename = document.createElement('span');
            rename.innerHTML = "&#128221;";
            rename.className = "app-action-btn rename-btn";
            rename.title = "Rename app";
            rename.onclick = (e) => { e.stopPropagation(); openRenamePrompt(game); };
            li.appendChild(rename);

            const del = document.createElement('span');
            del.innerHTML = "🗑️"; del.className = "app-action-btn trash-btn";
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

    // Add Divider and Recents if they exist
    if (recents.length > 0) {
        // Medium thickness grey dividing line
        const divider = document.createElement('div');
        divider.style.borderBottom = '3px solid #444';
        divider.style.margin = '15px 15px 10px 15px';
        list.appendChild(divider);
        
        // Recents Header
        const header = document.createElement('div');
        header.textContent = 'RECENTS';
        header.style.color = '#777';
        header.style.fontSize = '10px';
        header.style.fontWeight = 'bold';
        header.style.margin = '0 15px 8px 25px';
        header.style.letterSpacing = '1px';
        list.appendChild(header);
        
        recents.forEach((game, i) => {
            const li = document.createElement('li');
            li.style.borderLeft = '3px solid #F57C00'; 
            const t = document.createElement('span');
            t.className = "game-title";
            t.textContent = addSoftBreaks(game.title, 12);
            li.onclick = () => loadGame(game);
            li.appendChild(t);
            list.appendChild(li);
        });
    }

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

    const bmBtn = document.getElementById('bookmark-active-btn');
    const spacer = document.getElementById('bookmark-spacer');
    if (bmBtn && spacer) {
        if (game.id && game.id.startsWith('ugs_')) {
            bmBtn.style.display = 'inline-flex';
            spacer.style.display = 'block';
            
            const sourceKey = buildBookmarkSourceKey(game.url);
            const bmId = buildBookmarkIdFromSourceKey(sourceKey);
            const isBookmarked = games.some(g => g.id === bmId);
            
            if (isBookmarked) {
                bmBtn.className = 'save-btn';
                bmBtn.style.background = '#555';
                bmBtn.textContent = 'Bookmarked';
                bmBtn.disabled = true;
                bmBtn.style.cursor = 'default';
                bmBtn.onclick = null;
            } else {
                bmBtn.className = 'save-btn rainbow-btn';
                bmBtn.style.background = '';
                bmBtn.textContent = 'Bookmark';
                bmBtn.disabled = false;
                bmBtn.style.cursor = 'pointer';
                bmBtn.onclick = () => addCurrentUGSToBookmarks(game);
            }
        } else if (game.isRecent) {
            bmBtn.style.display = 'none';
            spacer.style.display = 'none';
        } else {
            bmBtn.style.display = 'none';
            spacer.style.display = 'none';
        }
    }

    if (game.id && game.id.startsWith('ugs_')) {
        addToRecents(game);
    } else if (game.isRecent) {
        addToRecents(game);
    }

    // 1. UI Updates: Hide empty state, show frame, show emergency btn
    if (emptyState) emptyState.style.display = 'none';
    if (emergencyBtn) emergencyBtn.style.display = 'inline-flex';
    
    frame.style.setProperty('display', 'block', 'important');
    frame.style.setProperty('visibility', 'visible', 'important');
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

// Chromebook Universal Tab Killer
function killMainTab() {
    document.title = "New Tab";
    document.body.innerHTML = ""; 
    window.open('', '_self');
    window.close();
    
    // UPDATED: Now redirects to about:blank instead of Google Classroom
    setTimeout(() => { window.location.replace("about:blank"); }, 300);
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
        const win = window.open('about:blank', '_blank');
        const gameSrc = currentGame.type === 'file' ? URL.createObjectURL(new Blob([atob(currentGame.content.split(',')[1])], {type:'text/html'})) : currentGame.url;
        win.document.title = "My Drive - Google Drive";
        const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png';
        win.document.head.appendChild(link);
        const ifr = win.document.createElement('iframe');
        Object.assign(ifr.style, { position:'fixed', top:0, left:0, width:'100%', height:'100%', border:'none' });
        ifr.src = gameSrc; win.document.body.appendChild(ifr);
        killMainTab();
    };
}

const exportBtn = document.getElementById('export-btn');
if (exportBtn) {
    exportBtn.onclick = async () => {
        const tx = db.transaction('customGames', 'readonly');
        const customGames = await new Promise(r => {
            const req = tx.objectStore('customGames').getAll();
            req.onsuccess = () => r(req.result);
        });

        const allSaves = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            allSaves[key] = localStorage.getItem(key);
        }

        const idbData = {};
        const dbs = await window.indexedDB.databases();
        for (let dbInfo of dbs) {
            if (dbInfo.name === "GameStorageDB") continue; 
            const gameDB = await new Promise(res => {
                const req = indexedDB.open(dbInfo.name);
                req.onsuccess = () => res(req.result);
            });
            const dbContent = {};
            for (let storeName of gameDB.objectStoreNames) {
                const storeTx = gameDB.transaction(storeName, 'readonly');
                dbContent[storeName] = await new Promise(res => {
                    storeTx.objectStore(storeName).getAll().onsuccess = e => res(e.target.result);
                });
            }
            idbData[dbInfo.name] = dbContent;
            gameDB.close();
        }

        const backupData = { saves: allSaves, indexedData: idbData, games: customGames };
        const blob = new Blob([JSON.stringify(backupData)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'toothbrush_backup.json';
        a.click();
    };
}

const proxyBtn = document.getElementById('proxy-btn');
if (proxyBtn) {
    proxyBtn.onclick = () => {
        const win = window.open('about:blank', '_blank');
        if (!win) return alert("Pop-up Blocked! Please allow pop-ups.");

        // Set the cloaked tab title and icon
        win.document.title = 'New Tab';
        const icon = win.document.createElement('link');
        icon.rel = 'icon';
        icon.href = 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png';
        win.document.head.appendChild(icon);

        // Inject the proxy header
        const header = win.document.createElement('div');
        Object.assign(header.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '40px',
            backgroundColor: '#1f1f1f', color: '#fff', display: 'flex', alignItems: 'center',
            padding: '0 15px', boxSizing: 'border-box', zIndex: '999999',
            fontFamily: 'sans-serif', borderBottom: '1px solid #333'
        });
        
        const backBtn = win.document.createElement('button');
        backBtn.textContent = 'Back';
        Object.assign(backBtn.style, {
            backgroundColor: '#3d3d3d', color: 'white', border: '1px solid #555',
            padding: '5px 15px', borderRadius: '4px', cursor: 'pointer', marginRight: '15px'
        });
        backBtn.onclick = () => win.close();
        
        const title = win.document.createElement('span');
        title.textContent = 'Toothbrush Proxy';
        title.style.fontWeight = 'bold';
        title.style.marginRight = '15px';
        
        const subtext = win.document.createElement('span');
        subtext.textContent = 'Press F2 to hide (Launcher+Refresh on Chromebook)';
        subtext.style.fontSize = '12px';
        subtext.style.color = '#aaa';

        header.appendChild(backBtn);
        header.appendChild(title);
        header.appendChild(subtext);
        win.document.body.appendChild(header);

        // Inject the proxy iframe
        const iframe = win.document.createElement('iframe');
        Object.assign(iframe.style, {
            position: 'fixed', top: '40px', left: '0', width: '100%', height: 'calc(100% - 40px)',
            border: 'none', margin: '0', padding: '0', overflow: 'hidden'
        });
        iframe.src = "https://trigonometry.scientificsense.org/"; // You can change this proxy link if it gets blocked
        win.document.body.appendChild(iframe);
        
        win.document.addEventListener('keydown', (e) => {
            if (e.key === 'F2') {
                if (header.style.display !== 'none') {
                    header.style.display = 'none';
                    iframe.style.top = '0';
                    iframe.style.height = '100%';
                } else {
                    header.style.display = 'flex';
                    iframe.style.top = '40px';
                    iframe.style.height = 'calc(100% - 40px)';
                }
            }
        });
        
        // Kill the original tab
        killMainTab();
    };
}

const importBtn = document.getElementById('import-btn');
if (importBtn) {
    importBtn.onchange = (e) => {
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const data = JSON.parse(ev.target.result);
            if (data.saves) Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
            if (data.games) {
                const tx = db.transaction('customGames', 'readwrite');
                data.games.forEach(g => tx.objectStore('customGames').put(g));
            }
            if (data.indexedData) {
                for (let dbName in data.indexedData) {
                    const dbRequest = indexedDB.open(dbName);
                    dbRequest.onupgradeneeded = (event) => {
                        for (let storeName in data.indexedData[dbName]) { event.target.result.createObjectStore(storeName); }
                    };
                    const openedDB = await new Promise(res => { dbRequest.onsuccess = () => res(dbRequest.result); });
                    for (let storeName in data.indexedData[dbName]) {
                        const storeTx = openedDB.transaction(storeName, 'readwrite');
                        data.indexedData[dbName][storeName].forEach(item => storeTx.objectStore(storeName).put(item));
                    }
                    openedDB.close();
                }
            }
            alert("Restore Complete! Reloading site...");
            location.reload();
        };
        reader.readAsText(e.target.files[0]);
    };
}

loadGames();
