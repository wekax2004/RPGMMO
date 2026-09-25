# Original User Request

## 2026-09-25T07:35:33Z

# Teamwork Project Prompt — Draft

> Status: Launched.
> Goal: Craft prompt → get user approval → delegate to teamwork_preview
> Requested team: Very large scale agent team (requested massive scope)

Execute a massive expansion and overhaul of the Tibia-inspired Node.js/HTML5 MMORPG prototype. The project requires broad development across content, gameplay systems, and technical architecture.

Working directory: C:\Users\home\.gemini\antigravity\scratch\tibia_mmo
Integrity mode: development

## Requirements

### R1. Gameplay & Combat Systems
Implement advanced progression including Sub-classes (e.g., Warrior -> Juggernaut) and complex Boss mechanics (e.g., Spider Queen with AoE ground indicators). 

### R2. World & Content Expansion
Expand the world with new biomes, intricate quest lines, advanced NPC dialogue trees, and a richer item/loot ecosystem.

### R3. Multiplayer Features
Implement social and community MMO features such as player trading, party systems, and global chat channels.

### R4. Technical Refactoring
Refactor the codebase for maintainability, ensuring robust synchronization, scalable Firebase database integration, and reduced lag.

## Acceptance Criteria

### Combat & Gameplay (Verified via Agent-in-Browser)
- [ ] An independent browser agent can level up a character to the required threshold and successfully transition to a Sub-class.
- [ ] An independent browser agent can engage a Boss mob, trigger its AoE ability, and verify that the AoE ground indicator renders correctly before damage is applied.

### Content & UI (Verified via Agent-in-Browser)
- [ ] An independent browser agent can initiate a conversation with an advanced NPC, accept a multi-step quest, and verify the UI updates accordingly.
- [ ] An independent browser agent can successfully execute a secure player-to-player trade interface flow.

### Networking & Stability (Verified via Programmatic Bots)
- [ ] A script can spawn 50 concurrent headless WebSocket bots that actively move and attack without causing the Node.js server to crash or exceed acceptable tick delays.
- [ ] Two headless bots can successfully form a Party and broadcast messages to a global chat channel, verified via WebSocket message logs.
- [ ] Server data correctly and consistently persists to Firebase during the load test, verified by cleanly shutting down the server and reading the intact states on restart.
