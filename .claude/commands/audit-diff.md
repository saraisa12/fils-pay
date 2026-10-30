---
description: Review the current diff for money, time and security mistakes before committing
---
Read `git diff` (staged and unstaged). Check each change against AGENTS.md and report problems only:

- Money: any float, `* 100`, `/ 1000`, `toFixed`, `parseFloat`, `float32`, an `INTEGER` money column, or a share/fee computed per item without a remainder rule?
- Time: "today" or "yesterday" taken from the UTC date instead of Asia/Bahrain?
- Security: `Math.random` for something guessable? A merchant query not scoped by the authenticated merchant? A state-changing route without a server-side role check? A signature checked over re-serialized data?
- Concurrency: a money row read and written in different transactions, or validated before it is locked?
- Tests: is there a regression test that fails without the change? Was a test edited to make it pass, and is the reason written down?

End with a one-line verdict: ready to commit, or the list of things to fix first.
