# Initial validation — 2026-11-22

The initial implementation passed 33 automated tests, TypeScript checking, and the production build. The bootstrap was exercised on this Linux host. Private observations and authentication material are excluded from this directory.

## Fresh local holdout

After screening six candidates, the finalist played 600 paired scenarios against V0: 300 on each board, with seats rotated and shared seeds/background armies. All 1,200 games finished.

| Metric | Result |
| --- | --- |
| Candidate tested-seat wins | 31% (186/600) |
| Champion tested-seat wins | 28% (168/600) |
| Paired improvement | +3 percentage points |
| One-sided 95% Hoeffding lower bound | −6.99 percentage points |
| Promotion | Rejected; V0 retained |

The measured difference does not meet the configured promotion threshold. These are results against the local heuristic roster, not against human opponents. The evaluated source fingerprint and per-board statistics are in [summary.json](summary.json). The tested source snapshot is commit `336a0f2e5dd4d8832d30eaefac0f02622b9e6e66`; subsequent changes add export/recovery checks and learning-time allocation.

## Live website

Two unranked bot games completed using the supplied account: a three-player win at move 40 and a four-player loss at move 150. This sample is too small to estimate live playing strength.

Collected observations passed 51 movement/artillery geometry checks and 52 isolated transition checks, including one reinforcement. No discrepancies remain in the retained observable transitions. Fire handling also has a regression test based on the public client's reveal format; no live fire transition was observed in these two games.

The server denied controlled test-game creation with `Only admins can create test games`. Full simulator parity remains unverified, especially repetition/chasing and unobserved hidden-state interactions. Automatic promotion remains blocked independently of the statistical result.

Run `./bot report` for the private local HTML report or `./bot export` to refresh the public aggregate files after future runs.
