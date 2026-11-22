import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { digest, checkout, jsonText } from "./master-git.js";
export const leagueDir = () =>
  path.resolve(
    process.env.FLAG_CARRIERS_LEAGUE_DATA ||
      path.join(
        process.env.FLAG_CARRIERS_DATA || path.join(checkout(), ".runtime"),
        "league",
      ),
  );
export function local(name: string) {
  return path.join(leagueDir(), name);
}
export function get<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(local(name), "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
function putBytes(file: string, content: string, immutable: boolean) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    if (immutable) {
      try {
        fs.linkSync(tmp, file);
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        return false;
      }
    } else fs.renameSync(tmp, file);
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function put(name: string, value: unknown) {
  putBytes(local(name), jsonText(value), false);
}
export function freeze(name: string, value: unknown) {
  return putBytes(local(name), jsonText(value), true);
}
export function pin(source: string) {
  const file = local("artifacts/" + digest(source) + ".mjs");
  putBytes(file, source, true);
  if (digest(fs.readFileSync(file)) !== digest(source))
    throw Error("Corrupt immutable policy artifact");
  return file;
}
export function list(dir: string) {
  try {
    return fs
      .readdirSync(local(dir))
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
export interface Submission {
  id: string;
  hash: string;
  parent: string;
  agent: string;
  theory: string;
  created: string;
}
export interface QueueEntry extends Submission {
  state: "queued" | "running" | "prepared" | "rejected" | "failed" | "promoted";
  run?: string;
  error?: string;
}
export function enqueueCandidate(input: {
  source: string;
  theory: string;
  agent: string;
  parent: string;
}): QueueEntry {
  const { source, theory, agent, parent } = input;
  if (
    typeof source !== "string" ||
    !source.trim() ||
    Buffer.byteLength(source) > 128 * 1024
  )
    throw Error("Policy must be 1–131072 UTF-8 bytes");
  if (
    !/^[a-f0-9]{64}$/.test(parent) ||
    typeof theory !== "string" ||
    !theory.trim() ||
    theory.length > 2000 ||
    typeof agent !== "string" ||
    !agent.trim() ||
    agent.length > 160
  )
    throw Error("Invalid candidate metadata");
  const hash = digest(source);
  if (hash === parent) throw Error("Candidate duplicates its parent Master");
  pin(source);
  const id = parent + "-" + hash;
  const sub = {
    id,
    hash,
    parent,
    theory,
    agent,
    created: new Date().toISOString(),
  };
  freeze("queue/" + id + ".json", sub);
  return entry(get("queue/" + id + ".json", sub));
}
export function entry(sub: Submission): QueueEntry {
  return {
    ...sub,
    ...get("states/" + sub.id + ".json", { state: "queued" as const }),
  };
}
export function queue() {
  return list("queue")
    .map((n) => entry(get<Submission>("queue/" + n, null!)))
    .sort(
      (a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id),
    );
}
export function hasPendingCandidates() {
  return queue().some((e) =>
    ["queued", "prepared", "running"].includes(e.state),
  );
}
export function update(
  id: string,
  status: Pick<QueueEntry, "state" | "run" | "error">,
) {
  put("states/" + id + ".json", status);
}
export async function refereeLock() {
  const hash = digest(leagueDir()).slice(0, 12);
  const server = net.createServer((socket) => socket.destroy());
  const addr =
    process.platform === "linux"
      ? { path: "\0flag-carriers-referee-" + hash }
      : {
          host: "127.0.0.1",
          port: 46000 + (parseInt(hash.slice(0, 4), 16) % 12000),
        };
  await new Promise<void>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "EADDRINUSE"
          ? Error("Master referee is already running for this league")
          : e,
      ),
    );
    server.listen(addr, resolve);
  });
  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
}
