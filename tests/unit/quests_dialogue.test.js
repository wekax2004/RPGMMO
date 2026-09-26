// Unit tests for the multi-step quest chain and the NPC dialogue trees.
// These modules are pure enough to require directly, with no server boot.
process.env.TIBIA_DB_DRIVER = 'local';
process.env.TIBIA_DB_FILE = require('path').join(
    require('os').tmpdir(),
    `tibia_quests_test_${process.pid}.json`
);

const test = require('node:test');
const assert = require('node:assert');
const Q = require('../../server/quests');
const { npcs } = require('../../server/npcs');

const ARTHUR = 'n_king_arthur';

function fakePlayer() {
    return { charName: 'Tester', gold: 0, inventory: [], quests: Q.initPlayerQuests() };
}

test('multi-step quest: accepting skips the briefing step', () => {
    const quests = Q.initPlayerQuests();
    assert.strictEqual(Q.acceptQuest(quests, 'quest_spider_menace', ARTHUR), true);

    const state = quests.active.quest_spider_menace;
    assert.ok(state, 'quest should be active');
    // The 'talk' briefing is satisfied by accepting, so we land on 'slay'.
    assert.strictEqual(state.stepIndex, 1);
    assert.strictEqual(state.objectives.length, 1);
    assert.strictEqual(state.objectives[0].target, 'Spider');
    assert.strictEqual(state.objectives[0].required, 5);
    assert.strictEqual(state.objectives[0].current, 0);
});

test('multi-step quest: not turn-in-able until the kill objective is done', () => {
    const quests = Q.initPlayerQuests();
    Q.acceptQuest(quests, 'quest_spider_menace', ARTHUR);
    assert.strictEqual(Q.checkQuestComplete(quests, 'quest_spider_menace'), false);

    for (let i = 0; i < 4; i++) Q.onMobKilled(quests, 'Spider');
    assert.strictEqual(Q.checkQuestComplete(quests, 'quest_spider_menace'), false);
});

test('multi-step quest: finishing the objective advances to the turn-in step', () => {
    const quests = Q.initPlayerQuests();
    Q.acceptQuest(quests, 'quest_spider_menace', ARTHUR);

    for (let i = 0; i < 5; i++) Q.onMobKilled(quests, 'Spider');

    const state = quests.active.quest_spider_menace;
    assert.strictEqual(state.stepIndex, 2, 'should advance to the return step');
    assert.strictEqual(state.objectives.length, 0, 'turn-in step has no counters');
    assert.strictEqual(Q.checkQuestComplete(quests, 'quest_spider_menace'), true);
});

test('multi-step quest: wrong mob does not advance progress', () => {
    const quests = Q.initPlayerQuests();
    Q.acceptQuest(quests, 'quest_spider_menace', ARTHUR);

    Q.onMobKilled(quests, 'Skeleton');
    Q.onMobKilled(quests, 'Minotaur');
    assert.strictEqual(quests.active.quest_spider_menace.objectives[0].current, 0);
});

test('multi-step quest: progress cannot exceed the requirement', () => {
    const quests = Q.initPlayerQuests();
    Q.acceptQuest(quests, 'quest_spider_menace', ARTHUR);
    // Four kills keep us on the slay step, so the counter is observable.
    for (let i = 0; i < 4; i++) Q.onMobKilled(quests, 'Spider');
    const objective = quests.active.quest_spider_menace.objectives[0];
    assert.strictEqual(objective.current, 4);
    // One more completes it and advances; further kills must not overflow
    // into a negative or over-counted value on any later step.
    for (let i = 0; i < 20; i++) Q.onMobKilled(quests, 'Spider');
    const state = quests.active.quest_spider_menace;
    assert.strictEqual(state.stepIndex, 2, 'stays on the hand-in step');
    assert.strictEqual(state.objectives.length, 0);
});

test('multi-step quest: turn-in grants gold and the Holy Staff exactly once', () => {
    const player = fakePlayer();
    Q.acceptQuest(player.quests, 'quest_spider_menace', ARTHUR);
    for (let i = 0; i < 5; i++) Q.onMobKilled(player.quests, 'Spider');

    const result = Q.completeQuest(player.quests, 'quest_spider_menace', player);
    assert.ok(result, 'completion should succeed');
    assert.strictEqual(player.gold, 500);
    assert.deepStrictEqual(player.inventory, ['Holy Staff']);
    assert.strictEqual(player.quests.active.quest_spider_menace, undefined);
    assert.ok(player.quests.completed.includes('quest_spider_menace'));

    // A second attempt must not re-award anything.
    const again = Q.completeQuest(player.quests, 'quest_spider_menace', player);
    assert.strictEqual(again, null);
    assert.strictEqual(player.gold, 500);
    assert.deepStrictEqual(player.inventory, ['Holy Staff']);
});

