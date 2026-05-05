// ==================== COOKIE ENGINE: Spawning, Clicking, Effects, UI ====================

// --- Sound Manager ---
const SFX = {};
function initSounds() {
    ['get1','get2','get3','get4'].forEach(s => SFX[s] = new Audio('Sound/'+s+'.mp3'));
    ['Common','Uncommon','Rare','Epic','Epic2','divine','divine2','divine3','stop','start','achN','achR'].forEach(s => SFX[s] = new Audio('Sound/'+s+'.mp3'));
    SFX.bgm = new Audio('Sound/bgm.mp3'); SFX.bgm.loop = true; SFX.bgm.volume = 0.3;
}
function playSound(key) {
    if (G.muted || !SFX[key]) return;
    try { const s = SFX[key]; s.currentTime = 0; s.play().catch(()=>{}); } catch(e) {}
}
function playRandomGet() {
    playSound('get' + (Math.floor(Math.random()*4)+1));
}

// --- DOM References ---
let DOM = {};
function cacheDom() {
    DOM = {
        cookieLayer: document.getElementById('cookie-layer'),
        floatLayer: document.getElementById('float-layer'),
        bucksDisplay: document.getElementById('bucks-display'),
        cpsDisplay: document.getElementById('cps-display'),
        swagDisplay: document.getElementById('swag-display'),
        shopBucks: document.getElementById('shop-bucks'),
        shopList: document.getElementById('shop-list'),
        statsList: document.getElementById('stats-list'),
        shopModal: document.getElementById('shop-modal'),
        statsModal: document.getElementById('stats-modal'),
        screenBorder: document.getElementById('screen-border'),
        divineOverlay: document.getElementById('divine-overlay'),
        divPart: document.getElementById('div-part'),
        inePart: document.getElementById('ine-part'),
        effectsContainer: document.getElementById('effects-container'),
        discoveryPopup: document.getElementById('discovery-popup'),
        discTitle: document.getElementById('disc-title'),
        discLore: document.getElementById('disc-lore'),
        muteBtn: document.getElementById('btn-mute'),
        splashText: document.getElementById('splash-text'),
        menuWrapper: document.getElementById('menu-items-wrapper'),
        hideMenuBtn: document.getElementById('hide-menu-btn'),
        magnetVisual: document.getElementById('magnet-visual')
    };
}

// --- State ---
let menusHidden = false;
let divineActive = false;
let spawnTimer = null;
let bgmStarted = false;
let activeCookies = [];

// --- Splashes ---
const splashes = [
    "Assisted by Jayden!", "No, please don't close my ta-", "Y'all, Vivian says hi!",
    "Wait, wait, I was about to finish the level!", "READ the TUTORIAL!", "Dead.",
    "Wow. Just... wow.", "Honorable mention: Ctrl+W.", "Iso bottom frags",
    "Thanks for using Toothbrush!", "Yo Dhruva, wassup? Join the chat room!",
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
    "Become a Swag Lord.", "Cookies are life.", "Baking at lightspeed."
];

function cycleSplash() {
    if (!DOM.splashText) return;
    const s = splashes[Math.floor(Math.random() * splashes.length)];
    DOM.splashText.style.opacity = 0;
    setTimeout(() => { DOM.splashText.textContent = '"' + s + '"'; DOM.splashText.style.opacity = 1; }, 150);
}

