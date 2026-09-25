const parties = new Map();
const invites = new Map();
const INVITE_TTL_MS = 60_000;

function inviteKey(partyId, targetId) {
    return `${partyId}:${targetId}`;
}

function cleanupInvites(now = Date.now()) {
    for (const [key, invite] of invites.entries()) {
        if (invite.expiresAt <= now || !parties.has(invite.partyId)) {
            invites.delete(key);
        }
    }
}

function createParty(leaderId) {
    const existing = getParty(leaderId);
    if (existing) return existing.id;

    const partyId = 'party_' + Math.random().toString(36).substring(2, 11);
    parties.set(partyId, {
        id: partyId,
        leader: leaderId,
        members: [leaderId]
    });
    return partyId;
}

function inviteToParty(partyId, inviterId, targetId, players) {
    cleanupInvites();

    const party = parties.get(partyId);
    if (!party) return { success: false, message: 'Party not found.' };
    if (party.leader !== inviterId) return { success: false, message: 'Only the party leader can invite.' };
    if (targetId === inviterId) return { success: false, message: 'You cannot invite yourself.' };
    if (party.members.length >= 4) return { success: false, message: 'Party is full.' };
    if (getParty(targetId)) return { success: false, message: 'Target player is already in a party.' };
    if (!players || !players.has(targetId)) return { success: false, message: 'Target player not found.' };

    const key = inviteKey(partyId, targetId);
    invites.set(key, {
        partyId,
        inviterId,
        targetId,
        expiresAt: Date.now() + INVITE_TTL_MS
    });

    return { success: true, message: 'Invite sent.', inviteKey: key };
}

function findInvite(playerId, partyId = null) {
    cleanupInvites();
    for (const invite of invites.values()) {
        if (invite.targetId === playerId && (!partyId || invite.partyId === partyId)) {
            return invite;
        }
    }
    return null;
}

function acceptInvite(playerId, partyId, players) {
    const invite = findInvite(playerId, partyId);
    if (!invite) return { success: false, message: 'No valid party invitation.' };

    const party = parties.get(invite.partyId);
    if (!party) {
        invites.delete(inviteKey(invite.partyId, playerId));
        return { success: false, message: 'Party not found.' };
    }
    if (!players || !players.has(playerId)) return { success: false, message: 'Player not found.' };
    if (party.members.length >= 4) return { success: false, message: 'Party is full.' };
    if (getParty(playerId)) return { success: false, message: 'You are already in a party.' };

    party.members.push(playerId);
    invites.delete(inviteKey(invite.partyId, playerId));
    return { success: true, message: 'Joined the party.', party };
}

function declineInvite(playerId, partyId = null) {
    const invite = findInvite(playerId, partyId);
    if (!invite) return false;
    invites.delete(inviteKey(invite.partyId, playerId));
    return true;
}

function leaveParty(playerId) {
    cleanupInvites();
    for (const [partyId, party] of parties.entries()) {
        const index = party.members.indexOf(playerId);
        if (index === -1) continue;

        party.members.splice(index, 1);
        for (const [key, invite] of invites.entries()) {
            if (invite.partyId === partyId) invites.delete(key);
        }
        if (party.members.length === 0) {
            disbandParty(partyId);
        } else if (party.leader === playerId) {
            party.leader = party.members[0];
        }
        return { success: true, partyId, party: parties.get(partyId) || null };
    }
    return { success: false };
}

function getParty(playerId) {
    for (const party of parties.values()) {
        if (party.members.includes(playerId)) return party;
    }
    return null;
}

function getPartyMembers(playerId, players) {
    const party = getParty(playerId);
    if (!party || !players) return [];

    return party.members
        .map(id => players.get(id))
        .filter(Boolean);
}

function getPartySnapshot(party, players) {
    if (!party) return { id: null, leader: null, members: [] };

    const members = party.members
        .map(id => {
            const player = players && players.get(id);
            return {
                id,
                name: player ? player.charName : null,
                hp: player ? player.hp : 0,
                maxHp: player ? player.maxHp : 0
            };
        });

    return {
        id: party.id,
        leader: party.leader,
        members
    };
}

function shareXp(party, amount, killerPlayer, players) {
    if (!party || !killerPlayer || !Number.isFinite(amount) || amount <= 0) return [];

    const nearbyMembers = [];
    for (const memberId of party.members) {
        const member = players.get(memberId);
        if (!member || member.hp <= 0) continue;
        const distance = Math.abs(member.x - killerPlayer.x) + Math.abs(member.y - killerPlayer.y);
        if (distance <= 320) nearbyMembers.push(member);
    }

    if (nearbyMembers.length === 0) return [];

    const total = Math.floor(nearbyMembers.length > 1 ? amount * 1.15 : amount);
    const baseShare = Math.floor(total / nearbyMembers.length);
    let remainder = total - baseShare * nearbyMembers.length;
    return nearbyMembers.map(member => {
        const xp = baseShare + (remainder-- > 0 ? 1 : 0);
        return { member, xp };
    });
}

function disbandParty(partyId) {
    parties.delete(partyId);
    for (const [key, invite] of invites.entries()) {
        if (invite.partyId === partyId) invites.delete(key);
    }
}

module.exports = {
    parties,
    invites,
    createParty,
    inviteToParty,
    acceptInvite,
    declineInvite,
    leaveParty,
    getParty,
    getPartyMembers,
    getPartySnapshot,
    shareXp,
    disbandParty
};
