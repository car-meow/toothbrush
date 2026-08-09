// ==================== TUTORIAL ENGINE ====================
// Cross-page tutorial state machine for Nexus
// Loaded on every page. Each page calls its own init function.

(function() {
    'use strict';

    const localStorage = window.nexusStorage;
    const STEP_KEY = 'tb_tutorial_step';
    const SKIP_KEY = 'tb_tutorial_skipped';
    const PLAYED_KEY = 'tb_tutorial_played';

    // ---- Helpers ----
    function getStep()        { return localStorage.getItem(STEP_KEY) || ''; }
    function setStep(s)       { localStorage.setItem(STEP_KEY, s); }
    function isSkipped()      { return localStorage.getItem(SKIP_KEY) === 'true'; }
    function isPlayed()       { return localStorage.getItem(PLAYED_KEY) === 'true'; }
    function shouldRun()      { return !isSkipped() && !isPlayed(); }

    function skip() {
        localStorage.setItem(SKIP_KEY, 'true');
        clearAll();
    }

    function finish() {
        localStorage.setItem(PLAYED_KEY, 'true');
        clearAll();
    }

    // ---- DOM Helpers ----
    let overlayEl = null;
    let overriddenButtons = []; // Array of { el: Element, origClick: Function }

    function overrideClick(id, newClick) {
        const el = document.getElementById(id);
        if (!el) return;
        if (!overriddenButtons.some(item => item.el === el)) {
            overriddenButtons.push({ el: el, origClick: el.onclick });
        }
        el.onclick = newClick;
    }

    function restoreClicks() {
        overriddenButtons.forEach(item => {
            item.el.onclick = item.origClick;
        });
        overriddenButtons = [];
    }

    function ensureOverlay() {
        overlayEl = document.getElementById('tutorial-overlay');
        if (!overlayEl) {
            overlayEl = document.createElement('div');
            overlayEl.id = 'tutorial-overlay';
            overlayEl.className = 'tutorial-overlay';
            document.body.appendChild(overlayEl);
        }
        overlayEl.style.display = 'block';
        document.body.classList.add('tutorial-active');
    }

    function removeOverlay() {
        if (overlayEl) overlayEl.style.display = 'none';
        document.body.classList.remove('tutorial-active');
    }

    function clearAll() {
        const popup = document.getElementById('tut-popup');
        if (popup) popup.remove();
        removeOverlay();
        
        // Restore all overridden clicks
        restoreClicks();

        // Restore home navigation styling & pointer-events/opacity
        unlockHomeNav();

        // Restore header utility buttons hover and pointer-events/opacity
        removeUtilityHovers();

        // Restore logo pointer-events
        const logo = document.getElementById('nexus-logo');
        if (logo) logo.style.pointerEvents = '';

        // Remove any remaining highlight
        document.querySelectorAll('.tutorial-highlight').forEach(el => {
            el.classList.remove('tutorial-highlight');
            if (el.classList.contains('material-nav-btn') || el.classList.contains('home-btn')) {
                el.style.pointerEvents = '';
                el.style.opacity = '';
            }
        });
    }

    /**
     * Create a tutorial popup.
     * @param {string} bodyHTML - inner html for the content area
     * @param {object} opts
     *   opts.centered  - if true, center the popup
     *   opts.btn       - { label, cb } proceed button
     *   opts.showSkip  - default true
     */
    function createPopup(bodyHTML, opts = {}) {
        // Remove any existing popup
        const old = document.getElementById('tut-popup');
        if (old) old.remove();

        const centered = opts.centered || false;
        const showSkip = opts.showSkip !== false;

        const popup = document.createElement('div');
        popup.id = 'tut-popup';
        popup.className = 'tutorial-popup' + (centered ? ' centered' : ' bottom-right');

        let html = '<div class="tutorial-content">' + bodyHTML + '</div>';

        if (opts.btn) {
            html += '<button id="tut-proceed-btn">' + opts.btn.label + '</button>';
        }

        if (showSkip) {
            html += '<span class="tutorial-skip" id="tut-skip-btn">Skip tour</span>';
        }

        popup.innerHTML = html;
        document.body.appendChild(popup);

        if (opts.btn) {
            document.getElementById('tut-proceed-btn').onclick = (e) => {
                e.stopPropagation();
                opts.btn.cb();
            };
        }

        if (showSkip) {
            document.getElementById('tut-skip-btn').onclick = (e) => {
                e.stopPropagation();
                skip();
            };
        }

        return popup;
    }

    function highlightEl(id) {
        const el = document.getElementById(id);
        if (el) el.classList.add('tutorial-highlight');
        return el;
    }

    function clearHighlight(id) {
        const el = document.getElementById(id);
        if (el) el.classList.remove('tutorial-highlight');
    }

    // Disable all home nav buttons except the given one
    function lockHomeNav(allowId) {
        const ids = ['btn-nav-games', 'btn-nav-ai', 'proxy-btn', 'btn-nav-chat', 'btn-nav-media', 'btn-nav-settings'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            if (id === allowId) {
                el.classList.add('tutorial-highlight');
                el.style.pointerEvents = 'auto';
            } else {
                el.style.pointerEvents = 'none';
                el.style.opacity = '0.3';
            }
        });
    }

    function unlockHomeNav() {
        const ids = ['btn-nav-games', 'btn-nav-ai', 'proxy-btn', 'btn-nav-chat', 'btn-nav-media', 'btn-nav-settings'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.remove('tutorial-highlight');
            el.style.pointerEvents = '';
            el.style.opacity = '';
        });
    }

    // ===========================
    //   HOME PAGE (index.html)
    // ===========================
    function initHome() {
        if (!shouldRun()) return;

        const step = getStep();

        // First ever visit — no step set yet
        if (step === '' || step === 'home_welcome') {
            showHomeWelcome();
            return;
        }

        if (step === 'home_opening') {
            showHomeOpening();
            return;
        }

        // Returning from Games
        if (step === 'games_done' || step === 'home_post_games') {
            setStep('home_post_games');
            showHomePostGames();
            return;
        }

        // Returning from AI
        if (step === 'ai_done' || step === 'home_post_ai') {
            setStep('home_post_ai');
            showHomePostAI();
            return;
        }

        // After "For sure bro"
        if (step === 'home_proxy_skip') {
            showHomeProxySkip();
            return;
        }

        // Returning from Chat
        if (step === 'chat_done' || step === 'home_post_chat') {
            setStep('home_post_chat');
            showHomePostChat();
            return;
        }

        // Returning from Media
        if (step === 'media_done' || step === 'home_wrap_up') {
            setStep('home_wrap_up');
            showHomeWrapUp();
            return;
        }

        if (step === 'home_farewell') {
            showHomeFarewell();
            return;
        }
    }

    function showHomeWelcome() {
        ensureOverlay();
        const popup = createPopup(
            '<strong>Welcome to Nexus! Would you like a guided walkthrough or can you figure it out?</strong>',
            {
                centered: true,
                showSkip: false
            }
        );

        setStep('home_welcome');

        const walkthroughBtn = document.createElement('button');
        walkthroughBtn.id = 'tut-walkthrough-btn';
        walkthroughBtn.textContent = 'Walkthrough!';
        walkthroughBtn.onclick = (e) => {
            e.stopPropagation();
            showHomeOpening();
        };

        const skipBtn = document.createElement('button');
        skipBtn.id = 'tut-welcome-skip-btn';
        skipBtn.textContent = 'Skip';
        skipBtn.onclick = (e) => {
            e.stopPropagation();
            showSkipGoodbye();
        };

        popup.appendChild(walkthroughBtn);
        popup.appendChild(skipBtn);
    }

    function showSkipGoodbye() {
        localStorage.setItem(SKIP_KEY, 'true');
        clearAll();
        ensureOverlay();
        createPopup(
            '<strong>Alright, do as you wish. But if you want to come back to this tutorial, look in Settings.</strong>',
            {
                centered: true,
                showSkip: false,
                btn: {
                    label: 'Got it',
                    cb: () => {
                        clearAll();
                    }
                }
            }
        );
    }

    function showHomeOpening() {
        ensureOverlay();
        createPopup(
            '<strong>Alright! Click the Games button to get started.</strong>',
            {
                centered: false,
                showSkip: true
            }
        );

        // Lock all buttons except Games
        setStep('home_opening');
        lockHomeNav('btn-nav-games');

        // Also disable the nexus logo clicking
        const logo = document.getElementById('nexus-logo');
        if (logo) logo.style.pointerEvents = 'none';

        // When the Games button is clicked, navigate normally
        overrideClick('btn-nav-games', (e) => {
            setStep('games_main');
            const item = overriddenButtons.find(x => x.el.id === 'btn-nav-games');
            const orig = item ? item.origClick : null;
            clearAll();
            if (typeof orig === 'function') orig.call(document.getElementById('btn-nav-games'), e);
            else location.href = 'carmeow.html';
        });
    }

    function showHomePostGames() {
        ensureOverlay();
        createPopup(
            '<strong>You\'re done playing for now? I\'ll show you around the rest of the website! Let\'s start with the AI chatbot.</strong>',
            { centered: false }
        );

        lockHomeNav('btn-nav-ai');

        const logo = document.getElementById('nexus-logo');
        if (logo) logo.style.pointerEvents = 'none';

        overrideClick('btn-nav-ai', (e) => {
            setStep('ai_main');
            const item = overriddenButtons.find(x => x.el.id === 'btn-nav-ai');
            const orig = item ? item.origClick : null;
            clearAll();
            if (typeof orig === 'function') orig.call(document.getElementById('btn-nav-ai'), e);
            else location.href = 'ai.html';
        });
    }

    function showHomePostAI() {
        ensureOverlay();
        createPopup(
            '<strong>Hopefully the AI wasn\'t too slow, was it?</strong>',
            {
                btn: { label: 'For sure, bro', cb: () => {
                    setStep('home_proxy_skip');
                    clearAll();
                    showHomeProxySkip();
                }}
            }
        );
    }

    function showHomeProxySkip() {
        ensureOverlay();
        createPopup(
            '<strong>Whatever. Anyway, I would tell you how to use the proxy, but it has its own built in tutorial because I didn\'t make it— NautilusLabs did! Check it out later. But for now, let\'s get to the Chat Rooms!</strong>',
            { centered: false }
        );

        lockHomeNav('btn-nav-chat');

        const logo = document.getElementById('nexus-logo');
        if (logo) logo.style.pointerEvents = 'none';

        overrideClick('btn-nav-chat', (e) => {
            setStep('chat_main');
            const item = overriddenButtons.find(x => x.el.id === 'btn-nav-chat');
            const orig = item ? item.origClick : null;
            clearAll();
            if (typeof orig === 'function') orig.call(document.getElementById('btn-nav-chat'), e);
            else location.href = 'chat.html';
        });
    }

    function showHomePostChat() {
        ensureOverlay();
        createPopup(
            '<strong>Hope you had some fun chatting. Now we come to the last stop on our tour: Media!</strong>',
            { centered: false }
        );

        lockHomeNav('btn-nav-media');

        const logo = document.getElementById('nexus-logo');
        if (logo) logo.style.pointerEvents = 'none';

        overrideClick('btn-nav-media', (e) => {
            setStep('media_main');
            const item = overriddenButtons.find(x => x.el.id === 'btn-nav-media');
            const orig = item ? item.origClick : null;
            clearAll();
            if (typeof orig === 'function') orig.call(document.getElementById('btn-nav-media'), e);
            else location.href = 'media.html';
        });
    }

    function showHomeWrapUp() {
        ensureOverlay();
        createPopup(
            '<strong>Alrighty! You\'ve checked out most of the stuff here, and sadly, our tour is coming to a close.</strong>',
            {
                btn: { label: 'Aww, so soon?', cb: () => {
                    setStep('home_farewell');
                    clearAll();
                    showHomeFarewell();
                }}
            }
        );
    }

    function showHomeFarewell() {
        ensureOverlay();
        createPopup(
            '<strong>Indeed. If you have any concerns or requests, hover over the version tag next to the logo on the home page and click Request Stuff. And with that, I will leave you. See ya!</strong>',
            {
                btn: { label: 'Bye!', cb: () => {
                    finish();
                }}
            }
        );
    }

    // ===========================
    //   GAMES PAGE (carmeow.html)
    // ===========================
    function initGames() {
        if (!shouldRun()) return;

        const step = getStep();

        if (step === 'games_main') {
            showGamesMain();
        } else if (step === 'games_utilities') {
            showGamesUtilities();
        } else if (step === 'games_done') {
            showGamesDone();
        }
    }

    function showGamesMain() {
        ensureOverlay();
        createPopup(
            '<strong>This is your hub for all games and apps. The Master Stash has tons of games. Click a game to add it to sidebar. Click the sidebar icon to play it.</strong>',
            {
                btn: { label: 'Alright', cb: () => {
                    setStep('games_utilities');
                    clearAll();
                    showGamesUtilities();
                }}
            }
        );
    }

    function showGamesUtilities() {
        ensureOverlay();

        const defaultText = '<strong>In the top right are your utilities. Hover over each button to learn about it.</strong>';

        const hoverTexts = {
            'cloak-btn': '<strong>Fullscreen opens a sidebar game in a full about:blank window. You can\'t do this for the Stash though.</strong>',
            'export-btn': '<strong>Don\'t worry, your progress auto-saves. These are if you want to backup your progress in the form of one file to restore on other devices.</strong>',
            'custom-app-btn': '<strong>This is for adding any HTML file you have to the sidebar as an app.</strong>'
        };

        // The Restore button doesn't have a unique id — it's the button wrapping #import-btn
        // The Home button is the last .material-nav-btn in .controls

        createPopup(defaultText, {
            btn: { label: "I've learned enough", cb: () => {
                setStep('games_done');
                clearAll();
                removeUtilityHovers();
                showGamesDone();
            }}
        });

        // Highlight each individual button in controls so pointer-events pass through
        const controlBtns = document.querySelectorAll('header .controls .material-nav-btn');
        controlBtns.forEach(btn => {
            btn.classList.add('tutorial-highlight');
            btn.style.pointerEvents = 'auto';
        });

        // Set up hover listeners on the utility buttons
        const popup = document.getElementById('tut-popup');
        const contentEl = popup ? popup.querySelector('.tutorial-content') : null;

        function setHoverText(html) {
            if (contentEl) contentEl.innerHTML = html;
        }

        const hoverHandlers = [];

        controlBtns.forEach((btn) => {
            // Determine which button this is
            const id = btn.id;
            const spanText = btn.querySelector('span') ? btn.querySelector('span').textContent.trim().toLowerCase() : '';

            let hoverHTML = null;
            if (hoverTexts[id]) {
                hoverHTML = hoverTexts[id];
            } else if (spanText === 'restore') {
                hoverHTML = hoverTexts['export-btn']; // same text as backup
            } else if (spanText === 'home') {
                hoverHTML = '<strong>Go back to the home screen.</strong>';
            }

            if (hoverHTML) {
                const enterHandler = () => setHoverText(hoverHTML);
                const leaveHandler = () => setHoverText(defaultText);
                btn.addEventListener('mouseenter', enterHandler);
                btn.addEventListener('mouseleave', leaveHandler);
                hoverHandlers.push({ el: btn, enter: enterHandler, leave: leaveHandler });
            }
        });

        // Store handlers for cleanup
        window._tutHoverHandlers = hoverHandlers;
    }

    function removeUtilityHovers() {
        if (window._tutHoverHandlers) {
            window._tutHoverHandlers.forEach(h => {
                h.el.removeEventListener('mouseenter', h.enter);
                h.el.removeEventListener('mouseleave', h.leave);
                h.el.classList.remove('tutorial-highlight');
                h.el.style.pointerEvents = '';
            });
            window._tutHoverHandlers = null;
        }
        // Also clean up any remaining highlights on control buttons
        document.querySelectorAll('header .controls .material-nav-btn').forEach(btn => {
            btn.classList.remove('tutorial-highlight');
            btn.style.pointerEvents = '';
        });
    }

    function showGamesDone() {
        ensureOverlay();
        createPopup(
            '<strong>Alright! Explore around here and whenever you head back to the homepage, I\'ll be there.</strong>',
            {
                centered: false,
                btn: { label: "Alrighty! Let's game", cb: () => {
                    setStep('games_done');
                    clearAll();
                }}
            }
        );
    }

    // ===========================
    //   AI PAGE (ai.html)
    // ===========================
    function initAI() {
        if (!shouldRun()) return;

        const step = getStep();

        if (step === 'ai_main') {
            showAIMain();
        } else if (step === 'ai_sidebar') {
            showAISidebar();
        }
    }

    function showAIMain() {
        ensureOverlay();
        createPopup(
            '<strong>This is an AI chatbot for your convenience! Type an answer in and expect a response in 3-5 business days!</strong> In all seriousness, if it\'s slow, just hang in there— the API I\'m using is free but not that fast!',
            {
                btn: { label: "I'll try", cb: () => {
                    setStep('ai_sidebar');
                    clearAll();
                    showAISidebar();
                }}
            }
        );
    }

    function showAISidebar() {
        ensureOverlay();
        createPopup(
            '<strong>Good, good. The sidebar contains your previous chats which you can delete via the button on them. You can go back to them as well.</strong> Currently, though, you\'re on a new chat, so type something in if you want and it\'ll show up in the sidebar. Alright, I\'ll leave you to it!',
            {
                btn: { label: 'Bet', cb: () => {
                    setStep('ai_done');
                    clearAll();
                }}
            }
        );
    }

    // ===========================
    //   CHAT PAGE (chat.html)
    // ===========================
    function initChat() {
        if (!shouldRun()) return;

        const step = getStep();

        if (step === 'chat_main') {
            showChatMain();
        }
    }

    function showChatMain() {
        ensureOverlay();
        createPopup(
            '<strong>Nexus Chat Rooms are completely anonymous, meaning you have to give your peers the 6-digit code in person and they\'ll be able to join.</strong> Keep in mind the host is literally hosting the server, so if they close their tab the room gets disbanded! Anyway, why don\'t you try it out?',
            {
                btn: { label: 'Okay', cb: () => {
                    setStep('chat_done');
                    clearAll();
                }}
            }
        );
    }

    // ===========================
    //   MEDIA PAGE (media.html)
    // ===========================
    function initMedia() {
        if (!shouldRun()) return;

        const step = getStep();

        if (step === 'media_main') {
            showMediaMain();
        }
    }

    function showMediaMain() {
        ensureOverlay();
        createPopup(
            '<strong>Here you can watch all the latest movies and TV shows. You can scroll through the list or search for anything, from actors in a movie to a genre to the title. Try it out and watch something cool!</strong>',
            {
                btn: { label: 'Awesome!', cb: () => {
                    setStep('media_done');
                    clearAll();
                }}
            }
        );
    }

    // ===========================
    //   PUBLIC API
    // ===========================
    window.TutorialEngine = {
        initHome:  initHome,
        initGames: initGames,
        initAI:    initAI,
        initChat:  initChat,
        initMedia: initMedia,
        skip:      skip,
        finish:    finish,
        clearAll:  clearAll,
        getStep:   getStep,
        setStep:   setStep
    };

})();
