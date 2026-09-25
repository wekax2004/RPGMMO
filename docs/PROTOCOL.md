# Tibia MMO WebSocket Protocol

Version: 0.2 (prototype)

The browser and bot clients use JSON text frames over WebSocket. The server is
authoritative for validation, state transitions, rewards, and persistence.
Unknown or malformed packets must not be executed.

## Connection

Development server:

```text
ws://127.0.0.1:8080
```

The browser derives `ws:` or `wss:` from the page protocol. Production should
use `wss://` behind a TLS terminator.

Maximum frame size: 16 KiB. Each connection is limited to 60 messages per
second. Exceeding a limit closes the connection.

## Common response fields

Every response has an `action` string. Responses that represent a player state
include an `id` or a `tradeId`/`partyId` when applicable. IDs are opaque strings.

## Session

### Client -> Server: `login`

```json
{
  "action": "login",
  "name": "Hero",
  "class": "warrior",
  "warmode": false
}
```

`class` is one of `warrior`, `mage`, `ranger`, or `healer`.

### Server -> Client

- `show_class_select`
- `your_id`
- `login_error`
- `time_sync`
- `status`
- `quest_journal`
- `map_data`
- entity synchronization packets

A character name may have only one active session on a server.

## Movement and combat

### Client -> Server: `move`

```json
{ "action": "move", "x": 352, "y": 320 }
```

Coordinates must be integer tile coordinates, one orthogonal tile from the
current position, inside the map, walkable, and within the movement cooldown.

### Client -> Server: `attack`

```json
{ "action": "attack", "target_id": "m_ab12cd" }
```

The server validates target existence, range, cooldown, combat state, and death
state.

## Chat

### Client -> Server: `chat`

```json
{
  "action": "chat",
  "channel": "global",
  "text": "Hello"
}
```

Supported channels in the prototype are `global`, `party`, and `zone`.
`world` is accepted as a compatibility alias for `global`. Text is trimmed and
limited to 240 characters.

### Server -> Client: `chat`

```json
{
  "action": "chat",
  "name": "Hero",
  "sender": "Hero",
  "text": "Hello",
  "channel": "global",
  "timestamp": 1760000000000
}
```

## Quests

### Client -> Server: `talk_npc`

```json
{ "action": "talk_npc", "npc_id": "n_1" }
```

### Server -> Client: `npc_dialogue`

```json
{
  "action": "npc_dialogue",
  "npc_id": "n_1",
  "npc_name": "Mayor Joe",
  "quests": [
    {
      "id": "quest_spider_slayer",
      "name": "Spider Slayer",
      "description": "Spiders are terrorizing the roads. Slay 5 of them.",
      "rewards": { "xp": 150, "gold": 100 }
    }
  ]
}
```

### Client -> Server: `accept_quest`

```json
{
  "action": "accept_quest",
  "quest_id": "quest_spider_slayer",
  "npc_id": "n_1"
}
```

The player must be near the declared quest giver. Prerequisite and duplicate
checks are server-side.

## Subclasses

### Client -> Server: `evolve`

```json
{ "action": "evolve" }
```

### Server -> Client: `show_subclass_select`

```json
{
  "action": "show_subclass_select",
  "subclasses": [
    {
      "id": "juggernaut",
      "name": "Juggernaut",
      "description": "+50% Max HP..."
    }
  ]
}
```

### Client -> Server: `select_subclass`

```json
{
  "action": "select_subclass",
  "subclassId": "juggernaut"
}
```

The level requirement and base class are checked by the server. Stats are
recalculated from base values using `statModifiers`.

## Parties

State machine:

```text
party_create -> party_invite -> party_accept -> party_sync -> party_leave
```

### Client -> Server: `party_invite`

```json
{
  "action": "party_invite",
  "targetName": "Bob"
}
```

### Server -> Client: `party_invited`

```json
{
  "action": "party_invited",
  "inviter": "Alice",
  "from": "Alice",
  "fromPlayer": "p_alice",
  "partyId": "party_abc"
}
```

Only the target player who received a stored invite can accept it.

### Server -> Client: `party_sync`

```json
{
  "action": "party_sync",
  "id": "party_abc",
  "leader": "p_alice",
  "members": [
    { "id": "p_alice", "name": "Alice", "hp": 100, "maxHp": 100 }
  ],
  "party": { "...": "same snapshot" }
}
```

The nested `party` field is retained temporarily for the original browser
client; new clients should use the top-level fields.

## Trading

State machine:

```text
trade_request -> trade_requested -> trade_accept -> trade_open
 -> trade_update -> trade_lock -> trade_locked -> trade_confirm
 -> trade_complete -> trade_close
```

### Client -> Server: `trade_request`

```json
{
  "action": "trade_request",
  "targetName": "Bob"
}
```

Players must be within 96 Manhattan pixels and must not already have an active
trade.

### Server -> Client: `trade_requested`

```json
{
  "action": "trade_requested",
  "requestId": "trade_request_abc",
  "tradeRequestId": "trade_request_abc",
  "from": "Alice",
  "fromPlayer": "p_alice",
  "fromName": "Alice"
}
```

### Client -> Server: `trade_accept`

```json
{
  "action": "trade_accept",
  "requestId": "trade_request_abc",
  "fromPlayer": "p_alice"
}
```

### Server -> Client: `trade_open`

```json
{
  "action": "trade_open",
  "tradeId": "trade_abc",
  "partnerName": "Bob"
}
```

### Staging

Canonical item staging:

```json
{
  "action": "trade_add_item",
  "tradeId": "trade_abc",
  "item": "Health Potion"
}
```

The combined compatibility form is also accepted:

```json
{
  "action": "trade_offer",
  "items": ["Health Potion"],
  "gold": 50
}
```

Gold must be a non-negative safe integer. The server checks ownership before an
item enters an offer.

### Lock and confirm

```json
{ "action": "trade_lock", "tradeId": "trade_abc" }
```

```json
{ "action": "trade_confirm", "tradeId": "trade_abc" }
```

Both players must lock before confirmation can execute. The server validates
distance, gold, inventory, and online state, then mutates both players only
after all checks pass.

## Boss AoE

### Server -> Client: `aoe_warning`

```json
{
  "action": "aoe_warning",
  "id": "boss_spider_queen_poison_123",
  "spellId": "boss_spider_queen_poison_123",
  "bossId": "boss_spider_queen_123",
  "x": 1856,
  "y": 320,
  "radius": 128,
  "type": "poison",
  "phase": "warning"
}
```

The same geometry and ID are sent in `aoe_impact`. `boss_aoe` is a legacy alias
sent during migration. Clients must key effects by `id`/`spellId`, never by an
undefined value.

## Errors

Human-readable errors currently use:

```json
{ "action": "log", "message": "❌ ..." }
```

A future protocol version should add a stable `error_code` field while keeping
the message for the browser UI.
