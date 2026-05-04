// ==================== COOKIE CORE: Data, Economy, Save/Load ====================

const COOKIES = [
    {id:'chocolate_chip', name:'Chocolate Chip', img:'Cookies/chocolate_chip.png', aura:'aura-basic', base:1, lore:"The OG. The one that started it all. Respectable."},
    {id:'cashew', name:'Cashew', img:'Cookies/cashew.png', aura:'aura-cashew', base:2, lore:"Fancy. Expensive. Probably from Whole Foods."},
    {id:'oatmeal_raisin', name:'Oatmeal Raisin', img:'Cookies/oatmeal_raisin.png', aura:'aura-oatmeal', base:2, lore:"The betrayal cookie. Looks like chocolate chip. Isn't."},
    {id:'peanut_butter', name:'Peanut Butter', img:'Cookies/peanut_butter.png', aura:'aura-peanut', base:3, lore:"Sticks to the roof of your mouth AND your heart."},
    {id:'sugar', name:'Sugar', img:'Cookies/sugar.png', aura:'aura-sugar', base:3, lore:"Pure. Uncut. 100% refined sweetness."},
    {id:'chocolate', name:'Chocolate', img:'Cookies/chocolate.png', aura:'aura-chocolate', base:4, lore:"Double the chocolate, double the serotonin."},
    {id:'snickerdoodle', name:'Snickerdoodle', img:'Cookies/snickerdoodle.png', aura:'aura-snickerdoodle', base:5, lore:"Named by a 5-year-old. Perfected by the gods."},
    {id:'smore', name:"S'more", img:'Cookies/smore.png', aura:'aura-smore', base:6, lore:"Three layers of regret-free indulgence."},
    {id:'golden', name:'Golden', img:'Cookies/golden.png', aura:'aura-golden', base:10, lore:"Rumored to grant wishes. Results may vary."},
    {id:'nebula', name:'Nebula', img:'Cookies/nebula.png', aura:'aura-nebula', base:15, lore:"Baked in a dying star. Tastes like infinity."}
];

const RARITIES = [
    {id:'common', name:'Common', mult:1, color:'#CFCFCF', cls:'rarity-common', weight:60, vignette:null},
    {id:'uncommon', name:'Uncommon', mult:2, color:'#6CDB66', cls:'rarity-uncommon', weight:25, vignette:'rgba(108,219,102,0.25)'},
    {id:'rare', name:'Rare', mult:5, color:'#566FEB', cls:'rarity-rare', weight:10, vignette:'rgba(86,111,235,0.3)'},
    {id:'epic', name:'Epic', mult:15, color:'#C24FFF', cls:'rarity-epic', weight:4, vignette:'rgba(194,79,255,0.35)'},
    {id:'divine', name:'Divine', mult:50, color:'#FFD700', cls:'rarity-divine', weight:1, vignette:'rgba(255,215,0,0.4)'}
];

const SHOP_ITEMS = [
    // Autobakers
    {id:'oven', name:'Rusty Oven', cat:'autobaker', desc:'Generates ₡1 every 60 seconds.', baseCost:500, scaling:1.25, cps: 1/60, currency:'bucks'},
    {id:'mixer', name:'Industrial Mixer', cat:'autobaker', desc:'Generates ₡5 every 45 seconds.', baseCost:5000, scaling:1.18, cps: 5/45, currency:'bucks'},
    {id:'bakery', name:'Local Bakery', cat:'autobaker', desc:'Generates ₡25 every 45 seconds.', baseCost:50000, scaling:1.20, cps: 25/45, currency:'bucks'},
    {id:'factory', name:'Cookie Factory', cat:'autobaker', desc:'Generates ₡67 every 30 seconds.', baseCost:250000, scaling:1.15, cps: 67/30, currency:'bucks'},
    {id:'dyson', name:'Dyson Sphere', cat:'autobaker', desc:'Generates ₡625 every 15 seconds.', baseCost:5000000, scaling:1.19, cps: 625/15, currency:'bucks'},

    // Swag Upgrades (Permanent)
    {id:'pierre', name:"Pierre d'Cauqi", cat:'upgrade', desc:"Harness the power of a TRUE French chef. Multiplies all ₡/s profit gains by 2.", baseCost:1000, scaling:1, max:1, currency:'swag'},
    {id:'gold_plates', name:'Golden Plates', cat:'upgrade', desc:'Granny gave you her special Golden Plates in her will! Use them to make every cookie worth 3% more. Compounds.', baseCost:50, scaling:1.10, currency:'swag'},
    {id:'nebula_plates', name:'Nebula-Infused Plates', cat:'upgrade', desc:'Harness the power of ultra-rare Nebula Cookies to infuse them in your own recipes. Every cookie worth 10% more. Compounds.', baseCost:200, scaling:1.05, currency:'swag'},
    {id:'frenzy', name:'Cookie Frenzy', cat:'upgrade', desc:'Increases cookie spawn rates by 10%. Better know how to click fast!', baseCost:100, scaling:1.3, currency:'swag'},
    {id:'magnet', name:'Sugar Magnet', cat:'upgrade', desc:'A divine magnet given by the Gods. Cookies stop in the center of your screen... better get to spamming! Can be enabled/disabled.', baseCost:100000, scaling:1, max:1, currency:'swag'},
    {id:'divine_intervention', name:'Divine Intervention', cat:'upgrade', desc:'The Gods are pleased with you. They sent a divine figure to watch over you. Auto-clicks 10% of cookies per tier (Max 90%).', baseCost:500, scaling:1.5, max:9, currency:'swag'},
    {id:'divine_calling', name:'Divine Calling', cat:'upgrade', desc:'The Gods are impressed by your power. They call you to Ascend to a higher plane. Auto-clicks all cookies onscreen.', baseCost:1000000, scaling:1, max:1, currency:'swag', req:{id:'divine_intervention', count:9}},

    // Consumables
    {id:'glass', name:'Magnifying Glass', cat:'consumable', desc:'Obtain a magnifying glass that lets you inspect cookies for rarer ingredients. Rare cookies +25% (2m).', baseCost:50000, duration:120, cooldown:120, currency:'bucks'},
    {id:'grandma', name:"Grandma's Blessing", cat:'consumable', desc:"Grandma is watching over you. Golden rate 1/40 (1m).", baseCost:1000000, duration:60, cooldown:120, currency:'bucks'},
    {id:'warp', name:'Time Warp', cat:'consumable', desc:'1hr production value, instantly (1h Cooldown).', baseCost:5000, duration:0, cooldown:3600, currency:'bucks'}
];

