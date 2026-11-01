// Deterministic offline stand-in for the founder's Muse model. It matches
// the prompt by content (runLlm prefixes a model line, so `includes`, never
// `startsWith`) and returns a canned, schema-valid value tagged [local-stub].
// Gate results (rules) are real; Muse verdicts under the stub are
// deliberately boring and must never be quoted as model quality.

import { z } from "zod";

function anchorFrom(prompt: string): { anchor: string; terms: string[] } {
  const anchor = prompt.match(/anchor term is "([^"]+)"/)?.[1] ?? "users";
  const terms = (prompt.match(/Valid anchor terms for queries: ([^\n]+)/)?.[1] ?? anchor)
    .split(",")
    .map((t) => t.trim().replace(/\.$/, ""))
    .filter(Boolean);
  return { anchor, terms: terms.length ? terms : [anchor] };
}

function expansionStub(prompt: string): unknown {
  const { anchor, terms } = anchorFrom(prompt);
  const t = terms[0] ?? anchor;
  const t2 = terms[1] ?? t;
  return {
    anchorTerm: anchor,
    queries: [
      { query: `${t} not working, need help`, intent: "[local-stub] pain phrasing" },
      { query: `struggling with ${t}`, intent: "[local-stub] struggle phrasing" },
      { query: `${t} alternative that actually works`, intent: "[local-stub] workaround phrasing" },
      { query: `how do you handle ${t2}`, intent: "[local-stub] question phrasing" },
      { query: `first time dealing with ${t}`, intent: "[local-stub] beginner framing" },
    ],
    painPhrases: [`${t} is exhausting`, `tired of fighting ${t2}`],
    adjacentProblems: [`[local-stub] adjacent problem around ${t}`],
    adjacentAudiences: ["[local-stub] adjacent audience"],
    communities: [
      { name: "[local-stub] open posters", where: "Bluesky", channel: "bluesky", access: "open", why: "[local-stub] open test community" },
      { name: "[local-stub] testers group", where: "Reddit", channel: "reddit", access: "closed", why: "[local-stub] closed test community" },
    ],
    relaxations: [`[local-stub] relax ${t2}`],
    nextSuggestions: ["[local-stub] try an adjacent audience next"],
  };
}

function classifyStub(prompt: string): unknown {
  const posts = [...prompt.matchAll(/--- POST \d+ \(id (\d+), channel ([^)]+)\) ---\nTitle: ([^\n]*)/g)];
  return {
    results: posts.map((m) => ({
      id: Number(m[1]),
      category: "seed_user",
      confidence: 70,
      reason: "[local-stub] deterministic verdict for offline testing",
      quote: "",
      rightPerson: true,
      realPain: true,
      workaroundOrPaying: false,
      recent: true,
    })),
  };
}

function draftStub(prompt: string): unknown {
  const title = prompt.match(/Their post \(by [^)]*\): Title: ([^\n]*)/)?.[1]?.trim().slice(0, 80) ?? "your post";
  return {
    draft: `[local-stub] Saw your post about "${title}" — I built something for exactly this pain. Would you be open to trying it for one real task and telling me where it breaks?`,
    toneCheck: "[local-stub] reads like a founder asking for help; verify before approving.",
  };
}

export async function complete<T>(prompt: string, opts: { schema: z.ZodType<T, any, any> }): Promise<T> {
  let value: unknown;
  if (prompt.includes("Build a search expansion plan")) value = expansionStub(prompt);
  else if (prompt.includes("Classify candidate seed users")) value = classifyStub(prompt);
  else if (prompt.includes("Write a first outreach message")) value = draftStub(prompt);
  else if (prompt.includes("Connection test:")) value = "ok [local-stub]";
  else if (prompt.includes("Expand a founder's plain problem description")) {
    value = {
      painPhrases: ["[local-stub] pain phrase one", "[local-stub] pain phrase two"],
      workaroundPhrases: ["[local-stub] workaround phrase"],
      exclusions: ["[local-stub] exclusion"],
    };
  } else if (prompt.includes("Extract the pain language")) value = { painLanguage: "[local-stub] extracted pain language" };
  else if (prompt.includes("Summarise seed-user feedback")) {
    value = { clusters: [], repeatedPainLanguage: [], followUpQuestions: ["[local-stub] what almost stopped you?"] };
  } else if (prompt.includes("Suggest ONE next experiment")) value = { experiment: "[local-stub] run one concierge test with five people this week and watch the core action." };
  else value = {};
  return (opts.schema as z.ZodTypeAny).parse(value) as T;
}
