# First Master league research session

Three independent GPT-6.2 Astra researchers used ultra reasoning effort to propose changes to G0. Each candidate played the same 48 development scenarios twice, with seats reversed. Third-seat wins count for neither bot.

| Theory | Challenger wins | G0 wins | Games | Win-rate lead | 3-player lead | 4-player lead |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Clear friendly pieces from the flag carrier’s route | 61 | 11 | 96 | +52.08 pp | +62.50 pp | +41.67 pp |
| Use visible rank evidence to avoid unfavorable recaptures | 23 | 17 | 96 | +6.25 pp | +12.50 pp | 0.00 pp |
| Screen for immediate enemy wins near the goal | 24 | 19 | 96 | +5.21 pp | +14.58 pp | −4.17 pp |

All three qualified for the referee queue. Promotion requires an independent 2,400-game qualification against the current Master. [Generation history and qualifications](../league/leaderboard.md)

## Self-play speed

On this host, 24 reference games took 14.853 CPU seconds with the original engine and 5.570 with the optimized engine, a 2.67× speedup. Throughput increased from 286 to 762 plies per CPU second. Both produced the same actions and winners across all 4,246 plies. The combined trajectory SHA-256 was `ca3e0f174a417fc79403bfc1a0702dc72f66a670aa93ab939b17c2265c657267`.

The comparison used Node 24.15.0 and the original engine at `f62a7e6f952a5225061172f5038f25d21ac9c448`. Four warmups used seeds 99000–99003. Measured seeds 12700–12723 alternated three- and four-player boards with rotating test seats and the original heuristic roster. The arena also has a separate mirrored-pair benchmark runnable with `./bot benchmark --pairs 12`. [Trajectory regression tests](../test/arena-match.test.ts)
