import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { stopping } from "./control.js";
export async function pairedJobs(
  jobs: any[],
  onPair: (pair: any, completed: number) => void,
  deadline = Infinity,
): Promise<any[]> {
  const count = Math.max(
    1,
    Math.min(
      4,
      Number(process.env.FLAG_CARRIERS_WORKERS) || os.availableParallelism(),
      jobs.length,
    ),
  );
  const results: any[] = [];
  let next = 0,
    complete = 0;
  await new Promise<void>((resolve, reject) => {
    const workers = new Set<ReturnType<typeof fork>>();
    let failed = false;
    const finish = () => {
      if (!workers.size && !failed) resolve();
    };
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      for (const w of workers) w.kill();
      reject(e);
    };
    const send = (w: ReturnType<typeof fork>) => {
      if (next >= jobs.length || stopping || Date.now() >= deadline) {
        workers.delete(w);
        w.disconnect();
        finish();
        return;
      }
      w.send({
        ...jobs[next++],
        deadline: Number.isFinite(deadline) ? deadline : undefined,
      });
    };
    for (let i = 0; i < count; i++) {
      const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const w = fork(
        fileURLToPath(new URL("./worker." + ext, import.meta.url)),
        [],
        {
          execArgv: ext === "ts" ? ["--import", "tsx"] : [],
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      workers.add(w);
      let diagnostics = "";
      w.stderr?.on("data", (d) => {
        diagnostics = (diagnostics + d).slice(-2000);
      });
      w.on("error", fail);
      w.on("exit", (code) => {
        if (workers.has(w) && !failed)
          fail(
            Error(
              "Evaluation worker exited unexpectedly: " + (diagnostics || code),
            ),
          );
      });
      w.on("message", (pair: any) => {
        if (pair.error) {
          fail(Error(pair.error));
          return;
        }
        results[pair.index] = pair;
        complete++;
        onPair(pair, complete);
        send(w);
      });
      send(w);
    }
  });
  return results.filter(Boolean);
}