// --- Cookie Spawning ---
function spawnCookie(forceCookie = null, forceRarity = null) {
    if (divineActive) return;
    const cookie = forceCookie || rollCookie();
    const rarity = forceRarity || rollRarity();
    const size = getCookieSize();

    const el = document.createElement('div');
    el.className = 'cookie-entity ' + cookie.aura;
    el.style.width = size + 'px';
    el.style.height = size + 'px';

    const img = document.createElement('img');
    img.src = cookie.img;
    img.draggable = false;
    el.appendChild(img);

    const yPos = 10 + Math.random() * 80;
    el.style.top = yPos + 'vh';

    const goRight = Math.random() > 0.5;
    const duration = 8000 + Math.random() * 6000;
    const startX = goRight ? -size : window.innerWidth + size;
    const endX = goRight ? window.innerWidth + size : -size;
    el.style.left = startX + 'px';

    const hasMagnet = (G.upgrades['magnet'] || 0) > 0;
    
    const data = {
        el, cookie, rarity, startX, endX, yStart: yPos / 100 * window.innerHeight,
        startTime: performance.now(), duration, hasMagnet, alive: true, size
    };

    activeCookies.push(data);
    if (DOM.cookieLayer) DOM.cookieLayer.appendChild(el);

    const triggerClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!data.alive) return;
        data.alive = false;
        handleCookieClick(data, e.clientX || (e.touches && e.touches[0].clientX), e.clientY || (e.touches && e.touches[0].clientY));
    };
    el.onclick = triggerClick;
    el.ontouchstart = triggerClick;

    const divIntervention = G.upgrades['divine_intervention'] || 0;
    const divCalling = G.upgrades['divine_calling'] || 0;
    
    let autoClicked = false;
    if (divCalling > 0) {
        autoClicked = true;
    } else if (divIntervention > 0) {
        if (Math.random() < divIntervention * 0.10) autoClicked = true;
    }

    if (autoClicked) {
        setTimeout(() => {
            if (data.alive) {
                data.alive = false;
                const rect = el.getBoundingClientRect();
                handleCookieClick(data, rect.left + size/2, rect.top + size/2);
            }
        }, 600); 
    }
}

function animateCookies(now) {
    if (DOM.magnetVisual) {
        DOM.magnetVisual.style.display = ((G.upgrades['magnet'] || 0) > 0 && G.magnetEnabled) ? 'block' : 'none';
    }

    for (let i = activeCookies.length - 1; i >= 0; i--) {
        const c = activeCookies[i];
        if (!c.alive) continue;
        if (divineActive) { requestAnimationFrame(animateCookies); return; }

        const elapsed = now - c.startTime;
        let progress = Math.min(elapsed / c.duration, 1);

        let x, y, rot;

        if (c.hasMagnet && G.magnetEnabled) {
            let magProgress = Math.min(elapsed / (c.duration / 2), 1);
            const targetX = window.innerWidth / 2 - c.size / 2;
            const targetY = window.innerHeight / 2 - c.size / 2;
            
            x = c.startX + (targetX - c.startX) * magProgress;
            y = c.yStart + (targetY - c.yStart) * magProgress;
            rot = magProgress * 360 * 2;
            
            if (magProgress >= 1) {
                c.el.style.left = targetX + 'px';
                c.el.style.top = targetY + 'px';
                c.el.style.transform = 'rotate(' + rot + 'deg)';
                continue; 
            }
        } else {
            if (progress >= 1) {
                c.alive = false;
                if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
                activeCookies.splice(i, 1);
                continue;
            }
            x = c.startX + (c.endX - c.startX) * progress;
            y = c.yStart;
            rot = progress * 360 * 2;
        }

        c.el.style.left = x + 'px';
        c.el.style.top = y + 'px';
        c.el.style.transform = 'rotate(' + rot + 'deg)';
    }
    activeCookies = activeCookies.filter(c => c.alive);
    requestAnimationFrame(animateCookies);
}

function startSpawning() {
    if (spawnTimer) clearInterval(spawnTimer);
    const interval = getSpawnInterval();
    spawnTimer = setInterval(() => {
        if (Math.random() < 0.85) spawnCookie(); 
    }, interval);
}

