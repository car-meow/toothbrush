(function (global) {
    const KEY = 'tb_local_profile';
    function get() {
        try {
            const value = JSON.parse((global.nexusStorage || global.localStorage).getItem(KEY) || 'null');
            return value && typeof value.id === 'string' && typeof value.username === 'string' ? { id: value.id, username: clean(value.username), createdAt: Number(value.createdAt) || null } : null;
        } catch (_) { return null; }
    }
    function clean(name) { return String(name || '').replace(/[<>&"']/g, '').trim().replace(/\s+/g, ' ').slice(0, 24); }
    function save(name) {
        name = clean(name);
        if (!name) throw new Error('Enter a username.');
        const storage = global.nexusStorage || global.localStorage;
        const current = get();
        const profile = { id: current ? current.id : (global.crypto && crypto.randomUUID ? crypto.randomUUID() : 'profile-' + Date.now().toString(36) + Math.random().toString(36).slice(2)), username: name, createdAt: current && current.createdAt ? current.createdAt : Date.now() };
        storage.setItem(KEY, JSON.stringify(profile));
        return profile;
    }
    function clear() { (global.nexusStorage || global.localStorage).removeItem(KEY); }
    global.NexusProfile = { get, save, clear, clean, key: KEY };
})(window);
