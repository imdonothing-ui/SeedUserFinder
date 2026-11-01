// Localhost HTTP server: serves the locally built client and dispatches
// POST /actions to the REAL server action handlers. Open
// http://localhost:3107 (override with PORT=). For in-process tests without
// a port, see local/smoke.ts.

import { boot } from "./harness.ts";
import { Actions } from "../server/src/actions.ts";

const { ctx } = await boot();
const PORT = Number(process.env.PORT ?? 3107);
const dist = new URL("./dist/", import.meta.url).pathname;

function safePath(pathname: string): string | null {
  const clean = decodeURIComponent(pathname.split("?")[0]).replace(/^\/+/, "");
  if (!clean || clean.endsWith("/")) return "index.html";
  // resolveSync throws for missing files (SPA routes) — that is not
  // traversal; only ".." is ever rejected, before any file is touched.
  if (clean.includes("..")) return null;
  let resolved: string;
  try {
    resolved = Bun.resolveSync(`./${clean}`, dist) as string;
  } catch {
    return clean;
  }
  if (!resolved.startsWith(dist)) return null;
  return clean;
}

// Exported so the full HTTP contract (static serving + action dispatch) can
// be driven in-process where sockets are unavailable; Bun.serve below uses
// this same handler, so there is exactly one serving path.
export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "POST" && (url.pathname === "/actions" || url.pathname === "./actions")) {
    const { action, args } = (await req.json()) as { action: string; args: unknown };
    const def = (Actions as Record<string, { request: { parse(v: unknown): any }; response: { parse(v: unknown): any }; handler(ctx: unknown, args: any): Promise<unknown> }>)[action];
    if (!def) return Response.json({ error: `unknown action: ${action}` }, { status: 404 });
    try {
      return Response.json(def.response.parse(await def.handler(ctx, def.request.parse(args))));
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 500 });
    }
  }
  const rel = safePath(url.pathname);
  if (!rel) return new Response("not found", { status: 404 });
  const f = Bun.file(dist + rel);
  if (await f.exists()) return new Response(f);
  const index = Bun.file(dist + "index.html");
  if (await index.exists()) return new Response(index);
  return new Response("client not built — run: bun local/build-client.ts", { status: 404 });
}

if (!process.env.LOCAL_NO_SERVE) {
  Bun.serve({ port: PORT, fetch: handleRequest });
  console.log(`EarlyProof local → http://localhost:${PORT}`);
}
