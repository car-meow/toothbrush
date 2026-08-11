// ============================================================
// SITE CORE: Navigation, Splash System, Proxy Launcher, Keybinds
// (Independent of Cookie Clicker Game)
// ============================================================

(function () {
    // --- Splashes ---
    const splashes = [
        "Assisted by Jayden!", "No, please don't close my ta-", "Y'all, Vivian says hi!",
        "Wait, wait, I was about to finish the level!", "READ the TUTORIAL!", "Dead.",
        "Wow. Just... wow.", "Honorable mention: Ctrl+W.", "Iso bottom frags",
        "Thanks for using Nexus!", "Yo Dhruva, wassup? Join the chat room!",
        "Master, I'm hungry", "No food for you!", "Prompted to perfection.",
        "ALT+TAB is your best friend.", "AI solved the math, I solved the level.",
        "High scores > GPA.", "Saving progress... hopefully.", "Not a bug, it's a feature.",
        "Powered by pure procrastination.", "100% human-ish.", "Linewize is watching...",
        "GoGuardian is blind.", "Just one more level.", "Strictly educational...",
        "Does this count as CS homework?", "Bypassing the boredom.",
        "Don't forget to backup!", "Stealth mode engaged.",
        "Everything is unblocked if you try.", "Browser-based bliss.",
        "Level 99 Procrastinator.", "Error 404: Homework not found.",
        "About:blank magic.", "Speedrunning the semester.",
        "The AI says take a break.", "One file to rule them all.",
        "Don't close the lid!", "Your progress is persistent.",
        "Chromebooks are gaming rigs.", "Click the cookie.",
        "Become a Swag Lord.", "Cookies are life.", "Baking at lightspeed.",
        "Respawn Ready!", "Critical Hit!", "Level Up!", "GG EZ!", "Boss Incoming!",
        "Loot Everything!", "360 No Scope!", "#1 Victory Royale!", "Achievement Get!",
        "Quest Accepted!", "Combo Master!", "1-up mushroom!", "Save Point!", "Speedrun Time!",
        "New Game+!", "Frag Out!", "Final Boss!", "XP Farming!", "Skill Issue!",
        "Patch Notes!", "Nerf This!", "Buff Incoming!", "Game On!", "Pixel Perfect!",
        "One More Match!", "Ranked Grind!", "Hidden Treasure!", "Checkpoint Reached!",
        "Mana Low!", "Full Health!", "Legendary Drop!", "Dungeon Crawling!",
        "Ultimate Ready!", "Press Start!", "Loading Assets!", "Arcade Fever!",
        "Respawn Pending!", "Loot Goblin!", "Side Questing!", "Combo Breaker!",
        "Boss Defeated!", "Controller Connected!", "Keyboard Warrior!", "AFK Moment!",
        "Victory Screen!", "Bonus Round!", "Inventory Full!", "Secret Found!",
        "Achievement Hunter!", "Power Up!", "Match Found!", "Squad Wipe!",
        "Headshot Confirmed!", "Damage Dealer!", "Ready Check!", "Raid Night!",
        "Farming Materials!", "Rare Spawn!", "Crafting Time!", "Gold Farming!",
        "PvP Enabled!", "Battle Ready!", "Last Life!", "Perfect Run!", "Daily Quest!",
        "Weapon Equipped!", "Armor Up!", "Boss Rush!", "Mini Map!", "Quick Save!",
        "Spawn Camping!", "New Record!", "Ultimate Combo!", "Epic Victory!", "Rare Loot!",
        "Legendary Status!", "Quest Complete!", "Raid Cleared!", "Enemy Spotted!",
        "Critical Success!", "Fast Travel!", "Grinding XP!", "Multiplayer Madness!",
        "Stay Frosty!", "Game Saved!", "Boss Music!", "Hidden Path!", "Loot Crate!",
        "Hero Selected!", "Character Created!", "Dungeon Mastered!", "Arena Champion!",
        "Ready Player!", "Insert Coin!", "Tactical Pause!", "Final Round!",
        "Battle Commencing!", "Match Point!", "Victory Achieved!", "Gaming Never Sleeps!",
        "Suspicious Banana.", "Quantum Pickles!", "Bees Approved!", "Tuesday Energy!",
        "Moist Algorithms.", "Garlic Powered!", "Duck Certified!", "Bread Protocol.",
        "Cosmic Toaster!", "Microwave Wisdom.", "Slightly Chaotic!", "Frog Economics.",
        "Caffeinated Thoughts.", "Certified Goblin!", "Unexpected Cheese!",
        "Moon Enthusiast.", "Parallel Parking!", "Hyperactive Spoon!", "Pancake Horizon.",
        "Gravity Optional!", "Keyboard Gremlin!", "Tactical Nonsense.", "Banana Orbit!",
        "Shrimp Diplomacy.", "Waffle Engine!", "Owl Software.", "Pocket Tornado!",
        "Tiny Apocalypse!", "Unlicensed Wizardry.", "Crouton Powered!", "Infinite Laundry.",
        "Penguin Approved!", "Bread Detected!", "Probably Fine.", "Chaotic Neutrality.",
        "Evil Muffin!", "Sentient Cactus.", "Mystery Button!", "The Cake Is A Lie!",
        "It's Over 69420!", "Leeroy Jenkins!", "All Your Base!", "Do A Barrel Roll!",
        "Press F To Pay Respects.", " Gigachad Approved.", "Bing Chilling"
    ];

    function cycleSplash() {
        const splashEl = document.getElementById('splash-text');
        if (!splashEl) return;
        const s = splashes[Math.floor(Math.random() * splashes.length)];
        splashEl.style.opacity = 0;
        setTimeout(() => {
            splashEl.textContent = '"' + s + '"';
            splashEl.style.opacity = 1;
        }, 150);
    }

    function navigateWithFade(url) {
        const overlay = document.getElementById('page-fade-overlay');
        if (overlay) {
            overlay.classList.remove('fade-out');
            setTimeout(() => { location.href = url; }, 370);
        } else {
            location.href = url;
        }
    }

    window.cycleSplash = cycleSplash;
    window.navigateWithFade = navigateWithFade;

    document.addEventListener('DOMContentLoaded', () => {
        // Page Fade In
        const overlay = document.getElementById('page-fade-overlay');
        if (overlay) {
            requestAnimationFrame(() => { overlay.classList.add('fade-out'); });
        }

        // Splash Cycling
        const logo = document.getElementById('nexus-logo');
        if (logo) {
            logo.onclick = (e) => { e.preventDefault(); cycleSplash(); };
            cycleSplash();
        }

        // Navigation Handlers
        const btnNavGames = document.getElementById('btn-nav-games');
        if (btnNavGames) btnNavGames.onclick = () => navigateWithFade('carmeow.html');

        const btnNavAi = document.getElementById('btn-nav-ai');
        if (btnNavAi) btnNavAi.onclick = () => navigateWithFade('ai.html');

        const btnNavChat = document.getElementById('btn-nav-chat');
        if (btnNavChat) btnNavChat.onclick = () => navigateWithFade('chat.html');

        const btnNavMedia = document.getElementById('btn-nav-media');
        if (btnNavMedia) btnNavMedia.onclick = () => navigateWithFade('media.html');

        const btnNavSettings = document.getElementById('btn-nav-settings');
        if (btnNavSettings) btnNavSettings.onclick = () => navigateWithFade('settings.html');

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
                    if (window.nexusAlert) window.nexusAlert('Pop-up blocked! Please allow pop-ups to open the proxy.');
                    else alert('Pop-up blocked! Please allow pop-ups to open the proxy.');
                }
            };
        }

        // Version card hover setup
        const verContainer = document.querySelector('.nexus-version-container');
        const updateCard = document.querySelector('.nexus-update-card');
        if (verContainer && updateCard) {
            let hideTimer = null;
            function showCard() {
                clearTimeout(hideTimer);
                updateCard.style.opacity = '1';
                updateCard.style.visibility = 'visible';
                updateCard.style.transform = 'translateY(-50%) translateX(0)';
                updateCard.style.pointerEvents = 'auto';
            }
            function hideCard() {
                hideTimer = setTimeout(() => {
                    updateCard.style.opacity = '0';
                    updateCard.style.visibility = 'hidden';
                    updateCard.style.transform = 'translateY(-50%) translateX(6px)';
                    updateCard.style.pointerEvents = 'none';
                }, 200);
            }
            verContainer.addEventListener('mouseenter', showCard);
            verContainer.addEventListener('mouseleave', hideCard);
            updateCard.addEventListener('mouseenter', showCard);
            updateCard.addEventListener('mouseleave', hideCard);
        }

        // Launch in-app tutorial engine
        if (window.TutorialEngine && typeof window.TutorialEngine.initHome === 'function') {
            window.TutorialEngine.initHome();
        }
    });
})();
