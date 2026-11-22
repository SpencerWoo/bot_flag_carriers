# Flag Carriers Master league

One GPT-6.2 Astra researcher develops strategies for the three- and four-player Flag Carriers boards. It starts from the current **Master**, proposes one change, and plays it against Master. A separate referee decides promotions. [Master leaderboard](league/leaderboard.md) · [Website results](results/live-by-master.md) · [First research session](results/master-g0-research.md)

```sh
./bot setup
./bot leaderboard --sync
./bot learn --session first-league --minutes 120 --rounds 1 --live-games 0
./bot master queue
./bot report
```

`learn` runs one `gpt-6.2-astra` researcher at `ultra` reasoning effort through an authenticated Codex CLI. It uses the original winning researcher’s slot, `carrier`, and can change any part of the strategy. It fetches the latest published Master before each proposal. After a candidate passes development, the researcher waits for its independent qualification and any promotion. Its next proposal receives the development and qualification results.

Use `--rounds 1` for one proposal in this invocation, or omit it to iterate until the time budget expires. Reuse a session name to continue the same researcher’s notes and unfinished work. The historical inference and threats proposals stay available through `./bot master queue` and can be selected explicitly with `./bot master qualify --id SUBMISSION_ID`. The solo session allocates its self-play budget to the carrier researcher.

The launcher supports Node.js 24+ and bootstraps a checksum-verified Node 24.15.0 on Linux or macOS (x64 or arm64). Set `FLAG_CARRIERS_NODE` to use a particular executable. Set `FLAG_CARRIERS_WORKERS` to limit simulation concurrency. The pool respects the available CPUs. Research and qualification share those slots.

## How a generation earns the title

1. **Development.** Every seat runs a distinct policy instance with its own memory and random stream. Each proposal plays the Master on both boards with seat-swapped deals and fixed filler opponents. A 12-pair screen drops clearly losing ideas. The full development screen uses 48 pairs and requires an observed lead of three percentage points. The researcher receives the measured results.
2. **Qualification.** Freeze the submitted code. The referee draws 1,200 fresh seed pairs, 600 per board size. One challenger and one Master play in each game. The second game in the pair swaps their seats. Other seats use fixed policies and available past Masters. All 2,400 games must finish. A win by a third seat contributes zero to both win totals.
3. **Decision.** The challenger needs an observed win-rate lead of at least three percentage points, a positive lower confidence bound and no significant loss on either board. Each seed pair supplies one observation. The referee adjusts the evidence threshold for repeated challenges to a given generation. It also measures successful challengers against a fixed historical roster so generations have a common benchmark.
4. **Publication.** The winning source, qualification evidence, generation history and leaderboard advance in one Git commit. The push checks the expected remote head. A challenger overtaken by another promotion gets a fresh comparison against the new Master. The solo researcher fetches the latest published Master before each experiment. Interrupted qualifications reuse the frozen candidate and completed pairs.

The canonical branch defaults to `origin/main`. The referee fetches the public repository and first attempts a native Git push. On the canonical repository it can also use the authenticated Codex GitHub connector. That publisher verifies the prepared tree, the new commit’s parent and the expected branch head before advancing Master. `./bot master qualify --prepare` creates the exact publication files and expected Git head for a connected publisher. `./bot master publish` retries a prepared publication and reconciles an already-published commit. Keep one durable referee store (`FLAG_CARRIERS_LEAGUE_DATA`, default `.runtime/league/`) to preserve generation attempt counts and unfinished work.

```sh
./bot research --session openings --rounds 1 --minutes 30
./bot master submit --candidate candidate.mjs --agent my-agent --theory 'Clear the Marshal’s shortest route early'
./bot master qualify --minutes 120
./bot master status --sync
./bot leaderboard --sync
```

`research` runs the development stage against the latest published Master and queues passing submissions. `learn` includes research, qualification and any requested live games. `master qualify` processes one pending candidate. `./bot benchmark --pairs 12` measures arena throughput. Existing weight experiments remain available through `./bot tune`, `./bot evaluate`, `./bot match` and `./bot replay`.

## Policy interface

A policy is a self-contained JavaScript module. Its default export is called once per seat per game. The factory receives a seeded `random`, public board geometry, distances, legal actions, and a V0 baseline helper. `setup(view)` can choose the opening carrier rank. `observe(view)` receives public reveals between turns. `choose(view)` returns a legal move, fire or reinforcement action. The player sees its own ranks and public observations. Neither the hidden deal nor the scenario seed is included in its view.

```js
export default ({ baseline }) => {
  const player = baseline();
  return {
    setup: (view) => player.setup(view),
    observe: (view) => player.observe(view),
    choose: (view) => player.choose(view),
  };
};
```

## Playing on the website

```sh
./bot auth                 # reads FLAG_CARRIERS_EMAIL and FLAG_CARRIERS_PASSWORD
./bot auth --check
./bot live --mode 3 --kind offline --minutes 30
./bot validate
./bot report
./bot export
```

The website calls its unranked bot mode **Offline**. These games run on the actual service. `--kind friendly` creates a human lobby. `--id GAME_ID` selects an existing game. A new live match fetches and pins the published Master generation, journals player-visible observations, and restores its policy state on resume. The runner checks the chosen action against the server's legal list before submitting it. A lost response triggers state reconciliation. An unresolved submission is saved for inspection. Ranked and team play are disabled.

`learn` defaults to two hours and up to four live bot games, with 25% of the budget (up to 30 minutes) reserved for those games. Use `--live-games 0` for a local session. Website sign-in uses the two environment variables above. The session cookie, private traces and journals stay in `.runtime/`, which Git ignores. The public export contains aggregate results.

Master promotion measures local strength. The website restricts controlled test-game creation to administrators. `validate` checks observable transitions from ordinary live games, and the website report shows how each tested generation performed against the service bots. [Initial validation](results/README.md) · [Game rules sources](SOURCES.md)

Run `npm test` for the tests and production build, or `npm run check` for static type checking.