test('multi-step quest: Holy Staff reward is a real equippable item', () => {
    const ITEMS = require('../../server/items');
    assert.ok(ITEMS.weapons['Holy Staff'], 'Holy Staff must exist in the weapon catalog');
});

test('prerequisite chain: the vigil is gated behind the menace', () => {
    const quests = Q.initPlayerQuests();
    assert.strictEqual(Q.acceptQuest(quests, 'quest_arthur_vigil', ARTHUR), false);

    Q.acceptQuest(quests, 'quest_spider_menace', ARTHUR);
    for (let i = 0; i < 5; i++) Q.onMobKilled(quests, 'Spider');
    const player = fakePlayer();
    player.quests = quests;
    Q.completeQuest(quests, 'quest_spider_menace', player);

    assert.strictEqual(Q.acceptQuest(quests, 'quest_arthur_vigil', ARTHUR), true);
});

test('four-step quest walks through two objective stages before the hand-in', () => {
    const quests = Q.initPlayerQuests();
    quests.completed.push('quest_spider_menace');
    Q.acceptQuest(quests, 'quest_arthur_vigil', ARTHUR);

    let state = quests.active.quest_arthur_vigil;
    assert.strictEqual(state.stepIndex, 1);
    assert.strictEqual(state.objectives[0].target, 'Skeleton');

    for (let i = 0; i < 3; i++) Q.onMobKilled(quests, 'Skeleton');
    state = quests.active.quest_arthur_vigil;
    assert.strictEqual(state.stepIndex, 2, 'should advance to the minotaur stage');
    assert.strictEqual(state.objectives[0].target, 'Minotaur');

    for (let i = 0; i < 2; i++) Q.onMobKilled(quests, 'Minotaur');
    state = quests.active.quest_arthur_vigil;
    assert.strictEqual(state.stepIndex, 3, 'should advance to the return step');
    assert.strictEqual(Q.checkQuestComplete(quests, 'quest_arthur_vigil'), true);
});

test('legacy single-step quests still work unchanged', () => {
    const quests = Q.initPlayerQuests();
    assert.strictEqual(Q.acceptQuest(quests, 'quest_spider_slayer', 'n_1'), true);
    const state = quests.active.quest_spider_slayer;
    assert.strictEqual(state.stepIndex, undefined, 'legacy quests carry no step index');
    assert.strictEqual(state.objectives[0].target, 'Spider');
    assert.strictEqual(Q.checkQuestComplete(quests, 'quest_spider_slayer'), false);
    for (let i = 0; i < 5; i++) Q.onMobKilled(quests, 'Spider');
    assert.strictEqual(Q.checkQuestComplete(quests, 'quest_spider_slayer'), true);
});

test('dialogue: the root node offers a choice and hides the locked quest', () => {
    const player = fakePlayer();
    const ctx = Q.buildDialogueContext(player, ARTHUR);
    const node = Q.resolveDialogue(ARTHUR, null, ctx);

    assert.strictEqual(node.node_id, 'greet_offer');
    assert.ok(node.text.includes('Spider Menace'));
    const ids = node.choices.map(c => c.id);
    assert.ok(ids.includes('hear_spider_menace'));
    // The vigil is locked, so it must not be offered yet.
    assert.ok(!ids.includes('hear_vigil'), 'locked quest must not appear as a choice');
});

test('dialogue: accepting through the tree activates the quest', () => {
    const player = fakePlayer();
    const ctx = Q.buildDialogueContext(player, ARTHUR);
    const node = Q.resolveDialogue(ARTHUR, 'offer_spider_menace', ctx);
    const accept = node.choices.find(c => c.id === 'accept_spider_menace');
    assert.ok(accept, 'accept choice should be offered');

    const action = Q.resolveChoice(ARTHUR, 'offer_spider_menace', 'accept_spider_menace', ctx);
    assert.ok(action && action.action);
    assert.strictEqual(Q.acceptQuest(player.quests, action.action.questId, ARTHUR), true);
    assert.ok(player.quests.active.quest_spider_menace);
});

test('dialogue: a forged or unknown choice id is rejected', () => {
    const player = fakePlayer();
    const ctx = Q.buildDialogueContext(player, ARTHUR);
    assert.strictEqual(Q.resolveChoice(ARTHUR, 'offer_spider_menace', 'not_a_choice', ctx), null);
    assert.strictEqual(Q.resolveChoice(ARTHUR, 'no_such_node', 'accept_spider_menace', ctx), null);
    assert.strictEqual(Q.resolveChoice('n_1', 'greet_offer', 'anything', ctx), null, 'NPCs without a tree resolve nothing');
});

