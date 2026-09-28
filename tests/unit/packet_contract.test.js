// Guards the shared packet contract against drift.
//
// shared/packet_types.js used to be maintained by hand and had rotted badly:
// it advertised actions the server never handled (cast_subclass_skill, equip,
// turn_in_quest, PONG) and omitted every feature added since. Nothing failed
// because nothing read it. It is now generated from the server source, and
// this test fails if the committed file stops matching the code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { collectJsFiles, extractFromSource, buildContractFile } = require('../../tools/packet_contract');

const SERVER_DIR = path.join(__dirname, '..', '..', 'server');
const CONTRACT_PATH = path.join(__dirname, '..', '..', 'shared', 'packet_types.js');

const { toClient, fromClient } = extractFromSource(collectJsFiles(SERVER_DIR));

test('the committed contract matches what the server actually speaks', () => {
    const onDisk = fs.readFileSync(CONTRACT_PATH, 'utf8');
    const generated = buildContractFile();
    assert.strictEqual(
        onDisk.replace(/\r\n/g, '\n'),
        generated.replace(/\r\n/g, '\n'),
        'shared/packet_types.js is stale. Run: node tools/packet_contract.js --write'
    );
});

test('the contract is loadable and shaped as C2S/S2C maps', () => {
    const PACKET = require(CONTRACT_PATH);
    assert.ok(PACKET.C2S && typeof PACKET.C2S === 'object', 'C2S must be an object');
    assert.ok(PACKET.S2C && typeof PACKET.S2C === 'object', 'S2C must be an object');
});

test('every extracted action appears in the contract, in the right direction', () => {
    const PACKET = require(CONTRACT_PATH);
    const c2sValues = new Set(Object.values(PACKET.C2S));
    const s2cValues = new Set(Object.values(PACKET.S2C));

    const missingInbound = [...fromClient].filter(a => !c2sValues.has(a)).sort();
    const missingOutbound = [...toClient].filter(a => !s2cValues.has(a)).sort();
    assert.deepStrictEqual(missingInbound, [],
        'inbound actions the server handles but the contract omits');
    assert.deepStrictEqual(missingOutbound, [],
        'outbound actions the server sends but the contract omits');
});

test('the contract invents no actions the server does not speak', () => {
    // The failure that motivated this file: it listed actions that never
    // existed, which would have sent a frontend developer chasing dead ends.
    const PACKET = require(CONTRACT_PATH);
    const c2sValues = Object.values(PACKET.C2S);
    const s2cValues = Object.values(PACKET.S2C);
    const bogus = c2sValues.filter(a => !fromClient.has(a));
    assert.deepStrictEqual(bogus, [], 'C2S lists actions the server never handles');
    const bogusOut = s2cValues.filter(a => !toClient.has(a));
    assert.deepStrictEqual(bogusOut, [], 'S2C lists actions the server never sends');
});

test('the keys are unique and derive from the action name', () => {
    const PACKET = require(CONTRACT_PATH);
    for (const dir of ['C2S', 'S2C']) {
        const keys = Object.keys(PACKET[dir]);
        assert.strictEqual(new Set(keys).size, keys.length, `${dir} has a duplicate key`);
        keys.forEach(k => {
            const value = PACKET[dir][k];
            assert.strictEqual(k, value.toUpperCase(), `${dir}.${k} should be the upper-cased action`);
        });
    }
});

test('the features added most recently are all in the contract', () => {
    // Regression guard for the exact features that were missing from the
    // hand-maintained version.
    const PACKET = require(CONTRACT_PATH);
    const expectedC2S = [
        'drop_item', 'pickup_item', 'toggle_mount', 'fish',
        'auction_list', 'auction_buy', 'auction_request'
    ];
    expectedC2S.forEach(a => {
        assert.ok(Object.values(PACKET.C2S).includes(a), `C2S must include ${a}`);
        assert.ok(fromClient.has(a), `the server must actually handle ${a}`);
    });
    const expectedS2C = [
        'ground_sync', 'skill_update', 'boss_spawned', 'mount_changed',
        'auction_sync', 'auction_mailbox', 'fishing_result', 'spell_anim'
    ];
    expectedS2C.forEach(a => {
        assert.ok(Object.values(PACKET.S2C).includes(a), `S2C must include ${a}`);
        assert.ok(toClient.has(a), `the server must actually send ${a}`);
    });
});

test('the corpus the extractor reads is not empty', () => {
    // Guards against the extractor silently matching nothing, which would make
    // every other assertion in this file vacuously true.
    assert.ok(fromClient.size > 20, `only found ${fromClient.size} inbound actions`);
    assert.ok(toClient.size > 20, `only found ${toClient.size} outbound actions`);
});