// --- Cookie Click Handling ---
function handleCookieClick(data, cx, cy) {
    if (!bgmStarted && !G.muted) { SFX.bgm.play().catch(()=>{}); bgmStarted = true; }
    if (data.el && data.el.parentNode) data.el.parentNode.removeChild(data.el);

    const cookie = data.cookie;
    const rarity = data.rarity;

    let variance = 0.20;
    if (['smore', 'sugar', 'golden', 'nebula'].includes(cookie.id)) variance = 0.35;
    let baseVal = cookie.base * (1 + (Math.random() * variance * 2 - variance));
    
    const value = Math.round(baseVal * rarity.mult * getGlobalMult());

    G.bucks += value;
    G.totalEarned += value;

    if (!G.stats[cookie.id]) {
        G.stats[cookie.id] = { total: 0, common: 0, uncommon: 0, rare: 0, epic: 0, divine: 0 };
    }
    G.stats[cookie.id].total++;
    G.stats[cookie.id][rarity.id]++;

    const isNew = !G.discoveries[cookie.id];
    if (isNew) {
        G.discoveries[cookie.id] = true;
        showDiscovery(cookie, rarity.color);
    }

    playRandomGet();
    if (rarity.id !== 'common') {
        const rsnd = rarity.id === 'epic' ? (Math.random()>0.5?'Epic':'Epic2') :
                     rarity.id === 'divine' ? 'divine' : rarity.id;
        let soundKey = rarity.id.charAt(0).toUpperCase() + rarity.id.slice(1);
        if (rsnd === 'Epic2') soundKey = 'Epic2';
        if (rsnd === 'divine') soundKey = 'divine';
        setTimeout(() => playSound(soundKey), 100);
    }

    showPop(cx, cy);
    showFloatingBucks(cx, cy - 20, '+₡' + value);
    showFloatingRarity(cx, cy + 20, rarity.name, rarity.color);
    if (rarity.vignette) flashVignette(rarity.vignette);
    if (rarity.id === 'divine') triggerDivineEvent();

    updateHUD();
    saveGame();
}

// --- Visual Effects ---
function showPop(x, y) {
    const pop = document.createElement('img');
    pop.src = 'pop.gif';
    pop.className = 'pop-effect';
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    pop.style.width = '120px';
    pop.style.height = '120px';
    if (DOM.floatLayer) DOM.floatLayer.appendChild(pop);
    setTimeout(() => { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 600);
}

function showFloatingBucks(x, y, text) {
    const el = document.createElement('div');
    el.className = 'floating-bucks';
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    if (DOM.floatLayer) DOM.floatLayer.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 1600);
}

function showFloatingRarity(x, y, rName, rColor) {
    const el = document.createElement('div');
    el.className = 'floating-rarity';
    el.style.color = rColor;
    el.textContent = rName;
    el.style.left = x + 'px';
    el.style.top = (y + 30) + 'px';
    if (DOM.floatLayer) DOM.floatLayer.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
}

function flashVignette(color) {
    if (!DOM.screenBorder) return;
    DOM.screenBorder.style.boxShadow = 'inset 0 0 120px ' + color;
    DOM.screenBorder.style.opacity = '1';
    setTimeout(() => { DOM.screenBorder.style.opacity = '0'; }, 500);
}

function showDiscovery(cookie, color) {
    if (!DOM.discoveryPopup) return;
    DOM.discTitle.textContent = 'New ' + cookie.name + '!';
    DOM.discTitle.style.color = color || '#fff';
    DOM.discLore.textContent = '"' + cookie.lore + '"';
    DOM.discoveryPopup.classList.add('show');
    
    if (cookie.id === 'nebula' || cookie.id === 'golden') {
        playSound('achR');
    } else {
        playSound('achN');
    }
    
    setTimeout(() => DOM.discoveryPopup.classList.remove('show'), 4000);
}

// --- Divine Event ---
function triggerDivineEvent() {
    if (divineActive) return;
    divineActive = true;

    if (SFX.bgm && !G.muted) {
        const fade = setInterval(() => {
            if (SFX.bgm.volume > 0.05) SFX.bgm.volume -= 0.05;
            else { SFX.bgm.volume = 0; clearInterval(fade); }
        }, 100);
    }
    playSound('stop');

    DOM.divineOverlay.style.display = 'flex';
    DOM.divineOverlay.style.background = 'rgba(0,0,0,0.6)';

    setTimeout(() => {
        DOM.divPart.classList.add('slam');
        DOM.inePart.classList.add('slam');
        document.body.classList.add('camera-shake');
        playSound('divine2');
    }, 600);

    setTimeout(() => {
        document.body.classList.remove('camera-shake');
        DOM.divPart.classList.remove('slam');
        DOM.inePart.classList.remove('slam');
        DOM.divPart.style.transform = 'translateX(-150vw)';
        DOM.inePart.style.transform = 'translateX(150vw)';
        DOM.divineOverlay.style.background = 'rgba(0,0,0,0)';
        setTimeout(() => { DOM.divineOverlay.style.display = 'none'; }, 500);

        divineActive = false;

        if (!G.muted && bgmStarted) {
            const fadeIn = setInterval(() => {
                if (SFX.bgm.volume < 0.25) SFX.bgm.volume += 0.05;
                else { SFX.bgm.volume = 0.3; clearInterval(fadeIn); }
            }, 100);
        }
        playSound('start');
    }, 3000);
}

