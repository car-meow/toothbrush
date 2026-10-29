// nexus-version: 4.46.21
(function () {
    'use strict';

    const STORAGE_KEY = 'tb_home_widgets_v1';
    const HOLD_DURATION = 1200;
    const SAFE_PADDING = 58;
    const GRID_PADDING = 24;
    const WIDGET_INSET = 4;
    const WIDGETS = [
        { id: 'active-users', title: 'Active Users', description: 'Shows how many Nexus users are online right now.', columns: 2, rows: 1 },
        { id: 'time', title: 'Time', description: 'Shows your current local time.', columns: 3, rows: 1 },
        { id: 'date', title: 'Date', description: 'Shows today’s date in your local format.', columns: 3, rows: 1 },
        { id: 'version', title: 'Version', description: 'Shows the current Nexus version and opens its update notes.', columns: 2, rows: 1 },
        { id: 'performance', title: 'Performance Mode', description: 'Turns Performance Mode on or off.', columns: 4, rows: 1 },
        { id: 'theme', title: 'Theme', description: 'Switches between Light mode and Dark mode.', columns: 2, rows: 1 }
    ];
    const widgetById = new Map(WIDGETS.map(widget => [widget.id, widget]));

    if (!document.body.classList.contains('home-screen') || !document.getElementById('menu-items-wrapper')) return;

    const storage = window.nexusStorage || window.localStorage;
    const system = document.createElement('div');
    system.className = 'home-widget-system';
    system.innerHTML = `
        <div class="home-widget-grid" aria-hidden="true"><div class="home-widget-grid-cells"></div></div>
        <div class="home-widget-layer"></div>
        <div class="home-widget-hold-ring" aria-hidden="true"></div>
        <div class="home-widget-toolbar" hidden>
            <span>Edit Widgets</span><span>Drag to move · M to manage · ESC to leave</span>
            <button class="home-widget-manage-trigger" type="button">Manage Widgets</button>
            <button class="home-widget-done" type="button">Done</button>
        </div>
        <div class="home-widget-manager" id="home-widget-manager" hidden>
            <section class="home-widget-manager-panel" role="dialog" aria-modal="true" aria-labelledby="home-widget-manager-title" tabindex="-1">
                <header class="home-widget-manager-header">
                    <h2 class="home-widget-manager-title" id="home-widget-manager-title">Manage Widgets</h2>
                    <button class="home-widget-manager-close" type="button" aria-label="Close widget manager">×</button>
                </header>
                <div class="home-widget-manager-list"></div>
                <p class="home-widget-manager-status" aria-live="polite"></p>
            </section>
        </div>`;
    document.body.appendChild(system);

    const grid = system.querySelector('.home-widget-grid');
    const gridCells = system.querySelector('.home-widget-grid-cells');
    const widgetLayer = system.querySelector('.home-widget-layer');
    const holdRing = system.querySelector('.home-widget-hold-ring');
    const toolbar = system.querySelector('.home-widget-toolbar');
    const manager = system.querySelector('.home-widget-manager');
    const managerPanel = system.querySelector('.home-widget-manager-panel');
    const managerList = system.querySelector('.home-widget-manager-list');
    const managerStatus = system.querySelector('.home-widget-manager-status');
    const parking = document.createElement('div');
    parking.hidden = true;
    parking.id = 'home-widget-parking';
    document.body.appendChild(parking);

    let unitWidth = 140;
    let unitHeight = 88;
    let columns = 1;
    let rows = 1;
    let safeZone = null;
    let isEditing = false;
    let holdRaf = 0;
    let holdStart = 0;
    let dragState = null;
    let suppressClickUntil = 0;
    const shells = new Map();
    const footprints = new Map();
    const content = new Map();
    let state = null;

    function readStorage(key) {
        try { return storage.getItem(key); } catch (_) { return null; }
    }

    function writeStorage(key, value) {
        try { storage.setItem(key, value); } catch (_) {}
    }

    function presenceEnabled() { return readStorage('tb_online_count_enabled') !== 'false'; }

    function defaultState() {
        const widgets = {};
        const candidates = [
            ['active-users', 0, 0],
            ['time', Math.max(0, columns - 3), 0],
            ['date', Math.max(0, columns - 3), 1],
            ['version', Math.max(0, columns - 2), Math.max(0, rows - 1)]
        ];
        candidates.forEach(([id, col, row]) => {
            if (id === 'active-users' && !presenceEnabled()) return;
            const location = findPlacement(id, { col, row }, widgets);
            if (location) widgets[id] = location;
        });
        return { widgets };
    }

    function loadState() {
        const raw = readStorage(STORAGE_KEY);
        if (!raw) return defaultState();
        try {
            const saved = JSON.parse(raw);
            if (!saved || !saved.widgets || typeof saved.widgets !== 'object') return defaultState();
            const widgets = {};
            WIDGETS.forEach(widget => {
                const pos = saved.widgets[widget.id];
                if (!pos || !Number.isInteger(pos.col) || !Number.isInteger(pos.row)) return;
                widgets[widget.id] = { col: pos.col, row: pos.row };
            });
            return { widgets };
        } catch (_) { return defaultState(); }
    }

    function saveState() { writeStorage(STORAGE_KEY, JSON.stringify(state)); }

    function getNativeContent() {
        const clock = document.querySelector('.nexus-home-clock');
        if (clock) {
            const time = clock.querySelector('#nexus-local-time');
            const date = clock.querySelector('#nexus-local-date');
            if (time) {
                const timeClock = clock.cloneNode(false);
                timeClock.appendChild(time);
                content.set('time', timeClock);
            }
            if (date) {
                const dateClock = clock.cloneNode(false);
                dateClock.appendChild(date);
                content.set('date', dateClock);
            }
            clock.remove();
        }
        const version = document.querySelector('.nexus-version-container');
        if (version) {
            const versionButton = version.querySelector('.nexus-version-tag') || version;
            content.set('version', versionButton);
            if (versionButton !== version) version.remove();
        }
        const online = document.querySelector('.online-users-bubble');
        if (online) content.set('active-users', online);
        content.forEach(node => parking.appendChild(node));
    }

    function makeOnlineUsersPlaceholder() {
        const bubble = document.createElement('div');
        bubble.className = 'online-users-bubble';
        bubble.setAttribute('role', 'status');
        bubble.setAttribute('aria-live', 'polite');
        bubble.setAttribute('aria-label', 'Active Nexus users');
        bubble.innerHTML = presenceEnabled()
            ? '<span id="online-users-count">—</span>&nbsp;online'
            : '<span id="online-users-count">Online count off</span>';
        return bubble;
    }

    function ensureOnlineWidgetContent() {
        let bubble = content.get('active-users') || document.querySelector('.online-users-bubble');
        if (!bubble) bubble = makeOnlineUsersPlaceholder();
        content.set('active-users', bubble);
        const shell = shells.get('active-users');
        if (shell && state.widgets['active-users']) shell.appendChild(bubble);
        else parking.appendChild(bubble);
        return bubble;
    }

    function dimensions() {
        const availableWidth = Math.max(1, window.innerWidth - GRID_PADDING * 2);
        const availableHeight = Math.max(1, window.innerHeight - GRID_PADDING * 2);
        columns = Math.max(4, Math.round(availableWidth / 64));
        rows = Math.max(4, Math.round(availableHeight / 60));
        unitWidth = availableWidth / columns;
        unitHeight = availableHeight / rows;
        system.style.setProperty('--widget-unit-width', `${unitWidth}px`);
        system.style.setProperty('--widget-unit-height', `${unitHeight}px`);
        system.style.setProperty('--widget-columns', columns);
        system.style.setProperty('--widget-rows', rows);
        grid.style.left = `${GRID_PADDING}px`;
        grid.style.top = `${GRID_PADDING}px`;
        grid.style.width = `${availableWidth}px`;
        grid.style.height = `${availableHeight}px`;
        safeZone = measureSafeZone();
        renderGridCells();
    }

    function measureSafeZone() {
        const items = [
            document.querySelector('.title-area'),
            document.querySelector('.button-row'),
            document.querySelector('.home-splash'),
            document.querySelector('.nexus-greeting')
        ].filter(element => element && element.getClientRects().length && (element.offsetWidth || element.offsetHeight));
        if (!items.length) return null;
        const rects = items.map(element => element.getBoundingClientRect());
        return {
            left: Math.max(0, Math.min(...rects.map(rect => rect.left)) - SAFE_PADDING),
            top: Math.max(0, Math.min(...rects.map(rect => rect.top)) - SAFE_PADDING),
            right: Math.min(window.innerWidth, Math.max(...rects.map(rect => rect.right)) + SAFE_PADDING),
            bottom: Math.min(window.innerHeight, Math.max(...rects.map(rect => rect.bottom)) + SAFE_PADDING)
        };
    }

    function zoneBlocksCell(col, row) {
        if (!safeZone) return false;
        const left = GRID_PADDING + col * unitWidth;
        const top = GRID_PADDING + row * unitHeight;
        const right = left + unitWidth;
        const bottom = top + unitHeight;
        return left < safeZone.right && right > safeZone.left && top < safeZone.bottom && bottom > safeZone.top;
    }

    function renderGridCells() {
        const visible = new Set();
        for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < columns; col += 1) {
                if (!zoneBlocksCell(col, row)) visible.add(`${col},${row}`);
            }
        }
        const fragment = document.createDocumentFragment();
        visible.forEach(key => {
            const [col, row] = key.split(',').map(Number);
            const cell = document.createElement('div');
            cell.className = 'home-widget-grid-cell';
            cell.style.gridColumn = String(col + 1);
            cell.style.gridRow = String(row + 1);
            if (col === 0 || !visible.has(`${col - 1},${row}`)) cell.classList.add('edge-left');
            if (row === 0 || !visible.has(`${col},${row - 1}`)) cell.classList.add('edge-top');
            if (!visible.has(`${col + 1},${row}`)) cell.classList.add('edge-right');
            if (!visible.has(`${col},${row + 1}`)) cell.classList.add('edge-bottom');
            fragment.appendChild(cell);
        });
        gridCells.replaceChildren(fragment);
    }

    function fits(widget, col, row) {
        if (col < 0 || row < 0 || col + widget.columns > columns || row + widget.rows > rows) return false;
        for (let y = row; y < row + widget.rows; y += 1) {
            for (let x = col; x < col + widget.columns; x += 1) {
                if (zoneBlocksCell(x, y)) return false;
            }
        }
        return true;
    }

    function overlaps(col, row, widget, positions, exceptId) {
        return Object.entries(positions).some(([otherId, pos]) => {
            if (otherId === exceptId) return false;
            const other = widgetById.get(otherId);
            return other && col < pos.col + other.columns && col + widget.columns > pos.col && row < pos.row + other.rows && row + widget.rows > pos.row;
        });
    }

    function findPlacement(id, preferred, positions, exceptId) {
        const widget = widgetById.get(id);
        if (!widget) return null;
        const candidates = [];
        if (preferred) candidates.push({ col: preferred.col, row: preferred.row });
        for (let row = 0; row < rows; row += 1) {
            for (let col = 0; col < columns; col += 1) {
                if (preferred && preferred.col === col && preferred.row === row) continue;
                candidates.push({ col, row });
            }
        }
        candidates.sort((a, b) => {
            if (!preferred) return a.row - b.row || a.col - b.col;
            const da = Math.abs(a.col - preferred.col) + Math.abs(a.row - preferred.row);
            const db = Math.abs(b.col - preferred.col) + Math.abs(b.row - preferred.row);
            return da - db || a.row - b.row || a.col - b.col;
        });
        return candidates.find(pos => fits(widget, pos.col, pos.row) && !overlaps(pos.col, pos.row, widget, positions, exceptId)) || null;
    }

    function createShell(widget) {
        const shell = document.createElement('article');
        shell.className = 'home-widget';
        shell.dataset.widgetId = widget.id;
        shell.setAttribute('aria-label', widget.title);
        shell.setAttribute('role', 'group');
        shell.addEventListener('pointerdown', event => startWidgetDrag(event, widget.id, shell));
        shells.set(widget.id, shell);
        widgetLayer.appendChild(shell);
        const footprint = document.createElement('div');
        footprint.className = 'home-widget-footprint';
        footprint.dataset.widgetId = widget.id;
        footprint.setAttribute('aria-hidden', 'true');
        footprints.set(widget.id, footprint);
        widgetLayer.appendChild(footprint);
        return shell;
    }

    function ensureNative(widget) {
        if (content.has(widget.id)) return content.get(widget.id);
        if (widget.id === 'active-users') {
            const bubble = makeOnlineUsersPlaceholder();
            content.set(widget.id, bubble);
            return bubble;
        }
        if (widget.id === 'performance') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'home-widget-native-pill home-widget-performance-pill';
            button.innerHTML = '<span>Performance Mode</span><span class="home-widget-switch" aria-hidden="true"><span class="home-widget-switch-thumb"></span></span>';
            button.addEventListener('click', () => setPerformanceMode(!performanceModeEnabled()));
            updatePerformanceWidget(button);
            content.set(widget.id, button);
            return button;
        }
        if (widget.id === 'theme') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'home-widget-native-pill home-widget-theme-toggle';
            button.innerHTML = '<span class="home-widget-theme-icon" aria-hidden="true">☾</span><span class="home-widget-theme-label"></span>';
            button.addEventListener('click', () => applyTheme(readStorage('tb_theme') === 'light' ? 'dark' : 'light'));
            updateThemeWidget(button);
            content.set(widget.id, button);
            return button;
        }
        return null;
    }

    function performanceModeEnabled() {
        return readStorage('tb_performance_mode') === 'true' || readStorage('tb_performance_mode_lite') === 'true';
    }

    function updatePerformanceWidget(button) {
        const enabled = performanceModeEnabled();
        button.setAttribute('aria-pressed', String(enabled));
        button.setAttribute('aria-label', `Performance Mode ${enabled ? 'on' : 'off'}`);
    }

    function updateThemeWidget(button) {
        const light = (readStorage('tb_theme') || 'dark') === 'light';
        const icon = button.querySelector('.home-widget-theme-icon');
        const label = button.querySelector('.home-widget-theme-label');
        if (icon) {
            icon.textContent = light ? '☀' : '☾';
            icon.classList.toggle('is-light', light);
            icon.classList.toggle('is-dark', !light);
        }
        if (label) label.textContent = light ? 'Light' : 'Dark';
        button.setAttribute('aria-pressed', String(light));
        button.setAttribute('aria-label', `Switch to ${light ? 'dark' : 'light'} mode`);
    }

    function syncHomeBackground() {
        const performanceEnabled = performanceModeEnabled();
        let video = document.getElementById('home-bg-video');
        if (performanceEnabled && video) {
            video.pause();
            video.remove();
        } else if (!performanceEnabled && !video) {
            video = document.createElement('video');
            video.id = 'home-bg-video';
            video.className = 'home-bg-video';
            video.autoplay = true;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.preload = 'none';
            video.setAttribute('aria-hidden', 'true');
            document.body.prepend(video);
            video.src = readStorage('tb_theme') === 'light' ? 'Assets/loopBGlight.mp4' : 'Assets/loopBG.mp4';
            if (!document.hidden) video.play().catch(() => {});
        }
    }

    function setPerformanceMode(enabled) {
        try {
            storage.setItem('tb_performance_mode', 'false');
            storage.setItem('tb_performance_mode_lite', String(enabled));
        } catch (_) {}
        document.documentElement.classList.remove('performance-mode');
        document.documentElement.classList.toggle('performance-mode-lite', enabled);
        syncHomeBackground();
        const button = content.get('performance');
        if (button) updatePerformanceWidget(button);
        window.dispatchEvent(new CustomEvent('nexus-performance-mode-change', { detail: { enabled } }));
    }

    function applyTheme(theme) {
        try { storage.setItem('tb_theme', theme); } catch (_) {}
        document.documentElement.classList.toggle('light-mode', theme === 'light');
        const video = document.getElementById('home-bg-video');
        if (video && !performanceModeEnabled()) {
            video.src = theme === 'light' ? 'Assets/loopBGlight.mp4' : 'Assets/loopBG.mp4';
            if (!document.hidden) video.play().catch(() => {});
        }
        const button = content.get('theme');
        if (button) updateThemeWidget(button);
        window.dispatchEvent(new CustomEvent('nexus-theme-change', { detail: { theme } }));
    }

    function notifyOnlineWidgetChange() {
        window.dispatchEvent(new CustomEvent('nexus-online-count-widget-change', {
            detail: { enabled: !!state.widgets['active-users'] }
        }));
    }

    function positionShell(id, pos) {
        const widget = widgetById.get(id);
        const shell = shells.get(id);
        const footprint = footprints.get(id);
        if (!widget || !shell || !footprint || !pos) return;
        shell.style.left = `${GRID_PADDING + pos.col * unitWidth + WIDGET_INSET}px`;
        shell.style.top = `${GRID_PADDING + pos.row * unitHeight + WIDGET_INSET}px`;
        shell.style.width = `${widget.columns * unitWidth - WIDGET_INSET * 2}px`;
        shell.style.height = `${widget.rows * unitHeight - WIDGET_INSET * 2}px`;
        shell.dataset.col = String(pos.col);
        shell.dataset.row = String(pos.row);
        positionFootprint(id, pos);
    }

    function positionFootprint(id, pos) {
        const widget = widgetById.get(id);
        const footprint = footprints.get(id);
        if (!widget || !footprint || !pos) return;
        footprint.style.left = `${GRID_PADDING + pos.col * unitWidth}px`;
        footprint.style.top = `${GRID_PADDING + pos.row * unitHeight}px`;
        footprint.style.width = `${widget.columns * unitWidth}px`;
        footprint.style.height = `${widget.rows * unitHeight}px`;
        footprint.dataset.col = String(pos.col);
        footprint.dataset.row = String(pos.row);
    }

    function renderWidgets() {
        WIDGETS.forEach(widget => {
            const shell = shells.get(widget.id) || createShell(widget);
            const pos = state.widgets[widget.id];
            if (!pos) {
                shell.remove();
                const inactiveFootprint = footprints.get(widget.id);
                if (inactiveFootprint) inactiveFootprint.remove();
                const node = content.get(widget.id);
                if (node) parking.appendChild(node);
                return;
            }
            if (!shell.isConnected) widgetLayer.appendChild(shell);
            const footprint = footprints.get(widget.id);
            if (footprint && !footprint.isConnected) widgetLayer.appendChild(footprint);
            const node = ensureNative(widget);
            if (node && node.parentElement !== shell) shell.appendChild(node);
            positionShell(widget.id, pos);
            shell.removeAttribute('aria-hidden');
        });
        renderManagerList();
    }

    function renderManagerList() {
        const fragment = document.createDocumentFragment();
        WIDGETS.forEach(widget => {
            const added = !!state.widgets[widget.id];
            const item = document.createElement('div');
            item.className = `home-widget-manager-item${added ? ' is-added' : ''}`;
            item.setAttribute('role', 'group');
            item.dataset.widgetId = widget.id;
            const choice = document.createElement('button');
            choice.type = 'button';
            choice.className = 'home-widget-manager-choice';
            choice.setAttribute('aria-pressed', String(added));
            const copy = document.createElement('div');
            copy.className = 'home-widget-manager-copy';
            const title = document.createElement('h3');
            title.className = 'home-widget-manager-name';
            title.textContent = widget.title;
            const description = document.createElement('p');
            description.className = 'home-widget-manager-description';
            description.textContent = widget.description;
            copy.append(title, description);
            const size = document.createElement('span');
            size.className = 'home-widget-manager-size';
            size.textContent = `${widget.columns} wide × ${widget.rows} tall`;
            choice.append(copy, size);
            item.appendChild(choice);
            item.addEventListener('click', event => {
                if (event.target.closest('.home-widget-delete') || added) return;
                addWidget(widget.id);
            });
            choice.addEventListener('keydown', event => {
                if ((event.key === 'Enter' || event.key === ' ') && !added) {
                    event.preventDefault();
                    addWidget(widget.id);
                }
            });
            if (added) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'home-widget-delete';
                remove.setAttribute('aria-label', `Delete ${widget.title} widget`);
                remove.title = `Delete ${widget.title} widget`;
                const icon = document.createElement('img');
                icon.className = 'home-widget-delete-icon';
                icon.src = 'Assets/Delete.svg';
                icon.alt = '';
                icon.setAttribute('aria-hidden', 'true');
                remove.appendChild(icon);
                remove.addEventListener('pointerenter', () => item.classList.add('is-delete-hover'));
                remove.addEventListener('pointerleave', () => item.classList.remove('is-delete-hover'));
                remove.addEventListener('focus', () => item.classList.add('is-delete-hover'));
                remove.addEventListener('blur', () => item.classList.remove('is-delete-hover'));
                remove.addEventListener('click', event => {
                    event.stopPropagation();
                    deleteWidget(widget.id);
                });
                item.appendChild(remove);
            }
            fragment.appendChild(item);
        });
        managerList.replaceChildren(fragment);
    }

    function addWidget(id) {
        const widget = widgetById.get(id);
        if (!widget || state.widgets[id]) return;
        const pos = findPlacement(id, null, state.widgets);
        if (!pos) {
            managerStatus.textContent = 'There is no open grid space outside the protected homescreen area.';
            return;
        }
        managerStatus.textContent = '';
        state.widgets[id] = pos;
        saveState();
        renderWidgets();
        if (id === 'active-users') notifyOnlineWidgetChange();
        const entry = managerList.querySelector(`[data-widget-id="${id}"] .home-widget-manager-choice`);
        if (entry) entry.focus();
    }

    function deleteWidget(id) {
        if (!state.widgets[id]) return;
        delete state.widgets[id];
        saveState();
        managerStatus.textContent = '';
        renderWidgets();
        if (id === 'active-users') notifyOnlineWidgetChange();
        const entry = managerList.querySelector(`[data-widget-id="${id}"] .home-widget-manager-choice`);
        if (entry) entry.focus();
    }

    function setGridProgress(progress) {
        const alpha = Math.max(0, Math.min(.5, progress * .5));
        system.style.setProperty('--widget-grid-alpha', alpha.toFixed(3));
        system.style.setProperty('--widget-grid-fill-alpha', (alpha * .045).toFixed(4));
        holdRing.style.left = `${holdRing.dataset.x || 0}px`;
        holdRing.style.top = `${holdRing.dataset.y || 0}px`;
        holdRing.style.setProperty('--hold-progress', `${progress * 360}deg`);
    }

    function emptyTarget(target) {
        return !target.closest('#menu-items-wrapper, .home-widget, .home-widget-manager, .home-widget-toolbar, button, a, input, select, textarea, [contenteditable="true"], [role="dialog"]');
    }

    function startHold(event) {
        if (isEditing || event.button !== 0 || !emptyTarget(event.target)) return;
        if (holdRaf) return;
        dimensions();
        holdStart = performance.now();
        holdRing.dataset.x = String(event.clientX);
        holdRing.dataset.y = String(event.clientY);
        system.classList.add('is-charging');
        setGridProgress(0);
        function tick(now) {
            const progress = Math.min((now - holdStart) / HOLD_DURATION, 1);
            setGridProgress(progress);
            if (progress >= 1) {
                holdRaf = 0;
                enterEditMode();
            } else {
                holdRaf = requestAnimationFrame(tick);
            }
        }
        holdRaf = requestAnimationFrame(tick);
    }

    function cancelHold() {
        if (!holdRaf) return;
        const elapsed = performance.now() - holdStart;
        cancelAnimationFrame(holdRaf);
        holdRaf = 0;
        if (elapsed >= HOLD_DURATION) {
            setGridProgress(1);
            enterEditMode();
            return;
        }
        holdStart = 0;
        system.classList.remove('is-charging');
        system.style.setProperty('--widget-grid-alpha', '0');
        system.style.setProperty('--widget-grid-fill-alpha', '0');
        holdRing.style.setProperty('--hold-progress', '0deg');
    }

    function enterEditMode() {
        isEditing = true;
        holdStart = 0;
        system.classList.remove('is-charging');
        system.classList.add('is-editing');
        system.style.setProperty('--widget-grid-alpha', '.5');
        system.style.setProperty('--widget-grid-fill-alpha', '.0225');
        toolbar.hidden = false;
        document.body.classList.add('home-widget-edit-mode');
        renderWidgets();
        sanitizePositions();
    }

    function exitEditMode() {
        if (!isEditing) return;
        isEditing = false;
        closeManager();
        system.classList.remove('is-editing');
        system.style.setProperty('--widget-grid-alpha', '0');
        system.style.setProperty('--widget-grid-fill-alpha', '0');
        toolbar.hidden = true;
        document.body.classList.remove('home-widget-edit-mode');
    }

    function openManager() {
        if (!isEditing) return;
        manager.hidden = false;
        managerStatus.textContent = '';
        renderManagerList();
        managerPanel.focus();
    }

    function closeManager() {
        manager.hidden = true;
        managerStatus.textContent = '';
    }

    function startWidgetDrag(event, id, shell) {
        if (!isEditing || event.button !== 0) return;
        const pos = state.widgets[id];
        if (!pos) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = shell.getBoundingClientRect();
        dragState = {
            id,
            shell,
            pointerId: event.pointerId,
            originCol: pos.col,
            originRow: pos.row,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
            col: pos.col,
            row: pos.row
        };
        shell.classList.add('is-dragging');
        shell.setPointerCapture(event.pointerId);
        shell.addEventListener('pointermove', moveWidgetDrag);
        shell.addEventListener('pointerup', finishWidgetDrag, { once: true });
        shell.addEventListener('pointercancel', finishWidgetDrag, { once: true });
    }

    function moveWidgetDrag(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        event.preventDefault();
        const desiredX = event.clientX - dragState.offsetX;
        const desiredY = event.clientY - dragState.offsetY;
        const widget = widgetById.get(dragState.id);
        const col = Math.round((desiredX - GRID_PADDING - WIDGET_INSET) / unitWidth);
        const row = Math.round((desiredY - GRID_PADDING - WIDGET_INSET) / unitHeight);
        dragState.col = col;
        dragState.row = row;
        dragState.shell.style.left = `${desiredX}px`;
        dragState.shell.style.top = `${desiredY}px`;
        const valid = fits(widget, col, row) && !overlaps(col, row, widget, state.widgets, dragState.id);
        const footprint = footprints.get(dragState.id);
        positionFootprint(dragState.id, { col, row });
        if (footprint) footprint.classList.toggle('is-invalid-drop', !valid);
    }

    function finishWidgetDrag(event) {
        if (!dragState || (event && event.pointerId !== dragState.pointerId)) return;
        const { id, shell, pointerId, col, row, originCol, originRow } = dragState;
        shell.removeEventListener('pointermove', moveWidgetDrag);
        try { if (shell.hasPointerCapture(pointerId)) shell.releasePointerCapture(pointerId); } catch (_) {}
        const widget = widgetById.get(id);
        const valid = fits(widget, col, row) && !overlaps(col, row, widget, state.widgets, id);
        shell.classList.remove('is-dragging');
        if (valid) state.widgets[id] = { col, row };
        else state.widgets[id] = { col: originCol, row: originRow };
        positionShell(id, state.widgets[id]);
        const footprint = footprints.get(id);
        if (footprint) footprint.classList.remove('is-invalid-drop');
        saveState();
        dragState = null;
        suppressClickUntil = performance.now() + 350;
    }

    function sanitizePositions() {
        const placed = {};
        WIDGETS.forEach(widget => {
            const old = state.widgets[widget.id];
            if (!old) return;
            const pos = findPlacement(widget.id, old, placed);
            if (pos) placed[widget.id] = pos;
            else delete state.widgets[widget.id];
        });
        state.widgets = placed;
        saveState();
        renderWidgets();
    }

    document.addEventListener('pointerdown', startHold, true);
    document.addEventListener('pointerup', cancelHold, true);
    document.addEventListener('pointercancel', cancelHold, true);
    window.addEventListener('blur', cancelHold, { passive: true });
    document.addEventListener('contextmenu', event => {
        if (holdRaf) event.preventDefault();
    }, true);
    document.addEventListener('click', event => {
        if (isEditing && !event.target.closest('.home-widget-manager, .home-widget-toolbar')) {
            event.preventDefault();
            event.stopImmediatePropagation();
        } else if (performance.now() < suppressClickUntil && event.target.closest('.home-widget')) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if (!manager.hidden) closeManager();
            else exitEditMode();
            return;
        }
        if (!isEditing || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key.toLowerCase() === 'm' && !event.target.closest('input, textarea, select, [contenteditable="true"]')) {
            event.preventDefault();
            if (manager.hidden) openManager();
            else closeManager();
        }
    });

    system.querySelector('.home-widget-manage-trigger').addEventListener('click', openManager);
    system.querySelector('.home-widget-done').addEventListener('click', exitEditMode);
    system.querySelector('.home-widget-manager-close').addEventListener('click', closeManager);
    manager.addEventListener('click', event => { if (event.target === manager) closeManager(); });

    const observer = new MutationObserver(records => {
        let discoveredBubble = null;
        let removedActiveBubble = false;
        records.forEach(record => record.addedNodes.forEach(node => {
            if (!(node instanceof Element)) return;
            if (node.matches('.online-users-bubble')) discoveredBubble = node;
            const nested = node.querySelector('.online-users-bubble');
            if (nested) discoveredBubble = nested;
        }));
        records.forEach(record => record.removedNodes.forEach(node => {
            if (node === content.get('active-users') && node instanceof Element && !node.isConnected) removedActiveBubble = true;
        }));
        if (discoveredBubble && !content.has('active-users')) {
            content.set('active-users', discoveredBubble);
            parking.appendChild(discoveredBubble);
            if (state && state.widgets['active-users']) renderWidgets();
        }
        if (removedActiveBubble && state) {
            const replacement = makeOnlineUsersPlaceholder();
            content.set('active-users', replacement);
            const shell = state.widgets['active-users'] ? shells.get('active-users') : null;
            (shell || parking).appendChild(replacement);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    window.addEventListener('resize', () => {
        dimensions();
        if (state) sanitizePositions();
    }, { passive: true });
    window.addEventListener('storage', event => {
        if (event.key === STORAGE_KEY && state) {
            state = loadState();
            renderWidgets();
        }
        if (event.key === 'tb_theme') {
            document.documentElement.classList.toggle('light-mode', readStorage('tb_theme') === 'light');
            syncHomeBackground();
            const theme = content.get('theme');
            if (theme) updateThemeWidget(theme);
        }
        if (event.key === 'tb_performance_mode' || event.key === 'tb_performance_mode_lite') {
            document.documentElement.classList.toggle('performance-mode-lite', readStorage('tb_performance_mode_lite') === 'true');
            document.documentElement.classList.toggle('performance-mode', readStorage('tb_performance_mode') === 'true');
            syncHomeBackground();
            const performance = content.get('performance');
            if (performance) updatePerformanceWidget(performance);
        }
    });

    document.addEventListener('DOMContentLoaded', () => {
        getNativeContent();
        dimensions();
        state = loadState();
        if (state.widgets['active-users']) ensureOnlineWidgetContent();
        const themeObserver = new MutationObserver(() => {
            const theme = content.get('theme');
            if (theme) updateThemeWidget(theme);
            const performance = content.get('performance');
            if (performance) updatePerformanceWidget(performance);
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        sanitizePositions();
        if (!readStorage(STORAGE_KEY)) saveState();
    }, { once: true });
})();
