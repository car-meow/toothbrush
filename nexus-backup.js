(function (global) {
    const storage = global.nexusStorage || global.localStorage;
    const SENSITIVE = /(?:api.?key|groq|secret|token|password|credential|(?:^|[_-])key(?:$|[_-]))/i;
    const TRANSIENT = new Set(['tb_chat_timeout', 'tb_system_backup_flush']);
    const KNOWN_DBS = ['GameStorageDB', 'AIChatDB', 'NexusSidebarSettings'];
    const KNOWN_GAME_DBS = ['/home/web_user/love', '/idbfs', '/save', '/settings', 'UnityCache', 'ruffle', 'localforage', 'keyval-store'];
    const b64 = bytes => {
        const encodedChunks = [];
        // Keep each input small and divisible by three so intermediate
        // base64 chunks can be joined without padding gaps.
        const chunkSize = 3 * 0x4000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            encodedChunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))));
        }
        return encodedChunks.join('');
    };
    const un64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
    const BACKUP_BINARY_CHUNK_BYTES = 48 * 1024;
    async function encode(value) {
        if (value instanceof Blob) return { __nexusBinary: 'Blob', mime: value.type, data: b64(new Uint8Array(await value.arrayBuffer())) };
        if (value instanceof ArrayBuffer) return { __nexusBinary: 'ArrayBuffer', data: b64(new Uint8Array(value)) };
        if (ArrayBuffer.isView(value)) return { __nexusBinary: value.constructor.name, data: b64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
        if (value instanceof Date) return { __nexusType: 'Date', time: value.getTime() };
        if (Array.isArray(value)) {
            const out = [];
            for (const item of value) out.push(await encode(item));
            return out;
        }
        if (value && typeof value === 'object') { const out = {}; for (const key of Object.keys(value)) out[key] = await encode(value[key]); return out; }
        return value;
    }
    function decode(value, references = new Map(), modernTypes = false) {
        if (Array.isArray(value)) return value.map(item => decode(item, references, modernTypes));
        if (modernTypes && value && value.__nexusGraph === 'Reference') {
            const id = String(value.id);
            if (!references.has(id)) throw new Error('The backup contains an invalid circular reference.');
            return references.get(id);
        }
        if (modernTypes && value && value.__nexusGraph === 'Node') {
            const id = String(value.id);
            const nodeValue = value.value;
            let output;
            if (value.kind === 'Array') output = [];
            else if (value.kind === 'Map') output = new Map();
            else if (value.kind === 'Set') output = new Set();
            else if (value.kind === 'Object') output = {};
            else throw new Error('The backup contains an invalid stored value.');
            references.set(id, output);
            if (value.kind === 'Array') {
                (Array.isArray(nodeValue) ? nodeValue : []).forEach(item => output.push(decode(item, references, modernTypes)));
            } else if (value.kind === 'Map') {
                (Array.isArray(nodeValue) ? nodeValue : []).forEach(entry => {
                    if (Array.isArray(entry) && entry.length === 2) output.set(decode(entry[0], references, modernTypes), decode(entry[1], references, modernTypes));
                });
            } else if (value.kind === 'Set') {
                (Array.isArray(nodeValue) ? nodeValue : []).forEach(item => output.add(decode(item, references, modernTypes)));
            } else if (nodeValue && typeof nodeValue === 'object' && !Array.isArray(nodeValue)) {
                Object.keys(nodeValue).forEach(key => Object.defineProperty(output, key, {
                    value: decode(nodeValue[key], references, modernTypes), enumerable: true, writable: true, configurable: true
                }));
            }
            return output;
        }
        if (value && value.__nexusType === 'Date') return new Date(value.time);
        if (modernTypes && value && value.__nexusType === 'Undefined') return undefined;
        if (modernTypes && value && value.__nexusType === 'BigInt') return BigInt(value.value);
        if (modernTypes && value && value.__nexusType === 'Map') return new Map((value.entries || []).map(([key, entryValue]) => [decode(key, references, modernTypes), decode(entryValue, references, modernTypes)]));
        if (modernTypes && value && value.__nexusType === 'Set') return new Set((value.values || []).map(item => decode(item, references, modernTypes)));
        if (value && value.__nexusBinary) {
            const encodedChunks = Array.isArray(value.chunks) ? value.chunks : [value.data || ''];
            const decodedChunks = encodedChunks.map(un64);
            const length = decodedChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            const bytes = new Uint8Array(length);
            let offset = 0;
            decodedChunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
            if (value.__nexusBinary === 'Blob') return new Blob([bytes], { type: value.mime || 'application/octet-stream' });
            if (value.__nexusBinary === 'ArrayBuffer') return bytes.buffer;
            const types = {
                Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array,
                Int8Array, Int16Array, Int32Array, Float32Array, Float64Array,
                BigInt64Array: global.BigInt64Array,
                BigUint64Array: global.BigUint64Array
            };
            if (value.__nexusBinary === 'DataView') return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const Ctor = types[value.__nexusBinary] || Uint8Array;
            const elementSize = Ctor.BYTES_PER_ELEMENT || 1;
            if (bytes.byteLength % elementSize !== 0) throw new Error('The backup contains a binary value with an invalid length.');
            return new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / elementSize);
        }
        if (value && typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value)) Object.defineProperty(out, key, {
                value: decode(value[key], references, modernTypes), enumerable: true, writable: true, configurable: true
            });
            return out;
        }
        return value;
    }
    async function writeEncodedJson(value, append, graph = { ids: new WeakMap(), nextId: 1 }) {
        const write = async text => append(text);
        const writeBinaryChunks = async (byteLength, getChunk) => {
            await write('[');
            let first = true;
            for (let offset = 0; offset < byteLength; offset += BACKUP_BINARY_CHUNK_BYTES) {
                const chunk = await getChunk(offset, Math.min(byteLength, offset + BACKUP_BINARY_CHUNK_BYTES));
                if (!first) await write(',');
                await write(JSON.stringify(b64(chunk)));
                first = false;
            }
            await write(']');
        };

        if (value === undefined) return write('{"__nexusType":"Undefined"}');
        if (typeof value === 'bigint') return write('{"__nexusType":"BigInt","value":' + JSON.stringify(String(value)) + '}');
        if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return write(JSON.stringify(value));
        }
        if (value instanceof Date) return write('{"__nexusType":"Date","time":' + JSON.stringify(value.getTime()) + '}');
        if (typeof Blob === 'function' && value instanceof Blob) {
            await write('{"__nexusBinary":"Blob","mime":' + JSON.stringify(value.type || '') + ',"chunks":');
            await writeBinaryChunks(value.size, async (start, end) => new Uint8Array(await value.slice(start, end).arrayBuffer()));
            return write('}');
        }
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const binaryType = value instanceof ArrayBuffer ? 'ArrayBuffer' : value.constructor.name;
            await write('{"__nexusBinary":' + JSON.stringify(binaryType) + ',"chunks":');
            await writeBinaryChunks(bytes.byteLength, async (start, end) => bytes.subarray(start, end));
            return write('}');
        }
        const existingId = graph.ids.get(value);
        if (existingId !== undefined) return write('{"__nexusGraph":"Reference","id":' + JSON.stringify(existingId) + '}');
        const id = graph.nextId++;
        graph.ids.set(value, id);
        if (value instanceof Map) {
            await write('{"__nexusGraph":"Node","id":' + JSON.stringify(id) + ',"kind":"Map","value":[');
            let first = true;
            for (const [key, entryValue] of value.entries()) {
                if (!first) await write(',');
                await write('[');
                await writeEncodedJson(key, append, graph);
                await write(',');
                await writeEncodedJson(entryValue, append, graph);
                await write(']');
                first = false;
            }
            return write(']}');
        }
        if (value instanceof Set) {
            await write('{"__nexusGraph":"Node","id":' + JSON.stringify(id) + ',"kind":"Set","value":[');
            let first = true;
            for (const entryValue of value.values()) {
                if (!first) await write(',');
                await writeEncodedJson(entryValue, append, graph);
                first = false;
            }
            return write(']}');
        }
        if (Array.isArray(value)) {
            await write('{"__nexusGraph":"Node","id":' + JSON.stringify(id) + ',"kind":"Array","value":[');
            for (let index = 0; index < value.length; index++) {
                if (index) await write(',');
                await writeEncodedJson(value[index], append, graph);
            }
            return write(']}');
        }
        await write('{"__nexusGraph":"Node","id":' + JSON.stringify(id) + ',"kind":"Object","value":{');
        let first = true;
        for (const key of Object.keys(value)) {
            if (!first) await write(',');
            await write(JSON.stringify(key) + ':');
            await writeEncodedJson(value[key], append, graph);
            first = false;
        }
        return write('}}');
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
    async function readKeyBatch(db, storeName, lastKey, hasLastKey, batchSize = 64) {
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(storeName, 'readonly');
                const range = hasLastKey ? global.IDBKeyRange.lowerBound(lastKey, true) : undefined;
                const request = tx.objectStore(storeName).openKeyCursor(range);
                const keys = [];
                request.onsuccess = () => {
                    const cursor = request.result;
                    if (!cursor || keys.length >= batchSize) return resolve(keys);
                    keys.push(cursor.primaryKey);
                    if (keys.length >= batchSize) return resolve(keys);
                    cursor.continue();
                };
                request.onerror = () => reject(request.error || tx.error || new Error('Could not read IndexedDB keys.'));
                tx.onabort = () => reject(tx.error || new Error('Reading IndexedDB keys was interrupted.'));
            } catch (error) {
                reject(error);
            }
        });
    }
    async function forEachDatabaseKey(db, storeName, callback) {
        let hasLastKey = false;
        let lastKey;
        while (true) {
            const keys = await readKeyBatch(db, storeName, lastKey, hasLastKey);
            if (!keys.length) break;
            for (const key of keys) await callback(key);
            lastKey = keys[keys.length - 1];
            hasLastKey = true;
        }
    }
    async function readDatabaseRecord(db, storeName, key) {
        return new Promise((resolve, reject) => {
            let tx;
            try {
                tx = db.transaction(storeName, 'readonly');
                const request = tx.objectStore(storeName).openCursor(key);
                request.onsuccess = () => {
                    const cursor = request.result;
                    resolve(cursor ? { found: true, value: cursor.value } : { found: false });
                };
                request.onerror = () => reject(request.error || tx.error || new Error('Could not read an IndexedDB record.'));
                tx.onabort = () => reject(tx.error || new Error('Reading an IndexedDB record was interrupted.'));
            } catch (error) {
                reject(error);
            }
        });
    }
    async function readDatabase(name) {
        let db;
        try { db = await openDB(name); } catch (_) { return null; }
        if (db.version === 1 && db.objectStoreNames.length === 0) { db.close(); if (!KNOWN_DBS.includes(name)) await deleteDB(name); return null; }
        try {
            const result = { __version: db.version };
            for (const storeName of Array.from(db.objectStoreNames)) {
                const tx = db.transaction(storeName, 'readonly'), store = tx.objectStore(storeName);
                const storeInfo = {
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    indexes: Array.from(store.indexNames, n => {
                        const i = store.index(n);
                        return { name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry };
                    })
                };
                const records = [];
                await forEachDatabaseKey(db, storeName, async key => {
                    // getAll() asks Chromium to clone an entire store in one
                    // operation. A large store can exceed the browser's
                    // serialized-result limit even when each record is valid.
                    // Fetch one value per transaction and encode sequentially
                    // to keep peak memory bounded on low-memory devices.
                    let record;
                    try {
                        record = await readDatabaseRecord(db, storeName, key);
                    } catch (error) {
                        throw new Error(`Could not read a value from IndexedDB database “${name}”, store “${storeName}”: ${error && error.message || error}`);
                    }
                    if (record.found) records.push({ key: await encode(key), value: await encode(record.value) });
                });
                result[storeName] = { ...storeInfo, records };
            }
            return result;
        } finally { db.close(); }
    }
    async function appendDatabaseToBackup(name, append, useComma) {
        let db;
        try { db = await openDB(name); } catch (error) {
            throw new Error(`Could not open IndexedDB database “${name}” for backup: ${error && error.message || error}`);
        }
        if (db.version === 1 && db.objectStoreNames.length === 0) {
            db.close();
            if (!KNOWN_DBS.includes(name)) await deleteDB(name);
            return false;
        }
        try {
            await append((useComma ? ',' : '') + JSON.stringify(name) + ':{"__version":' + JSON.stringify(db.version));
            for (const storeName of Array.from(db.objectStoreNames)) {
                const store = db.transaction(storeName, 'readonly').objectStore(storeName);
                const storeInfo = {
                    keyPath: store.keyPath,
                    autoIncrement: store.autoIncrement,
                    indexes: Array.from(store.indexNames, indexName => {
                        const index = store.index(indexName);
                        return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                    })
                };
                const storeHeader = JSON.stringify(storeInfo);
                await append(',' + JSON.stringify(storeName) + ':' + storeHeader.slice(0, -1) + ',"records":[');
                let recordIndex = 0;
                await forEachDatabaseKey(db, storeName, async key => {
                    let record;
                    try {
                        record = await readDatabaseRecord(db, storeName, key);
                    } catch (error) {
                        throw new Error(`Could not read a value from IndexedDB database “${name}”, store “${storeName}”: ${error && error.message || error}`);
                    }
                    if (!record.found) return;
                    await append((recordIndex ? ',' : '') + '{"key":');
                    await writeEncodedJson(key, append);
                    await append(',"value":');
                    await writeEncodedJson(record.value, append);
                    await append('}');
                    recordIndex++;
                });
                await append(']}');
            }
            await append('}');
            return true;
        } finally { db.close(); }
    }
    function snapshotLocalStorage() {
        const result = {};
        for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (!SENSITIVE.test(key) && !TRANSIENT.has(key) && (key.startsWith('tb_') || key.startsWith('sidebar-game-order'))) result[key] = storage.getItem(key); }
        return result;
    }
    async function exportBackup() {
        // Request the file handle during the button's user activation. Waiting
        // first can make Chrome reject the picker and force a large in-memory
        // download fallback on low-memory devices.
        let pickerPromise = null;
        if (typeof global.showSaveFilePicker === 'function') {
            try {
                pickerPromise = global.showSaveFilePicker({
                    suggestedName: 'nexus_backup.json',
                    types: [{ description: 'Nexus backup', accept: { 'application/json': ['.json'] } }]
                }).then(handle => ({ handle }), error => ({ error }));
            } catch (error) {
                pickerPromise = Promise.resolve({ error });
            }
        }
        try { storage.setItem('tb_system_backup_flush', String(Date.now())); } catch (_) {}
        await new Promise(resolve => setTimeout(resolve, 350));
        let writable = null;
        let parts = null;
        if (pickerPromise) {
            try {
                const pickerResult = await pickerPromise;
                if (pickerResult.error) throw pickerResult.error;
                const handle = pickerResult.handle;
                writable = await handle.createWritable();
            } catch (error) {
                if (error && error.name === 'AbortError') return;
                // Browsers may expose the picker but deny it in a particular
                // context; keep the download fallback available in that case.
                writable = null;
            }
        }
        if (!writable) parts = [];
        const append = async value => {
            const text = String(value);
            if (writable) await writable.write(text);
            else parts.push(text);
        };
        try {
            await append('{"format":"nexus-system-backup","version":5,"createdAt":' + JSON.stringify(new Date().toISOString()) + ',"scope":{"type":"system-wide"},"localStorage":' + JSON.stringify(snapshotLocalStorage()) + ',"databases":{');
            let databaseCount = 0;
            for (const name of await dbNames()) {
                if (await appendDatabaseToBackup(name, append, databaseCount > 0)) databaseCount++;
            }
            await append('}}');
            if (writable) {
                await writable.close();
                return;
            }
            const blob = new Blob(parts, { type: 'application/json' }), link = document.createElement('a');
            link.href = URL.createObjectURL(blob); link.download = 'nexus_backup.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        } catch (error) {
            if (writable && typeof writable.abort === 'function') {
                try { await writable.abort(); } catch (abortError) {}
            }
            throw error;
        }
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
    async function restoreDatabase(name, content, backupVersion = 3) {
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
                    const val = decode(item && Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item, new Map(), backupVersion >= 5), key = item && decode(item.key, new Map(), backupVersion >= 5);
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
            for (const [name, contents] of Object.entries(data.databases)) await restoreDatabase(name, contents, Number(data.version));
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