// --- HUD Updates ---
function updateHUD() {
    if (DOM.bucksDisplay) DOM.bucksDisplay.textContent = formatNum(G.bucks);
    if (DOM.cpsDisplay) DOM.cpsDisplay.textContent = '(' + formatNum(getCPS(), 1) + '/s)';
    if (DOM.swagDisplay) DOM.swagDisplay.textContent = formatNum(G.swag);
    if (DOM.shopBucks) DOM.shopBucks.textContent = formatNum(G.bucks);
}

function formatNum(n, dec) {
    if (n >= 1e12) return (n/1e12).toFixed(1) + 'T';
    if (n >= 1e9) return (n/1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K';
    return dec !== undefined ? n.toFixed(dec) : Math.floor(n).toString();
}

// --- Shop Rendering ---
function renderShop() {
    if (!DOM.shopList) return;
    DOM.shopList.innerHTML = '';

    // Autobakers
    addShopCategory('🤖 Autobakers');
    SHOP_ITEMS.filter(i => i.cat === 'autobaker').forEach(item => {
        const count = G.autobakers[item.id] || 0;
        const cost = getItemCost(item, count);
        const canBuy = G.bucks >= cost;
        const div = makeShopCard(item.name, item.desc, '₡' + formatNum(cost), 'Owned: ' + count + ' (+'+(item.cps*count).toFixed(1)+'/s)', canBuy, () => {
            if (G.bucks < cost) return;
            G.bucks -= cost;
            G.autobakers[item.id] = count + 1;
            updateHUD(); renderShop(); saveGame();
        });
        DOM.shopList.appendChild(div);
    });

    // Swag Upgrades (Permanent)
    addShopCategory('🔥 Swag Upgrades (Permanent)');
    SHOP_ITEMS.filter(i => i.cat === 'upgrade').forEach(item => {
        if (item.req && (G.upgrades[item.req.id] || 0) < item.req.count) return;

        const count = G.upgrades[item.id] || 0;
        const maxed = item.max && count >= item.max;
        const cost = getItemCost(item, count);
        const canBuy = G.swag >= cost && !maxed;
        const div = makeShopCard(item.name, item.desc, maxed ? 'MAXED' : '₴' + formatNum(cost), 'Level: ' + count + (item.max ? '/' + item.max : ''), canBuy, () => {
            if (G.swag < cost || maxed) return;
            G.swag -= cost;
            G.upgrades[item.id] = count + 1;
            if (item.id === 'frenzy') startSpawning(); 
            updateHUD(); renderShop(); saveGame();
        });
        div.classList.add('swag-item'); 
        DOM.shopList.appendChild(div);
    });

    // Consumables
    addShopCategory('⚡ Consumables');
    SHOP_ITEMS.filter(i => i.cat === 'consumable').forEach(item => {
        const state = G.consumables[item.id] || {active:false, endTime:0, cooldownEnd:0};
        const now = Date.now();
        const onCooldown = now < state.cooldownEnd;
        const isActive = state.active && now < state.endTime;
        const canBuy = G.bucks >= item.baseCost && !onCooldown && !isActive;
        const statusText = isActive ? '⏳ Active' : onCooldown ? '🕐 Cooldown' : 'Ready';
        const div = makeShopCard(item.name, item.desc, '₡' + formatNum(item.baseCost), statusText, canBuy, () => {
            if (!canBuy) return;
            G.bucks -= item.baseCost;
            if (item.id === 'warp') {
                const cps = getCPS();
                const gain = cps * 3600;
                G.bucks += gain;
                G.totalEarned += gain;
                G.consumables[item.id] = {active:false, endTime: now, cooldownEnd: now + item.cooldown*1000};
                showFloatingBucks(window.innerWidth/2, window.innerHeight/2, '+₡' + formatNum(gain));
                playSound('achN');
            } else {
                G.consumables[item.id] = {active:true, endTime: now + item.duration*1000, cooldownEnd: now + (item.duration + item.cooldown)*1000};
            }
            updateHUD(); renderShop(); saveGame();
        });
        DOM.shopList.appendChild(div);
    });

    const gain = calcPrestigeGain();
    const magnetVisible = (G.upgrades['magnet'] || 0) > 0;
    const magBtnText = G.magnetEnabled ? 'Disable Magnet' : 'Enable Magnet';
    const magBtnColor = G.magnetEnabled ? '#B71C1C' : '#2E7D32';

    let incinHtml = `<div class="shop-cat">You can't make a profit without burning some dough!</div>
        <div class="shop-item" style="grid-column: span 2; border-color: #f44336; text-align: center;">
            <div class="item-name" style="color: #f44336; font-size: 18px;">₴${formatNum(G.swag)} Swag Points Owned</div>
            <button id="btn-incinerate" class="save-btn incinerate-btn" style="width:100%;margin-top:10px;">Incinerate Cookies. Send an offering to the Cookie Gods. (+₴${formatNum(gain)})</button>
        </div>`;
    
    if (magnetVisible) {
        incinHtml += `<button id="btn-toggle-magnet" class="save-btn" style="grid-column: span 2; background:${magBtnColor}; margin-top:10px; width: 100%; border:none; padding:10px; border-radius:10px; color:white; font-weight:bold; cursor:pointer;">${magBtnText}</button>`;
    }
    
    const incinContainer = document.createElement('div');
    incinContainer.style.gridColumn = 'span 2';
    incinContainer.innerHTML = incinHtml;
    DOM.shopList.appendChild(incinContainer);

    document.getElementById('btn-incinerate').onclick = (e) => { e.preventDefault(); doIncinerate(); };
    if (magnetVisible) {
        document.getElementById('btn-toggle-magnet').onclick = (e) => { 
            e.preventDefault(); 
            G.magnetEnabled = !G.magnetEnabled; 
            renderShop(); 
            saveGame();
        };
    }

    updateHUD();
}

function addShopCategory(label) {
    const cat = document.createElement('div');
    cat.className = 'shop-cat';
    cat.textContent = label;
    DOM.shopList.appendChild(cat);
}

function makeShopCard(name, desc, cost, sub, canBuy, onClickCb) {
    const div = document.createElement('div');
    div.className = 'shop-item';
    div.innerHTML = '<div class="item-name">' + name + '</div><div class="item-desc">' + desc + '</div><div class="item-cost">' + cost + '</div>' + (sub ? '<div class="item-owned">' + sub + '</div>' : '');
    const btn = document.createElement('button');
    btn.className = 'buy-btn' + (canBuy ? '' : ' disabled');
    btn.textContent = canBuy ? 'Buy' : (cost === 'MAXED' || cost === 'OWNED' ? '✓' : 'Can\'t Afford');
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); onClickCb(); };
    btn.ontouchstart = (e) => { e.preventDefault(); e.stopPropagation(); onClickCb(); };
    div.appendChild(btn);
    return div;
}

