// nexus-version: 4.28.4
(function () {
    const sectionNames = {
        'index.html': 'Home',
        'carmeow.html': 'Games',
        'ai.html': 'AI',
        'chat.html': 'Chat',
        'media.html': 'Media',
        'settings.html': 'Settings'
    };

    function labelForUrl(url) {
        try {
            const target = new URL(url, window.location.href);
            const fileName = target.pathname.split('/').pop() || 'index.html';
            return sectionNames[fileName.toLowerCase()] || 'Home';
        } catch (error) {
            return 'Home';
        }
    }

    function ensureOverlay() {
        let overlay = document.getElementById('page-fade-overlay');
        if (!overlay && document.body) {
            overlay = document.createElement('div');
            overlay.id = 'page-fade-overlay';
            document.body.prepend(overlay);
        }
        if (overlay && !overlay.querySelector('.nexus-transition-content')) {
            overlay.innerHTML = '<div class="nexus-transition-content"><img src="Assets/loadingRoll.gif" alt=""><span class="nexus-transition-label"></span></div>';
        }
        return overlay;
    }

    function setMessage(overlay, message) {
        if (!overlay) return;
        const label = overlay.querySelector('.nexus-transition-label');
        if (label) label.textContent = message;
    }

    window.nexusNavigateWithFade = function (url) {
        const overlay = ensureOverlay();
        setMessage(overlay, `loading ${labelForUrl(url)}...`);
        if (overlay) {
            overlay.classList.remove('fade-out');
            overlay.classList.add('is-loading');
        }
        if (typeof window.nexusPauseHomeVideo === 'function') window.nexusPauseHomeVideo();
        setTimeout(() => { window.location.href = url; }, 370);
    };

    window.nexusFinishPageTransition = function () {
        const overlay = ensureOverlay();
        if (!overlay) return;
        overlay.classList.remove('is-loading');
        overlay.classList.add('fade-out');
    };

    function initializePageTransition() {
        const overlay = ensureOverlay();
        if (!overlay) return;
        setMessage(overlay, `loading ${labelForUrl(window.location.href)}...`);

        // Games marks itself ready only after both the game list and Stash load.
        if (labelForUrl(window.location.href) === 'Games') return;
        const finish = () => window.nexusFinishPageTransition();
        if (document.readyState === 'complete') setTimeout(finish, 0);
        else window.addEventListener('load', finish, { once: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializePageTransition, { once: true });
    } else {
        initializePageTransition();
    }
})();
