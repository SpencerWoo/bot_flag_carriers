# Flag Carriers Master leaderboard

Each row records the local free-for-all qualification against the preceding Master. Fixed-anchor win rates use the same G0 opponent, fillers and 120 paired seeds across generations. The two live board sizes have separate results in [the website results by Master generation](../results/live-by-master.md).

| Generation | Agent and theory | Parent | Master vs predecessor | Advantage (lower bound) | 3P / 4P edge | Seed pairs | Fixed-anchor win rate | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G2 | carrier · G0 showed that clearing a Marshal’s route can decide the opening race. My hypothesis is that a trailing player can recover by positioning a spy or artillery piece to attack RING one turn before the leading Marshal arrives. Against Master, I predict fewer rival deliveries and a higher win rate in games where a rival first gets within two moves of V. | `b39da925a820` | 45.5% vs 32.1% | 13.4 pp (9.7 pp) | 17.9 / 8.8 pp | 1200 | 61.7% | [Qualification](qualifications/g1-1-7487ca06c774.json) |
| G1 | carrier · V0 spends opening turns on unrelated moves when allies block its Marshal. I predict that choosing a route by the estimated turns needed to clear it, then moving the first ally that can step aside, will reduce the median own-turn count to first reach RING with the flag and increase the win rate against V0. | `3bd526b4cf8b` | 59.0% vs 14.2% | 44.8 pp (40.0 pp) | 54.7 / 34.9 pp | 1200 | 57.9% | [Qualification](qualifications/g0-1-beb232f2f941.json) |
| G0 | baseline · Original V0 heuristic | — | — | — | — | — | 27.5% | [Initial results](../results/README.md) |
