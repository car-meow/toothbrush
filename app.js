const dbName = "GameStorageDB";
let db;
let games = [];
let currentGame = null;

// 1. Initialize Database (IndexedDB)
async function initDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains('customGames')) {
                database.createObjectStore('customGames', { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
    });
}

// 2. Load Games from JSON and Database
async function loadGames() {
    await initDB();
    
    // Get custom games from IndexedDB
    const transaction = db.transaction('customGames', 'readonly');
    const customGames = await new Promise(r => {
        const req = transaction.objectStore('customGames').getAll();
        req.onsuccess = () => r(req.result);
    });

    try {
        // Fetch default games (The Tutorial) from games.json
        const response = await fetch('games.json');
        if (!response.ok) throw new Error("JSON not found");
        const defaultGames = await response.json();
        games = [...defaultGames, ...customGames];
    } catch (e) {
        console.warn("Games.json failed to load. Only showing custom games.");
        games = [...customGames];
    }
    
    renderGameList();
}

// 3. Render the Sidebar List
function renderGameList() {
    const list = document.getElementById('game-list');
    list.innerHTML = '';
    
    games.forEach((game, i) => {
        const li = document.createElement('li');
        
        // --- UPDATED: Apply the Tutorial Class ---
        if (game.id === "tutorial") {
            li.classList.add('tutorial-item');
        }
        
        const titleSpan = document.createElement('span');
        titleSpan.textContent = game.title;
        titleSpan.style.flex = "1";
        titleSpan.onclick = () => loadGame(game);
        li.appendChild(titleSpan);

        // Add Trashcan only for manually added games
        if (game.id.toString().startsWith('custom_')) {
            const trash = document.createElement('span');
            trash.innerHTML = "🗑️";
            trash.className = "trash-btn";
            trash.onclick = (e) => { 
                e.stopPropagation(); 
                deleteGame(game.id, i); 
            };
            li.appendChild(trash);
        }
        
        list.appendChild(li);
    });
}

// 4. Load Game into Iframe
function loadGame(game) {
    currentGame = game;
    const frame = document.getElementById('game-frame');
    
    if (game.type === 'file') {
        // Decode base64 and inject into iframe to keep saves on this domain
        const base64Data = game.content.split(',')[1];
        const htmlContent = atob(base64Data);
        frame.srcdoc = htmlContent;
    } else {
        frame.removeAttribute('srcdoc');
        frame.src = game.url;
    }
}

// 5. Add Custom Game Logic
document.getElementById('add-game-btn').onclick = () => {
    const title = document.getElementById('new-game-title').value;
    const fileInput = document.getElementById('new-game-file');
    
    if (!title || !fileInput.files.length) return alert("Enter a title and select a file.");
    
    const reader = new FileReader();
    reader.onload = async (e) => {
        const newGame = {
            id: 'custom_' + Date.now(),
            title: title,
            type: 'file',
            content: e.target.result
        };
        
        const tx = db.transaction('customGames', 'readwrite');
        tx.objectStore('customGames').put(newGame);
        
        games.push(newGame);
        renderGameList();
        
        document.getElementById('new-game-title').value = '';
        fileInput.value = '';
    };
    reader.readAsDataURL(fileInput.files[0]);
};

// 6. Delete Game Logic
async function deleteGame(id, index) {
    if (!confirm("Delete this game permanently?")) return;
    const tx = db.transaction('customGames', 'readwrite');
    await tx.objectStore('customGames').delete(id);
    games.splice(index, 1);
    renderGameList();
}

// 7. Cloaker: about:blank + Tab Close
document.getElementById('cloak-btn').onclick = () => {
    if (!currentGame) return alert("Select a game first!");

    const win = window.open('about:blank', '_blank');
    if (!win) return alert("Pop-up Blocked!");

    // Prep Source
    let gameSrc = "";
    if (currentGame.type === 'file') {
        const base64Data = currentGame.content.split(',')[1];
        const binary = atob(base64Data);
        const array = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) array[i] = binary.charCodeAt(i);
        gameSrc = URL.createObjectURL(new Blob([array], { type: 'text/html' }));
    } else {
        gameSrc = currentGame.url;
    }

    win.document.title = 'My Drive - Google Drive';
    const link = win.document.createElement('link');
    link.rel = 'icon';
    link.href = 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png';
    win.document.head.appendChild(link);

    const iframe = win.document.createElement('iframe');
    Object.assign(iframe.style, {
        position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', border: 'none'
    });
    iframe.src = gameSrc;
    win.document.body.appendChild(iframe);

    // Close current tab
    window.open('about:blank', '_self');
    window.close();
};

// 8. Backup and Restore
document.getElementById('export-btn').onclick = async () => {
    const tx = db.transaction('customGames', 'readonly');
    const custom = await new Promise(r => {
        const req = tx.objectStore('customGames').getAll();
        req.onsuccess = () => r(req.result);
    });
    const blob = new Blob([JSON.stringify({ saves: { ...localStorage }, games: custom })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'toothbrush_backup.json';
    a.click();
};

document.getElementById('import-btn').onchange = (e) => {
    const reader = new FileReader();
    reader.onload = async (ev) => {
        const data = JSON.parse(ev.target.result);
        if (data.saves) Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
        if (data.games) {
            const tx = db.transaction('customGames', 'readwrite');
            data.games.forEach(g => tx.objectStore('customGames').put(g));
        }
        location.reload();
    };
    reader.readAsText(e.target.files[0]);
};

// Start the site
loadGames();