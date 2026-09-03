// Register Service Worker for offline support
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker registered successfully. Scope:', reg.scope))
            .catch(err => console.log('Service Worker registration failed:', err));
    });
}

// Nexus Custom Storage Wrapper (for URL cloaking storage proxy support)
(function() {
    let mockStore = null;
    let useProxy = false;
    let fallbackStore = {};

    try {
        if (window.name && window.name.startsWith('{') && window.name.includes('tb_')) {
            mockStore = JSON.parse(window.name);
            useProxy = true;
            console.log('Nexus Storage initialized from window.name');
        }
    } catch(e) {}

    let nativeStorage = null;
    try {
        nativeStorage = window.localStorage;
    } catch (e) {
        console.warn('Native localStorage is blocked.');
    }

    const storageObj = {
        getItem: function(key) {
            if (useProxy && mockStore) return mockStore[key] !== undefined ? mockStore[key] : null;
            if (nativeStorage) {
                try { return nativeStorage.getItem(key); } catch(e) {}
            }
            return fallbackStore[key] !== undefined ? fallbackStore[key] : null;
        },
        setItem: function(key, val) {
            const strVal = String(val);
            if (useProxy && mockStore) {
                mockStore[key] = strVal;
                window.name = JSON.stringify(mockStore);
                try {
                    window.parent.postMessage({ type: 'nexus-storage-save', key: key, value: strVal }, '*');
                } catch(e) {}
                return;
            }
            if (nativeStorage) {
                try { nativeStorage.setItem(key, strVal); return; } catch(e) {}
            }
            fallbackStore[key] = strVal;
        },
        removeItem: function(key) {
            if (useProxy && mockStore) {
                delete mockStore[key];
                window.name = JSON.stringify(mockStore);
                try {
                    window.parent.postMessage({ type: 'nexus-storage-delete', key: key }, '*');
                } catch(e) {}
                return;
            }
            if (nativeStorage) {
                try { nativeStorage.removeItem(key); } catch(e) {}
            }
            delete fallbackStore[key];
        },
        key: function(i) {
            if (useProxy && mockStore) return Object.keys(mockStore)[i] || null;
            if (nativeStorage) {
                try { return nativeStorage.key(i); } catch(e) {}
            }
            return Object.keys(fallbackStore)[i] || null;
        },
        clear: function() {
            if (useProxy && mockStore) {
                mockStore = {};
                window.name = JSON.stringify(mockStore);
                try {
                    window.parent.postMessage({ type: 'nexus-storage-clear' }, '*');
                } catch(e) {}
                return;
            }
            if (nativeStorage) {
                try { nativeStorage.clear(); return; } catch(e) {}
            }
            fallbackStore = {};
        }
    };

    Object.defineProperty(storageObj, 'length', {
        get: function() {
            if (useProxy && mockStore) return Object.keys(mockStore).length;
            if (nativeStorage) {
                try { return nativeStorage.length; } catch(e) {}
            }
            return Object.keys(fallbackStore).length;
        }
    });

    window.nexusStorage = storageObj;
})();

// App Cloaking Support
(function() {
    const localStorage = window.nexusStorage || window.localStorage;
    let originalTitle = document.title;
    let originalFavicon = '';
    const origLink = document.querySelector("link[rel*='icon']");
    if (origLink) {
        originalFavicon = origLink.getAttribute('href');
    }

    function applyTabCloak() {
        const rawPreset = localStorage.getItem('tb_cloak_preset');
        const preset = (rawPreset === null || rawPreset === undefined || rawPreset === '' || rawPreset === 'default') ? 'canvas' : rawPreset;

        const presets = {
            canvas: {
                title: 'Dashboard',
                icon: 'Assets/canvas_cloak.png'
            },
            wikipedia: {
                title: 'Wikipedia, the free encyclopedia',
                icon: 'https://en.wikipedia.org/favicon.ico'
            },
            drive: {
                title: 'My Drive - Google Drive',
                icon: 'Assets/drive_cloak.png'
            },
            none: {
                title: 'New Tab',
                icon: 'data:,'
            },
            newtab: {
                title: 'New Tab',
                icon: 'data:,'
            }
        };

        const data = presets[preset] || presets.canvas;

        document.title = data.title;
        let link = document.querySelector("link[rel*='icon']");
        if (!link) {
            link = document.createElement('link');
            link.type = 'image/x-icon';
            link.rel = 'shortcut icon';
            document.head.appendChild(link);
        }
        link.href = data.icon;
    }

    applyTabCloak();

    window.addEventListener('DOMContentLoaded', () => {
        if (!originalTitle || originalTitle === 'New Tab' || originalTitle === '') {
            originalTitle = document.title;
        }
        const currentLink = document.querySelector("link[rel*='icon']");
        if (currentLink && !originalFavicon) {
            originalFavicon = currentLink.getAttribute('href');
        }
        applyTabCloak();
    });

    window.applyTabCloak = applyTabCloak;
})();

// BGM Mock Interface for backward compatibility
window.BGMManager = {
    toggleMute: function() {},
    updateState: function() {},
    playNextTrack: function() {}
};

