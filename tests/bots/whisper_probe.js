/*
 * tests/bots/whisper_probe.js
 *
 * Drives whispering over real sockets (roadmap 6.1).
 *
 * The unit tests cover parsing, refusal and privacy with a stub context. This covers
 * the part a stub cannot: that /w typed into the client's own chat path actually
 * reaches the server, that it lands on the intended recipient and nobody else, and
 * that the whisper never appears on the global channel where every other bot can see
 * it.
 *
 * The privacy check is the one that matters. A whisper that is also broadcast looks
 * correct in every other respect -- the recipient gets it, the sender gets the echo,
 * the chat log shows a message -- so a unit test that only asserts "the recipient
 * received it" would pass while the feature leaked. Here a bystander is connected
 * the whole time and must never see the text.
 *
 * Run: node tests/bots/whisper_probe.js --port=8142
 */

const BotClient = (() => {
    try { return require('./bot_client'); } catch (e) { return require('./bot_client.js'); }
})();

function readPort(argv) {
    const eq = argv.find(a => a.startsWith('--port='));
    if (eq) return Number(eq.split('=')[1]);
    const i = argv.indexOf('--port');
    if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
    return 8142;
}

const PORT = readPort(process.argv.slice(2));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '\n          ' + detail : ''}`);
    if (!ok) failures++;
}

/** Records every chat packet a bot receives. */
function watch(bot) {
    const seen = [];
    const sock = bot.ws;
    const handle = (raw) => {
        let p;
        try { p = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
        if (p.action === 'chat' || p.action === 'log') seen.push(p);
    };
    // Both subscription styles: bot_client.js resolves Node's global WHATWG
    // WebSocket when it exists, which has addEventListener and no .on().
    if (typeof sock.addEventListener === 'function') sock.addEventListener('message', e => handle(e.data));
    else if (typeof sock.on === 'function') sock.on('message', d => handle(d));
    return seen;
}

const chats = (seen) => seen.filter(p => p.action === 'chat');
const texts = (seen) => chats(seen).map(p => p.text);

async function main() {
    console.log(`=== whisper probe (port ${PORT}) ===\n`);

    const tag = Math.random().toString(36).slice(2, 7);
    const mk = async (n) => {
        const bot = new BotClient({ name: `Wh${n}_${tag}` });
        await bot.connect(`ws://localhost:${PORT}`, 10000);
        await bot.login(bot.charName, 'warrior', false, 20000);
        await sleep(200);
        return bot;
    };

    const alice = await mk('Alice');
    const bob = await mk('Bob');
    const eve = await mk('Eve');
    const aliceLog = watch(alice), bobLog = watch(bob), eveLog = watch(eve);
    await sleep(800);

    const SECRET = 'thepasswordishunter2';

    // The full character name, not a short handle. The first run of this probe
    // whispered to "Bob" while the character was registered as "WhBob_xxxxx", so
    // every delivery check failed against a server that was correctly reporting
    // that nobody was called Bob. The bystander checks passed at the same time, for
    // the same reason -- nothing was sent anywhere -- which is how a probe can look
    // like it passed a privacy check while proving nothing at all.
    const BOB = bob.charName;

    // --- delivered to the recipient --------------------------------------
    aliceLog.length = 0; bobLog.length = 0; eveLog.length = 0;
    alice.send({ action: 'chat', text: `/w ${BOB} ${SECRET}` });
    await sleep(700);

    const bobGot = chats(bobLog).filter(c => c.channel === 'whisper' && c.text === SECRET);
    check('the named recipient receives the whisper', bobGot.length === 1,
        bobGot.length ? `from ${bobGot[0].sender}, target ${bobGot[0].target}` : `saw ${JSON.stringify(texts(bobLog))}`);

    check('the whisper carries the sender and the target name',
        bobGot.length === 1 && bobGot[0].sender === alice.charName && bobGot[0].target === bob.charName,
        bobGot.length ? `sender=${bobGot[0].sender} target=${bobGot[0].target}` : 'nothing received');

    // A bystander check that passes because nothing was delivered is worse than no
    // check, because it reads as a pass. Require that the whisper really was in
    // flight before concluding it was not visible to Eve.
    check('the whisper really was in flight before the bystander is consulted',
        bobGot.length === 1,
        bobGot.length === 1 ? 'Bob received it, so Eve not receiving it means something'
            : 'Eve saw nothing, but so did Bob -- this proves nothing');

    const aliceEcho = chats(aliceLog).filter(c => c.channel === 'whisper' && c.text === SECRET);
    check('the sender sees their own message back', aliceEcho.length === 1,
        aliceEcho.length ? `outbound=${aliceEcho[0].outbound}` : `saw ${JSON.stringify(texts(aliceLog))}`);

    check('the sender echo is marked outbound',
        aliceEcho.length === 1 && aliceEcho[0].outbound === true,
        aliceEcho.length ? `outbound=${aliceEcho[0].outbound}` : 'no echo');

    // --- and to nobody else. This is the one that matters. ---------------
    const eveSaw = texts(eveLog).filter(t => t.includes(SECRET));
    check('A BYSTANDER NEVER SEES THE WHISPER', eveSaw.length === 0,
        eveSaw.length ? `LEAKED to Eve: ${JSON.stringify(eveSaw)}`
            : `Eve saw ${texts(eveLog).length} chat line(s), none of them the whisper`);

    check('the whisper did not go out on the global channel',
        !chats(eveLog).some(c => c.channel === 'global'),
        `Eve's channels: ${JSON.stringify(chats(eveLog).map(c => c.channel))}`);

    // --- ordinary chat still works, and is still global -------------------
    // Plain text, not "/z ...". The server does not strip slash prefixes; the
    // client does, before sending. Sending "/z hello" to the server directly asserts
    // behaviour the server was never meant to have, and the first run of this probe
    // failed on exactly that.
    aliceLog.length = 0; eveLog.length = 0;
    alice.send({ action: 'chat', text: 'everyone can hear this', channel: 'zone' });
    await sleep(600);
    check('ordinary chat is unaffected', texts(eveLog).includes('everyone can hear this'),
        `Eve saw ${JSON.stringify(texts(eveLog))}`);

    // A whisper must still be private with ordinary traffic on the same channel.
    aliceLog.length = 0; bobLog.length = 0; eveLog.length = 0;
    alice.send({ action: 'chat', text: 'public chatter', channel: 'zone' });
    await sleep(300);
    alice.send({ action: 'chat', text: `/w ${BOB} ${SECRET}` });
    await sleep(700);
    check('a whisper stays private while zone chat is flowing',
        texts(eveLog).includes('public chatter') &&
        !texts(eveLog).some(t => t.includes(SECRET)),
        `Eve saw ${JSON.stringify(texts(eveLog))}`);

    // --- refusals ---------------------------------------------------------
    aliceLog.length = 0;
    alice.send({ action: 'chat', text: '/w NoSuchPerson hello' });
    await sleep(600);
    const notFound = aliceLog.filter(p => p.action === 'log' && /Nobody online/.test(p.message || ''));
    check('an offline target is reported to the sender only', notFound.length === 1,
        notFound.length ? notFound[0].message : `Alice saw ${JSON.stringify(aliceLog.map(p => p.message || p.text))}`);

    check('the offline report does not reveal whether the character exists',
        !notFound.some(p => /exist|unknown|never/i.test(p.message || '')),
        notFound.length ? notFound[0].message : 'no message');

    aliceLog.length = 0; bobLog.length = 0;
    alice.send({ action: 'chat', text: `/w ${alice.charName} talking to myself` });
    await sleep(600);
    const selfAttempt = chats(bobLog).filter(c => c.text === 'talking to myself');
    check('whispering yourself sends nothing', selfAttempt.length === 0,
        selfAttempt.length ? `Bob received ${JSON.stringify(selfAttempt.map(c => c.text))}`
            : 'Bob received nothing');
    check('and tells the sender so',
        aliceLog.some(p => p.action === 'log' && /cannot whisper yourself/i.test(p.message || '')),
        aliceLog.map(p => p.message || p.text).join(' | ') || 'nothing');

    // --- /wave must not be eaten -------------------------------------------
    aliceLog.length = 0; eveLog.length = 0;
    alice.send({ action: 'chat', text: '/wave at everyone' });
    await sleep(600);
    check('a line starting with /wave is not treated as a whisper',
        !chats(eveLog).some(c => c.channel === 'whisper'),
        `Eve saw channels ${JSON.stringify(chats(eveLog).map(c => c.channel))}`);

    for (const b of [alice, bob, eve]) b.disconnect();
    console.log(`\n  ${failures === 0 ? 'all checks passed' : failures + ' check(s) FAILED'}`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
    console.error('  probe could not run:', e && (e.stack || e.message || String(e)));
    process.exit(1);
});
