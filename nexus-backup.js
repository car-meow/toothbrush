(function (global) {
    const storage = global.nexusStorage || global.localStorage;
    const SENSITIVE = /(?:api.?key|groq|secret|token|password|credential|(?:^|[_-])key(?:$|[_-]))/i;
    const TRANSIENT = new Set(['tb_chat_timeout', 'tb_system_backup_flush']);
    const KNOWN_DBS = ['GameStorageDB', 'AIChatDB', 'NexusSidebarSettings'];
    const KNOWN_GAME_DBS = ['/home/web_user/love', '/idbfs', '/save', '/settings', 'UnityCache', 'ruffle', 'localforage', 'keyval-store'];
    const b64 = bytes => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); };
    const un64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
    async function encode(value) {
        if (value instanceof Blob) return { __nexusBinary: 'Blob', mime: value.type, data: b64(new Uint8Array(await value.arrayBuffer())) };
        if (value instanceof ArrayBuffer) return { __nexusBinary: 'ArrayBuffer', data: b64(new Uint8Array(value)) };
        if (ArrayBuffer.isView(value)) return { __nexusBinary: value.constructor.name, data: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
        if (value instanceof Date) return { __nexusType: 'Date', time: value.getTime() };
        if (Array.isArray(value)) return Promise.all(value.map(encode));
        if (value && typeof value === 'object') { const out = {}; for (const key of Object.keys(value)) out[key] = await encode(value[key]); return out; }
        return value;
    }
    function decode(value) {
        if (Array.isArray(value)) return value.map(decode);
        if (value && value.__nexusType === 'Date') return new Date(value.time);
        if (value && value.__nexusBinary) {
            const bytes = un64(value.data || '');
            if (value.__nexusBinary === 'Blob') return new Blob([bytes], { type: value.mime || 'application/octet-stream' });
            if (value.__nexusBinary === 'ArrayBuffer') return bytes.buffer;
            const types = { Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array };
            const Ctor = types[value.__nexusBinary] || Uint8Array;
            return new Ctor(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / (Ctor.BYTES_PER_ELEMENT || 1)));
        }
        if (value && typeof value === 'object') { const out = {}; for (const key of Object.keys(value)) out[key] = decode(value[key]); return out; }
        return value;
    }
    function openDB(name) { return new Promise((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error('A stored database is busy. Close other Nexus tabs and try again.')); }); }
    function deleteDB(name) {
        return new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('A stored database is busy. Close other Nexus tabs and try again.')), 10000);
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => { clearTimeout(timer); resolve(); };
            req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('A stored database could not be replaced.')); };
            req.onblocked = () => { clearTimeout(timer); reject(new Error('A stored database is busy. Close other Nexus tabs and try again.')); };
        });
    }
    async function dbNames() {
        const names = new Set([...KNOWN_DBS, ...KNOWN_GAME_DBS]);
        if (indexedDB.databases) try { (await indexedDB.databases()).forEach(db => db.name && names.add(db.name)); } catch (_) {}
        return [...names];
    }
    async function readDatabase(name) {
        let db;
        try { db = await openDB(name); } catch (_) { return null; }
        if (db.version === 1 && db.objectStoreNames.length === 0) { db.close(); if (!KNOWN_DBS.includes(name)) await deleteDB(name); return null; }
        try {
            const result = { __version: db.version };
            for (const storeName of Array.from(db.objectStoreNames)) {
                const tx = db.transaction(storeName, 'readonly'), store = tx.objectStore(storeName);
                const [keys, values] = await Promise.all([
                    new Promise((res, rej) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
                    new Promise((res, rej) => { const r = store.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); })
                ]);
                result[storeName] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: Array.from(store.indexNames, n => { const i = store.index(n); return { name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }; }), records: await Promise.all(values.map(async (value, i) => ({ key: await encode(keys[i]), value: await encode(value) }))) };
            }
            return result;
        } finally { db.close(); }
    }
    function snapshotLocalStorage() {
        const result = {};
        for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (!SENSITIVE.test(key) && !TRANSIENT.has(key) && (key.startsWith('tb_') || key.startsWith('sidebar-game-order'))) result[key] = storage.getItem(key); }
        return result;
    }
    async function exportBackup() {
        storage.setItem('tb_system_backup_flush', String(Date.now()));
        await new Promise(resolve => setTimeout(resolve, 350));
        const databases = {};
        for (const name of await dbNames()) { const contents = await readDatabase(name); if (contents) databases[name] = contents; }
        const data = { format: 'nexus-system-backup', version: 4, createdAt: new Date().toISOString(), scope: { type: 'system-wide' }, localStorage: snapshotLocalStorage(), databases };
        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' }), link = document.createElement('a');
        link.href = URL.createObjectURL(blob); link.download = 'nexus_backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    function validate(data) {
        if (!data || typeof data !== 'object' || !Number.isInteger(Number(data.version))) throw new Error('This is not a supported Nexus backup.');
        const system = data.format === 'nexus-system-backup' && data.version >= 4 && data.scope && data.scope.type === 'system-wide';
        const legacy = data.version <= 3 && (data.saves || data.indexedData || data.gameLibrary || data.games || data.gameSnapshots);
        if (!system && !legacy) throw new Error('This is not a supported Nexus backup.');
        if (system && (!data.localStorage || typeof data.localStorage !== 'object' || !data.databases || typeof data.databases !== 'object')) throw new Error('The backup is missing required data.');
        if (data.databases && Object.keys(data.databases).some(name => !/^[\w /.-]{1,120}$/.test(name))) throw new Error('The backup contains an invalid database name.');
        if (system) for (const [name, database] of Object.entries(data.databases)) {
            if (!database || typeof database !== 'object' || !Number.isFinite(Number(database.__version))) throw new Error('The backup contains an invalid database: ' + name);
            for (const [storeName, store] of Object.entries(database)) if (storeName !== '__version' && (!store || typeof store !== 'object' || (!Array.isArray(store.records) && !Array.isArray(store)))) throw new Error('The backup contains invalid stored data.');
        }
        return system ? 'system' : 'legacy';
    }
    async function restoreDatabase(name, content) {
        await deleteDB(name);
        const version = Math.max(1, Number(content.__version) || 1);
        const db = await new Promise((resolve, reject) => {
            let timer = setTimeout(() => reject(new Error('A stored database could not be opened.')), 10000);
            const req = indexedDB.open(name, version);
            req.onupgradeneeded = event => {
                const target = event.target.result;
                for (const storeName of Object.keys(content)) {
                    if (storeName === '__version') continue;
                    const info = content[storeName], opts = {};
                    if (info && !Array.isArray(info)) { if (info.keyPath !== undefined && info.keyPath !== null) opts.keyPath = info.keyPath; if (info.autoIncrement !== undefined) opts.autoIncrement = info.autoIncrement; }
                    const store = target.objectStoreNames.contains(storeName) ? event.target.transaction.objectStore(storeName) : target.createObjectStore(storeName, opts);
                    (info.indexes || []).forEach(idx => { if (!store.indexNames.contains(idx.name)) store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique, multiEntry: !!idx.multiEntry }); });
                }
            };
            req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
            req.onerror = () => { clearTimeout(timer); reject(req.error); };
            req.onblocked = () => { clearTimeout(timer); reject(new Error('A stored database is busy. Close other Nexus tabs and try again.')); };
        });
        try {
            for (const [storeName, info] of Object.entries(content)) {
                if (storeName === '__version' || !db.objectStoreNames.contains(storeName)) continue;
                const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName);
                for (const item of (Array.isArray(info) ? info : info.records || [])) {
                    const val = decode(item && Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item), key = item && decode(item.key);
                    if (store.keyPath !== null) store.put(val); else if (key !== undefined) store.put(val, key); else store.put(val);
                }
                await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
            }
        } finally { db.close(); }
    }
    async function restore(data, kind) {
        if (kind === 'system') {
            const incoming = new Set(Object.keys(data.databases));
            for (const name of await dbNames()) if (!incoming.has(name)) await deleteDB(name);
            for (const [name, contents] of Object.entries(data.databases)) await restoreDatabase(name, contents);
            for (let i = storage.length - 1; i >= 0; i--) { const key = storage.key(i); if ((key.startsWith('tb_') || key.startsWith('sidebar-game-order')) && !SENSITIVE.test(key) && !TRANSIENT.has(key)) storage.removeItem(key); }
            Object.entries(data.localStorage).forEach(([key, value]) => { if ((key.startsWith('tb_') || key.startsWith('sidebar-game-order')) && !SENSITIVE.test(key) && !TRANSIENT.has(key) && typeof value === 'string') storage.setItem(key, value); });
            return;
        }
        // Legacy v3 backups retain the previous selective import semantics and carry no system-wide snapshot marker.
        if (data.saves && typeof data.saves === 'object') Object.entries(data.saves).forEach(([key, value]) => { if (!SENSITIVE.test(key) && !TRANSIENT.has(key) && typeof value === 'string') storage.setItem(key, value); });
        const games = data.gameLibrary && Array.isArray(data.gameLibrary.games) ? data.gameLibrary.games : (Array.isArray(data.games) ? data.games : []);
        if (games.length || data.gameLibrary || data.games || data.gameSnapshots) {
            const current = await readDatabase('GameStorageDB');
            const merged = current || { __version: 3, customGames: { keyPath: 'id', autoIncrement: false, indexes: [], records: [] }, gameSnapshots: { keyPath: 'gameId', autoIncrement: false, indexes: [], records: [] } };
            const ids = new Set(games.map(g => g.id));
            if (!merged.customGames) merged.customGames = { keyPath: 'id', records: [] };
            merged.customGames.records = (merged.customGames.records || []).filter(r => !ids.has(r.value.id)).concat(await Promise.all(games.map(async value => ({ key: value.id, value: await encode(value) }))));
            if (Array.isArray(data.gameSnapshots)) { if (!merged.gameSnapshots) merged.gameSnapshots = { keyPath: 'gameId', records: [] }; merged.gameSnapshots.records = (merged.gameSnapshots.records || []).filter(r => !ids.has(r.value.gameId)).concat(await Promise.all(data.gameSnapshots.map(async value => ({ key: value.gameId, value: await encode(value) })))); }
            await restoreDatabase('GameStorageDB', merged);
        }
        if (data.indexedData) for (const [name, contents] of Object.entries(data.indexedData)) if (name !== 'GameStorageDB') await restoreDatabase(name, contents);
    }
    global.NexusBackup = { export: exportBackup, validate, restore };
})(window);