// =========================================================================
// IN-APP POPUP DIALOG ENGINE
// Replaces in-browser dialogs (alert, confirm, prompt) with formatted in-app modals.
// =========================================================================
(function() {
    function getDialogElements() {
        let overlay = document.getElementById('nexus-inapp-dialog-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'nexus-inapp-dialog-overlay';
            overlay.style.cssText = 'display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.86); z-index:999999; align-items:center; justify-content:center; backdrop-filter:blur(8px);';
            
            overlay.innerHTML = `
                <div style="background:var(--modal-bg, #18102b); padding:28px; border-radius:20px; width:460px; max-width:92vw; max-height:85vh; border:2px solid #2196F3; text-align:center; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 0 50px rgba(0,0,0,0.9); color:var(--text-color, #fff); font-family:'Space Grotesk', sans-serif;">
                    <div id="nexus-dialog-title" style="color:#2196F3; font-size:22px; font-weight:bold; margin-bottom:14px;">Nexus</div>
                    <div id="nexus-dialog-msg" style="font-size:15px; line-height:1.5; color:var(--text-color, #e2dcf0); margin-bottom:18px; white-space:pre-wrap; max-height:50vh; overflow-y:auto; word-break:break-word;"></div>
                    <input type="text" id="nexus-dialog-input" style="display:none; width:100%; padding:12px; margin-bottom:18px; box-sizing:border-box; border-radius:8px; border:1px solid var(--border-color, #362854); background:var(--input-bg, #0d0818); color:var(--text-color, #fff); font-size:15px; outline:none;">
                    <div style="display:flex; gap:12px; justify-content:center; margin-top:8px;">
                        <button id="nexus-dialog-ok" class="save-btn" style="background:#2196F3 !important; border:2.5px solid #ffffff !important; padding:10px 24px; border-radius:999px; font-weight:bold; color:white; cursor:pointer; flex:1; min-width:90px; text-shadow:none;">OK</button>
                        <button id="nexus-dialog-cancel" class="save-btn" style="background:rgba(255,255,255,0.1) !important; border:2.5px solid rgba(255,255,255,0.5) !important; padding:10px 24px; border-radius:999px; font-weight:bold; color:#ccc; cursor:pointer; flex:1; min-width:90px; text-shadow:none;">Cancel</button>
                    </div>
                </div>
            `;
            if (document.body) {
                document.body.appendChild(overlay);
            } else {
                window.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay));
            }
        }
        return {
            overlay: overlay,
            title: overlay.querySelector('#nexus-dialog-title'),
            msg: overlay.querySelector('#nexus-dialog-msg'),
            input: overlay.querySelector('#nexus-dialog-input'),
            okBtn: overlay.querySelector('#nexus-dialog-ok'),
            cancelBtn: overlay.querySelector('#nexus-dialog-cancel')
        };
    }

    function showDialog(options) {
        return new Promise((resolve) => {
            const els = getDialogElements();
            if (!els.overlay.parentNode) document.body.appendChild(els.overlay);
            
            els.title.textContent = options.title || 'Nexus';
            els.msg.textContent = options.message || '';
            
            if (options.isPrompt) {
                els.input.style.display = 'block';
                els.input.value = options.defaultValue || '';
            } else {
                els.input.style.display = 'none';
            }

            els.okBtn.style.display = 'inline-block';
            els.cancelBtn.style.display = 'inline-block';
            els.overlay.style.display = 'flex';
            
            if (options.isPrompt) {
                setTimeout(() => { els.input.focus(); els.input.select(); }, 50);
            } else {
                setTimeout(() => { els.okBtn.focus(); }, 50);
            }

            const cleanup = () => {
                els.overlay.style.display = 'none';
                els.okBtn.onclick = null;
                els.cancelBtn.onclick = null;
                document.removeEventListener('keydown', keyHandler);
            };

            const keyHandler = (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    cleanup();
                    resolve(options.isPrompt ? els.input.value : true);
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cleanup();
                    resolve(options.isPrompt ? null : false);
                }
            };

            document.addEventListener('keydown', keyHandler);

            els.okBtn.onclick = (e) => {
                e.preventDefault();
                cleanup();
                resolve(options.isPrompt ? els.input.value : true);
            };

            els.cancelBtn.onclick = (e) => {
                e.preventDefault();
                cleanup();
                resolve(options.isPrompt ? null : false);
            };
        });
    }

    window.nexusAlert = function(msg, title) {
        return showDialog({ message: String(msg), title: title || 'Nexus', isConfirm: false });
    };
    window.nexusConfirm = function(msg, title) {
        return showDialog({ message: String(msg), title: title || 'Nexus', isConfirm: true });
    };
    window.nexusPrompt = function(msg, defaultVal, title) {
        return showDialog({ message: String(msg), defaultValue: defaultVal, title: title || 'Nexus', isPrompt: true });
    };

    window.alert = function(msg) {
        window.nexusAlert(msg);
    };
    window.confirm = function(msg) {
        window.nexusConfirm(msg);
        return true;
    };
    window.prompt = function(msg, defaultVal) {
        window.nexusPrompt(msg, defaultVal);
        return null;
    };
})();
