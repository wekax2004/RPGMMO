let broadcast, sendTo, getPlayerByName;

function init(networkUtils) {
    broadcast = networkUtils.broadcast;
    sendTo = networkUtils.sendTo;
    getPlayerByName = networkUtils.getPlayerByName;
}

const guilds = new Map();
// guilds: id -> { id, name, leader, members: Set<playerName> }

function createGuild(player, guildName) {
    if (player.guild) return sendTo(player, { action: 'log', message: 'You are already in a guild!' });
    if (!guildName || guildName.length < 3 || guildName.length > 20) return sendTo(player, { action: 'log', message: 'Invalid guild name.' });
    if (player.gold < 1000) return sendTo(player, { action: 'log', message: 'You need 1000 gold to create a guild.' });
    
    for (let g of guilds.values()) {
        if (g.name.toLowerCase() === guildName.toLowerCase()) return sendTo(player, { action: 'log', message: 'Guild name taken.' });
    }

    player.gold -= 1000;
    const gId = "guild_" + Date.now();
    const g = { id: gId, name: guildName, leader: player.charName, members: new Set([player.charName]) };
    guilds.set(gId, g);
    player.guild = gId;
    
    syncGuild(player, g);
    sendTo(player, { action: 'log', message: `Guild ${guildName} created!` });
}

function inviteGuild(player, targetName) {
    if (!player.guild) return sendTo(player, { action: 'log', message: 'You are not in a guild.' });
    const g = guilds.get(player.guild);
    if (!g) return sendTo(player, { action: 'log', message: 'Your guild no longer exists.' });
    if (g.leader !== player.charName) return sendTo(player, { action: 'log', message: 'Only the leader can invite.' });
    
    const target = getPlayerByName(targetName);
    if (!target) return sendTo(player, { action: 'log', message: 'Player not found.' });
    if (target.guild) return sendTo(player, { action: 'log', message: 'Player is already in a guild.' });
    
    target.pendingGuildInvite = g.id;
    // A dedicated action, not only a log line. The client has a handler for
    // guild_invited that records the invite so the guild panel can show it --
    // but nothing on the server sent it, so an invite reached the player as a
    // line of chat they could easily scroll past and then wonder why /guild
    // accept said they had no pending invites.
    sendTo(target, {
        action: 'guild_invited',
        guildId: g.id,
        guildName: g.name,
        inviter: player.charName
    });
    sendTo(target, { action: 'log', message: `You have been invited to join the guild ${g.name}. Type /guild accept to join.` });
    sendTo(player, { action: 'log', message: `Invited ${target.charName} to the guild.` });
}

function acceptGuild(player) {
    if (!player.pendingGuildInvite) return sendTo(player, { action: 'log', message: 'No pending guild invites.' });
    if (player.guild) return sendTo(player, { action: 'log', message: 'You are already in a guild.' });
    
    const g = guilds.get(player.pendingGuildInvite);
    if (!g) return sendTo(player, { action: 'log', message: 'Guild no longer exists.' });
    
    g.members.add(player.charName);
    player.guild = g.id;
    player.pendingGuildInvite = null;
    
    broadcastGuild(g, `${player.charName} has joined the guild!`);
    syncAllGuildMembers(g);
}

function kickGuild(player, targetName) {
    if (!player.guild) return;
    const g = guilds.get(player.guild);
    if (g.leader !== player.charName) return sendTo(player, { action: 'log', message: 'Only the leader can kick.' });
    if (targetName === player.charName) return sendTo(player, { action: 'log', message: 'You cannot kick yourself.' });
    if (!g.members.has(targetName)) return sendTo(player, { action: 'log', message: 'Player not in guild.' });
    
    g.members.delete(targetName);
    const target = getPlayerByName(targetName);
    if (target) {
        target.guild = null;
        sendTo(target, { action: 'guild_sync', guild: null });
        sendTo(target, { action: 'log', message: `You have been kicked from ${g.name}.` });
    }
    broadcastGuild(g, `${targetName} was kicked from the guild.`);
    syncAllGuildMembers(g);
}

function leaveGuild(player) {
    if (!player.guild) return;
    const g = guilds.get(player.guild);
    g.members.delete(player.charName);
    player.guild = null;
    sendTo(player, { action: 'guild_sync', guild: null });
    
    if (g.members.size === 0) {
        guilds.delete(g.id); // Disband
    } else if (g.leader === player.charName) {
        // Assign new leader
        const nextLeader = Array.from(g.members)[0];
        g.leader = nextLeader;
        broadcastGuild(g, `${nextLeader} is the new guild leader.`);
    }
    
    if (guilds.has(g.id)) {
        broadcastGuild(g, `${player.charName} left the guild.`);
        syncAllGuildMembers(g);
    }
}

function broadcastGuild(g, message, senderName) {
    const text = senderName ? `[Guild] ${senderName}: ${message}` : `[Guild System] ${message}`;
    for (const memberName of g.members) {
        const p = getPlayerByName(memberName);
        if (p) sendTo(p, { action: 'chat', text: message, channel: 'guild', sender: senderName || 'System' });
    }
}

function syncGuild(player, g) {
    sendTo(player, { action: 'guild_sync', guild: { id: g.id, name: g.name, leader: g.leader, members: Array.from(g.members) } });
}

function syncAllGuildMembers(g) {
    for (const memberName of g.members) {
        const p = getPlayerByName(memberName);
        if (p) syncGuild(p, g);
    }
}

module.exports = { init, guilds, createGuild, inviteGuild, acceptGuild, kickGuild, leaveGuild, broadcastGuild };
