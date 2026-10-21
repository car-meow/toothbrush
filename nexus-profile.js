(function (global) {
    const KEY = 'tb_local_profile';
    const ENROLLED_KEY = 'tb_enrolled_groups';

    function isLocked() {
        try {
            const raw = (global.nexusStorage || global.localStorage).getItem(ENROLLED_KEY);
            const groups = JSON.parse(raw || '[]');
            return Array.isArray(groups) && groups.length > 0;
        } catch (_) { return false; }
    }

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
        if (current && isLocked() && clean(current.username).toLowerCase() !== name.toLowerCase()) {
            throw new Error('You cannot change your username while enrolled in group chats. Leave all groups first.');
        }
        const profile = { id: current ? current.id : (global.crypto && crypto.randomUUID ? crypto.randomUUID() : 'profile-' + Date.now().toString(36) + Math.random().toString(36).slice(2)), username: name, createdAt: current && current.createdAt ? current.createdAt : Date.now() };
        storage.setItem(KEY, JSON.stringify(profile));
        return profile;
    }
    function clear() {
        if (isLocked()) {
            throw new Error('You cannot log out or reset your username while enrolled in group chats. Leave all groups first.');
        }
        (global.nexusStorage || global.localStorage).removeItem(KEY);
    }
    global.NexusProfile = { get, save, clear, clean, key: KEY, isLocked, enrolledKey: ENROLLED_KEY };
})(window);
