const dbName = "GameStorageDB";
let db, games = [], currentGame = null;

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
        const res = await fetch('games.json');
        const defaults = await res.json();
        games = [...defaults, ...custom];
    } catch { games = [...custom]; }
    renderGameList();
}

function renderGameList() {
    const list = document.getElementById('game-list');
    list.innerHTML = '';
    games.forEach((game, i) => {
        const li = document.createElement('li');
        const title = document.createElement('span');
        title.textContent = game.title;
        title.style.flex = "1";
        title.onclick = () => loadGame(game);
        li.appendChild(title);
        if (game.id.toString().startsWith('custom_')) {
            const trash = document.createElement('span');
            trash.innerHTML = "🗑️";
            trash.className = "trash-btn";
            trash.onclick = (e) => { e.stopPropagation(); deleteGame(game.id, i); };
            li.appendChild(trash);
        }
        list.appendChild(li);
    });
}

function loadGame(game) {
    currentGame = game;
    const frame = document.getElementById('game-frame');
    if (game.type === 'file') {
        frame.srcdoc = atob(game.content.split(',')[1]);
    } else {
        frame.removeAttribute('srcdoc');
        frame.src = game.url;
    }
}

document.getElementById('add-game-btn').onclick = () => {
    const title = document.getElementById('new-game-title').value;
    const file = document.getElementById('new-game-file').files[0];
    if (!title || !file) return alert("Fill in all fields");
    const reader = new FileReader();
    reader.onload = async e => {
        const newGame = { id: 'custom_' + Date.now(), title, type: 'file', content: e.target.result };
        const tx = db.transaction("customGames", "readwrite");
        tx.objectStore("customGames").put(newGame);
        games.push(newGame);
        renderGameList();
    };
    reader.readAsDataURL(file);
};

async function deleteGame(id, index) {
    if (!confirm("Delete this game?")) return;
    const tx = db.transaction("customGames", "readwrite");
    await tx.objectStore("customGames").delete(id);
    games.splice(index, 1);
    renderGameList();
}

document.getElementById('cloak-btn').onclick = () => {
    if (!currentGame) return alert("Select a game first!");
    const win = window.open('about:blank', '_blank');
    const gameSrc = currentGame.type === 'file' ? URL.createObjectURL(new Blob([atob(currentGame.content.split(',')[1])], {type:'text/html'})) : currentGame.url;
    win.document.title = "My Drive - Google Drive";
    const link = win.document.createElement('link');
    link.rel = 'icon'; link.href = 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png';
    win.document.head.appendChild(link);
    const iframe = win.document.createElement('iframe');
    Object.assign(iframe.style, { position:'fixed', top:0, left:0, width:'100%', height:'100%', border:'none' });
    iframe.src = gameSrc;
    win.document.body.appendChild(iframe);
    window.open('about:blank', '_self'); window.close();
};

document.getElementById('export-btn').onclick = async () => {
    const tx = db.transaction("customGames", "readonly");
    const custom = await new Promise(r => {
        const req = tx.objectStore("customGames").getAll();
        req.onsuccess = () => r(req.result);
    });
    const blob = new Blob([JSON.stringify({ saves: {...localStorage}, games: custom })], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'backup.json'; a.click();
};

document.getElementById('import-btn').onchange = e => {
    const reader = new FileReader();
    reader.onload = async ev => {
        const data = JSON.parse(ev.target.result);
        if (data.saves) Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
        if (data.games) {
            const tx = db.transaction("customGames", "readwrite");
            data.games.forEach(g => tx.objectStore("customGames").put(g));
        }
        location.reload();
    };
    reader.readAsText(e.target.files[0]);
};

loadGames();