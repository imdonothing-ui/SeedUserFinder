// Hybrid retrieval, stage 1 (rent-free, zero-dependency).
//
// The rule gate (domain anchor + pain/workaround signals) decides what is
// ALLOWED in; this stage decides the ORDER and which 30 reach Muse. Lexical
// scoring alone overweightes common words ("giving", "away", "help" match
// everywhere) — BM25's inverse document frequency fixes exactly that:
// words that appear in half the pool barely count, rare domain words count
// a lot. Title counts double (titles summarize the ask).
//
// Fusion is reciprocal rank fusion over two orderings — the rule score and
// the BM25 score — so neither signal can single-handedly promote junk:
// RRF only lifts what BOTH rank highly. matchScore stays rule-based (the
// gates and the "keyword match" pill read it); fusion changes only which
// candidates get saved and in what order they queue.
//
// Stage 2 (shipped, in actions.ts): a third ordering from a batched listwise
// Muse rerank — meaning, not words — fused in alongside the rule and BM25
// orderings. A local embedding backend (cosine vs the anchor queries) stays
// an optional future swap for cost/latency: it would replace the rerank call
// with a ~20-line ordering function, no fusion change needed. Blocked only
// by weight downloads (model hubs unreachable from the build sandbox).
function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length > 1);
}

// BM25 over an in-memory pool. Field weighting via repetition: title text
// counts twice. Returns keys ordered best-first.
export function bm25Order(queries: string[], docs: { key: string; title: string; body: string }[]): string[] {
  const qterms = tokenize(queries.join(" "));
  if (!qterms.length || !docs.length) return docs.map((d) => d.key);
  const toks = new Map<string, { tf: Map<string, number>; len: number }>();
  let totalLen = 0;
  for (const d of docs) {
    const ts = tokenize(`${d.title} ${d.title} ${d.body}`);
    const tf = new Map<string, number>();
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    toks.set(d.key, { tf, len: ts.length });
    totalLen += ts.length;
  }
  const n = docs.length;
  const avgLen = totalLen / n || 1;
  const df = new Map<string, number>();
  for (const { tf } of toks.values()) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  const scored = docs.map((d) => {
    const { tf, len } = toks.get(d.key)!;
    let s = 0;
    for (const t of qterms) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { key: d.key, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.key);
}

// Reciprocal rank fusion over any number of best-first orderings (k=60).
// Returns keys best-first; unknown keys (missing from an ordering) rank last.
export function fuseRanks(orders: string[][]): string[] {
  const keys = new Set<string>();
  for (const o of orders) for (const k of o) keys.add(k);
  const k = 60;
  const scored = [...keys].map((key) => {
    let s = 0;
    for (const o of orders) {
      const rank = o.indexOf(key);
      s += 1 / (k + (rank >= 0 ? rank + 1 : o.length + 1));
    }
    return { key, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.key);
}
