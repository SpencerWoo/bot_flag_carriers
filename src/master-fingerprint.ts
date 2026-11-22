import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
// Workers execute built JavaScript even when the CLI itself runs from TS.
const directory = fileURLToPath(new URL(".", import.meta.url));
const repo = fs.existsSync(path.join(directory, "../vendor"))
  ? path.join(directory, "..")
  : path.join(directory, "../..");
export function refereeFingerprint() {
  const files = [
    "core",
    "simulator",
    "strategy",
    "arena-threats",
    "arena-match",
    "arena-policy",
    "arena-view",
    "league-worker",
    "master-fingerprint",
  ].map((m) => "dist/src/" + m + ".js");
  const hash = createHash("sha256").update(process.version);
  for (const file of [...files, "vendor/board3.cjs", "vendor/rules-core.cjs"])
    hash
      .update("\0" + file + "\0")
      .update(fs.readFileSync(path.join(repo, file)));
  return hash.digest("hex");
}
