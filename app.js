const dbName = "GameStorageDB";
let db, games =[], currentGame = null;

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
    renderGameList();
}

function renderGameList() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = '';
    games.forEach((game, i) => {
        const li = document.createElement('li');
        
        if (game.id === "ugs-stash") li.classList.add('ugs-item');
        
        const t = document.createElement('span');
        t.textContent = game.title; t.style.flex = "1";
        t.onclick = () => loadGame(game);
        li.appendChild(t);
        if (game.id.toString().startsWith('custom_')) {
            const del = document.createElement('span');
            del.innerHTML = "🗑️"; del.className = "trash-btn";
            del.onclick = (e) => { e.stopPropagation(); deleteGame(game.id, i); };
            li.appendChild(del);
        }
        list.appendChild(li);
    });
}

function loadGame(game) {
    currentGame = game;
    const frame = document.getElementById('game-frame');
    const emergencyBtn = document.getElementById('emergency-open-btn');
    const emptyState = document.getElementById('empty-state');
    const statusContainer = document.getElementById('game-status-container');
    const statusDot = document.getElementById('game-status-dot');
    const statusText = document.getElementById('game-status-text');

    // 1. UI Updates: Hide empty state, show frame, show emergency btn
    if (emptyState) emptyState.style.display = 'none';
    if (emergencyBtn) emergencyBtn.style.display = 'inline-flex';
    
    frame.style.setProperty('display', 'block', 'important');
    frame.style.setProperty('visibility', 'visible', 'important');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-pointer-lock');
	
    // 2. Set Status to Loading (Yellow)
    if (statusContainer) {
        statusContainer.style.display = 'flex';
        statusDot.style.background = '#FFEB3B';
        statusDot.style.boxShadow = '0 0 8px #FFEB3B';
        statusText.textContent = 'Loading...';
    }

    // 3. Listen for Iframe to finish loading (Set Status to Green)
    frame.onload = () => {
        if (statusContainer) {
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
    if (!confirm("Delete permanently?")) return;
    const tx = db.transaction("customGames", "readwrite");
    await tx.objectStore("customGames").delete(id);
    games.splice(index, 1); renderGameList();
}

// Chromebook Universal Tab Killer
function killMainTab() {
    document.title = "New Tab";
    document.body.innerHTML = ""; 
    window.open('', '_self');
    window.close();
    
    // UPDATED: Now redirects to about:blank instead of Google Classroom
    setTimeout(() => { window.location.replace("about:blank"); }, 300);
}

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

        // Inject the proxy iframe
        const iframe = win.document.createElement('iframe');
        Object.assign(iframe.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            border: 'none', margin: '0', padding: '0', overflow: 'hidden'
        });
        iframe.src = "https://trigonometry.scientificsense.org/"; // You can change this proxy link if it gets blocked
        win.document.body.appendChild(iframe);
        
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