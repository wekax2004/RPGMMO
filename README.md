# Tibia MMO Prototype

A browser-based Tibia-inspired MMORPG prototype built with Node.js, WebSockets,
vanilla JavaScript, HTML5 Canvas, and local JSON persistence by default.

## Requirements

- Node.js 22.12 or newer
- Chrome or Edge for browser acceptance tests

## Install

```powershell
cd "C:\Users\home\.gemini\antigravity\scratch\tibia_mmo"
npm ci
npm --prefix server ci
```

## Run locally

```powershell
npm start
```

Open <http://localhost:8080/>.

The server uses `TIBIA_DB_DRIVER=local` by default. Player data is written to:

```text
server/data/players.json
```

Set `TIBIA_DB_FILE` to choose another file. Set `PORT` to change the port. The
server binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only behind an
appropriate firewall and TLS proxy. Test-only mutation actions require
`TIBIA_TEST_MODE=true` and are disabled otherwise. Firebase is fail-fast by
default; set `TIBIA_DB_ALLOW_LOCAL_FALLBACK=true` only when that fallback is an
intentional operational choice.

## Tests

```powershell
npm test
npm run test:baseline
npm run test:acceptance
npm run test:browser
npm run test:bots
```

The acceptance runner starts isolated test servers and persistence files. A
full acceptance run currently exercises subclass progression, boss telegraphs,
NPC quests, secure trade, bot load, party/chat, and persistence across restart.

## Project layout

```text
client/                 Browser client
server/                 Game server and domain modules
server/persistence.js   Local/Firebase persistence boundary
tests/unit/             Fast deterministic tests
tests/bots/             WebSocket bot tests
tests/browser/          Puppeteer browser tests
IMPLEMENTATION_PLAN.md  Ordered execution plan for future agents
```

## Current status

This is still a prototype. Authentication, full protocol schemas, area-of-
interest synchronization, and production operations are future work. Do not
expose the current server to the public Internet without completing the
security and deployment phases in `IMPLEMENTATION_PLAN.md`.
