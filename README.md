# Flag Carriers learning agent

A reproducible local strategy league and an authenticated player for [Flag Carriers](https://play.flag-carriers.workers.dev). Supports three- and four-player free-for-all games. Live play uses the server's legal actions and only information available to this account.

```sh
./bot setup
./bot auth --check
./bot match --mode 3 --seed 42
./bot replay
./bot live --mode 4 --kind offline --minutes 20
./bot validate
./bot learn --minutes 120 --live-games 4
./bot report
./bot export
```

`./bot` uses Node.js 24+ when installed, otherwise downloads Node 24.15.0 from nodejs.org and verifies its SHA-256. `./bot setup` installs locked dependencies and builds TypeScript. Set `FLAG_CARRIERS_NODE` to use a particular Node executable. Linux and macOS on x64 and arm64 are supported by the bootstrap.

## Authentication and privacy

For a fresh sign-in, supply `FLAG_CARRIERS_EMAIL` and `FLAG_CARRIERS_PASSWORD` through your shell's environment or secret manager, then run `./bot auth`. Do not put a password in a command-line argument or tracked file. `./bot auth --check` checks the saved session without requiring the password again.

The supplied account was authenticated during implementation. Only its session cookie is saved locally in `.runtime/session.json`, with owner-only permissions. Passwords are not persisted. `.runtime/`, environment files, logs, and dependencies are excluded from Git. The committed `.env.example` contains names only; the CLI does not automatically source `.env`.

All private runtime data stays under `.runtime/` (override with `FLAG_CARRIERS_DATA`). Reports and traces may contain game observations and player identifiers; keep the directory private. No chat, email, friend, profile, or account-management actions are implemented.

## Local learning

`match` runs a seeded local game without rendering or real-time delays. `--mode 3|4`, `--seed N`, and `--slot N` select the scenario. `replay` replays the most recent local match's saved actions. Each seat receives a masked view and its own memory; hidden ranks never enter the policy. Public reveals, surviving known ranks, graveyards, and army composition inform combat probabilities.

The initial policy protects and advances its flag, contests the bunker, considers probable exchanges and immediate threats, uses artillery and reinforcements, and penalizes repeated visits. Setup places the configured carrier rank on the flag's starting square. Search varies six decision weights and the carrier rank.

```sh
./bot evaluate --candidate candidate.example.json --games 600 --seed 100000
./bot learn --minutes 120 --rounds 1 --live-games 4
```

A learning round screens six challengers on 12 paired scenarios each, then evaluates the finalist on 600 fresh pairs, equally split between the two boards and balanced across seats. Each pair shares seed, seat, initial background armies, and roster. Background opponents include the champion and two fixed heuristic variants. Up to four isolated worker processes run pairs concurrently (`FLAG_CARRIERS_WORKERS=1` forces serial execution).

Promotion requires complete games, a positive one-sided 95% Hoeffding lower bound on paired win-rate improvement, no statistically significant regression on either board, and certified simulator parity. The bound is conservative and supports differences in [-1, 1]; repeated learning runs do not constitute a simultaneous lifetime guarantee. A sample of better-looking wins is insufficient for promotion. Draws count as non-wins. Unfinished or interrupted evaluations cannot promote a strategy.

Champion versions, parent versions, seeds, policy/engine fingerprints, paired results, and promotion decisions are saved. Historical champions are retained for rollback and inspection. Candidates and failed evaluations are also retained. An unchanged champion is a valid outcome. `./bot export` writes the champion, its history, and aggregate evaluation results into `strategies/` and `results/` for committing to Git. It omits credentials, account names, game identifiers, and private traces. A fresh clone reads the exported champion when no runtime champion exists.

## Live play and recovery

The website calls its unranked bot mode **Offline**; it still runs on the live website. This is the default. `--kind friendly` explicitly creates a human lobby; `--id GAME_ID` resumes a particular game. Ranked games and teams are rejected. One live game runs at a time, enforced by a process lock. The learning command starts at most four live bot games, and defaults to a two-hour total budget. It reserves 25% of that budget (up to 30 minutes) for live evaluation.

The runner handles setup, moves, artillery, and reinforcement choices. Decisions have a two-second policy budget. It uses the event stream when available, with polling as a fallback. Decisions are based on refreshed state; move submissions are never blindly retried after a lost response. Every accepted action is checkpointed, and SIGINT/SIGTERM requests a clean stop at the next action boundary.

Restart `./bot live` to resume the saved game. An unresolved `pending.json` blocks submission if the server state has not changed; inspect the game and recorded action before clearing it. Authentication failures, rate limiting, repeated action rejection, or a parity discrepancy stop play. Finished games clear the active checkpoint. A time limit checkpoints the game rather than automatically resigning. Human games retain their server clocks while the process is stopped.

## Validation status and limitation

The account can create live bot games, but `/api/games` returns **403: Only admins can create test games** for test mode. Therefore full controlled server parity cannot currently be established. `./bot validate` replays the collected observable transitions and checks movement/artillery geometry against server legal actions, respecting the server's repetition/chasing exclusions. These checks are useful but do not certify the local repetition/chasing model or every hidden-state transition.

**Automatic champion promotion remains blocked while full parity is unverified.** No current command silently turns partial validation into certification. Restoring an authorized controlled reference environment or obtaining authoritative engine fixtures is required before enabling this gate. Local search, saved candidates, statistical evaluation, and live bot play work independently of that gate. Do not interpret local win rates as measured performance against human players.

```sh
npm test
npm run check
npm run build
```

Tests cover both boards, special moves, combat, flag exchange and ownership, reinforcement, clocks, repetition, hidden-information isolation, checkpoint replay, seeded reproducibility, server-action selection, and the observed combat-reveal format. See [SOURCES.md](SOURCES.md) for the public board and rules assets used as references.
