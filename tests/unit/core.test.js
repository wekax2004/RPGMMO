const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tibia-mmo-unit-'));
process.env.TIBIA_DB_DRIVER = 'local';
process.env.TIBIA_DB_FILE = path.join(tempDir, 'players.json');

const DB = require('../../server/persistence');
const TRADE = require('../../server/trade');
const PARTY = require('../../server/party');
const QUESTS = require('../../server/quests');
const SUBCLASSES = require('../../server/subclasses');

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('local persistence serializes concurrent character writes', async () => {
  await Promise.all([
    DB.savePlayer('Alpha', { level: 2, inventory: ['Potion'] }),
    DB.savePlayer('Beta', { level: 3, inventory: ['Sword'] }),
    DB.savePlayer('Gamma', { level: 4, inventory: ['Bone'] })
  ]);
  await DB.flush();

  await DB.savePlayer('CaseTest', { level: 7 });
  assert.equal((await DB.loadPlayer('casetest')).level, 7);
  assert.deepEqual((await DB.loadPlayer('Alpha')).inventory, ['Potion']);
  assert.deepEqual((await DB.loadPlayer('Beta')).inventory, ['Sword']);
  assert.deepEqual((await DB.loadPlayer('Gamma')).inventory, ['Bone']);
});

test('trade validates ownership, locks, and atomically swaps state', () => {
  const players = new Map([
    ['p1', { id: 'p1', x: 320, y: 320, gold: 100, inventory: ['Health Potion'] }],
    ['p2', { id: 'p2', x: 320, y: 320, gold: 0, inventory: ['Iron Sword'] }]
  ]);

  const request = TRADE.createTradeRequest('p1', 'p2');
  assert.equal(request.success, true);
  const accepted = TRADE.acceptTradeRequest('p2', request.request.id, 'p1');
  assert.equal(accepted.success, true);

  const tradeId = accepted.tradeId;
  const failedBatch = TRADE.stageTradeOffer(tradeId, 'p1', ['Health Potion', 'Not Owned'], undefined, players);
  assert.equal(failedBatch.success, false);
  assert.deepEqual(TRADE.getTradeSnapshot(TRADE.activeTrades.get(tradeId), 'p1').myOffer, []);
  assert.equal(TRADE.stageTradeOffer(tradeId, 'p1', ['Health Potion'], 50, players).success, true);
  assert.equal(TRADE.setTradeGold(tradeId, 'p1', NaN).success, false);
  assert.equal(TRADE.addItemToTrade(tradeId, 'p2', 'Iron Sword', players).success, true);
  assert.equal(TRADE.addItemToTrade(tradeId, 'p2', 'Not Owned', players).success, false);

  assert.equal(TRADE.lockTrade(tradeId, 'p1').bothLocked, false);
  assert.equal(TRADE.lockTrade(tradeId, 'p2').bothLocked, true);
  assert.equal(TRADE.confirmTrade(tradeId, 'p1').bothConfirmed, false);
  assert.equal(TRADE.confirmTrade(tradeId, 'p2').bothConfirmed, true);

  const result = TRADE.executeTrade(tradeId, players);
  assert.equal(result.success, true);
  assert.equal(players.get('p1').gold, 50);
  assert.equal(players.get('p2').gold, 50);
  assert.deepEqual(players.get('p1').inventory, ['Iron Sword']);
  assert.deepEqual(players.get('p2').inventory, ['Health Potion']);
});

test('party invitations cannot be accepted without a stored invite', () => {
  const players = new Map([
    ['leader', { id: 'leader', charName: 'Leader', hp: 10, maxHp: 10 }],
    ['target', { id: 'target', charName: 'Target', hp: 10, maxHp: 10 }],
    ['intruder', { id: 'intruder', charName: 'Intruder', hp: 10, maxHp: 10 }]
  ]);
  const partyId = PARTY.createParty('leader');
  assert.equal(PARTY.acceptInvite('intruder', partyId, players).success, false);
  assert.equal(PARTY.inviteToParty(partyId, 'leader', 'target', players).success, true);
  assert.equal(PARTY.acceptInvite('target', partyId, players).success, true);

  const snapshot = PARTY.getPartySnapshot(PARTY.getParty('target'), players);
  assert.equal(snapshot.members.length, 2);
  assert.equal(snapshot.leader, 'leader');
});

test('quest acceptance enforces giver and prerequisites', () => {
  const quests = QUESTS.initPlayerQuests();
  assert.ok(QUESTS.getAvailableQuests(quests, 'n_1').length > 0);
  assert.equal(QUESTS.acceptQuest(quests, 'quest_spider_slayer', 'n_ruins_sage'), false);
  assert.equal(QUESTS.acceptQuest(quests, 'quest_spider_slayer', 'n_1'), true);
  assert.equal(QUESTS.acceptQuest(quests, 'quest_spider_queen', 'n_forest_scout'), false);
});

test('subclass evolution uses classType and canonical stat modifiers', () => {
  const player = { level: SUBCLASSES.SUBCLASS_LEVEL_REQUIREMENT, classType: 'warrior', subclass: null };
  assert.equal(SUBCLASSES.canEvolve(player), true);
  assert.equal(SUBCLASSES.evolvePlayer(player, 'juggernaut'), true);
  assert.equal(player.subclass, 'juggernaut');
  assert.equal(SUBCLASSES.SUBCLASS_DATA.juggernaut.statModifiers.maxHpMulti, 1.5);
});
