import type { ChildProcess } from "node:child_process";
import { policyProcess } from "./policy-process.js";
import { refereeFingerprint } from "./master-fingerprint.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { playArenaPair } from "./arena-match.js";
export interface LeaguePairJob {
  mode: 3 | 4;
  seed: number;
  slots?: [number, number];
  challenger: string;
  master: string;
  fillers?: string[];
}
type Result = Awaited<ReturnType<typeof playArenaPair>>;
type Priority = "development" | "qualification";
interface Options {
  priority: Priority;
  deadline: number;
  signal?: AbortSignal;
}
interface Task {
  initialRetries?: number;
  job: LeaguePairJob;
  options: Options;
  resolve: (r: Result) => void;
  reject: (e: Error) => void;
}
// A kernel-owned socket reserves a simulator slot across independent CLI sessions.
// Abstract Unix sockets disappear with their owner, including after a crash.
async function permit(slot: number): Promise<net.Server | null> {
  const uid = process.getuid?.() ?? 0;
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") resolve(null);
      else reject(e);
    });
    const addr =
      process.platform === "linux"
        ? { path: "\0flag-carriers-arena-" + uid + "-" + slot }
        : {
            host: "127.0.0.1",
            port: 44000 + (uid % 1000) * 16 + slot,
            exclusive: true,
          };
    server.listen(addr, () => resolve(server));
  });
}
export class LeaguePool {
  readonly size: number;
  readonly fingerprint = refereeFingerprint();
  private dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-referee-"));
  private files = new Map<string, { stamp: string; dest: string }>();
  private children = new Map<number, ChildProcess>();
  private completed = new WeakMap<ChildProcess, number>();
  private idle = new Set<number>();
  private tasks: Record<Priority, Task[]> = {
    development: [],
    qualification: [],
  };
  private active = new Map<number, () => void>();
  private stopped = false;
  private cursor = 0;
  private pumps = new Set<number>();
  private retry: NodeJS.Timeout | undefined;
  constructor(
    workers = Number(process.env.FLAG_CARRIERS_WORKERS) ||
      os.availableParallelism(),
  ) {
    this.size = Math.max(
      1,
      Math.min(os.availableParallelism(), 16, Math.floor(workers) || 1),
    );
    for (let i = 0; i < this.size; i++) this.idle.add(i);
  }
  private stage(file: string) {
    const stat = fs.statSync(file, { bigint: true }),
      stamp = `${stat.ino}/${stat.mtimeNs}/${stat.size}`;
    const known = this.files.get(file);
    if (known?.stamp === stamp) return known.dest;
    const contents = fs.readFileSync(file);
    const dest = path.join(
      this.dir,
      createHash("sha256").update(contents).digest("hex") + ".mjs",
    );
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, contents, { mode: 0o400 });
    this.files.set(file, { stamp, dest });
    return dest;
  }
  pair(job: LeaguePairJob, options: Options): Promise<Result> {
    if (
      this.stopped ||
      options.signal?.aborted ||
      Date.now() >= options.deadline
    )
      return Promise.reject(Error("League evaluation stopped"));
    const staged = {
      ...job,
      challenger: this.stage(job.challenger),
      master: this.stage(job.master),
      fillers: job.fillers?.map((f) => this.stage(f)),
    };
    return new Promise((resolve, reject) => {
      this.tasks[options.priority].push({
        job: staged,
        options,
        resolve,
        reject,
      });
      this.pump();
    });
  }
  private next() {
    // Qualification gets three turns in four when both queues have work.
    const priority: Priority =
      this.cursor++ % 4 === 0 ? "development" : "qualification";
    return (
      this.tasks[priority].shift() ??
      this.tasks[
        priority === "development" ? "qualification" : "development"
      ].shift()
    );
  }
  private pump() {
    if (
      this.stopped ||
      (!this.tasks.development.length && !this.tasks.qualification.length)
    )
      return;
    for (const slot of this.idle) {
      if (this.pumps.has(slot)) continue;
      this.pumps.add(slot);
      void permit(slot)
        .then((lock) => {
          this.pumps.delete(slot);
          if (!lock) {
            if (!this.stopped && !this.retry)
              this.retry = setTimeout(() => {
                this.retry = undefined;
                this.pump();
              }, 40);
            return;
          }
          const task = this.next();
          if (!task || this.stopped) {
            lock.close();
            return;
          }
          this.idle.delete(slot);
          this.run(slot, task, lock);
        })
        .catch((error) => {
          this.pumps.delete(slot);
          this.next()?.reject(error);
          this.pump();
        });
    }
  }
  private worker(slot: number) {
    const existing = this.children.get(slot);
    if (existing?.connected) return existing;
    const child = policyProcess("league-worker", this.dir, true);
    this.children.set(slot, child);
    child.on("exit", () => {
      if (this.children.get(slot) === child) this.children.delete(slot);
    });
    return child;
  }
  private run(slot: number, task: Task, lock: net.Server) {
    let child: ChildProcess | undefined,
      timer: NodeJS.Timeout | undefined,
      done = false;
    const finish = (error?: Error, result?: Result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      task.options.signal?.removeEventListener("abort", stop);
      child?.removeListener("message", reply);
      child?.removeListener("exit", exit);
      child?.removeListener("error", fail);
      const completed = child ? (this.completed.get(child) ?? 0) + 1 : 0;
      if (child) this.completed.set(child, completed);
      // Recycle V8 realms between complete pairs. This bounds retained memory
      // across long qualifications without resetting any player during play.
      if (child && (error || completed >= 64)) {
        this.children.delete(slot);
        child.kill("SIGKILL");
      }
      this.active.delete(slot);
      this.idle.add(slot);
      lock.close(() => {
        const retryInitialization =
          error &&
          /Script execution timed out after 1500ms/.test(error.message) &&
          !task.initialRetries &&
          !this.stopped &&
          !task.options.signal?.aborted &&
          Date.now() < task.options.deadline;
        if (retryInitialization) {
          task.initialRetries = 1;
          this.tasks[task.options.priority].unshift(task);
        } else if (error) task.reject(error);
        else task.resolve(result!);
        this.pump();
      });
    };
    const exit = () => finish(Error("Referee worker exited during match"));
    const stop = () => finish(Error("League evaluation stopped"));
    const fail = (e: Error) => finish(e);
    const reply = (m: any) =>
      m.error
        ? finish(Error(String(m.error)))
        : finish(undefined, m.result as Result);
    try {
      if (task.options.signal?.aborted || Date.now() >= task.options.deadline) {
        stop();
        return;
      }
      child = this.worker(slot);
      this.active.set(slot, stop);
      child.once("message", reply);
      child.once("exit", exit);
      child.once("error", fail);
      task.options.signal?.addEventListener("abort", stop, { once: true });
      timer = setTimeout(
        () => finish(Error("Referee pair exceeded its time budget")),
        Math.min(120000, Math.max(1, task.options.deadline - Date.now())),
      );
      child.send({ job: task.job, fingerprint: this.fingerprint }, (e) => {
        if (e) fail(e);
      });
    } catch (e) {
      fail(e instanceof Error ? e : Error(String(e)));
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.retry);
    for (const q of Object.values(this.tasks))
      for (const task of q.splice(0)) task.reject(Error("League pool closed"));
    for (const stop of [...this.active.values()]) stop();
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
