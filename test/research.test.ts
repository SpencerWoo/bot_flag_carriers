import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runResearchers,
  type ResearchMaster,
  type ResearchProposal,
} from "../src/research.js";
import {
  parseResearchProposal,
  researchEnvironment,
  type ModelJob,
} from "../src/research-runner.js";

const source = "export default ({ baseline }) => baseline();\n";
const master: ResearchMaster = {
  generation: 0,
  hash: "g0",
  head: "cafecafe",
  source,
};
const makeDirectory = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "flags-research-test-"));
function options(directory: string) {
  return {
    repo: process.cwd(),
    directory,
    deadline: Date.now() + 10000,
    maxIterations: 1,
    master: () => master,
    generate: async (job: ModelJob) => {
      fs.mkdirSync(job.worktree, { recursive: true });
      return { source, theory: "Evaluate " + job.agent };
    },
    screen: async (_p: ResearchProposal) => ({
      qualified: true,
      summary: "+3 of 12 seed pairs",
    }),
    submit: async (_p: ResearchProposal) => {},
  };
}

test("only one researcher runs and retains its artifact, parent, and feedback", async () => {
  const directory = makeDirectory(),
    opts = options(directory),
    submissions: ResearchProposal[] = [];
  try {
    const result = await runResearchers({
      ...opts,
      submit: (p) => {
        submissions.push(p);
      },
    });
    assert.deepEqual(
      result.map((r) => r.agent),
      ["carrier"],
    );
    assert.equal(submissions.length, 1);

    for (const p of submissions) {
      assert.equal(p.parent, master.hash);
      assert.equal(fs.readFileSync(p.file, "utf8"), p.source);
    }
    const feedback: string[] = [];
    await runResearchers({
      ...opts,
      generate: async (job) => {
        feedback.push(job.feedback);
        return opts.generate(job);
      },
    });
    assert.equal(feedback.length, 1);
    assert(feedback.every((x) => x.includes("+3 of 12 seed pairs")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("interrupted researchers reuse their completed model outputs at resume", async () => {
  const directory = makeDirectory(),
    opts = options(directory),
    signal = new AbortController();
  let generated = 0;
  try {
    await runResearchers({
      ...opts,
      signal: signal.signal,
      generate: async (job) => {
        generated++;
        return opts.generate(job);
      },
      screen: async () => {
        signal.abort();
        return { qualified: false, summary: "interrupted" };
      },
    });
    const before = generated;
    assert(before > 0);
    let accepted = 0;
    await runResearchers({
      ...opts,
      generate: async () => {
        throw Error("unexpected model re-run");
      },
      submit: () => {
        accepted++;
      },
    });
    assert.equal(accepted, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("Master advance invalidates the pending development result", async () => {
  const directory = makeDirectory(),
    opts = options(directory);
  try {
    let calls = 0,
      screened = 0;
    await runResearchers({
      ...opts,
      master: () =>
        ++calls === 1 ? master : { ...master, generation: 1, hash: "g1" },
      screen: async () => {
        screened++;
        return { qualified: true, summary: "unused" };
      },
    });
    assert.equal(screened, 0);
    const state = JSON.parse(
      fs.readFileSync(
        path.join(directory, "carrier", "1", "state.json"),
        "utf8",
      ),
    );
    assert.equal(state.stage, "stale");
    assert.equal(state.parent, "g0");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("model output enforces source limits and model process excludes game and publishing credentials", () => {
  assert.throws(
    () => parseResearchProposal('{"theory":"x","source":"wrong"}'),
    /self-contained/,
  );
  assert.throws(() => parseResearchProposal("a".repeat(145 * 1024)), /limit/);
  assert.deepEqual(
    parseResearchProposal(JSON.stringify({ theory: "x", source })),
    { theory: "x", source },
  );
  const env = researchEnvironment();
  for (const key of [
    "FLAG_CARRIERS_PASSWORD",
    "FLAG_CARRIERS_EMAIL",
    "FLAG_CARRIERS_DATA",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
  ])
    assert.equal(env[key], undefined);
});
test("an uncertain enqueue resumes the qualified artifact without rescreening", async () => {
  const directory = makeDirectory(),
    opts = options(directory);
  let generations = 0,
    screens = 0;
  try {
    await runResearchers({
      ...opts,
      generate: async (job) => {
        generations++;
        return opts.generate(job);
      },
      screen: async (p) => {
        screens++;
        return opts.screen(p);
      },
      submit: () => {
        throw Error("queue unavailable");
      },
    });
    let submissions = 0;
    await runResearchers({
      ...opts,
      generate: async () => {
        throw Error("unexpected generation");
      },
      screen: async () => {
        throw Error("unexpected rescreen");
      },
      submit: () => {
        submissions++;
      },
    });
    assert.equal(generations, 1);
    assert.equal(screens, 1);
    assert.equal(submissions, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the solo researcher uses the promoted Master and the referee's verdict on its next proposal", async () => {
  const directory = makeDirectory();
  const opts = options(directory);
  let latest = master;
  const parents: string[] = [],
    feedback: string[] = [];
  try {
    const researchers = await runResearchers({
      ...opts,
      maxIterations: 2,
      master: () => latest,
      generate: async (job) => {
        parents.push(job.master.hash);
        feedback.push(job.feedback);
        return opts.generate(job);
      },
      submit: async () => {
        latest = { ...master, generation: 1, hash: "new-master" };
        return { feedback: "Fresh qualification passed in 2,400 games." };
      },
    });
    assert.equal(researchers.length, 1);
    assert.equal(researchers[0].attempts, 2);
    assert.deepEqual(parents, ["g0", "new-master"]);
    assert.match(feedback[1], /Fresh qualification passed in 2,400 games/);
    assert(!fs.existsSync(path.join(directory, "inference")));
    assert(!fs.existsSync(path.join(directory, "threats")));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