test('dialogue: the entry node switches to turn-in once a quest is finished', () => {
    const player = fakePlayer();
    Q.acceptQuest(player.quests, 'quest_spider_menace', ARTHUR);
    for (let i = 0; i < 5; i++) Q.onMobKilled(player.quests, 'Spider');

    const ctx = Q.buildDialogueContext(player, ARTHUR);
    assert.strictEqual(ctx.turnIns.length, 1, 'one quest should be ready to hand in');
    const node = Q.resolveDialogue(ARTHUR, null, ctx);
    assert.strictEqual(node.node_id, 'turn_in_intro');
    const ids = node.choices.map(c => c.id);
    assert.ok(ids.includes('turn_in_quest_spider_menace'));
});

test('dialogue: the greeting reports active business when nothing is turn-in-able', () => {
    const player = fakePlayer();
    Q.acceptQuest(player.quests, 'quest_spider_menace', ARTHUR);
    const ctx = Q.buildDialogueContext(player, ARTHUR);
    const node = Q.resolveDialogue(ARTHUR, null, ctx);
    assert.strictEqual(node.node_id, 'greet_in_progress');
    assert.ok(node.text.includes('Spider Menace'));
});

test('dialogue: idle greeting once everything is done', () => {
    const player = fakePlayer();
    player.quests.completed.push('quest_spider_menace', 'quest_arthur_vigil');
    const ctx = Q.buildDialogueContext(player, ARTHUR);
    const node = Q.resolveDialogue(ARTHUR, null, ctx);
    assert.strictEqual(node.node_id, 'greet_idle');
    assert.deepStrictEqual(node.choices.length, 1);
});

test('King Arthur exists in the starting city and offers the new quests', () => {
    const arthur = npcs.get(ARTHUR);
    assert.ok(arthur, 'King Arthur must exist');
    assert.strictEqual(arthur.name, 'King Arthur');
    assert.ok(arthur.quests_offered.includes('quest_spider_menace'));
    assert.ok(arthur.quests_offered.includes('quest_arthur_vigil'));
});

test('sanitizePlayerQuests clamps a mid-quest step to a well-formed shape', () => {
    const clean = Q.sanitizePlayerQuests({
        active: { quest_spider_menace: { stepIndex: 1, objectives: 'not-an-array' } },
        completed: []
    });
    const menace = clean.active.quest_spider_menace;
    assert.strictEqual(menace.stepIndex, 1, 'a valid step index is preserved');
    assert.ok(Array.isArray(menace.objectives));
    assert.strictEqual(menace.objectives.length, 1, 'the slay step has one counter');
    assert.strictEqual(menace.objectives[0].target, 'Spider');
    assert.strictEqual(menace.objectives[0].required, 5);
    assert.strictEqual(menace.objectives[0].current, 0);
});

test('sanitizePlayerQuests rebuilds a corrupt save instead of trusting it', () => {
    const corrupt = {
        active: {
            quest_spider_menace: { stepIndex: 99, objectives: 'not-an-array' },
            quest_spider_slayer: { objectives: [{ current: 3, required: 5 }] },
            not_a_real_quest: { objectives: [{ current: 1, required: 1 }] }
        },
        completed: ['quest_spider_slayer', 'quest_spider_slayer', 42]
    };
    const clean = Q.sanitizePlayerQuests(corrupt);

    // Unknown quests are dropped entirely.
    assert.strictEqual(clean.active.not_a_real_quest, undefined);
    // A non-array objectives field is replaced with a well-formed template.
    const menace = clean.active.quest_spider_menace;
    assert.ok(Array.isArray(menace.objectives), 'objectives must be rebuilt as an array');
    // The out-of-range step index 99 is clamped to the final step, which is
    // the hand-in and therefore carries no counters.
    assert.strictEqual(menace.stepIndex, 2, 'step index clamped to the last step');
    assert.strictEqual(menace.objectives.length, 0);
    // A legacy quest keeps its counter, rebuilt from the template.
    const slayer = clean.active.quest_spider_slayer;
    assert.ok(Array.isArray(slayer.objectives));
    assert.strictEqual(slayer.objectives[0].current, 3);
    assert.strictEqual(slayer.objectives[0].required, 5);
    // Duplicate and non-string completions are filtered.
    assert.deepStrictEqual(clean.completed, ['quest_spider_slayer']);
});

test('sanitizePlayerQuests clamps a tampered counter above the requirement', () => {
    const clean = Q.sanitizePlayerQuests({
        active: { quest_spider_slayer: { objectives: [{ current: 9999, required: 5 }] } },
        completed: []
    });
    assert.strictEqual(clean.active.quest_spider_slayer.objectives[0].current, 5);
});

test('sanitizePlayerQuests tolerates junk input without throwing', () => {
    for (const junk of [null, undefined, 'nope', 42, [], { active: 'bad', completed: 'bad' }]) {
        const clean = Q.sanitizePlayerQuests(junk);
        assert.deepStrictEqual(clean, { active: {}, completed: [] });
    }
});
