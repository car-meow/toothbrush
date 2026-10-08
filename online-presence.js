// nexus-version: 4.28.4
(function () {
    'use strict';

    const PREFERENCE_KEY = 'tb_online_count_enabled';
    const WORKER_URL = 'online-presence-worker.js?v=4';
    const WORKER_NAME = 'nexus-online-presence-v4';
    let worker = null;
    let port = null;
    let enabled = true;
    let gameActive = false;

    function keepCountedWhilePlayingPreference() {
        try {
            const storage = window.nexusStorage || window.localStorage;
            return storage.getItem('tb_presence_keep_counted_while_playing') !== 'false';
        } catch (_) {
            return true;
        }
    }

    function syncGameState() {
        if (!port) return;
        try {
            port.postMessage({
                type: 'set-game-state',
                active: gameActive,
                keepCounted: keepCountedWhilePlayingPreference()
            });
        } catch (_) {}
    }

    function preferenceEnabled() {
        try {
            const storage = window.nexusStorage || window.localStorage;
            return storage.getItem(PREFERENCE_KEY) !== 'false';
        } catch (_) {
            return true;
        }
    }

    function isHomePage() {
        return !!document.getElementById('menu-items-wrapper');
    }

    function updateHomeBubble(message) {
        if (!isHomePage()) return;
        let bubble = document.querySelector('.online-users-bubble');
        if (!enabled || (message && message.type === 'disabled')) {
            if (bubble) bubble.remove();
            return;
        }
        if (!bubble) {
            bubble = document.createElement('div');
            bubble.className = 'online-users-bubble';
            bubble.setAttribute('role', 'status');
            bubble.setAttribute('aria-live', 'polite');
            bubble.setAttribute('aria-label', 'Active Nexus users');
            bubble.innerHTML = '<span id="online-users-count">—</span>&nbsp;online';
            document.body.appendChild(bubble);
        }
        const count = bubble.querySelector('#online-users-count');
        if (count && message && message.type === 'count') count.textContent = String(message.count);
        if (count && message && message.type === 'unavailable') count.textContent = '—';
    }

    function stopWorkerPort(disablePresence) {
        if (port) {
            if (disablePresence) {
                try { port.postMessage({ type: 'set-enabled', enabled: false }); } catch (_) {}
            }
            try { port.postMessage({ type: 'release' }); } catch (_) {}
            try { port.close(); } catch (_) {}
        }
        port = null;
        worker = null;
    }

    function startWorkerPort() {
        if (!enabled || port) return;
        if (!('SharedWorker' in window)) {
            updateHomeBubble({ type: 'unavailable' });
            return;
        }
        try {
            worker = new SharedWorker(WORKER_URL, { name: WORKER_NAME });
            port = worker.port;
            port.onmessage = event => updateHomeBubble(event.data || {});
            port.start();
            port.postMessage({ type: 'set-enabled', enabled: true });
            syncGameState();
        } catch (_) {
            updateHomeBubble({ type: 'unavailable' });
            worker = null;
            port = null;
        }
    }

    function applyPreference() {
        const nextEnabled = preferenceEnabled();
        const wasEnabled = enabled;
        enabled = nextEnabled;
        if (wasEnabled !== enabled) updateHomeBubble(enabled ? null : { type: 'disabled' });
        if (enabled) {
            startWorkerPort();
            syncGameState();
        } else if (wasEnabled || port) stopWorkerPort(true);
    }

    window.addEventListener('nexus-game-standby-change', event => {
        gameActive = !!(event.detail && event.detail.active);
        syncGameState();
    });

    window.addEventListener('nexus-active-game-change', event => {
        gameActive = !!(event.detail && event.detail.active);
        syncGameState();
    });

    enabled = preferenceEnabled();
    if (enabled) startWorkerPort();
    else updateHomeBubble({ type: 'disabled' });

    window.addEventListener('storage', event => {
        if (event.key === PREFERENCE_KEY || event.key === 'tb_presence_keep_counted_while_playing') applyPreference();
    });
    window.addEventListener('nexus-online-count-preference-change', applyPreference);
    window.addEventListener('pagehide', () => stopWorkerPort(false), { once: true });
})();
