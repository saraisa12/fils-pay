# FilsPay: Claude Code configuration

@AGENTS.md

## Claude Code specifics

- Project settings and permission rules: `.claude/settings.json`. Custom commands in `.claude/commands/`:
  `/verify` (run every suite on clean databases), `/finding` (write up a bug the way the findings report
  needs it), `/audit-diff` (review the current diff for money, time and security mistakes).
- Prefer the dedicated search/read tools to shell commands. Run independent commands in parallel.
- After a change, run the affected suite; before you say a change is done, run `scripts/ai/verify.sh`.
- When a fact matters (a rate, a column type, a timezone), look at the code or run it instead of recalling it.
