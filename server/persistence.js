'use strict';

/**
 * Persistence boundary for the game server.
 *
 * Character state lives in SQLite (see database.js). Player data is
 * serialized to JSON before it reaches the database so a snapshot is written
 * atomically as one row, and the player object handed in by the caller is
 * never retained or mutated.
 *
 * TIBIA_DB_DRIVER=firebase keeps the optional Firestore adapter for a hosted
 * deployment. All adapters expose the same small async API.
 */

const DB = require('./database');

// 'local' was the old name for the default file-backed driver. It is
// accepted and mapped to sqlite so existing configurations and the test
// harness keep working unchanged.
const requestedDriver = String(process.env.TIBIA_DB_DRIVER || 'sqlite').toLowerCase() === 'local'
    ? 'sqlite'
    : String(process.env.TIBIA_DB_DRIVER || 'sqlite').toLowerCase();
if (!['sqlite', 'firebase'].includes(requestedDriver)) {
    throw new Error(`Unsupported TIBIA_DB_DRIVER '${requestedDriver}'. Use 'sqlite' (or its former name 'local') or 'firebase'.`);
}

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

function enqueueWrite(charName, operation) {
    const next = globalWriteQueue.catch(() => undefined).then(operation);
    globalWriteQueue = next;
    writeQueues.set(charName, next);

    const cleanup = () => {
        if (writeQueues.get(charName) === next) writeQueues.delete(charName);
    };
    next.then(cleanup, cleanup);
    return next;
}

const sqliteStore = {
    driver: 'sqlite',
    file: DB.file,

    async loadPlayer(charName) {
        const name = assertPlayerName(charName);
        const record = await DB.loadPlayer(name);
        return cloneData(record || null);
    },

    savePlayer(charName, playerData) {
        const name = assertPlayerName(charName);
        if (!playerData || typeof playerData !== 'object' || Array.isArray(playerData)) {
            return Promise.reject(new TypeError('Player data must be an object.'));
        }
        // Snapshot now, at the call site, so later mutations of the live
        // player object cannot change what this write commits.
        const snapshot = cloneData(playerData);
        return enqueueWrite(name, () => DB.savePlayer(name, snapshot));
    }
};

function createFirebaseStore() {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    if (!projectId) {
        throw new Error('FIREBASE_PROJECT_ID is required when TIBIA_DB_DRIVER=firebase.');
    }

    // Load lazily: the default SQLite adapter must not require Firebase.
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
            const snapshot = await getDoc(doc(db, 'players', name.toLowerCase()));
            return snapshot.exists() ? cloneData(snapshot.data()) : null;
        },

        async savePlayer(charName, playerData) {
            const name = assertPlayerName(charName);
            const snapshot = cloneData(playerData);
            await setDoc(doc(db, 'players', name.toLowerCase()), snapshot);
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
        store = sqliteStore;
        console.warn(`[persistence] Firebase unavailable; explicitly falling back to SQLite: ${error.message}`);
    }
} else {
    store = sqliteStore;
}

// Open the schema eagerly so a bad file surfaces at boot rather than on the
// first player save.
const ready = requestedDriver === 'sqlite' ? DB.initialize() : Promise.resolve();

async function loadPlayer(charName) {
    await ready;
    return store.loadPlayer(charName);
}

function savePlayer(charName, playerData) {
    if (!playerData || typeof playerData !== 'object' || Array.isArray(playerData)) {
        return Promise.reject(new TypeError('Player data must be an object.'));
    }
    const snapshot = cloneData(playerData);
    return ready.then(() => store.savePlayer(charName, snapshot));
}

async function flush() {
    await ready;
    if (store.driver === 'sqlite') await DB.flush();
    const pending = Array.from(writeQueues.values());
    if (pending.length > 0) await Promise.all(pending);
}

async function getLeaderboard(limit = 100) {
    await ready;
    if (store.driver === 'sqlite') return DB.getLeaderboard(limit);
    return []; // Firebase fallback not implemented
}

// Drains writes and then closes the underlying connection, so the SQLite
// file and its WAL can be released. Callers that only want the writes to land
// should use flush().
async function close() {
    await flush();
    if (store.driver === 'sqlite') await DB.close();
}

module.exports = {
    driver: store.driver,
    file: store.file,
    loadPlayer,
    savePlayer,
    getLeaderboard,
    flush,
    close
};
