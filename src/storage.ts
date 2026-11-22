import fs from "node:fs";
import path from "node:path";
export const root = path.resolve(process.env.FLAG_CARRIERS_DATA || ".runtime");
export function save(name: string, value: unknown) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const p = path.join(root, name);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(p + ".tmp", p);
}
export function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
export function append(name: string, value: unknown) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(root, name), JSON.stringify(value) + "\n", {
    mode: 0o600,
  });
}
export function records(name: string): any[] {
  try {
    return fs
      .readFileSync(path.join(root, name), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((x) => JSON.parse(x));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
