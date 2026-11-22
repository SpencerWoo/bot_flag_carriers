import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { root, read, save } from "./storage.js";
import { currentMaster, digest } from "./master-git.js";
import { arenaPlayerView } from "./arena-view.js";
import { policyProcess } from "./policy-process.js";
import {
  actionKey,
  ARMY,
  board,
  legalActions,
  type Action,
  type Game,
  type Seat,
} from "./core.js";
export interface LivePin {
  generation: number;
  hash: string;
  source: string;
}
type GamePin = LivePin & { seeds: Partial<Record<Seat, number>> };
type Request = { kind: "observe" | "setup" | "choose"; seat: Seat; view: Game };
const staleView = Symbol("stale live move");
export class LiveMaster {
  readonly pin: GamePin;
  private child: ChildProcess;
  private tape: string;
  private dir: string;
  private chain: Promise<unknown> = Promise.resolve();
  private lastObservation = new Map<Seat, { move: number; key: string }>();
  private previous = new Map<string, { key: string; result: any }>();
  private constructor(id: string, pin: GamePin) {
    this.pin = pin;
    this.tape = path.join(root, "live-policy", id + ".jsonl");
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "flag-live-"));
    this.child = policyProcess("live-worker", this.dir);
  }
  static async open(id: string, seats: Seat[], requested?: LivePin) {
    if (!/^[\w-]+$/.test(id)) throw Error("Invalid live game ID");
    const name = "live-policy/" + id + ".json";
    let pin = read<GamePin | null>(name, null);
    if (!pin) {
      const master = requested ?? currentMaster();
      pin = {
        generation: master.generation,
        hash: master.hash,
        source: master.source,
        seeds: Object.fromEntries(
          seats.map((s) => [s, randomBytes(4).readUInt32BE()]),
        ),
      };
      if (digest(pin.source) !== pin.hash)
        throw Error("Pinned policy digest mismatch");
      save(name, pin);
    }
    if (digest(pin.source) !== pin.hash)
      throw Error("Pinned policy digest mismatch");
    const runner = new LiveMaster(id, pin);
    try {
      await runner.send({ kind: "init", ...pin }, 10000);
      if (fs.existsSync(runner.tape)) {
        const tape = fs.readFileSync(runner.tape);
        const end = tape.lastIndexOf(10) + 1;
        // A newline commits the request to the tape before any website action.
        if (end < tape.length) fs.truncateSync(runner.tape, end);
        const lines = tape.subarray(0, end).toString("utf8").split("\n");
        for (const line of lines.slice(0, -1)) {
          const request = JSON.parse(line) as Request;
          await runner.invoke(request, false);
        }
      }
      return runner;
    } catch (e) {
      runner.close();
      throw e;
    }
  }
  private send(message: unknown, timeout = 1900): Promise<any> {
    return new Promise((resolve, reject) => {
      const c = this.child;
      if (!c.connected) {
        reject(Error("Live policy worker is offline"));
        return;
      }
      const finish = (error?: Error, result?: any) => {
        clearTimeout(timer);
        c.off("message", reply);
        c.off("exit", exit);
        c.off("error", fail);
        if (error) reject(error);
        else resolve(result);
      };
      const exit = () =>
        finish(Error("Live policy exited before returning an action"));
      const fail = (e: Error) => finish(e);
      const reply = (m: any) =>
        m.error ? finish(Error(m.error)) : finish(undefined, m.result);
      const timer = setTimeout(() => {
        c.kill("SIGKILL");
        finish(Error("Live policy exceeded its decision budget"));
      }, timeout);
      c.once("message", reply);
      c.once("exit", exit);
      c.once("error", fail);
      c.send(message as object, (e) => {
        if (e) fail(e);
      });
    });
  }
  private async invoke(req: Request, record: boolean) {
    const key = JSON.stringify(req.view),
      slot = req.seat + req.kind;
    if (
      req.kind === "choose" &&
      (this.lastObservation.get(req.seat)?.move ?? -1) > req.view.moveCount
    )
      return staleView;
    if (req.kind === "observe") {
      const last = this.lastObservation.get(req.seat);
      if (last && (last.move > req.view.moveCount || last.key === key)) return;
    } else {
      const last = this.previous.get(slot);
      if (last?.key === key) return last.result;
    }
    const result = await this.send(req);
    if (record)
      fs.appendFileSync(this.tape, JSON.stringify(req) + "\n", { mode: 0o600 });
    if (req.kind === "observe")
      this.lastObservation.set(req.seat, { move: req.view.moveCount, key });
    else this.previous.set(slot, { key, result });
    return result;
  }
  private request(kind: Request["kind"], g: Game, seat: Seat) {
    const req = { kind, seat, view: arenaPlayerView(g, seat) };
    this.chain = this.chain.then(() => this.invoke(req, true));
    return this.chain;
  }
  async observe(g: Game) {
    for (const seat of g.mySeats)
      if (this.pin.seeds[seat] !== undefined)
        await this.request("observe", g, seat);
  }
  async choose(g: Game): Promise<Action | null> {
    const choices = legalActions(g);
    if (!choices.length) return null;
    const seat = choices[0].seat;
    await this.request("observe", g, seat);
    const decision = await this.request("choose", g, seat);
    if (decision === staleView) return null;
    const a = decision as Action;
    const legal = a && choices.find((item) => actionKey(a) === actionKey(item));
    if (!legal)
      throw Error("Master returned an action outside the server legal list");
    return legal;
  }
  async setup(g: Game, seat: Seat): Promise<Action | null> {
    const rank = (await this.request("setup", g, seat)) as string;
    if (!Object.hasOwn(ARMY, rank)) throw Error("Invalid Master setup");
    const carrier = g.pieces.find(
      (p) => p.owner === seat && p.pos === board(g.mode).flagStart[seat],
    );
    const chosen = g.pieces.find((p) => p.owner === seat && p.rank === rank);
    if (!carrier || !chosen || carrier.rank === rank) return null;
    return { type: "swap", seat, a: chosen.id, b: carrier.id };
  }
  close() {
    this.child.kill();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
