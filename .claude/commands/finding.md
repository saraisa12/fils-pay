---
description: Write up a bug as a findings-report entry (symptom, reproduction, root cause, fix, proof, data effect)
argument-hint: <bug id or short title>
---
Write one findings-report entry for: $ARGUMENTS

Use exactly these headings, in plain language, and only facts you have checked in the code or by running it:

- **Symptom**: what a user, merchant or finance person sees.
- **How it was found and reproduced**: the clue, the file and line, and the steps or test that reproduce it.
- **Root cause**: why it happens (not just where).
- **Fix**: what changed, with the commit id.
- **Verification**: the test, query or run that proves it (a regression test must fail without the fix).
- **Effect on existing data**: what already-stored rows, ledger entries or balances are affected and what to do about them (or "none").

Keep it short enough to read aloud in 30 seconds. If several findings share one underlying cause, say which.
