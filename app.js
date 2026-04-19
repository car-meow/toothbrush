const dbName = "UnblockedGamesDB";
let db;
let games = [];
let currentGame = null;

// Initialize Database
function initDB() {
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

async function loadGames() {
    await initDB();
    const transaction = db.transaction('customGames', 'readonly');
    const customGames = await new Promise(r => {
        const req = transaction.objectStore('customGames').getAll();
        req.onsuccess = () => r(req.result);
    });

    try {
        const response = await fetch('games.json');
        const defaultGames = await response.json();
        games = [...defaultGames, ...customGames];
    } catch (e) {
        games = [...customGames];
    }
    renderGameList();
}

function renderGameList() {
    const list = document.getElementById('game-list');
    list.innerHTML = '';
    games.forEach((game) => {
        const li = document.createElement('li');
        li.textContent = game.title;
        li.onclick = () => loadGameToIframe(game);
        list.appendChild(li);
    });
}

// THE FIX FOR SAVING: Use srcdoc to keep the game on your domain
async function loadGameToIframe(game) {
    currentGame = game;
    const iframe = document.getElementById('game-frame');
    
    if (game.type === 'file') {
        // Convert Base64 back to raw HTML string
        const base64Data = game.content.split(',')[1];
        const htmlContent = atob(base64Data);
        // Injecting via srcdoc keeps the origin of YOUR site, allowing localstorage to work
        iframe.srcdoc = htmlContent;
    } else {
        iframe.removeAttribute('srcdoc');
        iframe.src = game.url;
    }
}

// Add Game Logic
document.getElementById('add-game-btn').onclick = () => {
    const title = document.getElementById('new-game-title').value;
    const fileInput = document.getElementById('new-game-file');
    if (!title || !fileInput.files.length) return alert("Missing Title or File");

    const reader = new FileReader();
    reader.onload = async (e) => {
        const newGame = { id: 'custom_' + Date.now(), title, type: 'file', content: e.target.result };
        const tx = db.transaction('customGames', 'readwrite');
        tx.objectStore('customGames').put(newGame);
        games.push(newGame);
        renderGameList();
    };
    reader.readAsDataURL(fileInput.files[0]);
};

// THE FIX FOR CLOAKING: Robust about:blank injector
document.getElementById('cloak-btn').onclick = async () => {
    if (!currentGame) return alert("Select a game first!");

    const win = window.open('about:blank', '_blank');
    if (!win) return alert("Pop-up Blocked! Allow pop-ups to use Cloaker.");

    let gameHTML = "";
    if (currentGame.type === 'file') {
        gameHTML = atob(currentGame.content.split(',')[1]);
    } else {
        gameHTML = `<iframe src="${currentGame.url}" style="width:100%;height:100%;border:none;"></iframe>`;
    }

    win.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>My Drive - Google Drive</title>
            <link rel="icon" type="image/x-icon" href="https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png">
            <style>body,html{margin:0;padding:0;height:100%;overflow:hidden;background:#000;}</style>
        </head>
        <body>${currentGame.type === 'file' ? gameHTML : gameHTML}</body>
        </html>
    `);
    win.document.close();
    window.location.replace("https://www.google.com");
};

// Backup and Restore
document.getElementById('export-btn').onclick = async () => {
    const tx = db.transaction('customGames', 'readonly');
    const customGames = await new Promise(r => {
        const req = tx.objectStore('customGames').getAll();
        req.onsuccess = () => r(req.result);
    });
    const blob = new Blob([JSON.stringify({ saves: { ...localStorage }, games: customGames })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'games_backup.json';
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
        alert("Done!");
        location.reload();
    };
    reader.readAsText(e.target.files[0]);
};

// Initialize
loadGames();