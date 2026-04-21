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
    
    const transaction = db.transaction('customGames', 'readonly');
    const customGames = await new Promise(r => {
        const req = transaction.objectStore('customGames').getAll();
        req.onsuccess = () => r(req.result);
    });

    try {
        // Fetch with a timestamp to bypass cache
        const response = await fetch('games.json?t=' + Date.now());
        if (!response.ok) throw new Error("JSON not found");
        const defaultGames = await response.json();
        games = [...defaultGames, ...customGames];
    } catch (e) {
        console.warn("Games.json failed to load. Showing custom games only.");
        games = [...customGames];
    }
    
    renderGameList();
}

// 3. Render the Sidebar List
function renderGameList() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = '';
    
    games.forEach((game, i) => {
        const li = document.createElement('li');
        
        // Apply Tutorial Style
        if (game.id === "tutorial") {
            li.classList.add('tutorial-item');
        }
        
        const titleSpan = document.createElement('span');
        titleSpan.textContent = game.title;
        titleSpan.style.flex = "1";
        titleSpan.onclick = () => loadGame(game);
        li.appendChild(titleSpan);

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
        const base64Data = game.content.split(',')[1];
        let htmlContent = atob(base64Data);

        const persistenceScript = `
            <script>
                try { window.localStorage.setItem('persistence_check', 'active'); } 
                catch(e) { console.error("Storage blocked"); }
            </script>
        `;
        frame.srcdoc = persistenceScript + htmlContent;
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
    Object.assign(iframe.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', border: 'none' });
    iframe.src = gameSrc;
    win.document.body.appendChild(iframe);

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

    const allSaves = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        allSaves[key] = localStorage.getItem(key);
    }

    const blob = new Blob([JSON.stringify({ saves: allSaves, games: custom })], { type: 'application/json' });
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

// 9. Splash Texts
const splashes = [
    "\"Assisted by Jayden!\"", "\"No, please don't close my ta-\"", "\"Wait, wait, I was about to finish the level!\"",
    "\"Prompted to perfection.\"", "\"ALT+F4: The ultimate speedrun tactic.\"", "\"My AI solved the math, I solved the level.\"",
    "\"High scores > GPA.\"", "\"Is it lag, or just the school WiFi?\"", "\"The teacher is coming, hit the Pink button!\"",
    "\"Database authorized.\"", "\"Saving your progress... hopefully.\"", "\"Not a bug, it's a feature.\"",
    "\"Llama-3 made me do it.\"", "\"Powered by pure procrastination.\"", "\"100% human-ish.\"",
    "\"Linewize can't see this.\"", "\"The ultimate study break.\"", "\"Just one more level before the bell.\"",
    "\"0% AI hallucinations, 100% gaming.\"", "\"Your high score is in the database.\"", "\"Strictly for educational purposes...\"",
    "\"Does this count as computer science?\"", "\"Bypassing the boredom.\"", "\"Infinite storage, finite time.\"",
    "\"Don't forget to backup!\"", "\"Restoring sanity, one game at a time.\"", "\"Calculated risks and heavy prompts.\"",
    "\"The AI knows the way.\"", "\"More tabs, more problems.\"", "\"Stealth mode engaged.\"",
    "\"Drive Mad? More like Drive Focused.\"", "\"Everything is unblocked if you try hard enough.\"", "\"Learning to code by playing games.\"",
    "\"Browser-based bliss.\"", "\"The stash is never empty.\"", "\"Level 99 Procrastinator.\"",
    "\"Prompt: 'Make me better at this game'.\"", "\"Error 404: Homework not found.\"", "\"Check your permissions.\"",
    "\"IndexedDB is my best friend.\"", "\"About:blank? Nothing to see here.\"", "\"The code is clean, the high score is not.\"",
    "\"Speedrunning through the semester.\"", "\"Logic applied, levels cleared.\"", "\"The AI said I should take a break.\"",
    "\"One file to rule them all.\"", "\"It's basically a digital library.\"", "\"A student's best kept secret.\"",
    "\"Don't close the lid yet!\"", "\"Frames per second > words per minute.\"", "\"GPT-4o approved.\"",
    "\"Your progress is persistent.\"", "\"Toothbrush Tutorial is mandatory reading.\"", "\"The sidebar of secrets.\"",
    "\"Cloak active. Icons changed.\"", "\"Memory leak? Never heard of her.\"", "\"HTML5: The future of study hall.\"",
    "\"Wait, did I save?\"", "\"The AI is my co-pilot.\"", "\"Simulating success.\"",
    "\"Pixel-perfect procrastination.\"", "\"Unblocked and unbothered.\"", "\"School computers are just gaming rigs in disguise.\"",
    "\"Loading a better reality.\"", "\"The Cloak button is your shield.\"", "\"Database synced.\"",
    "\"One prompt away from victory.\"", "\"Gaming is a soft skill.\"", "\"The math adds up.\"",
    "\"Why study when you can speedrun?\"", "\"Securely can't see about:blank.\"", "\"A collection of digital treasures.\"",
    "\"AI: 'I suggest playing 2048'.\"", "\"Minimalist interface, maximalist fun.\"", "\"The stash is legendary.\"",
    "\"Your secret is safe with the browser.\"", "\"Click to continue.\"", "\"The bell doesn't dismiss you, I do.\"",
    "\"Context window: Infinite.\"", "\"The PDF is the manual.\"", "\"Optimized for low-end Chromebooks.\"",
    "\"Your saves are in the cloud-ish.\"", "\"Toothbrush: The home of the bored.\"", "\"Synthesizing high scores.\"",
    "\"The AI isn't cheating, it's 'assisting'.\"", "\"Save states are a human right.\"", "\"Don't let the tab timeout!\"",
    "\"The perfect distraction.\"", "\"Bypassing the mundane.\"", "\"Strictly local storage.\"",
    "\"The UI is polished, the games are not.\"", "\"A masterclass in distraction.\"", "\"Wait, I actually need to solve this.\"",
    "\"The AI wrote the code, you play the game.\"", "\"Everything is fine.\"", "\"The final boss of the school year.\"",
    "\"Your progress is our priority.\"", "\"Hardcoded for fun.\"", "\"The stash is ultimate for a reason.\"",
    "\"READ the TUTORIAL!\"", "\"Dead.\"", "\"Wow. Just... wow.\"", "\"Honorable mention: Ctrl+W.\""
];

function setSplash() {
    const splashElement = document.getElementById('splash-text');
    if (splashElement) {
        const randomSplash = splashes[Math.floor(Math.random() * splashes.length)];
        splashElement.textContent = randomSplash;
    }
}

// Start everything
loadGames();
window.addEventListener('DOMContentLoaded', setSplash);const dbName = "GameStorageDB";
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
    
    const transaction = db.transaction('customGames', 'readonly');
    const customGames = await new Promise(r => {
        const req = transaction.objectStore('customGames').getAll();
        req.onsuccess = () => r(req.result);
    });

    try {
        // Fetch with a timestamp to bypass cache
        const response = await fetch('games.json?t=' + Date.now());
        if (!response.ok) throw new Error("JSON not found");
        const defaultGames = await response.json();
        games = [...defaultGames, ...customGames];
    } catch (e) {
        console.warn("Games.json failed to load. Showing custom games only.");
        games = [...customGames];
    }
    
    renderGameList();
}

// 3. Render the Sidebar List
function renderGameList() {
    const list = document.getElementById('game-list');
    if (!list) return;
    list.innerHTML = '';
    
    games.forEach((game, i) => {
        const li = document.createElement('li');
        
        // Apply Tutorial Style
        if (game.id === "tutorial") {
            li.classList.add('tutorial-item');
        }
        
        const titleSpan = document.createElement('span');
        titleSpan.textContent = game.title;
        titleSpan.style.flex = "1";
        titleSpan.onclick = () => loadGame(game);
        li.appendChild(titleSpan);

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
        const base64Data = game.content.split(',')[1];
        let htmlContent = atob(base64Data);

        const persistenceScript = `
            <script>
                try { window.localStorage.setItem('persistence_check', 'active'); } 
                catch(e) { console.error("Storage blocked"); }
            </script>
        `;
        frame.srcdoc = persistenceScript + htmlContent;
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
    Object.assign(iframe.style, { position: 'fixed', top: '0', left: '0', width: '100%', height: '100%', border: 'none' });
    iframe.src = gameSrc;
    win.document.body.appendChild(iframe);

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

    const allSaves = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        allSaves[key] = localStorage.getItem(key);
    }

    const blob = new Blob([JSON.stringify({ saves: allSaves, games: custom })], { type: 'application/json' });
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

// 9. Splash Texts
const splashes = [
    "\"Assisted by Jayden!\"", "\"No, please don't close my ta-\"", "\"Wait, wait, I was about to finish the level!\"",
    "\"Prompted to perfection.\"", "\"ALT+F4: The ultimate speedrun tactic.\"", "\"My AI solved the math, I solved the level.\"",
    "\"High scores > GPA.\"", "\"Is it lag, or just the school WiFi?\"", "\"The teacher is coming, hit the Pink button!\"",
    "\"Database authorized.\"", "\"Saving your progress... hopefully.\"", "\"Not a bug, it's a feature.\"",
    "\"Llama-3 made me do it.\"", "\"Powered by pure procrastination.\"", "\"100% human-ish.\"",
    "\"Linewize can't see this.\"", "\"The ultimate study break.\"", "\"Just one more level before the bell.\"",
    "\"0% AI hallucinations, 100% gaming.\"", "\"Your high score is in the database.\"", "\"Strictly for educational purposes...\"",
    "\"Does this count as computer science?\"", "\"Bypassing the boredom.\"", "\"Infinite storage, finite time.\"",
    "\"Don't forget to backup!\"", "\"Restoring sanity, one game at a time.\"", "\"Calculated risks and heavy prompts.\"",
    "\"The AI knows the way.\"", "\"More tabs, more problems.\"", "\"Stealth mode engaged.\"",
    "\"Drive Mad? More like Drive Focused.\"", "\"Everything is unblocked if you try hard enough.\"", "\"Learning to code by playing games.\"",
    "\"Browser-based bliss.\"", "\"The stash is never empty.\"", "\"Level 99 Procrastinator.\"",
    "\"Prompt: 'Make me better at this game'.\"", "\"Error 404: Homework not found.\"", "\"Check your permissions.\"",
    "\"IndexedDB is my best friend.\"", "\"About:blank? Nothing to see here.\"", "\"The code is clean, the high score is not.\"",
    "\"Speedrunning through the semester.\"", "\"Logic applied, levels cleared.\"", "\"The AI said I should take a break.\"",
    "\"One file to rule them all.\"", "\"It's basically a digital library.\"", "\"A student's best kept secret.\"",
    "\"Don't close the lid yet!\"", "\"Frames per second > words per minute.\"", "\"GPT-4o approved.\"",
    "\"Your progress is persistent.\"", "\"Toothbrush Tutorial is mandatory reading.\"", "\"The sidebar of secrets.\"",
    "\"Cloak active. Icons changed.\"", "\"Memory leak? Never heard of her.\"", "\"HTML5: The future of study hall.\"",
    "\"Wait, did I save?\"", "\"The AI is my co-pilot.\"", "\"Simulating success.\"",
    "\"Pixel-perfect procrastination.\"", "\"Unblocked and unbothered.\"", "\"School computers are just gaming rigs in disguise.\"",
    "\"Loading a better reality.\"", "\"The Cloak button is your shield.\"", "\"Database synced.\"",
    "\"One prompt away from victory.\"", "\"Gaming is a soft skill.\"", "\"The math adds up.\"",
    "\"Why study when you can speedrun?\"", "\"Securely can't see about:blank.\"", "\"A collection of digital treasures.\"",
    "\"AI: 'I suggest playing 2048'.\"", "\"Minimalist interface, maximalist fun.\"", "\"The stash is legendary.\"",
    "\"Your secret is safe with the browser.\"", "\"Click to continue.\"", "\"The bell doesn't dismiss you, I do.\"",
    "\"Context window: Infinite.\"", "\"The PDF is the manual.\"", "\"Optimized for low-end Chromebooks.\"",
    "\"Your saves are in the cloud-ish.\"", "\"Toothbrush: The home of the bored.\"", "\"Synthesizing high scores.\"",
    "\"The AI isn't cheating, it's 'assisting'.\"", "\"Save states are a human right.\"", "\"Don't let the tab timeout!\"",
    "\"The perfect distraction.\"", "\"Bypassing the mundane.\"", "\"Strictly local storage.\"",
    "\"The UI is polished, the games are not.\"", "\"A masterclass in distraction.\"", "\"Wait, I actually need to solve this.\"",
    "\"The AI wrote the code, you play the game.\"", "\"Everything is fine.\"", "\"The final boss of the school year.\"",
    "\"Your progress is our priority.\"", "\"Hardcoded for fun.\"", "\"The stash is ultimate for a reason.\"",
    "\"READ the TUTORIAL!\"", "\"Dead.\"", "\"Wow. Just... wow.\"", "\"Honorable mention: Ctrl+W.\""
];

function setSplash() {
    const splashElement = document.getElementById('splash-text');
    if (splashElement) {
        const randomSplash = splashes[Math.floor(Math.random() * splashes.length)];
        splashElement.textContent = randomSplash;
    }
}

// Start everything
loadGames();
window.addEventListener('DOMContentLoaded', setSplash);