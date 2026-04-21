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
        if (game.id === "tutorial") li.classList.add('tutorial-item');
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
    if (game.type === 'file') {
        const htmlContent = atob(game.content.split(',')[1]);
        frame.srcdoc = `<script>try{window.localStorage.setItem('p','1');}catch(e){}<\/script>` + htmlContent;
    } else {
        frame.removeAttribute('srcdoc');
        frame.src = game.url;
    }
}

document.getElementById('add-game-btn').onclick = () => {
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

async function deleteGame(id, index) {
    if (!confirm("Delete permanently?")) return;
    const tx = db.transaction("customGames", "readwrite");
    await tx.objectStore("customGames").delete(id);
    games.splice(index, 1); renderGameList();
}

document.getElementById('cloak-btn').onclick = () => {
    if (!currentGame) return alert("Select game");
    const win = window.open('about:blank', '_blank');
    const gameSrc = currentGame.type === 'file' ? URL.createObjectURL(new Blob([atob(currentGame.content.split(',')[1])], {type:'text/html'})) : currentGame.url;
    win.document.title = "My Drive - Google Drive";
    const link = win.document.createElement('link'); link.rel = 'icon'; link.href = 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png';
    win.document.head.appendChild(link);
    const ifr = win.document.createElement('iframe');
    Object.assign(ifr.style, { position:'fixed', top:0, left:0, width:'100%', height:'100%', border:'none' });
    ifr.src = gameSrc; win.document.body.appendChild(ifr);
    window.open('about:blank', '_self'); window.close();
};

document.getElementById('export-btn').onclick = async () => {
    const tx = db.transaction("customGames", "readonly");
    const custom = await new Promise(r => { const req = tx.objectStore("customGames").getAll(); req.onsuccess = () => r(req.result); });
    const saves = {}; for (let i=0; i<localStorage.length; i++) { const k = localStorage.key(i); saves[k] = localStorage.getItem(k); }
    const blob = new Blob([JSON.stringify({ saves, games: custom })], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'toothbrush_backup.json'; a.click();
};

document.getElementById('import-btn').onchange = e => {
    const reader = new FileReader();
    reader.onload = async ev => {
        const data = JSON.parse(ev.target.result);
        if (data.saves) Object.keys(data.saves).forEach(k => localStorage.setItem(k, data.saves[k]));
        if (data.games) { const tx = db.transaction("customGames", "readwrite"); data.games.forEach(g => tx.objectStore("customGames").put(g)); }
        location.reload();
    };
    reader.readAsText(e.target.files[0]);
};

const splashes = [
    "\"Assisted by Jayden!\"", "\"No, please don't close my ta-\"", "\"Wait, wait, I was about to finish the level!\"",
    "\"Prompted to perfection.\"", "\"ALT+F4: The ultimate speedrun tactic.\"", "\"My AI solved the math, I solved the level.\"",
    "\"Linewize can't see this.\"", "\"Your high score is in the database.\"", "\"Context window: Infinite.\"",
    "\"Toothbrush: The home of the bored.\"", "\"READ the TUTORIAL!\"", "\"Dead.\"", "\"Wow. Just... wow.\"", "\"Honorable mention: Ctrl+W.\""
]; // ... (Add the rest of the 100 splashes here)

function setSplash() {
    const el = document.getElementById('splash-text');
    if (el) el.textContent = splashes[Math.floor(Math.random() * splashes.length)];
}

loadGames();
window.addEventListener('DOMContentLoaded', setSplash);