let G = {
    bucks: 0, totalEarned: 0, swag: 0,
    autobakers: {},
    upgrades: {},
    stats: {},
    discoveries: {},
    consumables: {},
    lastSeen: Date.now(),
    muted: false,
    magnetEnabled: true
};

const SAVE_KEY = 'tb_cookie_save';

function saveGame() {
    G.lastSeen = Date.now();
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(G)); } catch(e) {}
}

function loadGame() {
    try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (raw) {
            const d = JSON.parse(raw);
            G.bucks = d.bucks || 0;
            G.totalEarned = d.totalEarned || 0;
            G.swag = d.swag || 0;
            G.autobakers = d.autobakers || {};
            G.upgrades = d.upgrades || {};
            if (d.swagUpgrades) {
                for (const key in d.swagUpgrades) {
                    if (d.swagUpgrades[key]) G.upgrades[key] = 1;
                }
            }
            G.stats = d.stats || {};
            G.discoveries = d.discoveries || {};
            G.consumables = d.consumables || {};
            G.lastSeen = d.lastSeen || Date.now();
            G.muted = d.muted || false;
            G.magnetEnabled = d.magnetEnabled !== undefined ? d.magnetEnabled : true;
        }
    } catch(e) {}
}

function resetAllData() {
    localStorage.removeItem(SAVE_KEY);
    G = {bucks:0,totalEarned:0,swag:0,autobakers:{},upgrades:{},stats:{},discoveries:{},consumables:{},lastSeen:Date.now(),muted:false, magnetEnabled:true};
}

function getCPS() {
    let cps = 0;
    SHOP_ITEMS.forEach(item => {
        if (item.cat === 'autobaker') cps += (G.autobakers[item.id] || 0) * item.cps;
    });
    if (G.upgrades['pierre']) cps *= Math.pow(2, G.upgrades['pierre']);
    return cps;
}

function getGlobalMult() {
    let m = 1;
    if (G.upgrades['gold_plates']) m *= Math.pow(1.03, G.upgrades['gold_plates']);
    if (G.upgrades['nebula_plates']) m *= Math.pow(1.10, G.upgrades['nebula_plates']);
    return m;
}

function getSpawnInterval() {
    let base = 3000;
    const frenzy = G.upgrades['frenzy'] || 0;
    base /= Math.pow(1.10, frenzy); 
    return Math.max(base, 100);
}

function getCookieSize() {
    return 70;
}

function getItemCost(item, count) {
    if (item.scaling) return Math.floor(item.baseCost * Math.pow(item.scaling, count));
    return item.baseCost;
}

function rollRarity() {
    let weights = RARITIES.map(r => r.weight);
    if (G.consumables['glass'] && G.consumables['glass'].active && Date.now() < G.consumables['glass'].endTime) {
        weights[2] *= 1.25;
        weights[3] *= 1.25;
        weights[4] *= 1.25;
    }
    if (G.consumables['grandma'] && G.consumables['grandma'].active && Date.now() < G.consumables['grandma'].endTime) {
        weights[4] *= 2.5; 
    }
    
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * total;
    for (let i = 0; i < RARITIES.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return RARITIES[i];
    }
    return RARITIES[0];
}

function rollCookie() {
    return COOKIES[Math.floor(Math.random() * COOKIES.length)];
}

function calcPrestigeGain() {
    return Math.floor(G.totalEarned / 1000000);
}

function calcOfflineEarnings() {
    const elapsed = (Date.now() - G.lastSeen) / 1000;
    if (elapsed < 5) return 0;
    const cps = getCPS();
    const cappedTime = Math.min(elapsed, 28800);
    return Math.floor(cps * cappedTime * 0.5);
}
