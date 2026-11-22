import fs from "node:fs";
import path from "node:path";
import { root } from "./storage.js";
export let stopping = false;
export function requestStop() {
  stopping = true;
}
export function installSignals() {
  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
}
export function lock(name: string): () => void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, name + ".lock");
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid))
            fs.unlinkSync(file);
        } catch {}
      };
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw Error("Invalid lock file: " + file);
      try {
        process.kill(pid, 0);
      } catch (err: any) {
        if (err.code === "ESRCH") {
          fs.unlinkSync(file);
          continue;
        }
        throw err;
      }
      throw Error(`Another ${name} process is running (${pid})`);
    }
  throw Error("Could not acquire " + name + " lock");
}
