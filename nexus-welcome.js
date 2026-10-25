(function () {
    const storage = window.nexusStorage || window.localStorage;
    const KEY = 'tb_welcome_v2_complete';
    const style = document.createElement('style');
    style.textContent = `#nexus-welcome-overlay{position:fixed;inset:0;z-index:50000;background:rgba(5,3,12,.78);backdrop-filter:blur(12px);display:none;align-items:center;justify-content:center;padding:18px}.nw-wrap{width:min(620px,94vw);color:var(--text-color);text-align:center;animation:nw-in .55s ease both}.nw-title{font-size:clamp(30px,6vw,52px);font-weight:900;color:var(--title-color);filter:blur(12px);animation:nw-title-in .8s ease forwards}.nw-card{margin:24px auto 0;padding:clamp(22px,5vw,38px);border-radius:22px;border:1px solid var(--border-color);background:var(--modal-bg);box-shadow:0 25px 90px #0009;animation:nw-card-in .5s .2s ease both}.nw-card.nw-enter-right{animation:nw-enter-right .42s ease both}.nw-card.nw-fly-left{animation:nw-fly-left .2s ease forwards}.nw-card h2{margin:0 0 22px;color:var(--title-color)}.nw-field{width:100%;box-sizing:border-box;padding:13px 16px;border-radius:10px;background:var(--input-bg);border:1px solid var(--border-color);color:var(--text-color);font-size:17px;margin-bottom:14px}.nw-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}.nw-button{border:0;border-radius:999px;padding:12px 22px;font-weight:800;font-size:15px;cursor:pointer;color:#fff;background:#6840ad}.nw-button.secondary{background:#4c4658}.nw-guest-link{display:block;margin:12px 0 0 auto;padding:0;border:0;background:transparent;color:#786b8f;font:inherit;font-size:12px;cursor:pointer}#nexus-welcome-overlay button.nw-guest-link,#nexus-welcome-overlay button.nw-guest-link:hover{padding:0!important;border:0!important;border-radius:0!important;background:transparent!important;color:#786b8f!important;box-shadow:none!important;text-shadow:none!important;transform:none!important;filter:none!important}#nexus-welcome-overlay button.nw-guest-link:hover{text-decoration:underline}.nw-guest-link:focus-visible{outline:2px solid currentColor;outline-offset:3px;border-radius:2px}.nw-note{font-size:13px;color:var(--muted-text,#aaa);margin:20px 0 14px}.nw-skip-copy{display:flex;flex-direction:column;align-items:center;gap:16px;margin-top:18px}.nw-skip-copy p{margin:0;max-width:42ch;line-height:1.5}.nw-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;text-align:left}.nw-setting{display:flex;justify-content:space-between;align-items:center;background:var(--settings-row-bg);padding:12px;border-radius:10px;gap:8px}.nw-select{background:var(--input-bg);color:var(--text-color);border:1px solid var(--border-color);border-radius:8px;padding:8px;max-width:55%}@keyframes nw-in{from{opacity:0}to{opacity:1}}@keyframes nw-title-in{to{filter:blur(0);transform:translateY(0)}}@keyframes nw-card-in{from{opacity:0;transform:scale(.92)}to{opacity:1;transform:scale(1)}}@keyframes nw-enter-right{from{opacity:0;transform:translateX(50vw)}to{opacity:1;transform:translateX(0)}}@keyframes nw-fly-left{to{opacity:0;transform:translateX(-50vw)}}@media(max-width:520px){.nw-grid{grid-template-columns:1fr}}`;
    style.textContent += `
        #nexus-welcome-overlay .nw-card { position:relative; isolation:isolate; background:transparent; }
        #nexus-welcome-overlay .nw-setting { background:var(--settings-row-bg); width:100%; box-sizing:border-box; }
        #nexus-welcome-overlay .nw-card::before {
            content:""; position:absolute; inset:0; z-index:-1; border-radius:inherit;
            background-color:var(--zigzag-bg); background-image:linear-gradient(135deg,var(--zigzag-line) 25%,transparent 25%),linear-gradient(225deg,var(--zigzag-line) 25%,transparent 25%),linear-gradient(45deg,var(--zigzag-line) 25%,transparent 25%),linear-gradient(315deg,var(--zigzag-line) 25%,transparent 25%);
            background-position:40px 0,40px 0,0 0,0 0; background-size:80px 80px;
            animation:nw-zigzag-move 18s linear infinite;
        }
        @keyframes nw-zigzag-move { to { background-position:440px 400px,440px 400px,400px 400px,400px 400px; } }
        #nexus-welcome-overlay .nw-card.nw-enter-left { animation:nw-enter-left .42s ease both; }
        #nexus-welcome-overlay .nw-card.nw-fly-right { animation:nw-fly-right .2s ease forwards; }
        @keyframes nw-enter-left { from { opacity:0; transform:translateX(-50vw); } to { opacity:1; transform:translateX(0); } }
        @keyframes nw-fly-right { to { opacity:0; transform:translateX(50vw); } }
        html.performance-mode #nexus-welcome-overlay .nw-card::before,
        html.performance-mode-lite #nexus-welcome-overlay .nw-card::before { animation:none!important; }
        #nexus-welcome-overlay .nw-tooltip-wrap { width:100%; }
        #nexus-welcome-overlay .nw-setting input,
        #nexus-welcome-overlay .nw-setting select { position:relative; z-index:1; }
        #nexus-welcome-overlay .nw-progress { display:flex; align-items:center; justify-content:center; gap:18px; margin-top:12px; color:var(--title-color); font-size:clamp(30px,6vw,52px); font-weight:900; line-height:1.1; }
        #nexus-welcome-overlay .nw-progress button { padding:0!important; border:0!important; border-radius:0!important; background:transparent!important; color:var(--title-color)!important; box-shadow:none!important; text-shadow:none!important; font:inherit; line-height:inherit; cursor:pointer; }
        #nexus-welcome-overlay .nw-progress button:hover { text-decoration:underline; background:transparent!important; color:var(--title-color)!important; transform:none!important; }
        #nexus-welcome-overlay .nw-progress button:disabled { opacity:.4; cursor:default; text-decoration:none; }
        #nexus-welcome-overlay .nw-hint { margin:20px 0 14px; font-size:13px; color:var(--muted-text,#aaa); }
        #nexus-welcome-overlay .nw-hint { margin-bottom:0; }
        #nexus-welcome-overlay .nw-hint + .nw-note { margin-top:0; }
        #nexus-welcome-overlay .nw-tooltip-wrap { position:relative; min-width:0; }
        #nexus-welcome-overlay .nw-setting { min-height:48px; cursor:help; }
        #nexus-welcome-overlay .nw-setting.nw-control-setting { cursor:default; }
        #nexus-welcome-overlay .nw-tooltip { position:absolute; top:50%; width:230px; box-sizing:border-box; padding:12px 14px; border:1px solid #a28db9; border-radius:12px; background:#ded4eb; color:#35234c; box-shadow:0 8px 24px #0005; font-size:13px; line-height:1.4; text-align:left; opacity:0; visibility:hidden; pointer-events:none; transform:translateY(-50%) scale(.97); transition:opacity .16s ease,transform .16s ease,visibility .16s; z-index:20; }
        #nexus-welcome-overlay .nw-tooltip-side-left { right:calc(100% + 12px); }
        #nexus-welcome-overlay .nw-tooltip-side-right { left:calc(100% + 12px); }
        #nexus-welcome-overlay .nw-tooltip-wrap:hover .nw-tooltip,
        #nexus-welcome-overlay .nw-tooltip-wrap:focus-within:not(.nw-pointer-focused) .nw-tooltip { opacity:1; visibility:visible; transform:translateY(-50%) scale(1); }
        #nexus-welcome-overlay .nw-tooltip-title { display:block; font-weight:800; color:#35234c; }
        #nexus-welcome-overlay .nw-tooltip-description { display:block; margin-top:5px; font-size:11px; color:#35234c; }
        #nexus-welcome-overlay .nw-tooltip-simple { color:#35234c; }
        @media(max-width:700px) {
            #nexus-welcome-overlay .nw-tooltip-side-left,
            #nexus-welcome-overlay .nw-tooltip-side-right { left:0; right:auto; top:calc(100% + 8px); transform:translateY(-4px); }
            #nexus-welcome-overlay .nw-tooltip-wrap:hover .nw-tooltip,
            #nexus-welcome-overlay .nw-tooltip-wrap:focus-within:not(.nw-pointer-focused) .nw-tooltip { transform:translateY(0); }
            #nexus-welcome-overlay .nw-grid { row-gap:38px; }
        }
        @media(max-width:520px) { #nexus-welcome-overlay .nw-progress { font-size:clamp(30px,6vw,52px); } }
    `;
    style.textContent += `
        #nw-birthday-overlay { position:fixed; inset:0; z-index:50010; display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; overflow:hidden; color:var(--text-color,#fff); background:rgba(7,5,14,.76); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px); font-family:inherit; }
        #nw-birthday-overlay .nw-mail-shell { width:min(600px,94vw); text-align:center; }
        #nw-birthday-overlay .nw-mail-title { margin:0; color:var(--title-color,#fff); font-size:clamp(30px,5vw,46px); font-weight:900; text-shadow:0 4px 24px #0008; animation:nw-mail-title-in .65s ease both; }
        #nw-birthday-overlay .nw-mail-prompt { margin:10px 0 0; color:rgba(238,231,248,.72); font-size:14px; animation:nw-mail-title-in .65s .15s ease both; }
        #nw-birthday-overlay .nw-mail-scene { position:relative; width:min(720px,94vw); height:min(78vh,760px); min-height:260px; margin:4px auto 0; perspective:1000px; }
        #nw-birthday-overlay .nw-envelope { position:absolute; left:50%; bottom:24px; width:min(620px,86vw,56vh); height:auto; aspect-ratio:1.72/1; transform:translateX(-50%); border:1px solid #806044; border-radius:11px; background-color:#c99a67; background-image:radial-gradient(ellipse at 20% 13%,#ffe5b966,transparent 43%),radial-gradient(ellipse at 83% 88%,#68411f38,transparent 53%),repeating-linear-gradient(7deg,#fff0 0 3px,#68482a0b 4px 5px),linear-gradient(145deg,#e4bd8e 0%,#d2a16e 38%,#bd8957 76%,#d1a071 100%); box-shadow:0 24px 42px #0009,inset 0 2px 5px #fff8,inset 0 -10px 18px #71452066; animation:nw-mail-in .95s cubic-bezier(.18,.76,.25,1) both; transform-origin:center; }
        #nw-birthday-overlay .nw-envelope-flap { position:absolute; z-index:2; left:0; right:0; top:0; height:58%; clip-path:polygon(0 0,100% 0,50% 100%); border-radius:10px 10px 0 0; background:linear-gradient(165deg,#f5d8a9 0%,#dfb682 48%,#bf8c5c 100%); filter:drop-shadow(0 7px 5px #613b2455); transform-origin:50% 0; transition:transform .95s cubic-bezier(.2,.72,.22,1),z-index .1s .42s; backface-visibility:visible; }
        #nw-birthday-overlay .nw-envelope-front { position:absolute; z-index:3; inset:31% 0 0; clip-path:polygon(0 0,50% 58%,100% 0,100% 100%,0 100%); border-radius:0 0 10px 10px; background:radial-gradient(ellipse at 50% 0%,#f1d0a366,transparent 50%),repeating-linear-gradient(171deg,#fff0 0 4px,#74482010 5px 6px),linear-gradient(135deg,#e0b382 0%,#c49362 54%,#d7a876 100%); filter:drop-shadow(0 -3px 4px #70452166); }
        #nw-birthday-overlay .nw-letter { position:absolute; z-index:1; left:8%; bottom:0; width:84%; height:auto; aspect-ratio:3/4; box-sizing:border-box; overflow:hidden; clip-path:inset(0 0 50% 0); padding:clamp(16px,2.2vw,28px); border:1px solid #d7c7a3; color:#46382d; text-align:left; background-color:#fbf4df; background-image:radial-gradient(ellipse at 17% 12%,#d0b88620,transparent 38%),radial-gradient(ellipse at 85% 78%,#b98e4a18,transparent 40%),repeating-linear-gradient(0deg,#fff0 0 5px,#9f7a4010 6px 7px),linear-gradient(110deg,#fff9e9,#f4e9ca 58%,#fff7e4); box-shadow:0 6px 20px #0004,inset 0 0 20px #ad8c4b22; transform:translateY(41.9%); transform-origin:center center; opacity:0; cursor:default; font-size:clamp(9px,.9vw,12px); line-height:1.35; scrollbar-width:thin; scrollbar-color:#b39a6b #f6efd9; }
        #nw-birthday-overlay .nw-mail-title.nw-mail-instruction { font-size:clamp(18px,3vw,28px); }
        #nw-birthday-overlay .nw-letter:focus { outline:none; }
        #nw-birthday-overlay .nw-letter:focus-visible { outline:2px solid #a88b58; outline-offset:3px; }
        #nw-birthday-overlay .nw-letter::-webkit-scrollbar { width:8px; }
        #nw-birthday-overlay .nw-letter::-webkit-scrollbar-track { background:#f6efd9; }
        #nw-birthday-overlay .nw-letter::-webkit-scrollbar-thumb { border:2px solid #f6efd9; border-radius:8px; background:#b39a6b; }
        #nw-birthday-overlay .nw-letter-content { font:inherit; }
        #nw-birthday-overlay .nw-letter-content p { margin:0 0 .8em; }
        #nw-birthday-overlay .nw-letter-content .nw-letter-signoff { margin-top:1.15em; }
        #nw-birthday-overlay .nw-letter-content .nw-letter-ps { margin-top:.8em; }
        #nw-birthday-overlay button.nw-birthday-close { position:fixed; z-index:2; left:50%; bottom:22px; transform:translateX(-50%); white-space:nowrap; border:0!important; border-radius:999px!important; padding:12px 22px; color:#fff!important; background:#6840ad!important; box-shadow:0 8px 28px #0007!important; font:inherit; font-size:15px; font-weight:800; cursor:pointer; opacity:0; visibility:hidden; transition:opacity .2s ease,transform .2s ease,background .2s ease; }
        #nw-birthday-overlay button.nw-birthday-close:hover { border:0!important; color:#fff!important; background:#7950bd!important; transform:translateX(-50%) translateY(-2px); }
        #nw-birthday-overlay button.nw-stamp { position:absolute; z-index:5; left:50%; top:50%; width:clamp(82px,12vw,110px); aspect-ratio:1; display:block; overflow:hidden; padding:0!important; border:0!important; border-radius:50%!important; background:transparent!important; box-shadow:none!important; color:transparent!important; text-shadow:none!important; filter:drop-shadow(0 5px 7px #48231e8c); cursor:pointer; transform:translate(-50%,-50%); }
        #nw-birthday-overlay .nw-stamp img { display:block; width:100%; height:100%; object-fit:cover; transform:translateY(4%); }
        #nw-birthday-overlay button.nw-stamp:hover { border:0!important; background:transparent!important; color:transparent!important; filter:brightness(1.08) drop-shadow(0 7px 9px #48231e99); }
        #nw-birthday-overlay .nw-envelope.nw-stamp-dropping .nw-stamp { animation:nw-stamp-drop 1.05s cubic-bezier(.55,0,1,.45) forwards; pointer-events:none; }
        #nw-birthday-overlay .nw-envelope.nw-flap-opening .nw-envelope-flap { transform:rotateX(180deg); z-index:0; }
        #nw-birthday-overlay .nw-envelope.nw-opening .nw-letter { z-index:1; animation:nw-letter-rise 1.6s .08s cubic-bezier(.12,.82,.18,1) forwards; }
        #nw-birthday-overlay .nw-letter.nw-letter-ready { z-index:1!important; opacity:1; cursor:pointer; animation:nw-paper-glow 2.4s ease-in-out infinite alternate; }
        #nw-birthday-overlay .nw-envelope.nw-opening .nw-letter.nw-letter-ready { animation:nw-paper-glow 2.4s ease-in-out infinite alternate; }
        #nw-birthday-overlay .nw-envelope.nw-opening .nw-letter.nw-letter-leaving { opacity:1; animation:nw-letter-lift .34s cubic-bezier(.18,.78,.2,1) forwards; }
        #nw-birthday-overlay .nw-letter.nw-letter-ready:hover { filter:brightness(1.025); }
        #nw-birthday-overlay.nw-paper-open .nw-mail-title,
        #nw-birthday-overlay.nw-paper-open .nw-mail-prompt,
        #nw-birthday-overlay.nw-paper-open .nw-mail-scene { visibility:hidden; }
        #nw-birthday-overlay.nw-paper-open .nw-letter { position:fixed; z-index:1!important; left:50%; top:clamp(42%,calc(50% - 3vh),48%); bottom:auto; width:min(720px,61.5vh,92vw); height:auto; max-height:82vh; aspect-ratio:3/4; padding:clamp(20px,4vh,34px) clamp(20px,5vw,42px); border-radius:3px; overflow:hidden; clip-path:none; transform:translate(-50%,-50%); opacity:1; cursor:auto; font-size:clamp(13px,1.45vw,16px); line-height:1.48; box-shadow:0 18px 75px #000a,inset 0 0 32px #ad8c4b26; }
        #nw-birthday-overlay.nw-paper-open .nw-letter.nw-letter-scrollable { overflow-y:auto; }
        #nw-birthday-overlay.nw-paper-open .nw-letter-content p { margin-bottom:1em; }
        #nw-birthday-overlay.nw-paper-open.nw-paper-ready .nw-birthday-close { opacity:1; visibility:visible; }
        @keyframes nw-mail-in { from { opacity:0; transform:translateX(calc(-50% - 65vw)) rotate(-9deg); } to { opacity:1; transform:translateX(-50%) rotate(0); } }
        @keyframes nw-mail-title-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
        @keyframes nw-stamp-drop { from { opacity:1; transform:translate(-50%,-50%) rotate(0); } to { opacity:0; transform:translate(-50%,calc(-50% + 115vh)) rotate(180deg); } }
        @keyframes nw-letter-rise { 0% { opacity:0; transform:translateY(43.1%); } 18% { opacity:1; } 100% { opacity:1; transform:translateY(41.9%); } }
        @keyframes nw-letter-lift { from { transform:translateY(41.9%) scale(1); } to { transform:translateY(0) scale(1.025); } }
        @keyframes nw-paper-glow { from { box-shadow:0 6px 20px #0004,0 0 14px 3px #f6dc9d77,inset 0 0 20px #ad8c4b22; } to { box-shadow:0 10px 28px #0006,0 0 30px 10px #ffe9aeaa,inset 0 0 24px #ad8c4b33; } }
        @media(max-width:560px) { #nw-birthday-overlay .nw-mail-scene { height:min(78vh,680px); } #nw-birthday-overlay .nw-mail-title { font-size:clamp(28px,8vw,38px); } #nw-birthday-overlay.nw-paper-open .nw-letter { font-size:13px; } #nw-birthday-overlay button.nw-birthday-close { bottom:14px; max-width:94vw; padding:11px 14px; font-size:13px; } }
        @media(max-height:600px) { #nw-birthday-overlay.nw-paper-open .nw-letter { top:42%; } }
        html.performance-mode #nw-birthday-overlay .nw-envelope { animation-duration:.95s!important; }
        html.performance-mode #nw-birthday-overlay .nw-mail-title,
        html.performance-mode #nw-birthday-overlay .nw-mail-prompt { animation-duration:.65s!important; }
        html.performance-mode #nw-birthday-overlay .nw-envelope.nw-stamp-dropping .nw-stamp { animation-duration:1.05s!important; }
        html.performance-mode #nw-birthday-overlay .nw-envelope-flap { transition-duration:.95s!important; }
        html.performance-mode #nw-birthday-overlay .nw-envelope.nw-opening .nw-letter { animation-duration:1.6s!important; }
        html.performance-mode #nw-birthday-overlay .nw-letter.nw-letter-ready { animation-duration:2.4s!important; }
        html.performance-mode #nw-birthday-overlay .nw-envelope.nw-opening .nw-letter.nw-letter-leaving { animation-duration:.34s!important; }
    `;
    document.head.appendChild(style);
    let overlay, step = 1, enterFromDirection = null;
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
    function showBirthdayMail(onClose) {
        const mail = document.createElement('div');
        mail.id = 'nw-birthday-overlay';
        mail.setAttribute('role', 'dialog');
        mail.setAttribute('aria-modal', 'true');
        mail.setAttribute('aria-labelledby', 'nw-mail-title');
        mail.innerHTML = `<div class="nw-mail-shell"><h2 class="nw-mail-title" id="nw-mail-title">You've got mail!</h2><p class="nw-mail-prompt">Click the stamp to open your letter.</p><div class="nw-mail-scene"><div class="nw-envelope" id="nw-mail-envelope"><article class="nw-letter" id="nw-birthday-letter" tabindex="0" role="button" aria-label="Open birthday letter"><div class="nw-letter-content"><p>Dear Prajun,</p><p>I want to preface this letter by saying that I'm really sorry I couldn't get you a birthday gift on time. I feel terrible about it even though you asked me not to get you a gift. So I coded this silly thing into my website to hopefully make up for a bit of it. You know who this is... Also, AI did not write this message, I just write like that. Deal wid it. :P</p><p>With that out of the way, have I mentioned how awesome of a dude you are? You may be less unc than the rest of us (as Praneetha said, you're "finally catching up") but in my eyes, you're the big bro of the friend group. You have the corn-o-meter that I always manage to raise to the top and anyone near you (oh darn, this is gonna sound even cornier) can just tell you're an honest, upstanding dude. It's kind of insane that the first time I met you in-person was literally a few months ago, but you've quickly grown to be one of my best friends and you always have my back. I can only hope I do the same for you. You curate your friends wisely and don't let random people in the group (ahem, Vihan) but you still manage to have a friend group large enough that it feels full. I grew so much as a person literally all thanks to you, both socially and mentally. You give me thousand-yard-stares that would genuinely OBLITERATE a Victorian child when I say something about... uhh... y'know what? I'mma just stop there. You're probably in school right now, so I don't want this letter to waste too much of your time. But yeah, that's it! I have no idea how to end letters properly, so I'mma just leave it at that.</p><p class="nw-letter-signoff">Thank you for reading and HAPPY BELATED BIRTHDAY!!!,<br>[redacted for privacy]</p><p class="nw-letter-ps">P. S.<br>After lunch, check your backpack :3</p></div></article><div class="nw-envelope-flap"></div><div class="nw-envelope-front"></div><button class="nw-stamp" id="nw-mail-stamp" type="button" aria-label="Open the birthday letter"><img src="Assets/pStamp.png" alt=""></button></div></div><button class="nw-birthday-close" id="nw-birthday-close" type="button">Close paper. Happy birthday! &lt;3</button></div>`;
        document.body.appendChild(mail);

        const envelope = mail.querySelector('#nw-mail-envelope');
        const stamp = mail.querySelector('#nw-mail-stamp');
        const letter = mail.querySelector('#nw-birthday-letter');
        let opened = false;
        let completed = false;
        const openLetter = () => {
            if (opened || !letter.classList.contains('nw-letter-ready')) return;
            opened = true;
            letter.classList.remove('nw-letter-ready');
            letter.classList.add('nw-letter-leaving');
            letter.addEventListener('animationend', event => {
                if (event.animationName !== 'nw-letter-lift') return;
                const startRect = letter.getBoundingClientRect();
                mail.classList.add('nw-paper-open');
                mail.appendChild(letter);
                letter.removeAttribute('role');
                letter.removeAttribute('aria-label');
                letter.tabIndex = -1;
                const endRect = letter.getBoundingClientRect();
                const dx = startRect.left + startRect.width / 2 - endRect.left - endRect.width / 2;
                const dy = startRect.top + startRect.height / 2 - endRect.top - endRect.height / 2;
                const zoom = letter.animate([
                    { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) scale(${startRect.width / endRect.width},${startRect.height / endRect.height})` },
                    { transform: 'translate(-50%,-50%)' }
                ], { duration: 850, easing: 'cubic-bezier(.18,.78,.2,1)' });
                zoom.addEventListener('finish', () => {
                    letter.classList.add('nw-letter-scrollable');
                    mail.classList.add('nw-paper-ready');
                }, { once: true });
            }, { once: true });
        };
        const finish = () => {
            if (completed) return;
            completed = true;
            mail.remove();
            onClose();
        };
        stamp.addEventListener('click', () => {
            if (envelope.classList.contains('nw-stamp-dropping') || envelope.classList.contains('nw-opening')) return;
            const title = mail.querySelector('#nw-mail-title');
            title.textContent = 'Click paper to open the letter.';
            title.classList.add('nw-mail-instruction');
            mail.querySelector('.nw-mail-prompt').hidden = true;
            envelope.classList.add('nw-stamp-dropping');
            stamp.addEventListener('animationend', event => {
                if (event.animationName !== 'nw-stamp-drop') return;
                stamp.remove();
                envelope.classList.remove('nw-stamp-dropping');
                envelope.classList.add('nw-flap-opening');
                window.setTimeout(() => {
                    if (!mail.isConnected) return;
                    letter.addEventListener('animationend', event => {
                        if (event.animationName !== 'nw-letter-rise') return;
                        letter.classList.add('nw-letter-ready');
                        letter.setAttribute('aria-label', 'Open the birthday letter');
                    }, { once: true });
                    envelope.classList.add('nw-opening');
                }, 1000);
            }, { once: true });
        });
        letter.addEventListener('click', openLetter);
        letter.addEventListener('keydown', event => {
            if ((event.key === 'Enter' || event.key === ' ') && !opened) {
                event.preventDefault();
                openLetter();
            }
        });
        mail.querySelector('#nw-birthday-close').addEventListener('click', finish);
    }
    function finishWelcome(startTutorial) {
        storage.setItem(KEY, 'true');
        const profile = window.NexusProfile && NexusProfile.get();
        const isPrajun = profile && typeof profile.username === 'string' && profile.username.trim().toLowerCase() === 'prajuntheflash';
        const complete = () => {
            if (overlay) overlay.remove();
            if (startTutorial && window.TutorialEngine) {
                TutorialEngine.setStep('home_opening');
                TutorialEngine.start();
            }
        };
        if (isPrajun) showBirthdayMail(complete);
        else complete();
    }
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
        name.classList.toggle('nexus-rainbow-text', !!(window.NexusProfile && NexusProfile.hasRainbowEffectFor(profile.username)));
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
    window.addEventListener('nexus-legolooper-rainbow-change', updateGreeting);
    function goTo(nextStep) {
        const oldCard = overlay && overlay.querySelector('.nw-card');
        const goingBack = nextStep < step;
        if (!oldCard) { step = nextStep; enterFromDirection = goingBack ? 'left' : 'right'; render(); return; }
        oldCard.classList.add(goingBack ? 'nw-fly-right' : 'nw-fly-left');
        setTimeout(() => { step = nextStep; enterFromDirection = goingBack ? 'left' : 'right'; render(); }, 210);
    }
    function progressMarkup(currentStep) {
        return `<nav class="nw-progress" aria-label="Welcome setup progress"><button type="button" data-progress="back" aria-label="Previous slide"${currentStep === 1 ? ' disabled' : ''}>&lt;</button><span>${currentStep}/3</span><button type="button" data-progress="forward" aria-label="Next slide"${currentStep === 3 ? ' disabled' : ''}>&gt;</button></nav>`;
    }
    function render() {
        const el = make(); el.style.display = 'flex';
        const cardClass = enterFromDirection ? `nw-card nw-enter-${enterFromDirection}` : 'nw-card';
        enterFromDirection = null;
        const profile = window.NexusProfile && NexusProfile.get();
        if (step === 1) {
            el.innerHTML = `<div class="nw-wrap"><div class="nw-title">Welcome to Nexus!</div><div class="${cardClass}"><h2>Choose your Username</h2><input class="nw-field" id="nw-username" maxlength="24" placeholder="Your username" value="${profile ? profile.username.replace(/[&<>"']/g, '') : ''}"><div id="nw-error" style="color:#ef5350;min-height:20px;margin-bottom:10px"></div><div class="nw-actions"><button class="nw-button" id="nw-next">Okay!</button></div><button class="nw-guest-link" id="nw-guest" type="button">Continue as Guest</button></div></div>`;
            el.querySelector('#nw-next').onclick = () => { try { NexusProfile.save(el.querySelector('#nw-username').value); updateGreeting(); goTo(2); } catch (e) { el.querySelector('#nw-error').textContent = e.message; } };
            el.querySelector('#nw-guest').onclick = () => { if (window.NexusProfile) NexusProfile.clear(); updateGreeting(); goTo(2); };
            el.querySelector('#nw-username').addEventListener('keydown', e => { if (e.key === 'Enter') el.querySelector('#nw-next').click(); });
        } else if (step === 2) {
            el.innerHTML = `<div class="nw-wrap"><div class="nw-title">Welcome to Nexus!</div><div class="${cardClass}"><h2>Customize your experience</h2><div class="nw-grid"><div class="nw-tooltip-wrap"><label class="nw-setting" for="nw-perf" aria-describedby="nw-perf-tip">Performance Mode<input type="checkbox" id="nw-perf" aria-describedby="nw-perf-tip"></label><div class="nw-tooltip nw-tooltip-side-left" id="nw-perf-tip" role="tooltip"><span class="nw-tooltip-title">Recommended for toasters.</span><span class="nw-tooltip-description">You should hopefully never have to enable this. Try Performance Mode Lite unless your device is older than 2010.</span></div></div><div class="nw-tooltip-wrap"><label class="nw-setting" for="nw-lite" aria-describedby="nw-lite-tip">Performance Mode Lite<input type="checkbox" id="nw-lite" aria-describedby="nw-lite-tip"></label><div class="nw-tooltip nw-tooltip-side-right" id="nw-lite-tip" role="tooltip"><span class="nw-tooltip-title">Recommended for most devices.</span><span class="nw-tooltip-description">Disables some extra flair while keeping things polished, perfect for mid-range devices.</span></div></div><div class="nw-tooltip-wrap"><label class="nw-setting nw-control-setting" for="nw-theme" aria-describedby="nw-theme-tip">Theme<select class="nw-select" id="nw-theme" aria-describedby="nw-theme-tip"><option value="dark">Dark</option><option value="light">Light</option></select></label><div class="nw-tooltip nw-tooltip-side-left nw-tooltip-simple" id="nw-theme-tip" role="tooltip">Changes the theme of the entire website. More themes coming soon.</div></div><div class="nw-tooltip-wrap"><label class="nw-setting nw-control-setting" for="nw-cloak" aria-describedby="nw-cloak-tip">Cloaking<select class="nw-select" id="nw-cloak" aria-describedby="nw-cloak-tip"><option value="canvas">Canvas (Default)</option><option value="wikipedia">Wikipedia</option><option value="drive">Google Drive</option><option value="none">New Tab</option></select></label><div class="nw-tooltip nw-tooltip-side-right nw-tooltip-simple" id="nw-cloak-tip" role="tooltip">Changes the tab's title and icon in your browser.</div></div></div><div class="nw-hint">Hover over items to find out what they do.</div><div class="nw-note">Everything can be changed anytime in Settings.</div><button class="nw-button" id="nw-confirm">Confirm Settings</button></div></div>`;
            const perf = el.querySelector('#nw-perf'), lite = el.querySelector('#nw-lite'), theme = el.querySelector('#nw-theme'), cloak = el.querySelector('#nw-cloak');
            perf.checked = storage.getItem('tb_performance_mode') === 'true'; lite.checked = storage.getItem('tb_performance_mode_lite') === 'true'; theme.value = storage.getItem('tb_theme') || 'dark'; cloak.value = storage.getItem('tb_cloak_preset') || 'canvas';
            perf.onchange = () => { apply('tb_performance_mode', String(perf.checked)); lite.checked = storage.getItem('tb_performance_mode_lite') === 'true'; };
            lite.onchange = () => { apply('tb_performance_mode_lite', String(lite.checked)); perf.checked = storage.getItem('tb_performance_mode') === 'true'; };
            theme.onchange = () => apply('tb_theme', theme.value); cloak.onchange = () => apply('tb_cloak_preset', cloak.value);
            el.querySelector('#nw-confirm').onclick = () => goTo(3);
        } else {
            el.innerHTML = `<div class="nw-wrap"><div class="nw-title">Welcome to Nexus!</div><div class="${cardClass}"><h2>Would you like to start the interactive tutorial?</h2><div class="nw-actions"><button class="nw-button" id="nw-sure">Sure!</button><button class="nw-button secondary" id="nw-skip">Skip</button></div><div class="nw-skip-copy" id="nw-skip-copy"></div></div></div>`;
            el.querySelector('#nw-sure').onclick = () => finishWelcome(true);
            el.querySelector('#nw-skip').onclick = () => {
                const actions = el.querySelector('.nw-actions');
                if (actions) actions.remove();
                const copy = el.querySelector('#nw-skip-copy');
                copy.innerHTML = `<p>You can start the interactive tutorial anytime in Settings. Check the Help tab if you have questions.</p><button class="nw-button" id="nw-done">Alright!</button>`;
                el.querySelector('#nw-done').onclick = () => finishWelcome(false);
            };
        }
        el.querySelectorAll('.nw-tooltip-wrap').forEach(wrap => {
            wrap.addEventListener('pointerdown', () => wrap.classList.add('nw-pointer-focused'));
            wrap.addEventListener('keydown', () => wrap.classList.remove('nw-pointer-focused'));
            wrap.addEventListener('focusout', () => setTimeout(() => {
                if (!wrap.contains(document.activeElement)) wrap.classList.remove('nw-pointer-focused');
            }, 0));
        });
        el.querySelector('.nw-wrap').insertAdjacentHTML('beforeend', progressMarkup(step));
        el.querySelector('[data-progress="back"]').onclick = () => { if (step > 1) goTo(step - 1); };
        el.querySelector('[data-progress="forward"]').onclick = () => {
            if (step === 1) {
                const username = el.querySelector('#nw-username').value.trim();
                try {
                    if (username) NexusProfile.save(username);
                    else if (window.NexusProfile) NexusProfile.clear();
                    updateGreeting();
                    goTo(2);
                } catch (e) { el.querySelector('#nw-error').textContent = e.message; }
            } else if (step < 3) goTo(step + 1);
        };
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
