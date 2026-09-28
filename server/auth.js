'use strict';

/**
 * Account and session authentication.
 *
 * Passwords are hashed with scrypt and salted per account. Accounts live in
 * the same SQLite database as character state but in a separate table, so
 * credentials are never serialized together with a player's inventory or
 * quests. Sessions are held in memory: a restart invalidates them, which is
 * the safe default.
 */

const crypto = require('crypto');
const DB = require('./database');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = Number(process.env.TIBIA_SESSION_TTL_MS) > 0
    ? Number(process.env.TIBIA_SESSION_TTL_MS)
    : 24 * 60 * 60 * 1000;
const AUTH_REQUIRED = process.env.TIBIA_REQUIRE_AUTH === 'true' ||
    (process.env.TIBIA_REQUIRE_AUTH !== 'false' && process.env.TIBIA_TEST_MODE !== 'true');
const sessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions.entries()) {
        if (session.expiresAt <= now) {
            sessions.delete(token);
        }
    }
}, 60 * 60 * 1000).unref();

// A real scrypt hash of an unguessable value. Used to spend the same CPU on a
// login for an unknown username as on a wrong password, so response time does
// not reveal whether an account exists.
const DUMMY_HASH = [
    'scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P,
    '00000000000000000000000000000000',
    'f'.repeat(SCRYPT_KEYLEN * 2)
].join('$');

function normalizeUsername(username) {
    return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

function validateCredentials(username, password) {
    const normalized = normalizeUsername(username);
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(normalized)) {
        return { ok: false, message: 'Username must be 3-32 letters, numbers, dots, dashes, or underscores.' };
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return { ok: false, message: 'Password must be between 8 and 128 characters.' };
    }
    return { ok: true, username: normalized };
}

function deriveKey(password, salt, options = {}) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, options.keylen || SCRYPT_KEYLEN, {
            N: options.N || SCRYPT_N,
            r: options.r || SCRYPT_R,
            p: options.p || SCRYPT_P
        }, (error, key) => {
            if (error) reject(error);
            else resolve(key);
        });
    });
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const key = await deriveKey(password, salt);
    return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), key.toString('hex')].join('$');
}

async function verifyPassword(password, encoded) {
    if (typeof encoded !== 'string') return false;
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltHex, keyHex] = parts;
    const expected = Buffer.from(keyHex, 'hex');
    const actual = await deriveKey(password, Buffer.from(saltHex, 'hex'), {
        N: Number(n), r: Number(r), p: Number(p), keylen: expected.length
    });
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function publicAccount(account) {
    if (!account) return null;
    return {
        accountId: account.accountId,
        username: account.username,
        characters: Array.isArray(account.characters) ? account.characters : []
    };
}

async function register(username, password) {
    const validation = validateCredentials(username, password);
    if (!validation.ok) return { success: false, message: validation.message };

    const existing = await DB.getAccountByUsername(validation.username);
    if (existing) return { success: false, message: 'Username is already registered.' };

    const account = {
        accountId: `acct_${crypto.randomBytes(12).toString('hex')}`,
        username: validation.username,
        passwordHash: await hashPassword(password),
        characters: [],
        createdAt: Date.now()
    };

    try {
        // UNIQUE(username) is the real guard. Two concurrent registrations of
        // the same name both pass the check above; only one INSERT can win.
        await DB.insertAccount(account);
    } catch (error) {
        if (String(error && error.message || '').includes('UNIQUE')) {
            return { success: false, message: 'Username is already registered.' };
        }
        throw error;
    }
    return { success: true, account: publicAccount(account) };
}

async function authenticate(username, password) {
    const normalized = normalizeUsername(username);
    if (!normalized || typeof password !== 'string') return null;

    const account = await DB.getAccountByUsername(normalized);
    if (!account) {
        // Run a hash against a throwaway account so a missing username costs
        // the same wall-clock time as a wrong password. Without this the
        // response time is a reliable oracle for which usernames exist.
        await verifyPassword(password, DUMMY_HASH);
        return null;
    }
    if (!await verifyPassword(password, account.passwordHash)) return null;
    return publicAccount(account);
}

function createSession(accountId) {
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { accountId, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, expiresAt: Date.now() + SESSION_TTL_MS };
}

function validateSession(token) {
    if (typeof token !== 'string' || token.length < 20) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
    }
    return { accountId: session.accountId, expiresAt: session.expiresAt };
}

function revokeSession(token) {
    return sessions.delete(token);
}

function normalizeCharacterKey(characterName) {
    return typeof characterName === 'string' ? characterName.trim().toLowerCase() : '';
}

async function findAccountById(accountId) {
    return await DB.getAccountById(accountId);
}

async function bindCharacter(accountId, characterName) {
    if (!accountId) return false;
    const key = normalizeCharacterKey(characterName);
    if (!key) return false;
    const account = await findAccountById(accountId);
    // No matching account means there is nothing to bind to.
    if (!account) return false;
    try {
        return await DB.addCharacterToAccount(accountId, key);
    } catch (e) {
        console.error("bindCharacter failed:", e);
        return false;
    }
}

async function accountOwnsCharacter(accountId, characterName) {
    if (!accountId) return false;
    const key = normalizeCharacterKey(characterName);
    if (!key) return false;
    const account = await findAccountById(accountId);
    return Boolean(account && account.characters.includes(key));
}

async function flush() {
    await DB.flush();
}

module.exports = {
    required: AUTH_REQUIRED,
    sessionTtlMs: SESSION_TTL_MS,
    register,
    authenticate,
    createSession,
    validateSession,
    revokeSession,
    bindCharacter,
    accountOwnsCharacter,
    flush
};
