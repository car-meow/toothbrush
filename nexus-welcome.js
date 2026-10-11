(function () {
    const storage = window.nexusStorage || window.localStorage;
    const KEY = 'tb_welcome_v2_complete';
    const style = document.createElement('style');
    style.textContent = `#nexus-welcome-overlay{position:fixed;inset:0;z-index:50000;background:rgba(5,3,12,.78);backdrop-filter:blur(12px);display:none;align-items:center;justify-content:center;padding:18px}.nw-wrap{width:min(620px,94vw);color:var(--text-color);text-align:center;animation:nw-in .55s ease both}.nw-title{font-size:clamp(30px,6vw,52px);font-weight:900;color:var(--title-color);filter:blur(12px);animation:nw-title-in .8s ease forwards}.nw-card{margin:24px auto 0;padding:clamp(22px,5vw,38px);border-radius:22px;border:1px solid var(--border-color);background:var(--modal-bg);box-shadow:0 25px 90px #0009;animation:nw-card-in .5s .2s ease both}.nw-card.nw-enter-right{animation:nw-enter-right .42s ease both}.nw-card.nw-fly-left{animation:nw-fly-left .2s ease forwards}.nw-card h2{margin:0 0 22px;color:var(--title-color)}.nw-field{width:100%;box-sizing:border-box;padding:13px 16px;border-radius:10px;background:var(--input-bg);border:1px solid var(--border-color);color:var(--text-color);font-size:17px;margin-bottom:14px}.nw-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}.nw-button{border:0;border-radius:999px;padding:12px 22px;font-weight:800;font-size:15px;cursor:pointer;color:#fff;background:#6840ad}.nw-button.secondary{background:#4c4658}.nw-note{font-size:13px;color:var(--muted-text,#aaa);margin:20px 0 14px}.nw-skip-copy{display:flex;flex-direction:column;align-items:center;gap:16px;margin-top:18px}.nw-skip-copy p{margin:0;max-width:42ch;line-height:1.5}.nw-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left}.nw-setting{display:flex;justify-content:space-between;align-items:center;background:var(--settings-row-bg);padding:12px;border-radius:10px;gap:8px}.nw-select{background:var(--input-bg);color:var(--text-color);border:1px solid var(--border-color);border-radius:8px;padding:8px;max-width:55%}@keyframes nw-in{from{opacity:0}to{opacity:1}}@keyframes nw-title-in{to{filter:blur(0);transform:translateY(0)}}@keyframes nw-card-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}@keyframes nw-enter-right{from{opacity:0;transform:translateX(50vw)}to{opacity:1;transform:translateX(0)}}@keyframes nw-fly-left{to{opacity:0;transform:translateX(-50vw)}}@media(max-width:520px){.nw-grid{grid-template-columns:1fr}}`;
    document.head.appendChild(style);
    let overlay, step = 1, enterFromRight = false;
    function apply(key, value) {
        storage.setItem(key, value);
        if (key === 'tb_theme') {
            document.documentElement.classList.toggle('light-mode', value === 'light');
            const video = document.getElementById('home-bg-video');
            if (video && video.src) {
                video.src = value === 'light' ? 'Assets/loopBGlight.mp4' : 'Assets/loopBG.mp4';
                if (!document.hidden) video.play().catch(() => {});
            }
        }
        if (key === 'tb_cloak_preset') { if (window.setCloakPreset) window.setCloakPreset(value); else { storage.setItem(key, value); if (window.applyTabCloak) window.applyTabCloak(); } }
        if (key === 'tb_performance_mode') { document.documentElement.classList.toggle('performance-mode', value === 'true'); if (value === 'true') apply('tb_performance_mode_lite', 'false'); }
        if (key === 'tb_performance_mode_lite') { document.documentElement.classList.toggle('performance-mode-lite', value === 'true'); if (value === 'true') apply('tb_performance_mode', 'false'); }
        if (key === 'tb_performance_mode' || key === 'tb_performance_mode_lite') {
            const reduced = storage.getItem('tb_performance_mode') === 'true' || storage.getItem('tb_performance_mode_lite') === 'true';
            let video = document.getElementById('home-bg-video');
            if (reduced && video) { video.pause(); video.remove(); }
            if (!reduced && !video && document.body.classList.contains('home-screen')) {
                video = document.createElement('video'); video.id = 'home-bg-video'; video.className = 'home-bg-video'; video.autoplay = true; video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'none'; video.setAttribute('aria-hidden', 'true');
                video.src = storage.getItem('tb_theme') === 'light' ? 'Assets/loopBGlight.mp4' : 'Assets/loopBG.mp4'; document.body.prepend(video); video.play().catch(() => {});
            }
        }
    }
    function make() { if (overlay) return overlay; overlay = document.createElement('div'); overlay.id = 'nexus-welcome-overlay'; document.body.appendChild(overlay); return overlay; }
    let greetingProfileId = null;
    function updateGreeting() {
        const profile = window.NexusProfile && NexusProfile.get();
        const logo = document.getElementById('nexus-logo');
        if (!logo || !logo.parentElement) return;
        let greeting = document.querySelector('.nexus-greeting');
        if (!profile) {
            const logoWrapper = document.querySelector('.logo-wrapper');
            if (logoWrapper && logo.parentElement !== logoWrapper) logoWrapper.appendChild(logo);
            if (greeting) greeting.remove();
            if (logo._greetingMeasure) {
                window.removeEventListener('resize', logo._greetingMeasure);
                logo.removeEventListener('load', logo._greetingMeasure);
                logo._greetingMeasure = null;
            }
            logo.style.display = '';
            greetingProfileId = null;
            return;
        }
        if (!greeting) {
            greeting = document.createElement('div');
            greeting.className = 'nexus-greeting';
            greeting.innerHTML = '<div class="nexus-greeting-opening"></div><div class="nexus-greeting-logo-row"><span class="nexus-greeting-comma" aria-hidden="true">,</span></div><div class="nexus-greeting-name"></div>';
            logo.parentElement.insertBefore(greeting, logo);
        }
        const visitKey = `tb_home_profile_visits_${profile.id}`;
        let visits = parseInt(storage.getItem(visitKey) || '0', 10);
        if (greetingProfileId !== profile.id) {
            const isNewProfile = profile.createdAt && Date.now() - profile.createdAt < 60000;
            if (!visits && !isNewProfile) visits = 1;
            visits += 1;
            storage.setItem(visitKey, String(visits));
            greetingProfileId = profile.id;
        }
        const returningMessages = ['Welcome back to', 'You are returning to', 'Good to see you in', 'Glad you’re back in', 'You have returned to', 'Welcome again to', 'You are back in', 'Good to have you back in', 'Happy to see you again in'];
        let message = 'Welcome to';
        if (visits > 1) {
            const choiceKey = `tb_home_profile_greeting_${profile.id}`;
            const previous = storage.getItem(choiceKey) || '';
            const choices = returningMessages.filter(item => item !== previous);
            message = choices[Math.floor(Math.random() * choices.length)] || returningMessages[0];
            storage.setItem(choiceKey, message);
        }
        const opening = greeting.querySelector('.nexus-greeting-opening');
        const logoRow = greeting.querySelector('.nexus-greeting-logo-row');
        const name = greeting.querySelector('.nexus-greeting-name');
        opening.textContent = message;
        name.textContent = `${profile.username}!`;
        logo.style.display = '';
        logoRow.insertBefore(logo, logoRow.firstChild);
        if (!logo._greetingMeasure) {
            logo._greetingMeasure = () => {
                const imageHeight = Math.min(140, parseFloat(getComputedStyle(logo).maxHeight) || 140);
                const naturalWidth = logo.naturalWidth;
                const naturalHeight = logo.naturalHeight;
                const fittedWidth = naturalWidth && naturalHeight ? naturalWidth * imageHeight / naturalHeight : logo.getBoundingClientRect().width;
                greeting.style.width = `${Math.max(1, Math.min(fittedWidth || 260, window.innerWidth - 32))}px`;
            };
            window.addEventListener('resize', logo._greetingMeasure, { passive: true });
            logo.addEventListener('load', logo._greetingMeasure);
        }
        logo._greetingMeasure();
    }
    function goTo(nextStep) {
        const oldCard = overlay && overlay.querySelector('.nw-card');
        if (!oldCard) { step = nextStep; enterFromRight = true; render(); return; }
        oldCard.classList.add('nw-fly-left');
        setTimeout(() => { step = nextStep; enterFromRight = true; render(); }, 210);
    }
    function render() {
        const el = make(); el.style.display = 'flex';
        const cardClass = enterFromRight ? 'nw-card nw-enter-right' : 'nw-card';
        enterFromRight = false;
        const profile = window.NexusProfile && NexusProfile.get();
        if (step === 1) {
            el.innerHTML = `<div class="nw-wrap"><div class="nw-title">Welcome to Nexus!</div><div class="${cardClass}"><h2>Choose your Username</h2><input class="nw-field" id="nw-username" maxlength="24" placeholder="Your username" value="${profile ? profile.username.replace(/[&<>"']/g, '') : ''}"><div id="nw-error" style="color:#ef5350;min-height:20px;margin-bottom:10px"></div><div class="nw-actions"><button class="nw-button" id="nw-next">Okay!</button><button class="nw-button secondary" id="nw-guest">Continue as Guest</button></div></div></div>`;
            el.querySelector('#nw-next').onclick = () => { try { NexusProfile.save(el.querySelector('#nw-username').value); updateGreeting(); goTo(2); } catch (e) { el.querySelector('#nw-error').textContent = e.message; } };
            el.querySelector('#nw-guest').onclick = () => { if (window.NexusProfile) NexusProfile.clear(); updateGreeting(); goTo(2); };
            el.querySelector('#nw-username').addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#nw-next').click(); });
        } else if (step === 2) {
            el.innerHTML = `<div class="nw-wrap"><div class="nw-title">Welcome to Nexus!</div><div class="${cardClass}"><h2>Customize your experience</h2><div class="nw-grid"><label class="nw-setting">Performance Mode<input type="checkbox" id="nw-perf"></label><label class="nw-setting">Performance Mode Lite<input type="checkbox" id="nw-lite"></label><label class="nw-setting">Theme<select class="nw-select" id="nw-theme"><option value="dark">Dark</option><option value="light">Light</option></select></label><label class="nw-setting">Cloaking<select class="nw-select" id="nw-cloak"><option value="canvas">Canvas (Default)</option><option value="wikipedia">Wikipedia</option><option value="drive">Google Drive</option><option value="none">New Tab</option></select></label></div><div class="nw-note">Everything can be changed anytime in Settings.</div><button class="nw-button" id="nw-confirm">Confirm Settings</button></div></div>`;
            const perf = el.querySelector('#nw-perf'), lite = el.querySelector('#nw-lite'), theme = el.querySelector('#nw-theme'), cloak = el.querySelector('#nw-cloak');
            perf.checked = storage.getItem('tb_performance_mode') === 'true'; lite.checked = storage.getItem('tb_performance_mode_lite') === 'true'; theme.value = storage.getItem('tb_theme') || 'dark'; cloak.value = storage.getItem('tb_cloak_preset') || 'canvas';
            perf.onchange = () => { apply('tb_performance_mode', String(perf.checked)); lite.checked = storage.getItem('tb_performance_mode_lite') === 'true'; };
            lite.onchange = () => { apply('tb_performance_mode_lite', String(lite.checked)); perf.checked = storage.getItem('tb_performance_mode') === 'true'; };
            theme.onchange = () => apply('tb_theme', theme.value); cloak.onchange = () => apply('tb_cloak_preset', cloak.value);
            el.querySelector('#nw-confirm').onclick = () => goTo(3);
        } else {
            el.innerHTML = `<div class="nw-wrap"><div class="nw-title">Welcome to Nexus!</div><div class="${cardClass}"><h2>Would you like to start the interactive tutorial?</h2><div class="nw-actions"><button class="nw-button" id="nw-sure">Sure!</button><button class="nw-button secondary" id="nw-skip">Skip</button></div><div class="nw-skip-copy" id="nw-skip-copy"></div></div></div>`;
            el.querySelector('#nw-sure').onclick = () => { storage.setItem(KEY, 'true'); el.remove(); if (window.TutorialEngine) { TutorialEngine.setStep('home_opening'); TutorialEngine.start(); } };
            el.querySelector('#nw-skip').onclick = () => {
                const actions = el.querySelector('.nw-actions');
                if (actions) actions.remove();
                const copy = el.querySelector('#nw-skip-copy');
                copy.innerHTML = `<p>You can start the interactive tutorial anytime in Settings. Check the Help tab if you have questions.</p><button class="nw-button" id="nw-done">Alright!</button>`;
                el.querySelector('#nw-done').onclick = () => { storage.setItem(KEY, 'true'); el.remove(); };
            };
        }
    }
    function start() { step = 1; render(); }
    window.NexusWelcome = { start, key: KEY };
    document.addEventListener('DOMContentLoaded', () => {
        updateGreeting();
        const time = document.createElement('div'); time.className = 'nexus-home-clock'; time.innerHTML = '<time id="nexus-local-time"></time><div id="nexus-local-date"></div>'; document.body.appendChild(time);
        const update = () => { const now = new Date(); document.getElementById('nexus-local-time').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); document.getElementById('nexus-local-date').textContent = now.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }); };
        update(); setInterval(update, 30000);
        if (storage.getItem(KEY) !== 'true') setTimeout(start, 350);
    });
})();
