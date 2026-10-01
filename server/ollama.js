/*
 * server/ollama.js
 *
 * Client for the local Ollama server. Every request here is to 127.0.0.1, so the
 * cost lands on this machine rather than a remote service, which makes it easier
 * to overlook and no less real: an inference on a 26B model saturates the CPU or
 * GPU and the game server shares them.
 *
 * Four limits, all added together because each closes a different hole:
 *
 *   1. A timeout. There was none, so a request against an Ollama that never
 *      answered left its promise unsettled forever -- the closure, the partial
 *      response buffer and the socket all stayed resident. Repeated /ask against a
 *      hung server was an unbounded memory leak, not just a slow response.
 *
 *   2. A concurrency cap. Without one, N prompts become N simultaneous
 *      inferences. Ollama queues them, so the server stays responsive, but the
 *      queue is unbounded and every queued prompt is a prompt that will eventually
 *      be paid for.
 *
 *   3. A prompt length cap. The inbound packet limit is 16 KB, and 16 KB of
 *      prompt is an enormous prefill -- minutes of compute for one player.
 *
 *   4. A response size cap. The response was accumulated with `body += chunk`
 *      and never bounded, so a runaway generation grew the heap until it died.
 *
 * The model list is cached. getAvailableModel() was an HTTP GET on every single
 * call, so each prompt cost two round trips, one of them pure overhead.
 */
const http = require('http');

const HOST = process.env.TIBIA_OLLAMA_HOST || '127.0.0.1';
const PORT = Number(process.env.TIBIA_OLLAMA_PORT) || 11434;
const FALLBACK_MODEL = 'gemma4:26b';

// A prompt longer than this is a prefill long enough to matter. 2000 characters
// is a couple of paragraphs, far more than the in-game questions ask for.
const MAX_PROMPT_CHARS = Number(process.env.TIBIA_OLLAMA_MAX_PROMPT) || 2000;

// How long a single generation may take before it is abandoned. Ollama on a large
// model can legitimately take a while for a long answer, so this is generous.
const REQUEST_TIMEOUT_MS = Number(process.env.TIBIA_OLLAMA_TIMEOUT_MS) || 45_000;

// Simultaneous generations allowed. One is usually enough for a single-player
// shard; the cap exists so a flood cannot become a queue.
const MAX_CONCURRENT = Number(process.env.TIBIA_OLLAMA_MAX_CONCURRENT) || 2;

// Bound on the response we will buffer, in bytes.
const MAX_RESPONSE_BYTES = Number(process.env.TIBIA_OLLAMA_MAX_RESPONSE) || 256 * 1024;

// Where the model list is read from at start-up. Fetching it per call doubled the
// round trips for every prompt.
let cachedModel = null;

/**
 * @returns {Promise<{ok: true, value: string} | {ok: false, reason: string}>}
 *
 * Resolves rather than rejects on every failure path, because a rejected promise
 * reaching the chat handler produced an "Ollama is unavailable: ..." message that
 * named the raw socket error. These reasons read as player-facing text.
 */
function generateOllamaResponse(prompt) {
    return new Promise((resolve) => {
        if (typeof prompt !== 'string' || !prompt.trim()) {
            return resolve({ ok: false, reason: 'Ask a question first.' });
        }
        if (prompt.length > MAX_PROMPT_CHARS) {
            return resolve({
                ok: false,
                reason: `That question is too long (${prompt.length} characters, limit ${MAX_PROMPT_CHARS}).`
            });
        }
        if (inFlight >= MAX_CONCURRENT) {
            // Refused here rather than queued. Queueing is how a flood becomes a
            // backlog that keeps burning after the attacker stops.
            return resolve({ ok: false, reason: 'Gemma is busy. Try again in a moment.' });
        }
        inFlight += 1;

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            inFlight -= 1;
            if (req) req.destroy();
            resolve(result);
        };

        const postData = JSON.stringify({
            model: cachedModel || FALLBACK_MODEL,
            prompt,
            stream: false
        });

        const req = http.request({
            hostname: HOST,
            port: PORT,
            path: '/api/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let body = '';
            let overflowed = false;
            res.on('data', (chunk) => {
                if (overflowed) return;
                body += chunk;
                if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
                    overflowed = true;
                    finish({ ok: false, reason: 'Gemma rambled. Ask something shorter.' });
                }
            });
            res.on('end', () => {
                if (overflowed) return;
                if (res.statusCode !== 200) {
                    return finish({ ok: false, reason: `Gemma is unavailable (${res.statusCode}).` });
                }
                try {
                    finish({ ok: true, value: JSON.parse(body).response });
                } catch (e) {
                    finish({ ok: false, reason: 'Gemma sent back something unreadable.' });
                }
            });
        });

        // The timeout is the important one. Without it a server that accepts the
        // connection and never answers leaves this promise pending forever.
        req.setTimeout(REQUEST_TIMEOUT_MS, () => {
            finish({ ok: false, reason: 'Gemma took too long. Try again.' });
        });
        req.on('error', () => finish({ ok: false, reason: 'Gemma is not running.' }));

        req.write(postData);
        req.end();
    });
}

let inFlight = 0;

/**
 * Resolve the model name once and remember it.
 *
 * Called at start-up and on demand; never per prompt. The previous code fetched
 * it inside generateOllamaResponse, so every question paid for a /api/tags round
 * trip before the real request went out.
 */
function getAvailableModel() {
    return new Promise((resolve) => {
        if (cachedModel) return resolve(cachedModel);
        const req = http.get(`http://${HOST}:${PORT}/api/tags`, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(body);
                    const models = (parsed.models || []).map(m => m.name).filter(Boolean);
                    if (models.length === 0) return resolve(null);
                    // Prefer a small model: this runs on the same box as the game
                    // server, so the smallest adequate one is the right default.
                    const small = models.find(n => /\b(1|2|3|7|8)b\b/i.test(n)) || models[0];
                    cachedModel = small;
                    resolve(cachedModel);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.setTimeout(5000, () => req.destroy());
        req.on('error', () => resolve(null));
    });
}

/** Test seam: how many generations are running right now. */
function inFlightCount() { return inFlight; }

/** Test seam: drop the cached model so the next call re-resolves it. */
function resetCache() { cachedModel = null; }

module.exports = {
    generateOllamaResponse,
    getAvailableModel,
    inFlightCount,
    resetCache,
    limits: { MAX_PROMPT_CHARS, REQUEST_TIMEOUT_MS, MAX_CONCURRENT, MAX_RESPONSE_BYTES }
};