// nexus-version: 4.28.4
/* One SharedWorker instance owns presence for all Nexus tabs in this browser. */
'use strict';

const TOPIC_ROOT = 'nexus-presence-v1/online/';
// Presence changes slowly, so one minute is enough for fresh counts and avoids
// unnecessary background publishes while a game is running.
const HEARTBEAT_MS = 60000;
const STALE_AFTER_MS = 180000;
const PEER_SWEEP_MS = 30000;
const browserSessionId = 'nx-' + randomId();
const presenceTopic = TOPIC_ROOT + browserSessionId;
const ports = new Set();
const portGameStates = new Map();
const peers = new Map();
let enabled = false;
let activeGame = false;
let keepCountedWhilePlaying = true;
let mqttLibraryLoading = false;
let mqttUnavailable = false;
let mqttClient = null;
let heartbeatTimer = null;
let sweepTimer = null;
let idleStopTimer = null;

function randomId() {
    try {
        const bytes = new Uint8Array(10);
        crypto.getRandomValues(bytes);
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 18);
    } catch (_) {
        return Math.random().toString(36).slice(2, 17);
    }
}

function broadcast(message) {
    for (const port of ports) {
        try { port.postMessage(message); } catch (_) { ports.delete(port); }
    }
}

function broadcastCount() {
    broadcast({ type: 'count', count: peers.size });
}

function loadMqtt() {
    if (!enabled || mqttClient || mqttLibraryLoading || mqttUnavailable) return;
    mqttLibraryLoading = true;
    try {
        importScripts('https://unpkg.com/mqtt@4.3.7/dist/mqtt.min.js');
        if (self.mqtt && typeof self.mqtt.connect === 'function') {
            mqttLibraryLoading = false;
            connect();
            return;
        }
    } catch (_) {}

    try {
        importScripts('https://cdnjs.cloudflare.com/ajax/libs/mqtt/4.3.7/mqtt.min.js');
        if (self.mqtt && typeof self.mqtt.connect === 'function') {
            mqttLibraryLoading = false;
            connect();
            return;
        }
    } catch (_) {}

    mqttLibraryLoading = false;
    mqttUnavailable = true;
    broadcast({ type: 'unavailable' });
}

function connect() {
    if (!enabled || !self.mqtt || mqttClient) return;
    try {
        mqttClient = self.mqtt.connect('wss://broker.emqx.io:8084/mqtt', {
            clientId: browserSessionId,
            keepalive: 90,
            connectTimeout: 10000,
            reconnectPeriod: 5000,
            clean: true,
            will: {
                topic: presenceTopic,
                payload: JSON.stringify({ online: false }),
                qos: 1,
                retain: true
            }
        });
    } catch (_) {
        mqttClient = null;
        broadcast({ type: 'unavailable' });
        return;
    }

    mqttClient.on('connect', () => {
        if (!enabled || !mqttClient) return;
        mqttClient.subscribe(TOPIC_ROOT + '+', { qos: 1 }, error => {
            if (error || !enabled || !mqttClient) return;
            updatePresenceMode();
            clearInterval(sweepTimer);
            sweepTimer = setInterval(removeStalePeers, PEER_SWEEP_MS);
        });
    });

    mqttClient.on('message', (messageTopic, payload) => {
        let presence;
        try { presence = JSON.parse(payload.toString()); } catch (_) { return; }
        if (presence.online !== true) {
            peers.delete(messageTopic);
            if (messageTopic !== presenceTopic) clearRetained(messageTopic);
            broadcastCount();
            return;
        }
        const lastSeen = Number(presence.lastSeen);
        if (!Number.isFinite(lastSeen)) return;
        const keepAlive = presence.keepAlive === true;
        if (!keepAlive && Date.now() - lastSeen > STALE_AFTER_MS) {
            peers.delete(messageTopic);
            clearRetained(messageTopic);
        } else {
            peers.set(messageTopic, { lastSeen, keepAlive });
        }
        broadcastCount();
    });

    mqttClient.on('close', () => {
        if (!enabled) return;
        broadcast({ type: 'unavailable' });
    });
}

function publishPresence() {
    if (!enabled || !mqttClient || !mqttClient.connected) return;
    const lastSeen = Date.now();
    const keepAlive = activeGame && keepCountedWhilePlaying;
    peers.set(presenceTopic, { lastSeen, keepAlive });
    mqttClient.publish(presenceTopic, JSON.stringify({ online: true, lastSeen, keepAlive }), { qos: 1, retain: true });
    broadcastCount();
}

function updatePresenceMode() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (!enabled || !mqttClient || !mqttClient.connected) return;
    publishPresence();
    if (!(activeGame && keepCountedWhilePlaying)) {
        heartbeatTimer = setInterval(publishPresence, HEARTBEAT_MS);
    }
}

function updateGameStateForPort(port, gameState) {
    portGameStates.set(port, {
        active: !!gameState.active,
        keepCounted: gameState.keepCounted !== false
    });
    activeGame = Array.from(portGameStates.values()).some(state => state.active);
    keepCountedWhilePlaying = Array.from(portGameStates.values()).every(state => state.keepCounted);
    updatePresenceMode();
}

function clearRetained(topic) {
    if (mqttClient && mqttClient.connected) mqttClient.publish(topic, '', { qos: 1, retain: true });
}

function removeStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [topic, peer] of peers) {
        if (!peer.keepAlive && now - peer.lastSeen > STALE_AFTER_MS) {
            peers.delete(topic);
            clearRetained(topic);
            changed = true;
        }
    }
    if (changed) broadcastCount();
}

function setEnabled(nextEnabled) {
    enabled = !!nextEnabled;
    if (enabled) {
        clearTimeout(idleStopTimer);
        idleStopTimer = null;
        broadcast({ type: 'loading' });
        if (mqttUnavailable) {
            mqttUnavailable = false;
            mqttLibraryLoading = false;
        }
        if (mqttClient) return;
        if (self.mqtt && typeof self.mqtt.connect === 'function') connect();
        else loadMqtt();
        return;
    }

    clearInterval(heartbeatTimer);
    clearInterval(sweepTimer);
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
    heartbeatTimer = null;
    sweepTimer = null;
    peers.clear();
    if (mqttClient) {
        const client = mqttClient;
        mqttClient = null;
        try {
            if (client.connected) client.publish(presenceTopic, '', { qos: 1, retain: true });
            client.end(false, {}, () => {});
        } catch (_) {
            try { client.end(true); } catch (_) {}
        }
    }
    broadcast({ type: 'disabled' });
}

self.onconnect = event => {
    const port = event.ports[0];
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
    ports.add(port);
    portGameStates.set(port, { active: false, keepCounted: true });
    port.onmessage = messageEvent => {
        const message = messageEvent.data || {};
        if (message.type === 'set-enabled') setEnabled(message.enabled);
        if (message.type === 'set-game-state') updateGameStateForPort(port, message);
        if (message.type === 'release') {
            ports.delete(port);
            portGameStates.delete(port);
            activeGame = Array.from(portGameStates.values()).some(state => state.active);
            keepCountedWhilePlaying = Array.from(portGameStates.values()).every(state => state.keepCounted);
            updatePresenceMode();
            if (ports.size === 0 && enabled) {
                idleStopTimer = setTimeout(() => {
                    if (ports.size === 0) setEnabled(false);
                }, 15000);
            }
        }
    };
    port.start();
    port.postMessage(enabled ? { type: 'loading' } : { type: 'disabled' });
};
