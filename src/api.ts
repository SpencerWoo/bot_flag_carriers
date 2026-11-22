import { read, save } from "./storage.js";
export const ORIGIN = "https://play.flag-carriers.workers.dev";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Client {
  private cookies: Record<string, string>;
  constructor() {
    this.cookies = read("session.json", {});
  }
  async request(method: string, url: string, body?: unknown): Promise<any> {
    if (!url.startsWith("/api/"))
      throw Error("Only game API paths are allowed");
    let res: Response;
    try {
      res = await fetch(ORIGIN + url, {
        method,
        redirect: "error",
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          Cookie: Object.entries(this.cookies)
            .map(([k, v]) => k + "=" + v)
            .join("; "),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new ApiError(
        0,
        "Network failure; reconcile state before further mutations",
      );
    }
    for (const raw of res.headers.getSetCookie()) {
      const pair = raw.split(";")[0],
        i = pair.indexOf("=");
      this.cookies[pair.slice(0, i)] = pair.slice(i + 1);
      save("session.json", this.cookies);
    }
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok)
      throw new ApiError(
        res.status,
        method === "POST" && url === "/api/login"
          ? "Login rejected"
          : String(data.error || `HTTP ${res.status}`).slice(0, 250),
      );
    return data;
  }
  async login() {
    const email = process.env.FLAG_CARRIERS_EMAIL,
      password = process.env.FLAG_CARRIERS_PASSWORD;
    if (!email || !password)
      throw Error("Set FLAG_CARRIERS_EMAIL and FLAG_CARRIERS_PASSWORD");
    await this.request("POST", "/api/login", { email, password });
    return this.me();
  }
  me() {
    return this.request("GET", "/api/me");
  }
  game(id: string) {
    if (!/^[\w-]+$/.test(id)) throw Error("Invalid game ID");
    return this.request("GET", "/api/games/" + id);
  }
  async act(id: string, action: unknown) {
    return this.request("POST", `/api/games/${id}/action`, action);
  }
  async create(mode: number, kind: "test" | "offline" | "friendly") {
    if (![3, 4].includes(mode)) throw Error("Mode must be 3 or 4");
    return this.request("POST", "/api/games", {
      players: mode,
      teams: false,
      ranked: false,
      offline: kind === "offline",
      testMode: kind === "test",
      clock: kind === "test" ? false : undefined,
      blind: true,
    });
  }
  async events(id: string, onView: (v: any) => void, signal: AbortSignal) {
    const res = await fetch(
      ORIGIN + "/api/events?game=" + encodeURIComponent(id),
      {
        headers: {
          Cookie: Object.entries(this.cookies)
            .map(([k, v]) => k + "=" + v)
            .join("; "),
        },
        signal,
      },
    );
    if (!res.ok || !res.body)
      throw new ApiError(res.status, "Event stream unavailable");
    let text = "",
      event = "message";
    for await (const chunk of res.body as any) {
      text += new TextDecoder().decode(chunk);
      let end;
      while ((end = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, end).replace(/\r$/, "");
        text = text.slice(end + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) {
          try {
            const d = JSON.parse(line.slice(5));
            if (d.view) onView(d.view);
            else if (event === "game" && d.id) onView(d);
          } catch {}
        }
      }
    }
  }
}
