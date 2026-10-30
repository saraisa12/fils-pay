---
description: Run every test suite, each on its own clean database, and summarise the result
---
Run `scripts/ai/verify.sh` (pass suite names to limit it: money events api reporting web scripts go).

Report, per suite, the number of tests and any failure with its first error line. If something fails:
1. Reproduce it on its own before changing anything.
2. Decide whether the code, the test or the data is wrong (see AGENTS.md, "Tests"); never delete a test to get green.
3. Re-run only that suite, then the full script.
