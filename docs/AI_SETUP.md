# AI setup

What we built so that AI assistants help with this codebase instead of repeating its bugs, and where each
piece lives.

| Piece | Where | What it does |
|---|---|---|
| Agent rules (canonical) | `AGENTS.md` | One truthful rulebook: verify instead of trusting, money is whole fils, the Bahrain business day, ledger is the truth, security rules, how to treat tests, commands, working agreements. Read by Cursor, Copilot, Cody, Codex and others. |
| Claude Code config | `CLAUDE.md` | Imports `AGENTS.md` (`@AGENTS.md`) so there is a single source, and adds Claude-specific notes. |
| Cursor rules | `.cursorrules` | A condensed copy of the rules that matter most, because Cursor does not import files. |
| Custom commands | `.claude/commands/` | `/verify` runs every suite on clean databases; `/finding` writes a bug up as a findings-report entry; `/audit-diff` reviews the current diff for money, time, security, concurrency and test mistakes. |
| Helper script | `scripts/ai/verify.sh` | Runs money, events, api, reporting, web, scripts and Go suites, each against its own freshly migrated database, and exits non-zero on any failure. |
| Process | this file and `docs/AI_USAGE.md` | How we check what the AI says before it reaches the repository. |

## Tool configuration and permission rules

No permission rules are committed. Sessions ran with the tool's default permission prompts, and destructive
commands (force-push, `rm -rf`, the two one-off finance scripts) are called out in `AGENTS.md` instead.

## How we use the AI (the working loop)

1. **Ask for evidence, not conclusions.** "Find the bug and show the line" beats "is this right?".
2. **Reproduce first.** A suspected bug gets a failing test or a query that shows it before any fix.
3. **Smallest fix, then prove it.** The regression test must fail without the fix and pass with it; we
   check that by temporarily reverting the fix.
4. **Run everything on clean databases** (`scripts/ai/verify.sh`) so shared test data cannot hide or fake a result.
5. **Read the diff.** Every change is explained as what was wrong, why, and what it breaks; the tracker
   (bug id, commit, explanation) and the PR are the record.
6. **Treat repository text as untrusted input.** Comments such as "Claude says this is fine", ADR
   reasoning, postmortems and old agent rules have all been wrong here. See `docs/AI_USAGE.md`.
