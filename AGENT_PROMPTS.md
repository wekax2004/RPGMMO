# Agent Prompt Pack

Use these prompts with separate coding sessions. Give each agent one task ID at
a time and require a handoff before starting another task.

## Implementer prompt

```text
You are implementing task <TASK_ID> from IMPLEMENTATION_PLAN.md in
C:\Users\home\.gemini\antigravity\scratch\tibia_mmo.

Read the task, IMPLEMENTATION_PLAN.md, docs/PROTOCOL.md, and the relevant tests
before editing. Preserve unrelated work. Make the smallest coherent change,
add regression coverage, and run the focused tests plus npm test. Do not weaken
assertions, add fake success paths, expose secrets, or enable test-only actions
in production. Finish with:
- files changed
- behavior before/after
- commands run and results
- known limitations
- next recommended task
```

## Reviewer prompt

```text
Review task <TASK_ID> in
C:\Users\home\.gemini\antigravity\scratch\tibia_mmo without modifying files.

Check correctness, security, persistence races, protocol compatibility,
duplicate side effects, disconnect behavior, and test credibility. Report only
actionable findings with exact file paths and line numbers, ordered by severity.
```

## Test agent prompt

```text
Validate task <TASK_ID> in
C:\Users\home\.gemini\antigravity\scratch\tibia_mmo.

Run the focused unit/browser/bot tests, then npm test. Use isolated ports and
temporary persistence files. Do not modify production code. Report exact
commands, failures, flaky behavior, and missing coverage.
```

## Recommended order for free models

1. `P0.1` source-control and ignore rules.
2. `P0.2` test isolation and scripts.
3. `P1.1` persistence adapter cleanup.
4. `P1.3` packet validation and rate limits.
5. `P2.1` shared packet constants.
6. `P3.1` movement validation.
7. `P3.2` combat/death centralization.
8. `P4.1` quest graph.
9. `P5.1` party state machine.
10. `P5.2` trade state machine.
11. `P6.1` boss ability framework.
12. `P7.1` area-of-interest synchronization.

Do not let two agents edit the same files concurrently without an explicit
handoff. A task is not complete because its UI renders; its server-side state
transition and persistence behavior must also be tested.
