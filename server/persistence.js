'use strict';

/**
 * Persistence boundary for the game server.
 *
 * Local JSON storage is the default so development and tests do not depend on
 * a browser Firebase configuration. Set TIBIA_DB_DRIVER=firebase to use the
 * optional Firestore adapter. All adapters expose the same small async API.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const requestedDriver = String(process.env.TIBIA_DB_DRIVER || 'local').toLowerCase();
if (!['local', 'firebase'].includes(requestedDriver)) {
    throw new Error(`Unsupported TIBIA_DB_DRIVER '${requestedDriver}'. Use 'local' or 'firebase'.`);
}
const localFile = path.resolve(
    process.env.TIBIA_DB_FILE || path.join(__dirname, 'data', 'players.json')
);
const writeQueues = new Map();
let globalWriteQueue = Promise.resolve();

function cloneData(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
}

function assertPlayerName(charName) {
    if (typeof charName !== 'string' || charName.trim().length === 0) {
        throw new TypeError('Player name must be a non-empty string.');
    }
    return charName.trim();
}

function playerKey(charName) {
    return assertPlayerName(charName).toLowerCase();
}

function enqueueWrite(charName, operation) {
    // Serialize the whole file, not only writes for one character. Otherwise
    // two different players can read the same snapshot and the second write
    // can erase the first player's state.
    const next = globalWriteQueue.catch(() => undefined).then(operation);
    globalWriteQueue = next;
    writeQueues.set(charName, next);

    const cleanup = () => {
        if (writeQueues.get(charName) === next) writeQueues.delete(charName);
    };
    next.then(cleanup, cleanup);
    return next;
}

async function readLocalStore() {
    try {
        const raw = await fsp.readFile(localFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Invalid player database shape in ${localFile}`);
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        if (error instanceof SyntaxError) {
            const backupPath = `${localFile}.corrupt-${Date.now()}`;
            await fsp.copyFile(localFile, backupPath).catch(() => undefined);
            const recoveryError = new Error(`Corrupt player database; a copy was preserved at ${backupPath}`);
            recoveryError.code = 'PERSISTENCE_CORRUPT';
            recoveryError.cause = error;
            throw recoveryError;
        }
        throw error;
    }
}

async function atomicWriteJson(filePath, value) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
    const tempHandle = await fsp.open(tempPath, 'r+');
    try {
        await tempHandle.sync();
    } finally {
        await tempHandle.close();
    }

    try {
        await fsp.rename(tempPath, filePath);
    } catch (error) {
        // Some Windows filesystems reject replacing an existing file with
        // rename(). Keep the normal path atomic and use a best-effort fallback.
        if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
            await fsp.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
        const backupPath = `${filePath}.previous`;
        await fsp.copyFile(filePath, backupPath).catch(() => undefined);
        await fsp.rm(filePath, { force: true });
        await fsp.rename(tempPath, filePath);
    }
}

const localStore = {
    driver: 'local',
    file: localFile,

    async loadPlayer(charName) {
        const name = assertPlayerName(charName);
        const key = playerKey(name);
        const players = await readLocalStore();
        const record = Object.prototype.hasOwnProperty.call(players, key)
            ? players[key]
            : players[name];
        return cloneData(record || null);
    },

    savePlayer(charName, playerData) {
        const name = assertPlayerName(charName);
        const key = playerKey(name);
        const snapshot = cloneData(playerData);
        if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
            throw new TypeError('Player data must be an object.');
        }

        return enqueueWrite(name, async () => {
            const players = await readLocalStore();
            players[key] = snapshot;
            if (key !== name) delete players[name];
            await atomicWriteJson(localFile, players);
        });
    }
};

function createFirebaseStore() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
        throw new Error('FIREBASE_PROJECT_ID is required when TIBIA_DB_DRIVER=firebase.');
    }

    // Load lazily: the default local adapter must not require Firebase.
    const { getApp, getApps, initializeApp } = require('firebase/app');
    const { doc, getDoc, getFirestore, setDoc } = require('firebase/firestore');
    const app = getApps().length > 0 ? getApp() : initializeApp({
        apiKey: process.env.FIREBASE_API_KEY,
        authDomain: process.env.FIREBASE_AUTH_DOMAIN,
        projectId,
        appId: process.env.FIREBASE_APP_ID
    });
    const db = getFirestore(app);

    return {
        driver: 'firebase',

        async loadPlayer(charName) {
            const name = assertPlayerName(charName);
            const snapshot = await getDoc(doc(db, 'players', playerKey(name)));
            return snapshot.exists() ? cloneData(snapshot.data()) : null;
        },

        async savePlayer(charName, playerData) {
            const name = assertPlayerName(charName);
            const snapshot = cloneData(playerData);
            await setDoc(doc(db, 'players', playerKey(name)), snapshot);
        }
    };
}

let store;
if (requestedDriver === 'firebase') {
    try {
        store = createFirebaseStore();
        console.warn('[persistence] Using Firebase Firestore adapter.');
    } catch (error) {
        if (process.env.TIBIA_DB_ALLOW_LOCAL_FALLBACK !== 'true') throw error;
        store = localStore;
        console.warn(`[persistence] Firebase unavailable; explicitly falling back to local storage: ${error.message}`);
    }
} else {
    store = localStore;
}

async function loadPlayer(charName) {
    return store.loadPlayer(charName);
}

function savePlayer(charName, playerData) {
    if (store.driver === 'firebase') {
        const name = assertPlayerName(charName);
        const snapshot = cloneData(playerData);
        return enqueueWrite(name, () => store.savePlayer(name, snapshot));
    }
    return store.savePlayer(charName, playerData);
}

async function flush() {
    const pending = Array.from(writeQueues.values());
    if (pending.length > 0) await Promise.all(pending);
}

module.exports = {
    driver: store.driver,
    file: store.file,
    loadPlayer,
    savePlayer,
    flush,
    close: flush
};
