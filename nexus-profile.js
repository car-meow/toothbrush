(function (global) {
    const KEY = 'tb_local_profile';
    const ENROLLED_KEY = 'tb_enrolled_groups';
    const RAINBOW_KEY = 'tb_legolooper_rainbow';
    const EASTER_EGG_USERNAME = 'legolooper';

    function isRainbowActive() {
        const profile = get();
        if (!profile || profile.username.toLowerCase() !== EASTER_EGG_USERNAME) return false;
        try { return (global.nexusStorage || global.localStorage).getItem(RAINBOW_KEY) === 'true'; }
        catch (_) { return false; }
    }

    function activateRainbowEffect() {
        const profile = get();
        if (!profile || profile.username.toLowerCase() !== EASTER_EGG_USERNAME) return false;
        try { (global.nexusStorage || global.localStorage).setItem(RAINBOW_KEY, 'true'); } catch (_) {}
        global.dispatchEvent(new global.CustomEvent('nexus-legolooper-rainbow-change'));
        return true;
    }

    function hasRainbowEffectFor(username) {
        return String(username || '').trim().toLowerCase() === EASTER_EGG_USERNAME && isRainbowActive();
    }

    function syncHomeRainbow() {
        const doc = global.document;
        if (!doc) return;
        const active = isRainbowActive();
        doc.documentElement.classList.toggle('nexus-rainbow-active', active);
        const isHome = doc.body?.classList.contains('home-screen') === true;
        doc.documentElement.classList.toggle('nexus-rainbow-home', isHome);
        doc.documentElement.classList.toggle('nexus-rainbow-static', active && isHome);
    }

    function closeEasterEggPrompt(overlay) {
        if (overlay && overlay.parentNode) overlay.remove();
    }

    function showEasterEggPrompt() {
        const doc = global.document;
        if (!doc || !doc.body || doc.getElementById('nexus-legolooper-prompt')) return;

        const overlay = doc.createElement('div');
        overlay.id = 'nexus-legolooper-prompt';
        overlay.className = 'nexus-legolooper-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        const panel = doc.createElement('div');
        panel.className = 'nexus-legolooper-panel';
        const input = doc.createElement('input');
        input.className = 'nexus-legolooper-input';
        input.type = 'text';
        input.autocomplete = 'off';
        input.setAttribute('aria-label', 'Code');

        const actions = doc.createElement('div');
        actions.className = 'nexus-legolooper-actions';
        const cancel = doc.createElement('button');
        cancel.type = 'button';
        cancel.className = 'nexus-legolooper-cancel';
        cancel.textContent = 'Cancel';
        const confirm = doc.createElement('button');
        confirm.type = 'button';
        confirm.className = 'nexus-legolooper-confirm';
        confirm.textContent = 'Confirm';

        // Intentional Easter egg rule: accept the secret only from Cancel; Confirm only dismisses the prompt.
        cancel.addEventListener('click', () => {
            if (input.value !== 'America12') return;
            activateRainbowEffect();
            closeEasterEggPrompt(overlay);
        });
        confirm.addEventListener('click', () => closeEasterEggPrompt(overlay));
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeEasterEggPrompt(overlay);
            if (event.key === 'Enter' && event.target === input) {
                event.preventDefault();
                confirm.click();
            }
        });

        actions.append(cancel, confirm);
        panel.append(input, actions);
        overlay.appendChild(panel);
        doc.body.appendChild(overlay);
        global.setTimeout(() => input.focus(), 0);
    }

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
            return value && typeof value.id === 'string' && typeof value.username === 'string' ? {
                id: value.id,
                username: clean(value.username),
                displayName: clean(value.displayName || ''),
                createdAt: Number(value.createdAt) || null
            } : null;
        } catch (_) { return null; }
    }

    function clean(name) { return String(name || '').replace(/[<>&"']/g, '').trim().replace(/\s+/g, ' ').slice(0, 24); }

    function save(name, options) {
        name = clean(name);
        if (!name) throw new Error('Enter a username.');
        const storage = global.nexusStorage || global.localStorage;
        const current = get();
        const wasRainbowActive = isRainbowActive();
        const force = options === true || (options && options.force);
        if (!force && current && isLocked() && clean(current.username).toLowerCase() !== name.toLowerCase()) {
            throw new Error('You cannot change your username while enrolled in group chats. Leave all groups first.');
        }
        const profile = {
            id: current ? current.id : (global.crypto && global.crypto.randomUUID ? global.crypto.randomUUID() : 'profile-' + Date.now().toString(36) + Math.random().toString(36).slice(2)),
            username: name,
            displayName: current ? current.displayName : '',
            createdAt: current && current.createdAt ? current.createdAt : Date.now()
        };
        storage.setItem(KEY, JSON.stringify(profile));
        if (!current || current.username.toLowerCase() !== EASTER_EGG_USERNAME || name.toLowerCase() !== EASTER_EGG_USERNAME) {
            storage.removeItem(RAINBOW_KEY);
        }
        syncHomeRainbow();
        if (wasRainbowActive !== isRainbowActive()) global.dispatchEvent(new global.CustomEvent('nexus-legolooper-rainbow-change'));
        if (name.toLowerCase() === EASTER_EGG_USERNAME && !isRainbowActive()) global.setTimeout(showEasterEggPrompt, 0);
        return profile;
    }

    function setDisplayName(value) {
        const profile = get();
        if (!profile) throw new Error('Set a username before choosing a display name.');
        profile.displayName = clean(value);
        (global.nexusStorage || global.localStorage).setItem(KEY, JSON.stringify(profile));
        global.dispatchEvent(new global.CustomEvent('nexus-profile-display-name-change', { detail: { displayName: profile.displayName } }));
        return profile;
    }

    function clear() {
        const wasRainbowActive = isRainbowActive();
        if (isLocked()) {
            throw new Error('You cannot log out or reset your username while enrolled in group chats. Leave all groups first.');
        }
        const storage = global.nexusStorage || global.localStorage;
        storage.removeItem(KEY);
        storage.removeItem(RAINBOW_KEY);
        syncHomeRainbow();
        if (wasRainbowActive) global.dispatchEvent(new global.CustomEvent('nexus-legolooper-rainbow-change'));
    }

    global.addEventListener('nexus-legolooper-rainbow-change', syncHomeRainbow);
    if (global.document) global.document.addEventListener('DOMContentLoaded', syncHomeRainbow, { once: true });
    global.NexusProfile = { get, save, setDisplayName, activateRainbowEffect, clear, clean, key: KEY, isLocked, enrolledKey: ENROLLED_KEY, hasRainbowEffectFor, isRainbowActive };
})(window);
