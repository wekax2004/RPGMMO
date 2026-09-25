'use strict';

/**
 * Local account and session authentication.
 *
 * Passwords are hashed with scrypt and salted per account. The account file
 * is intentionally separate from character saves so credentials are never
 * serialized with player state. Replace this store with a database/identity
 * provider later without changing the WebSocket protocol.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = Number(process.env.TIBIA_SESSION_TTL_MS) > 0
    ? Number(process.env.TIBIA_SESSION_TTL_MS)
    : 24 * 60 * 60 * 1000;
const AUTH_REQUIRED = process.env.TIBIA_REQUIRE_AUTH === 'true' ||
    (process.env.TIBIA_REQUIRE_AUTH !== 'false' && process.env.TIBIA_TEST_MODE !== 'true');
const accountsFile = path.resolve(
    process.env.TIBIA_AUTH_FILE || path.join(__dirname, 'data', 'accounts.json')
);
const sessions = new Map();
let writeQueue = Promise.resolve();

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

async function readAccounts() {
    try {
        const raw = await fsp.readFile(accountsFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(`Invalid account database shape in ${accountsFile}`);
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT') return {};
        throw error;
    }
}

async function writeAccounts(accounts) {
    await fsp.mkdir(path.dirname(accountsFile), { recursive: true });
    const tempPath = `${accountsFile}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(accounts, null, 2), 'utf8');
    try {
        await fsp.rename(tempPath, accountsFile);
    } catch (error) {
        if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code)) {
            await fsp.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
        await fsp.copyFile(accountsFile, `${accountsFile}.previous`).catch(() => undefined);
        await fsp.rm(accountsFile, { force: true });
        await fsp.rename(tempPath, accountsFile);
    }
}

function enqueueWrite(operation) {
    const next = writeQueue.catch(() => undefined).then(operation);
    writeQueue = next;
    return next;
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
    const accounts = await readAccounts();
    if (Object.prototype.hasOwnProperty.call(accounts, validation.username)) {
        return { success: false, message: 'Username is already registered.' };
    }
    const account = {
        accountId: `acct_${crypto.randomBytes(12).toString('hex')}`,
        username: validation.username,
        passwordHash: await hashPassword(password),
        characters: [],
        createdAt: Date.now()
    };
    await enqueueWrite(async () => {
        const latest = await readAccounts();
        if (Object.prototype.hasOwnProperty.call(latest, validation.username)) {
            const conflict = new Error('Username is already registered.');
            conflict.code = 'ACCOUNT_EXISTS';
            throw conflict;
        }
        latest[validation.username] = account;
        await writeAccounts(latest);
    });
    return { success: true, account: publicAccount(account) };
}

async function authenticate(username, password) {
    const normalized = normalizeUsername(username);
    if (!normalized || typeof password !== 'string') return null;
    const accounts = await readAccounts();
    const account = Object.prototype.hasOwnProperty.call(accounts, normalized) ? accounts[normalized] : null;
    if (!account || !await verifyPassword(password, account.passwordHash)) return null;
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

async function bindCharacter(accountId, characterName) {
    if (!accountId || typeof characterName !== 'string') return false;
    const key = characterName.trim().toLowerCase();
    if (!key) return false;
    await enqueueWrite(async () => {
        const accounts = await readAccounts();
        const account = Object.values(accounts).find(candidate => candidate.accountId === accountId);
        if (!account) return;
        account.characters = Array.isArray(account.characters) ? account.characters : [];
        if (!account.characters.includes(key)) account.characters.push(key);
        await writeAccounts(accounts);
    });
    return true;
}

async function accountOwnsCharacter(accountId, characterName) {
    if (!accountId || typeof characterName !== 'string') return false;
    const accounts = await readAccounts();
    const account = Object.values(accounts).find(candidate => candidate.accountId === accountId);
    return Boolean(account && Array.isArray(account.characters) && account.characters.includes(characterName.trim().toLowerCase()));
}

async function flush() {
    await writeQueue;
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
