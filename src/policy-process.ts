import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repo = fileURLToPath(
  new URL(
    fs.existsSync(new URL("../vendor", import.meta.url)) ? ".." : "../..",
    import.meta.url,
  ),
);
export function policyProcess(
  name: "league-worker" | "live-worker",
  directory: string,
  readDirectory = false,
) {
  const file = path.join(repo, "dist/src", name + ".js");
  if (!fs.existsSync(file))
    throw Error("Build the policy runner first with ./bot setup");
  const readable = ["dist", "vendor", "node_modules", "package.json"].map((f) =>
    path.join(repo, f),
  );
  if (readDirectory) readable.push(directory);
  return fork(file, [], {
    cwd: directory,
    env: { LANG: "C", TZ: "UTC" },
    execArgv: [
      "--permission",
      ...readable.map((f) => "--allow-fs-read=" + f),
      "--max-old-space-size=384",
    ],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
}