// --- Stats Rendering ---
function renderStats() {
    if (!DOM.statsList) return;
    DOM.statsList.innerHTML = '';
    COOKIES.forEach(cookie => {
        const s = G.stats[cookie.id];
        if (!s || (s.total === 0 && !G.discoveries[cookie.id])) return;
        const div = document.createElement('div');
        div.className = 'stat-item';
        div.innerHTML = \`
            <img src="\${cookie.img}">
            <div class="stat-info">
                <div class="stat-name" style="color:#FFF">\${cookie.name}</div>
                <div class="stat-count">Total clicked: \${s.total}</div>
                <div class="stat-breakdown" style="font-size:10px; margin-top:4px; font-weight:bold;">
                    <span style="color:#CFCFCF">C: \${s.common||0}</span> | 
                    <span style="color:#6CDB66">U: \${s.uncommon||0}</span> | 
                    <span style="color:#566FEB">R: \${s.rare||0}</span> | 
                    <span style="color:#C24FFF">E: \${s.epic||0}</span> | 
                    <span style="color:#FFD700">D: \${s.divine||0}</span>
                </div>
            </div>\`;
        DOM.statsList.appendChild(div);
    });
    if (DOM.statsList.children.length === 0) {
        DOM.statsList.innerHTML = '<div style="grid-column:span 2;text-align:center;color:#666;padding:40px;">No cookies clicked yet! Click cookies floating across the screen.</div>';
    }
}

// --- Prestige ---
function doIncinerate() {
    const gain = calcPrestigeGain();
    if (gain < 1) { alert('You need ₡1,000,000 total earnings to Incinerate! Keep clicking.'); return; }
    if (!confirm('🔥 INCINERATE?\n\nYou will lose ALL ₡' + formatNum(G.bucks) + ' and all Autobakers.\nYou will gain ' + gain + ' Swag Points (₴).\n\nSwag upgrades are permanent.')) return;
    G.swag += gain;
    G.bucks = 0;
    G.totalEarned = 0;
    G.autobakers = {};
    G.consumables = {};
    updateHUD(); renderShop(); startSpawning(); saveGame();
    playSound('divine3');
    flashVignette('rgba(183,28,28,0.5)');
}

// --- Effects Timer Display ---
function updateEffects() {
    if (!DOM.effectsContainer) return;
    DOM.effectsContainer.innerHTML = '';
    const now = Date.now();
    SHOP_ITEMS.filter(i => i.cat === 'consumable').forEach(item => {
        const state = G.consumables[item.id];
        if (!state) return;
        if (state.active && now < state.endTime) {
            const left = Math.ceil((state.endTime - now) / 1000);
            const el = document.createElement('div');
            el.className = 'effect-item';
            el.innerHTML = '<div class="effect-name">' + item.name + '</div><div class="effect-timer">' + left + 's</div>';
            DOM.effectsContainer.appendChild(el);
        } else if (state.active) {
            state.active = false; 
        }
    });
}

// --- Autobaker Tick ---
function autoTick() {
    const cps = getCPS();
    if (cps > 0) {
        G.bucks += cps / 10; 
        G.totalEarned += cps / 10;
    }
    updateHUD();
}

// --- Toggle Menus ---
function toggleMenus() {
    menusHidden = !menusHidden;
    DOM.menuWrapper.style.opacity = menusHidden ? '0' : '1';
    DOM.menuWrapper.style.visibility = menusHidden ? 'hidden' : 'visible';
    DOM.hideMenuBtn.textContent = menusHidden ? 'Show Menu' : 'Hide Menu';
    DOM.hideMenuBtn.style.backgroundColor = menusHidden ? '#c8e6c9' : '#ffcdd2';
    DOM.hideMenuBtn.style.color = menusHidden ? '#2e7d32' : '#b71c1c';
}

// ==================== INIT ====================
window.addEventListener('DOMContentLoaded', () => {
    cacheDom();
    initSounds();
    loadGame();

    const offline = calcOfflineEarnings();
    if (offline > 0) {
        G.bucks += offline;
        G.totalEarned += offline;
        setTimeout(() => alert('Welcome back! Your autobakers earned ₡' + formatNum(offline) + ' while you were away.'), 500);
    }

    updateHUD();
    cycleSplash();
    startSpawning();
    requestAnimationFrame(animateCookies);

    if (!localStorage.getItem('tb_tut_welcome')) {
        document.getElementById('tut-overlay').style.display = 'flex';
    }

    document.getElementById('toothbrush-logo').onclick = (e) => { e.preventDefault(); cycleSplash(); };
    document.getElementById('btn-nav-games').onclick = () => { location.href='games.html'; };
    document.getElementById('btn-nav-ai').onclick = () => { location.href='ai.html'; };
    document.getElementById('btn-nav-chat').onclick = () => { location.href='chat.html'; };
    document.getElementById('btn-nav-tut').onclick = () => { location.href='tutorial.html'; };
    document.getElementById('proxy-btn').onclick = () => {
        const win = window.open('helios.html','_blank');
        if(!win) return alert("Pop-up Blocked!");
        document.title="New Tab"; document.body.innerHTML="";
        window.open('','_self'); window.close();
        setTimeout(()=>{ window.location.replace("about:blank"); },300);
    };

    document.getElementById('tut-btn').onclick = (e) => {
        e.preventDefault();
        document.getElementById('tut-overlay').style.display='none';
        localStorage.setItem('tb_tut_welcome','done');
    };

    DOM.hideMenuBtn.onclick = (e) => { e.preventDefault(); toggleMenus(); };

    document.getElementById('btn-shop').onclick = (e) => { e.preventDefault(); renderShop(); DOM.shopModal.classList.add('open'); };
    document.getElementById('shop-close').onclick = (e) => { e.preventDefault(); DOM.shopModal.classList.remove('open'); };
    DOM.shopModal.onclick = (e) => { if(e.target===DOM.shopModal) DOM.shopModal.classList.remove('open'); };

    document.getElementById('btn-stats').onclick = (e) => { e.preventDefault(); renderStats(); DOM.statsModal.classList.add('open'); };
    document.getElementById('stats-close').onclick = (e) => { e.preventDefault(); DOM.statsModal.classList.remove('open'); };
    DOM.statsModal.onclick = (e) => { if(e.target===DOM.statsModal) DOM.statsModal.classList.remove('open'); };

    DOM.muteBtn.onclick = (e) => {
        e.preventDefault();
        G.muted = !G.muted;
        DOM.muteBtn.textContent = G.muted ? '🔇' : '🔊';
        if (G.muted) { SFX.bgm.pause(); } else if (bgmStarted) { SFX.bgm.play().catch(()=>{}); }
        saveGame();
    };
    if (G.muted) DOM.muteBtn.textContent = '🔇';

    setInterval(autoTick, 100);       
    setInterval(updateEffects, 1000); 
    setInterval(saveGame, 15000);     
    setInterval(() => { updateHUD(); if(DOM.shopModal.classList.contains('open')) renderShop(); }, 1000);

    document.addEventListener('click', () => {
        if (!bgmStarted && !G.muted) { SFX.bgm.play().catch(()=>{}); bgmStarted = true; }
    }, { once: true });

    // Debug Keys & Popups
    document.addEventListener('keydown', (e) => {
        if (e.shiftKey && e.key === 'F1') {
            e.preventDefault();
            const amt = prompt('DEBUG: Enter amount of ₡ to add:');
            if (amt && !isNaN(amt)) {
                const val = parseFloat(amt);
                G.bucks += val;
                G.totalEarned += val;
                updateHUD();
                saveGame();
            }
        }
        if (e.shiftKey && e.key === 'F2') {
            e.preventDefault();
            const dbg = document.getElementById('debug-menu');
            if (dbg) dbg.style.display = dbg.style.display === 'none' ? 'block' : 'none';
        }
    });

    // Setup Debug Menu
    const dbgCookie = document.getElementById('debug-cookie');
    const dbgRarity = document.getElementById('debug-rarity');
    if (dbgCookie && dbgRarity) {
        COOKIES.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id; opt.textContent = c.name;
            dbgCookie.appendChild(opt);
        });
        RARITIES.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id; opt.textContent = r.name;
            dbgRarity.appendChild(opt);
        });
        document.getElementById('debug-spawn').onclick = () => {
            const cId = dbgCookie.value;
            const rId = dbgRarity.value;
            const cookie = COOKIES.find(x => x.id === cId);
            const rarity = RARITIES.find(x => x.id === rId);
            if (cookie && rarity) spawnCookie(cookie, rarity);
        };
    }

    G.lastSeen = Date.now();
    saveGame();
});
