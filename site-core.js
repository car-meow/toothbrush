// ============================================================
// SITE CORE: Navigation, Splash System, Proxy Launcher, Keybinds
// (Independent of Cookie Clicker Game)
// ============================================================

(function () {
    // --- Splashes ---
    const splashes = [
        "Assisted by Jayden!", "No, please don't close my ta-", "Y'all, Vivian says hi!", "are u srs rn vro", 
        "Im tired boss", "Please don't press Shift+Q 2 times in rapid succession :(", "I don't know what I'm doing.", "I don't know what I'm doing either.",
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
        "Press F To Pay Respects.", " Gigachad Approved.", "Bing Chilling", "Welcome, Internet Stranger", 
        "Powered By Questionable Decisions", "Lag Is A Feature", "Probably Works On Mobile", "Insert Funny Text Here",
        "Skill Issue Detected", "Press Start, Probably", "No Lootboxes Here", "Made With Too Much Caffeine", "Loading Personality...", 
        "Achievement Unlocked: Website", "Touch Grass Later", "Certified Internet Nonsense", "Your Browser Is Screaming", 
        "Please Ignore The Bugs", "Respawning Shortly", "Built Different, Probably", "Warning: Fun Ahead", "Absolutely Nobody Asked", 
        "Welcome To The Void", "Gamers, Assemble", "Critical Hit!", "You Died. Again.", "Skill Issue Incorporated", "RNGesus Be Praised", 
        "One More Game", "Definitely Not A Mimic", "Loot Goblin Approved", "Spawn Camping Life", "GG, I Guess", "Nice Aim, Potato", 
        "Lag Spike Incoming", "Press F For Snacks", "Totally Balanced Gameplay", "Nerf This Website", "Buff The Coffee", 
        "Main Character Energy", "Side Quest Started", "Quest Accepted, Probably", "Boss Music Intensifies", "The Grind Never Ends", 
        "Farming Pixels Since Forever", "Loading... Blame The WiFi", "WiFi Diff", "Ping Is Pain", "Respawn And Repeat", 
        "Eat, Sleep, Respawn", "No Hitbox Included", "Definitely Meta", "Patch Notes Pending", "Error 404: Motivation", 
        "Running On Pure Chaos", "Probably Shouldn't Click That", "Don't Feed The Algorithm", "This Seemed Like Good Idea", 
        "Internet Go Brrr", "Powered By Bad Ideas", "Zero Thoughts Detected", "Brain.exe Has Crashed", "Please Hold My Brain", 
        "Currently Doing Nothing", "Professional Button Presser", "Unreasonably Confident", "Certified Silly Goose", "Bonk Responsibly",
        "Vibes Detected", "No Thoughts, Just Vibes", "Welcome To My Mess", "Nice", "You Found It", "What Could Go Wrong?", "Probably Nothing", 
        "It's Probably Fine", "Everything Is Under Control", "Ignore That Explosion", "We Meant To Do That", "Working As Intended", "Definitely Not Haunted", 
        "Do Not Summon Anything", "Please Don't Break Anything", "Have Fun, Nerd", "Welcome, Fellow Gremlin", "Your Quest Begins", "Enter At Your Own Risk", 
        "Adventure Awaits, Probably", "Dangerously Underqualified", "Maximum Goblin Energy", "Absolutely Zero Warranty", "May Contain Nonsense", "Now With More Website", 
        "Better Than A Blank Page", "Made Of Pixels", "Powered By Friendship", "Friendship Buff Activated", "Legendary Website Drop", "Rare Loot Found", "Epic Fail Incoming", 
        "Congratulations, You Have Eyes", "Thanks For Visiting", "Come Back With Snacks", "Certified Creeper Safe", "Totally Not A Creeper", "Diamond Hands", "Punching Trees Again", 
        "Achievement Get!", "You Found Iron!", "Smells Like Adventure", "Almost Legendary", "Very Blocky", "Extremely Cubical", "Now In 8 Bits", "Loading Chunk...", "Generating World...", "Building Terrain...", "Locating Stronghold...", "Finding Village...", "Trading Emeralds", "Suspicious Stew Included", "Creeper? Aw Man.", "Aww Man!", 
        "Where's My Pickaxe?", "Dig Down Carefully", "Never Dig Straight Down", "Watch Your Step", "Mind The Lava", "Lava Has Opinions", "That's A Lot Of Gravel", "Definitely Bring Torches", "Torch Acquired", "Inventory Almost Full", "Inventory Management Simulator", "Crafting Something", "Crafting Table Required", "Needs More Cobblestone", "Cobblestone Solves Everything", "Wooden Pickaxe Moment", "Stone Age Achieved", "Iron Age Soon", "Diamond Era Pending", 
        "Nether Bound", "Netherite Eventually", "Into The Nether", "Don't Look At Endermen", "Enderman Disapproves", "Ender Pearl Acquired", "Eyes Of Ender Ready", "The End Awaits", "Dragon Fight Later", "Boss Fight Eventually", "Respawn Point Set", "Bed Spawn Saved", "Sweet Dreams", "Night Is Coming", "Monsters Nearby", "Zombie Incoming", "Skeleton Has Aim", "Spider Situation", "Creeper Behind You", "Run!", "Hide In The Dirt", "Dig A Panic Hole", "Emergency Dirt Shelter", "Home Sweet Dirt", "Five-Star Dirt House", "Architectural Masterpiece", "Interior Design Optional", "Roof Sold Separately", "Door Optional", "Window Technology", "Villager Approved", "Hrrrm", "Emerald Economy", "Trade Offer!", "One Emerald, Please", "Definitely A Fair Trade", "Mending When?", "Fortune Favors The Miner", "Silk Touch Enjoyer", "Unbreaking Everything", "Efficiency Is Key", "Mining Fatigue Detected", "Critical Mining", "Chunk Loading Slowly", "Chunk Border Enjoyer", "Biome Discovered", "New Recipe Unlocked", "Recipe Book Opened", "Crafting Knowledge Increased", "XP Gained!", "Level Up!", "Enchantment Table Ready", "Enchanting Something", "Too Expensive!", "Anvil Has Spoken", "Repair Costs Excessive", "Fishing For Loot", "Fish Acquired", "Boat Technology", "Definitely A Real Horse", "Horse Acquired", "Wolf Friend Acquired", "Cat Friend Acquired", "Achievement Unlocked!", "Secret Area Found", "Hidden Chest Detected", "Chest Full Of Junk", "Rare Drop!", "Legendary Drop!", "Common Drop Moment", "Looting III Enjoyer", "Dungeon Nearby", "Mineshaft Detected", "Stronghold Nearby", "Temple Found", "Village Found!", "Village Has Beds", "Someone Moved My Bed", "Bed Was Missing", "Respawn Denied", "You May Not Rest Now", "Phantoms Approaching", "Sleep Is Important", "Daylight Restored", "Sunrise Achieved", "Night Skip Successful", "Rain Sounds Intensify", "Thunder Approaches", "Weather Event!", "Snow Biome Enjoyer", "Desert Has No Water", "Ocean Monument Somewhere", "Jungle Expedition", "Mushroom Island Real", "Rare Biome Moment", "Seed Is Blessed", "Seed Is Cursed", "World Generation Moment", 
        "Procedural Nonsense", "Random Seed Energy", "Spawn Point Unfortunate", "Spawn Point Fantastic", "Coordinates Unknown", "Map Not Included", "Compass Confused", "Lost Again", "Definitely This Way", "Wrong Way!", "Turn Around", "Home Is Somewhere", "Where Is Home?", "Coordinates Would Help", "Classic Gamer Navigation", "Map Acquired", "Map Still Confusing", "Secret Tunnel", "Definitely A Secret Tunnel", "Suspicious Button", "Press The Button", "Button Pressed", "Nothing Happened", "Something Happened", "Probably Fine", "Everything Is Fine", "It Wasn't Fine", "You Should Run", "Run Faster", "Too Late", "Game Over?", "Not Quite", "Continue?", "Press Any Key", "Any Key Missing", "Insert Coin", "Coin Accepted", "Player One Ready", "Player Two Waiting", "New Game+", "Old Game Energy", "Classic Mode Activated", "Pixel Perfect", "Retro Goodness", "8-Bit Nonsense", "16-Bit Chaos", "CRT Recommended", "Save Often", "Did You Save?", "Autosave Disabled", "Autosave Successful", "Loading Save...", "Corrupted Save?!", "Just Kidding", "Totally Stable", "Zero Bugs Found", "Bug Not Found", "Feature Discovered", "Unexpected Feature", "Classic Feature", "It's Not A Bug", "Working As Intended", "Patch Incoming", "Patch Notes When?", "Version Unknown", "Version Probably Fine", "Beta Forever", "Early Access Energy", "Demo Mode Activated", "Full Game Eventually", "Secret Cheat Code", "Konami Moment", "Press Up Up Down", "Cheat Code Rejected", "Achievement Hunters Welcome", "Completionist Behavior Detected", "100% Maybe", "New High Score", "Personal Best!", "Scoreboard Updated", "Leaderboard Dreams", "Git Gud", "Skill Issue+", "Critical Skill Issue", "Maximum Skill Issue", "Skill Tree Unlocked", "New Ability Acquired", "Passive Ability: Procrastination", "Passive Ability: Snacks", "Buff Applied", "Debuff Applied", "Status Effect: Confused", "Status Effect: Hungry", "Status Effect: Sleepy", "Status Effect: Powerful", "Maximum Health Probably", "Mana Not Included", "Stamina Optional", "Cooldown Remaining", "Ability Ready", "Ultimate Ready", "Boss Approaching", "Mini Boss Approaching", "Tutorial Boss Energy", 
        "Tutorial Completed", "Tutorial Was Optional", "Tutorial Ignored", "Controls Forgotten", "Controls Remapped", "Keyboard Warrior", "Mouse Diff", "Controller Disconnected", "Player Disconnected", "Player Reconnected", "Connection Established", "Connection Questionable", "Server Is Thinking", "Server Said No", "Server Said Maybe", "Multiplayer Shenanigans", "Local Multiplayer Energy", "Co-Op Recommended", "Friendship Required", "Friendship Optional", "NPC Behavior Detected", "NPC Has Quest", "Quest Marker Spotted", "Quest Log Full", "Quest Abandoned", "Quest Somehow Completed", "Side Quest Forever", "Main Quest Optional", "Lore Discovered", "Lore Unclear", "Lore Is Complicated", "Ancient Prophecy Pending", "Forbidden Knowledge Acquired", "Secret Knowledge", "Definitely Canon", "Probably Canon", "Non-Canon Behavior", "Plot Armor Equipped", "Main Character Spotted", "Villain Monologue Loading", "Cutscene Incoming", "Skip Cutscene?", "No Skipping Allowed", "Dialogue Intensifies", "NPC Dialogue Loop", "You Have Mail", "Mailbox Full", "Item Acquired", "Key Item Acquired", "Quest Item Missing", "Wrong Item", "Try Again", "Try Harder", "One More Try", "Last Try", "Actually Last Try", "Okay, One More", "This Time For Real", "Definitely The Last One", "Game Saved", "Now Entering...", "Welcome Back, Hero", "Welcome Back, Nerd", "Good Luck Out There", "Have Fun!", "Don't Die", "Try Not To Die", "Please Survive", "Survival Not Guaranteed", "Good Luck, You'll Need It", "May The RNG Favor You", "RNG Has Spoken", "The Dice Have Fallen", "Critical Success", "Critical Failure", "Natural Twenty!", "Natural One!", "Roll Again", "Loot First, Questions Later", "Chest Before Everything", "Always Check The Chest", "There Might Be Loot", "Loot Detected", "Rare Loot", "Epic Loot", "Mythic Loot", "Legendary Loot", "Common Loot", "Loot Goblin Mode", "Goblin Approved", "Goblin Hours", "Goblin Technology", "Certified Goblin Moment", "Absolutely Goblin Behavior", "Gremlin Mode Activated", "Gremlin Approved",
        "Prelude to Chaos", "Kuronami 1 + 2", "Ayakashi phantom goes brrrrr", "DID you really think I wrote all these?", "Don't worry bro, I did", "Also try 55gms.app!", "Sonion", "I'm gonna eat an onion today. RAW.", "PRIME VANDAL BABYYYYYY", "Solarstride mogs everything lil bro", "TS PMO", "Splash Text", "Don't read romance novels kids",
        "Chaos Mode Enabled", "Chaos Is Loading", "Maximum Chaos", "Controlled Chaos", "Uncontrolled Chaos", "Mildly Concerning", "Deeply Concerning", "Extremely Concerning", "Probably Haunted", "Definitely Haunted", "Ghosts Are Optional", "Ghost Detected", "Spooky Season Forever", "Do Not Open", "Definitely Open It", "You Opened It", "That Was A Mistake", "Worth It", "Probably Worth It", "No Regrets", "Several Regrets", "Immediate Regret", "Excellent Decision", "Terrible Decision", "Questionable Decision", "Decision Pending", "Decision Made", "Too Late Now", "We Ball", "Balling Continues", "Never Stop Balling", "Absolute Cinema", "Peak Gaming", "Gaming Has Occurred", "Game Detected", "Gamer Fuel Required", "Snack Break Incoming", "Hydration Check", "Touch Grass Reminder", "Grass Texture Loading", "Grass Successfully Touched", "Return To Game", "One More Round", "One More Run", "One More Turn", "One More Level", "One More Dungeon", "One More Chest", "One More Hour", "It Is Midnight", "Sleep Is Optional", "Sleep Later", "Tomorrow Is Fine", "Future Me Problem", "Past Me Failed", "Present Me Is Confused", "Brain Loading...", "Brain Has Left", "Brain Not Found", "Thinking...", "Still Thinking...", "Thought Complete", "No Thoughts Detected", "Certified Classic", "Instant Classic", "Retro Mode", "Nostalgia Unlocked", "Memory Card Missing", "Save File Found", "Press Start To Begin", "Press Start To Continue", "Continue The Adventure", "Adventure Continues", "To Be Continued", "End Of Demo", "Thanks For Playing", "Thanks For Visiting", "See You Next Time"

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
        const video = document.querySelector('.home-bg-video');
        if (video) {
            try { video.pause(); } catch(e) {}
        }
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

        // Expanded Patch Notes Modal Handlers
        const readMoreBtn = document.getElementById('nexus-read-more-btn');
        const closePatchnotesBtn = document.getElementById('nexus-close-patchnotes-btn');
        const patchnotesOverlay = document.getElementById('nexus-patchnotes-overlay');

        if (readMoreBtn && patchnotesOverlay) {
            readMoreBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (updateCard) {
                    updateCard.style.opacity = '0';
                    updateCard.style.visibility = 'hidden';
                    updateCard.style.pointerEvents = 'none';
                }
                patchnotesOverlay.style.display = 'flex';
            };
        }

        function closePatchnotesModal() {
            if (patchnotesOverlay) {
                patchnotesOverlay.style.display = 'none';
            }
        }

        if (closePatchnotesBtn) {
            closePatchnotesBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                closePatchnotesModal();
            };
        }

        if (patchnotesOverlay) {
            patchnotesOverlay.onclick = (e) => {
                if (e.target === patchnotesOverlay) {
                    closePatchnotesModal();
                }
            };
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && patchnotesOverlay && patchnotesOverlay.style.display === 'flex') {
                closePatchnotesModal();
            }
        });

        // Launch in-app tutorial engine
        if (window.TutorialEngine && typeof window.TutorialEngine.initHome === 'function') {
            window.TutorialEngine.initHome();
        }
    });
})();
