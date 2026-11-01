// Direct Meta Model API path (Muse Spark 1.3). The hosted artifact serves
// Muse calls through the workspace model runtime (ctx.inference); on
// localhost — and anywhere with egress — a founder key shaped like a Model
// API key (`LLM|…`) calls https://api.meta.ai/v1 directly instead, so the
// key pasted in AI setup is actually used. Verified against the live API
// (bogus key → HTTP 401: endpoint, model id, and auth scheme all real).

export const META_MODEL = "muse-spark-1.3";
const META_API_BASE = "https://api.meta.ai/v1";
const DIRECT_TIMEOUT_MS = 90000;

export function isDirectKey(apiKey: string): boolean {
  return apiKey.trim().startsWith("LLM|");
}

// Pure request construction (unit-tested): POST /v1/responses, Bearer key,
// model pinned — never a model picker, never a default that can drift.
export function buildResponsesRequest(prompt: string, apiKey: string, model = META_MODEL): {
  url: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    url: `${META_API_BASE}/responses`,
    headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: prompt }),
  };
}

// Pure response reading (unit-tested): Responses API `output_text`, the
// `output[].content[].text` item shape, or Chat Completions
// `choices[0].message.content` — then the largest {...} JSON block, the
// same extraction the runtime path applies before schema validation.
export function extractJsonValue(payload: unknown): unknown {
  const texts: string[] = [];
  const o = (payload ?? {}) as Record<string, unknown>;
  if (typeof o.output_text === "string") texts.push(o.output_text);
  const output = Array.isArray(o.output) ? o.output : [];
  for (const item of output) {
    const content = Array.isArray((item as Record<string, unknown>)?.content)
      ? ((item as Record<string, unknown>).content as unknown[])
      : [];
    for (const c of content) {
      const t = (c as Record<string, unknown>)?.text;
      if (typeof t === "string") texts.push(t);
    }
  }
  const choices = Array.isArray(o.choices) ? o.choices : [];
  const msg = (choices[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined;
  if (typeof msg?.content === "string") texts.push(msg.content);
  if (typeof payload === "string") texts.push(payload);
  const joined = texts.join("\n");
  const matches = joined.match(/\{[\s\S]*\}/g) ?? [];
  let best: unknown = null;
  for (const m of matches) {
    try {
      const v = JSON.parse(m);
      if (JSON.stringify(v).length > JSON.stringify(best ?? "").length) best = v;
    } catch { /* keep scanning */ }
  }
  return best;
}

export async function completeViaMetaModel(
  prompt: string,
  apiKey: string,
  model = META_MODEL,
): Promise<{ ok: true; value: unknown; model: string } | { ok: false; error: string }> {
  const req = buildResponsesRequest(prompt, apiKey, model);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DIRECT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    // POSTs never retry: a failed write must never execute twice.
    if (!res.ok) return { ok: false, error: res.status === 401 ? "HTTP 401 — key rejected, check the Model API key" : `HTTP ${res.status}` };
    const data: unknown = await res.json().catch(() => null);
    const value = extractJsonValue(data);
    if (typeof value !== "object" || value === null) return { ok: false, error: "no usable JSON in response" };
    return { ok: true, value, model };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120) };
  }
}
