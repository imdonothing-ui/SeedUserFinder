// Agentic layer: one thin interface over the existing staged pipeline.
//
// Each specialist (Scout, Searchers, Judge, Drafter, Watcher) is an agent:
// prompt in, schema-validated value out, at most one validation retry. The
// retry carries the validator's complaint back to the agent; a second
// failure fails closed with that complaint named — never a silent stub.
//
// Deliberately NOT in this file: every trust decision stays deterministic
// code at the call site (anchor filtering, verbatim-quote check, the 60%
// hold, no-dummy blocking, single-count verdicts). LLMs propose; this file
// only standardizes how their output is validated and retried.
import { type Ctx } from "@hatch/space-sdk";

// Same shape as the pipeline's LlmFail, declared here so this module has no
// import cycle with actions.ts (structurally identical unions stay
// assignable across the boundary).
export type AgentFail = { ok: false; status: "not_configured" | "error"; message: string };
export type AgentOk<T> = { ok: true; value: T };
// What the agent hears about its own retry: which attempt this is, the
// validator's complaint about the previous output (null on first try), and
// the search run to narrate progress into (0 = no trace).
export type AgentAttempt = { n: number; feedback: string | null; runId: number };
export type AgentRun<I, T> = (ctx: Ctx, input: I, attempt: AgentAttempt) => Promise<AgentOk<T> | AgentFail>;
// A validator names the exact problem or returns null. Pure code only —
// never a model call, so validation can't hallucinate a pass.
export type AgentValidate<T, I> = (value: T, input: I) => string | null;
export type AgentDef<I, T> = {
  name: string;
  goal: string;
  run: AgentRun<I, T>;
  validate?: AgentValidate<T, I>;
  execute: (ctx: Ctx, input: I, runId?: number) => Promise<AgentOk<T> | AgentFail>;
};
export function defineAgent<I, T>(def: {
  name: string;
  goal: string;
  run: AgentRun<I, T>;
  validate?: AgentValidate<T, I>;
}): AgentDef<I, T> {
  async function execute(ctx: Ctx, input: I, runId = 0): Promise<AgentOk<T> | AgentFail> {
    let feedback: string | null = null;
    for (let n = 1; n <= 2; n++) {
      const r = await def.run(ctx, input, { n, feedback, runId });
      if (!r.ok) return r;
      if (!def.validate) return r;
      const problem = def.validate(r.value, input);
      if (!problem) return r;
      feedback = problem;
    }
    return { ok: false, status: "error", message: `${def.name} output failed validation twice (${feedback}) — nothing was saved.` };
  }
  return { ...def, execute };
}
