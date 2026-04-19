let games =[];

// 1. Initialize and Load Games
async function loadGames() {
    // Pull any user-added games from local storage
    const customGames = JSON.parse(localStorage.getItem('customGames') || '[]');
    
    try {
        // Pull default games from the JSON file
        const response = await fetch('games.json');
        const defaultGames = await response.json();
        games = [...defaultGames, ...customGames];
    } catch (e) {
        console.warn("Could not load games.json. Are you running this via a web server?");
        games = [...customGames];
    }
    
    renderGameList();
}

// 2. Render Sidebar List
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

// 3. Load Game into Iframe
function loadGameToIframe(game) {
    const iframe = document.getElementById('game-frame');
    if (game.type === 'file') {
        // Loads a custom injected HTML file
        iframe.src = game.content; 
    } else {
        // Loads standard URLs from the JSON
        iframe.src = game.url;
    }
}

// 4. Add Custom HTML Game Logic
document.getElementById('add-game-btn').onclick = () => {
    const title = document.getElementById('new-game-title').value;
    const fileInput = document.getElementById('new-game-file');
    
    if (!title || !fileInput.files.length) {
        return alert("Please enter a title and select an HTML file.");
    }
    
    const file = fileInput.files[0];
    const reader = new FileReader();
    
    // Convert the HTML file to a Base64 string so the iframe can read it locally
    reader.onload = function(e) {
        const newGame = {
            id: 'custom_' + Date.now(),
            title: title,
            type: 'file',
            content: e.target.result // Base64 HTML string
        };
        
        // Save to LocalStorage
        const customGames = JSON.parse(localStorage.getItem('customGames') || '[]');
        customGames.push(newGame);
        localStorage.setItem('customGames', JSON.stringify(customGames));
        
        // Update live list
        games.push(newGame);
        renderGameList();
        
        // Reset Inputs
        document.getElementById('new-game-title').value = '';
        fileInput.value = '';
    };
    
    reader.readAsDataURL(file);
};

// 5. CACHE SURVIVAL MECHANISM: Export Saves & Added Games
document.getElementById('export-btn').onclick = () => {
    // Gather EVERYTHING from localStorage (this includes progress from HTML5 games)
    const backupData = JSON.stringify(localStorage);
    
    const blob = new Blob([backupData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = 'unblocked_games_backup.json';
    a.click();
    
    URL.revokeObjectURL(url);
};

// 6. CACHE SURVIVAL MECHANISM: Restore Saves & Added Games
document.getElementById('import-btn').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const importedStorage = JSON.parse(event.target.result);
            
            // Loop through imported data and push it back into the browser's storage
            for (let key in importedStorage) {
                localStorage.setItem(key, importedStorage[key]);
            }
            
            alert("Games and save progress restored successfully!");
            loadGames(); // Refresh the list
        } catch (err) {
            alert("Invalid backup file.");
        }
    };
    
    reader.readAsText(file);
    e.target.value = ''; // Reset input
};

// Start the app
loadGames();