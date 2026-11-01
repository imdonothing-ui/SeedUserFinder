import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type State = ApiResponse<typeof api, "getState">;
type Lead = State["leads"][number];
type Profile = State["profiles"][number];
type FeedbackEntry = State["feedback"][number];
type Summary = State["summaries"][number];

const LLM_CAT_LABEL: Record<string, string> = { seed_user: "Likely seed user", curious: "Curious clicker", irrelevant: "Irrelevant" };
function parseJsonArr(s: string): string[] { try { const v = JSON.parse(s || "[]") as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; } }
function parseJsonObj(s: string): Record<string, unknown> { try { const v = JSON.parse(s || "{}") as unknown; return v && typeof v === "object" ? (v as Record<string, unknown>) : {}; } catch { return {}; } }

type ExpansionCommunity = { name: string; where: string; channel: string; access: string; why: string };
type ExpansionPlanData = { anchorTerm: string; queries: { query: string; intent: string }[]; painPhrases: string[]; adjacentProblems: string[]; adjacentAudiences: string[]; communities: ExpansionCommunity[]; relaxations: string[]; nextSuggestions: string[]; droppedUnanchored: number };
function parsePlan(s: string): ExpansionPlanData {
  const o = parseJsonObj(s);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const queries = (Array.isArray(o.queries) ? o.queries : []).map((q) => { const r = (q && typeof q === "object" ? q : {}) as Record<string, unknown>; return { query: String(r.query ?? ""), intent: String(r.intent ?? "") }; }).filter((q) => q.query);
  const communities = (Array.isArray(o.communities) ? o.communities : []).map((c) => { const r = (c && typeof c === "object" ? c : {}) as Record<string, unknown>; return { name: String(r.name ?? ""), where: String(r.where ?? ""), channel: String(r.channel ?? ""), access: String(r.access ?? "open"), why: String(r.why ?? "") }; }).filter((c) => c.name);
  return { anchorTerm: String(o.anchorTerm ?? ""), queries, painPhrases: strs(o.painPhrases), adjacentProblems: strs(o.adjacentProblems), adjacentAudiences: strs(o.adjacentAudiences), communities, relaxations: strs(o.relaxations), nextSuggestions: strs(o.nextSuggestions), droppedUnanchored: typeof o.droppedUnanchored === "number" ? o.droppedUnanchored : 0 };
}

const CHANNEL_LABEL: Record<string, string> = {
  bluesky: "Bluesky", hackernews: "Hacker News", github: "GitHub", stackexchange: "Stack Exchange",
  agingcare: "AgingCare", mumsnet: "Mumsnet", reddit_poc: "Reddit · POC",
  reddit: "Reddit · pasted", x: "X · pasted", facebook: "Facebook Group", discord: "Discord",
  slack: "Slack", linkedin: "LinkedIn DM", instagram: "Instagram DM", manual: "Manual",
};
const NEW_CHANNELS = new Set(["stackexchange", "agingcare", "mumsnet"]);
const STAGES = ["new", "drafted", "approved", "sent", "replied", "conversation", "trial"] as const;
const STAGE_LABEL: Record<string, string> = { new: "Found", drafted: "Drafted", approved: "Approved", sent: "Sent", replied: "Replied", conversation: "Conversation", trial: "In trial", dismissed: "Dismissed" };
const EVENT_TYPES = ["started", "core", "returned", "paid", "referred"] as const;
const EVENT_LABEL: Record<string, string> = { started: "Started", core: "Core action", returned: "Came back", paid: "Paid", referred: "Referred" };

function fmtDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

const inputCls = "w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]";
const labelCls = "block text-xs font-semibold uppercase tracking-wide text-[var(--dim)] mb-1";
const btnPrimary = "rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--accent-text)] disabled:opacity-50";
const btnGhost = "rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm font-medium text-[var(--text)] disabled:opacity-50";
const btnSmall = "rounded-full border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1 text-xs font-medium text-[var(--text)] disabled:opacity-50";

function LlmSetupGate({ onGoSettings }: { onGoSettings: () => void }) {
  return (
    <section className="mt-5 rounded-[var(--radius)] border-2 border-[var(--amber)] bg-[var(--surface)] p-5" aria-label="Muse LLM setup required">
      <h2 className="font-serif text-xl font-bold">Step 2 — Configure AI (one-time setup)</h2>
      <p className="mt-2 text-sm leading-relaxed">Your target profile (Step 1) is done. Now configure Muse — this is a one-time step: the configuration is saved and persists, so you will not be asked again on the next search or visit. You can still change it later anytime from <strong>Edit AI config</strong> in the AI settings. EarlyProof runs on Muse: pain-language expansion, lead classification, outreach drafts, feedback summaries and next-experiment suggestions are core steps of the flow — not optional add-ons — and there is no rule-only fallback mode. Until Muse is configured, search, classification, drafts and the rest of the core flow stay blocked.</p>
      <p className="mt-2 text-sm leading-relaxed"><strong>What to do:</strong> open the AI settings in this app and enter <strong>your Muse API key</strong> there — models are picked automatically, so there is nothing else to configure. Enter it <strong>in the app only — never in chat</strong>. Your key is stored server-side and never shown again beyond its last 4 characters.</p>
      <p className="mt-2 text-sm text-[var(--dim)]">The rule-based relevance check still runs underneath as a pre-filter and safety net — but on its own it clears nobody for outreach. Every lead must be classified by Muse before it can be used, and nothing ever posts without you approving the exact text.</p>
      <button type="button" className={btnPrimary + " mt-3"} onClick={onGoSettings}>Open AI settings</button>
    </section>
  );
}

const WORKFLOW_STEPS = [
  { n: 1, title: "Create target profile", hint: "Product, what it does, whose pain" },
  { n: 2, title: "Configure AI key", hint: "Once — it persists; edit anytime" },
  { n: 3, title: "Search channels", hint: "Open channels, picked per profile" },
  { n: 4, title: "Synthesized results", hint: "Shown only after Muse synthesis" },
] as const;

function WorkflowStepper({ current, done, onStep }: { current: number; done: boolean[]; onStep: (n: number) => void }) {
  return (
    <ol aria-label="EarlyProof workflow" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
      {WORKFLOW_STEPS.map((s, i) => {
        const isDone = !!done[i];
        const isCurrent = current === s.n;
        return (
          <li key={s.n}>
            <button type="button" aria-current={isCurrent ? "step" : undefined} onClick={() => onStep(s.n)} className={`h-full w-full rounded-[var(--radius)] border p-2.5 text-left ${isCurrent ? "border-[var(--accent)] bg-[var(--surface)] shadow-sm" : "border-[var(--border)] bg-[var(--surface-alt)]"}`}>
              <span className="flex items-center gap-1.5 text-[13px] font-bold">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ${isDone ? "bg-[var(--accent)] text-[var(--accent-text)]" : isCurrent ? "border-2 border-[var(--accent)] text-[var(--accent)]" : "border border-[var(--border)] text-[var(--dim)]"}`}>{isDone ? "✓" : s.n}</span>
                Step {s.n}
              </span>
              <span className="mt-1 block text-[13px] font-semibold leading-tight">{s.title}</span>
              <span className="mt-0.5 block text-[11px] leading-tight text-[var(--dim)]">{s.hint}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function AiConfigStatus({ llm, onEdit }: { llm?: State["llm"]; onEdit: () => void }) {
  if (!llm?.configured) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm" aria-label="AI configuration status">
      <span className="rounded-full bg-[var(--accent-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--accent)]">AI configured ✓</span>
      <span className="text-[var(--dim)]">Muse · key {llm.keyHint || "saved"} · models automatic</span>
      <span className="text-[var(--dim)]">Saved once — you won't be asked again.</span>
      <button type="button" className={btnGhost + " ml-auto"} onClick={onEdit}>Edit AI config</button>
    </div>
  );
}

function VersionHeader() {
  const vQ = useQuery({ queryKey: ["version"], queryFn: () => api.getVersion({}), staleTime: 60000 });
  return (
    <header className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="font-serif text-2xl font-bold">EarlyProof</h1>
        {vQ.data && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--dim)]" title="App version · git commit — so you always know which build you're testing">{vQ.data.label}</span>}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">As AI makes building cheap, finding users is the bottleneck. EarlyProof finds your first seed users where they already talk about the pain — then drafts the outreach, tracks replies, and follows the cohort. Asking any LLM to search gives you a list; EarlyProof runs the loop: anchored matching, Muse verdicts with evidence, approve-first outreach, reply nudges, and cohort tracking.</p>
    </header>
  );
}

function DemoButton({ onDone, flash }: { onDone: (profileId: number) => void; flash: (m: string) => void }) {
  const demo = useMutation({
    mutationFn: () => api.seedDemoData({}),
    onSuccess: (r) => { if (r.ok) { onDone(r.profileId); flash("Demo workspace seeded — profile, leads, invite, events and one reply nudge. Explore every tab."); } else flash(r.message); },
    onError: () => flash("Demo seeding failed — try again."),
  });
  return <button type="button" className={btnPrimary} disabled={demo.isPending} onClick={() => demo.mutate()}>{demo.isPending ? "Seeding…" : "Try the demo workspace"}</button>;
}

export function App() {
  const qc = useQueryClient();
  const stateQ = useQuery({ queryKey: ["state"], queryFn: () => api.getState({}) });
  const [tab, setTab] = useState<"queue" | "tracker" | "cohort" | "ai" | "channels">("queue");
  const [profileId, setProfileId] = useState<number | null>(null);
  const [showProfileForm, setShowProfileForm] = useState(false);
  const [notice, setNotice] = useState("");

  const data = stateQ.data;
  const profiles = data?.profiles ?? [];
  const activeProfile: Profile | undefined = profiles.find((p) => p.id === profileId) ?? profiles[0];
  const leads = useMemo(() => (data?.leads ?? []).filter((l) => !activeProfile || l.profileId === activeProfile.id), [data, activeProfile]);
  const invites = useMemo(() => (data?.invites ?? []).filter((i) => !activeProfile || i.profileId === activeProfile.id), [data, activeProfile]);
  const events = data?.events ?? [];
  const insights = useMemo(() => (data?.insights ?? []).filter((i) => !activeProfile || i.profileId === activeProfile.id), [data, activeProfile]);
  const feedback = useMemo(() => (data?.feedback ?? []).filter((f) => !activeProfile || f.profileId === activeProfile.id), [data, activeProfile]);
  const summaries = useMemo(() => (data?.summaries ?? []).filter((s) => !activeProfile || s.profileId === activeProfile.id), [data, activeProfile]);
  const llm = data?.llm;

  const invalidate = () => qc.invalidateQueries({ queryKey: ["state"] });
  const flash = (m: string) => { setNotice(m); window.scrollTo({ top: 0, behavior: "smooth" }); };

  // The 4-step workflow, in order. Step 2 is done once: the Muse config
  // persists server-side, so a configured founder is never re-prompted —
  // they only see the status card with an Edit AI config option.
  const hasProfile = profiles.length > 0;
  const aiConfigured = !!llm?.configured;
  const hasSynthesized = (data?.leads ?? []).some((l) => !!l.llmCategory);
  const currentStep = !hasProfile ? 1 : !aiConfigured ? 2 : tab === "queue" && hasSynthesized ? 4 : 3;
  const stepDone = [hasProfile, aiConfigured, hasSynthesized, hasSynthesized];
  const goStep = (n: number) => {
    if (n === 1) { setShowProfileForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else if (n === 2) setTab("ai");
    else setTab("queue");
  };

  if (stateQ.isPending) return <div className="min-h-screen bg-[var(--bg)] px-4 py-16 text-center text-sm text-[var(--dim)]">Loading EarlyProof…</div>;
  if (stateQ.error) return <div className="min-h-screen bg-[var(--bg)] px-4 py-16 text-center text-sm text-[var(--red)]">Couldn’t load your workspace. Pull to retry.</div>;

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-4 pb-28 pt-5">
        <VersionHeader />
        <WorkflowStepper current={currentStep} done={stepDone} onStep={goStep} />
        <AiConfigStatus llm={llm} onEdit={() => setTab("ai")} />
        {/* Step 1 — Profile bar */}
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="profile-select" className={labelCls}>Step 1 · Target profile</label>
            {profiles.length ? (
              <select id="profile-select" aria-label="Active target profile" value={activeProfile?.id ?? ""} onChange={(e) => setProfileId(Number(e.target.value))} className={inputCls}>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.productName} — {p.audience || "no audience set"}</option>)}
              </select>
            ) : (
              <p className="text-sm text-[var(--dim)]">No profile yet. Your target profile is what every match is scored against.</p>
            )}
          </div>
          <button type="button" className={btnPrimary} onClick={() => setShowProfileForm((v) => !v)}>{profiles.length ? "New / edit profile" : "Create target profile"}</button>
        </div>

        {activeProfile && !showProfileForm && (
          <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
            <p><span className="font-semibold">{activeProfile.productName}</span> <span className="text-[var(--dim)]">— {activeProfile.productDesc || "no description"}</span></p>
            <p className="mt-1"><span className="font-semibold">Whose pain:</span> {activeProfile.audience || "—"}{activeProfile.pain ? ` — ${activeProfile.pain}` : ""}</p>
            {parseJsonArr(activeProfile.painPhrases).length > 0 && <p className="mt-1"><span className="font-semibold">AI pain phrases:</span> {parseJsonArr(activeProfile.painPhrases).slice(0, 4).join(" · ")}{parseJsonArr(activeProfile.painPhrases).length > 4 ? " …" : ""} <span className="text-[var(--dim)]">(full list in the AI tab)</span></p>}
          </div>
        )}

        {showProfileForm && (
          <ProfileForm
            existing={activeProfile}
            onDone={(id) => { setShowProfileForm(false); if (id) setProfileId(id); invalidate(); }}
            onClose={() => setShowProfileForm(false)}
          />
        )}

        {notice && (
          <div role="status" className="mt-3 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--green-bg)] p-3 text-sm">{notice}
            <button type="button" aria-label="Dismiss message" className="float-right font-bold" onClick={() => setNotice("")}>×</button>
          </div>
        )}

        {/* Tabs */}
        <nav aria-label="Sections" className="mt-5 grid grid-cols-5 gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-1">
          {([["queue", "Search & results"], ["tracker", "Tracker"], ["cohort", "Cohort"], ["ai", "AI settings"], ["channels", "Channels"]] as const).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)} className={`rounded-[8px] px-1 py-2 text-[12px] font-semibold ${tab === k ? "bg-[var(--surface)] shadow-sm" : "text-[var(--dim)]"}`}>{label}</button>
          ))}
        </nav>

        {/* Step order: profile (1) comes before AI config (2). A founder with
            no profile sees the Step 1 prompt, not the AI gate. A configured
            founder never sees the gate again — only the Edit AI config
            option in the status card above and the AI settings tab. */}
        {!activeProfile && tab !== "channels" && tab !== "ai" && (
          <div className="mt-6 rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">
            <p><strong className="text-[var(--text)]">Step 1:</strong> create a target profile first — product, what it does, whose pain it solves. Everything in EarlyProof matches against that. Configuring AI is Step 2, after the profile.</p>
            <div className="mt-3"><DemoButton onDone={(id) => { setProfileId(id); invalidate(); }} flash={flash} /></div>
          </div>
        )}

        {activeProfile && !llm?.configured && tab !== "ai" && tab !== "channels" && <LlmSetupGate onGoSettings={() => setTab("ai")} />}

        {llm?.configured && activeProfile && tab === "queue" && <QueueTab profile={activeProfile} leads={leads} expansions={(data?.expansions ?? []).filter((x) => x.profileId === activeProfile.id)} llmConfigured={!!llm?.configured} connections={data?.connections ?? []} onGoChannels={() => setTab("channels")} flash={flash} invalidate={invalidate} />}
        {llm?.configured && activeProfile && tab === "tracker" && <TrackerTab leads={leads} profile={activeProfile} followups={(data?.followups ?? []).filter((f) => f.profileId === activeProfile.id)} flash={flash} invalidate={invalidate} />}
        {llm?.configured && activeProfile && tab === "cohort" && <CohortTab profile={activeProfile} leads={leads} invites={invites} events={events} summaries={summaries} llmConfigured={!!llm?.configured} posthog={data?.posthog.find((p) => p.profileId === activeProfile.id)} flash={flash} invalidate={invalidate} />}
        {tab === "ai" && <AiTab profile={activeProfile} llm={llm} feedback={feedback} summaries={summaries} flash={flash} invalidate={invalidate} goCreateProfile={() => setShowProfileForm(true)} />}
        {tab === "channels" && <ChannelsTab connections={data?.connections ?? []} profile={activeProfile} insights={insights} llmConfigured={!!llm?.configured} flash={flash} invalidate={invalidate} />}
      </main>
    </div>
  );
}

function ProfileForm({ existing, onDone, onClose }: { existing?: Profile; onDone: (id?: number) => void; onClose: () => void }) {
  const blank = { productName: "", productDesc: "", audience: "", pain: "", workaround: "", keywords: "", coreAction: "" };
  // The form shows three fields; the rest travel through untouched so an
  // edit never wipes keywords, workaround or core action.
  const fromExisting = () => ({ ...blank, productName: existing?.productName ?? "", productDesc: existing?.productDesc ?? "", audience: existing?.audience ?? "", pain: existing?.pain ?? "", workaround: existing?.workaround ?? "", keywords: existing?.keywords ?? "", coreAction: existing?.coreAction ?? "" });
  const [f, setF] = useState(fromExisting);
  const [editing, setEditing] = useState(false);
  // Resync when the async profile loads or the founder switches profiles —
  // otherwise the form shows the previous (or empty) profile's values.
  useEffect(() => { setF(fromExisting()); setEditing(false); }, [existing?.id]);
  const create = useMutation({ mutationFn: () => api.createProfile(f), onSuccess: (r) => onDone(r.id) });
  const update = useMutation({ mutationFn: () => api.updateProfile({ id: existing?.id ?? 0, ...f }), onSuccess: () => onDone() });
  const del = useMutation({ mutationFn: () => api.deleteProfile({ id: existing?.id ?? 0 }), onSuccess: () => onDone() });
  const set = (k: "productName" | "productDesc" | "audience" | "pain") => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  return (
    <form className="mt-3 space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (editing && existing) update.mutate(); else create.mutate(); }}>
      <h2 className="font-serif text-lg font-bold">Step 1 — Target profile</h2>
      <p className="text-sm text-[var(--dim)]">Three fields. This is the first step — everything else (AI config, search, synthesis) builds on this profile. Be narrow. “New parents whose baby wakes at 5am” finds people; “parents” finds nobody.</p>
      <div><label htmlFor="pf-name" className={labelCls}>Product name</label><input id="pf-name" aria-label="Product name" required value={f.productName} onChange={set("productName")} className={inputCls} placeholder="e.g. DawnFeed" /></div>
      <div><label htmlFor="pf-desc" className={labelCls}>What it does, in one line</label><input id="pf-desc" aria-label="What your product does" value={f.productDesc} onChange={set("productDesc")} className={inputCls} placeholder="e.g. Tracks night feeds and predicts the next wake window" /></div>
      <div><label htmlFor="pf-aud" className={labelCls}>Whose problem it solves — and what that problem is, in their words</label><textarea id="pf-aud" aria-label="Whose problem and what problem" rows={3} value={f.audience ? `${f.audience}${f.pain ? ` — ${f.pain}` : ""}` : f.pain} onChange={(e) => { const v = e.target.value; const i = v.indexOf(" — "); setF((prev) => ({ ...prev, audience: i >= 0 ? v.slice(0, i) : v, pain: i >= 0 ? v.slice(i + 3) : "" })); }} className={inputCls} placeholder="e.g. First-time parents in the first 6 months — I never know if she'll sleep through or wake screaming at 5am" /></div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={btnPrimary} disabled={create.isPending || update.isPending}>{editing && existing ? "Save changes" : "Create profile"}</button>
        {existing && !editing && <button type="button" className={btnGhost} onClick={() => setEditing(true)}>Edit this profile instead</button>}
        {existing && <button type="button" className={btnGhost} onClick={() => { if (window.confirm("Delete this profile and everything under it (leads, invites, events, nudges)?")) del.mutate(); }}>Delete profile</button>}
        <button type="button" className={btnGhost} onClick={onClose}>Close</button>
      </div>
      {(create.error || update.error) && <p className="text-sm text-[var(--red)]">Saving failed — try again.</p>}
    </form>
  );
}

function QueueTab({ profile, leads, expansions, llmConfigured, connections, onGoChannels, flash, invalidate }: { profile: Profile; leads: Lead[]; expansions: State["expansions"]; llmConfigured: boolean; connections: State["connections"]; onGoChannels: () => void; flash: (m: string) => void; invalidate: () => void }) {
  // Step 3 default: ALL open channels are searched. Open channels are the
  // public, searchable ones that need no founder-provided API or account
  // connection — Bluesky, Hacker News, GitHub, Stack Exchange, AgingCare and
  // Mumsnet. Closed channels are never in this default list.
  const OPEN_DEFAULTS = ["bluesky", "hackernews", "github", "stackexchange", "agingcare", "mumsnet"];
  const [channels, setChannels] = useState<string[]>(OPEN_DEFAULTS);
  // Profile-aware picks: which channels fit THIS profile (signals + Muse
  // plan). Applied once per profile — the founder's own toggles win after.
  const [recsApplied, setRecsApplied] = useState(false);
  useEffect(() => setRecsApplied(false), [profile.id]);
  const recQ = useQuery({ queryKey: ["recs", profile.id], queryFn: () => api.recommendChannels({ profileId: profile.id }) });
  useEffect(() => {
    if (recsApplied || !recQ.data || recQ.data.status !== "ok") return;
    const open = recQ.data.recs.filter((r) => !r.needsConnection && r.fit !== "poor").map((r) => r.channel);
    setChannels(open.length ? open : OPEN_DEFAULTS);
    setRecsApplied(true);
  }, [recQ.data, recsApplied]);
  const recReasons: Record<string, string> = {};
  for (const r of recQ.data?.recs ?? []) recReasons[r.channel] = r.reasons.join(" · ");
  // Search-run progress: the server records real phases per run; the latest
  // run's plain-words summary is shown once it lands.
  const [runId, setRunId] = useState(0);
  const runQ = useQuery({ queryKey: ["run", runId], queryFn: () => api.searchRunStatus({ runId }), enabled: runId > 0, refetchOnWindowFocus: false });
  const redditConnected = !!connections.find((c) => c.channel === "reddit_poc")?.connected;
  const [subs, setSubs] = useState("");
  const [sortByScore, setSortByScore] = useState(true);
  const [result, setResult] = useState("");
  const [lastSearch, setLastSearch] = useState<{ found: number; created: number; synthesized: number } | null>(null);
  const latestExpansion = [...expansions].sort((a, b) => b.round - a.round)[0];
  const plan: ExpansionPlanData | null = latestExpansion ? parsePlan(latestExpansion.plan) : null;
  const describeSearch = (r: { found: number; created: number; discarded: number; pruned: number; promoted: number; synthesized: number; synthesisStatus: string; synthesisMessage: string; errors: { channel: string; message: string }[]; expansionRound: number; expansionAnchor: string; expansionQueries: string[]; nextSuggestions: string[] }, expanded: boolean) => {
    const errs = r.errors.map((e) => `${e.channel}: ${e.message}`).join(" ");
    const dropped = r.discarded ? ` ${r.discarded} result${r.discarded === 1 ? "" : "s"} dropped by the light pre-filter — no domain anchor from your profile in the post, or no pain/workaround signal alongside the anchor.` : "";
    const promotedNote = r.promoted ? ` ${r.promoted} top anchored candidate${r.promoted === 1 ? "" : "s"} had the domain anchor but no clear pain/workaround signal, so ${r.promoted === 1 ? "it was" : "they were"} passed up to Muse anyway — the pre-filter is a safety net, and Muse makes the relevance call with evidence and confidence.` : "";
    const cleaned = r.pruned ? ` ${r.pruned} old unclassified lead${r.pruned === 1 ? "" : "s"} with no domain anchor were removed (leads Muse already synthesized are never pruned).` : "";
    const exp = r.expansionQueries.length ? ` Muse's expansion plan (round ${r.expansionRound}, anchored to “${r.expansionAnchor}”) ran ${r.expansionQueries.length} ${expanded ? "new, broader " : ""}queries: ${r.expansionQueries.map((q) => `“${q}”`).join(", ")}.` : "";
    const hnNote = isFirstFeedback ? " Hacker News was searched Ask HN-only: help-request phrasing (\"how did you get your first users\", \"launched to crickets\", \"no traction\"…), and only posts whose title starts with \"Ask HN\" counted as candidates — \"Show HN\" showcases were excluded before the pre-filter." : "";
    const synth = r.synthesisStatus === "ok" ? ` Muse then synthesized the candidates (Step 4): ${r.synthesized} result${r.synthesized === 1 ? "" : "s"} classified with verdicts, evidence quotes and confidence — only those synthesized results are shown below.` : ` Muse synthesis did not complete (${r.synthesisMessage}) — raw candidates are NOT shown as results; run synthesis below to see them.`;
    const zero = r.synthesisStatus === "ok" && r.synthesized === 0 ? " That is 0 synthesized results — not a dead end: Muse's next expansion suggestions are shown below, with a one-click expand-and-re-run." : "";
    return `Search done: ${r.found} candidates found, ${r.created} new.${dropped}${promotedNote}${cleaned}${hnNote}${exp}${synth}${zero}${errs ? " " + errs : ""}`;
  };
  const expand = useMutation({
    mutationFn: () => api.expandSearchAndRerun({ profileId: profile.id, channels, subreddits: subs }),
    onSuccess: (r) => {
      invalidate();
      setRunId(r.runId);
      setLastSearch({ found: r.found, created: r.created, synthesized: r.synthesized });
      setResult(describeSearch(r, true));
      if (r.synthesized) flash(`Expanded search done — round ${r.expansionRound} found ${r.synthesized} synthesized result${r.synthesized === 1 ? "" : "s"}, deduplicated against the leads you already had.`);
    },
    onError: () => setResult("Expanded search failed — check your connection and try again."),
  });
  const genPlan = useMutation({
    mutationFn: () => api.generateExpansionPlan({ profileId: profile.id }),
    onSuccess: (r) => { invalidate(); setResult(r.message); if (r.status === "ok") flash("Expansion plan saved — it will drive the next search."); },
    onError: () => setResult("Expansion plan failed — try again."),
  });
  const search = useMutation({
    mutationFn: () => api.searchLiveLeads({ profileId: profile.id, channels, subreddits: subs }),
    onSuccess: (r) => {
      invalidate();
      setRunId(r.runId);
      setLastSearch({ found: r.found, created: r.created, synthesized: r.synthesized });
      setResult(describeSearch(r, false));
      if (r.synthesized) flash(`Search + synthesis done — ${r.synthesized} synthesized results below, each with its Muse verdict and evidence quote.`);
      else if (r.pruned) flash("Search done — old unclassified leads with no domain anchor were cleared from your queue.");
    },
    onError: () => setResult("Search failed — check your connection and try again."),
  });
  const [classifyResult, setClassifyResult] = useState("");
  const classify = useMutation({
    mutationFn: () => api.classifyLeads({ profileId: profile.id }),
    onSuccess: (r) => { invalidate(); setClassifyResult(r.message); if (r.status === "ok" && r.classified) flash("Classification done — every verdict on a lead shows its evidence and quote."); },
    onError: () => setClassifyResult("Classification failed — try again."),
  });
  const toggle = (c: string) => setChannels((v) => v.includes(c) ? v.filter((x) => x !== c) : [...v, c]);
  // FirstFeedback HN retune: for this profile Hacker News is Ask HN-only —
  // help-request posts, with Show HN showcases excluded server-side.
  const isFirstFeedback = profile.productName.trim().toLowerCase() === "firstfeedback";
  const queue = leads.filter((l) => ["new", "drafted", "approved"].includes(l.status));
  // Step 4: only synthesized (Muse-classified) leads are shown as results.
  // Raw, unclassified candidates are never presented as final results — they
  // sit in the awaiting-synthesis count until Muse has synthesized them.
  const synthesized = queue.filter((l) => !!l.llmCategory);
  const awaitingSynthesis = queue.filter((l) => !l.llmCategory);
  const sorted = [...synthesized].sort((a, b) => sortByScore ? b.matchScore - a.matchScore : b.id - a.id);

  return (
    <section className="mt-5 space-y-4">
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <h2 className="font-serif text-lg font-bold">Step 3 — Search</h2>
        <p className="mt-1 text-sm text-[var(--dim)]">By default, search runs across <strong className="text-[var(--text)]">all open channels</strong> — the public, searchable ones that don't require you to provide an API or account connection. Live search runs on free APIs, only when you tap Search — no continuous polling.</p>
        <p className="mt-1 text-sm text-[var(--dim)]">Search starts with a <strong className="text-[var(--text)]">light pre-filter — a safety net, not the relevance gate</strong>: a post becomes a candidate when the post itself contains your profile's domain anchor — for a makeup profile, an actual makeup term like makeup, foundation or eyeliner; for a developer profile, an anchor like users, traction or feedback — <em>plus</em> at least one pain or workaround signal in the person's own words. Community forums without a search API (AgingCare, Mumsnet Talk) are searched through their public sitemaps — thread titles matched with the same gate, always labeled title-only. It does <strong className="text-[var(--text)]">not</strong> need to repeat a keyword phrase word-for-word. Generic words like “skill” or “sucks” never count as an anchor, so off-domain matches still can't get in, and each candidate's reason names the anchor and signal that matched. If a search would otherwise pass almost nothing, the top anchored candidates are passed up to Muse anyway — <strong className="text-[var(--text)]">Muse makes the real relevance call</strong> (Step 4), with an evidence quote and confidence, and only Muse's synthesized results are shown below. Before searching, Muse also builds the <strong className="text-[var(--text)]">expansion plan</strong> below — where else these people talk, in their own language — and the search runs those expanded queries too, not just your original keyword.</p>
        <fieldset className="mt-3">
          <legend className={labelCls}>Open channels — picked for this profile, toggle freely</legend>
          <div className="flex flex-wrap gap-2">
            {([["bluesky", "Bluesky · public search"], ["hackernews", "Hacker News · public search"], ["github", "GitHub · public search"], ["stackexchange", "Stack Exchange · public Q&A"], ["agingcare", "AgingCare · forum threads"], ["mumsnet", "Mumsnet · forum threads"]] as [string, string][]).map(([v, label]) => (
              <label key={v} title={recReasons[v] ?? label} className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${channels.includes(v) ? "border-[var(--accent)] bg-[var(--accent-bg)] font-semibold" : "border-[var(--border)]"}`}>
                <input type="checkbox" aria-label={label} checked={channels.includes(v)} onChange={() => toggle(v)} />{label}
                {NEW_CHANNELS.has(v) && <span className="rounded-full bg-[var(--accent)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--accent-text)]">New</span>}
              </label>
            ))}
          </div>
          {recQ.data?.message && <p className="mt-2 text-xs text-[var(--dim)]">{recQ.data.message} Hover a channel for why.</p>}
        </fieldset>
        {isFirstFeedback && (
          <p className="mt-3 rounded-[var(--radius)] bg-[var(--accent-bg)] p-2 text-sm"><strong>Hacker News for FirstFeedback is Ask HN-only.</strong> HN is searched with help-request phrasing — “how did you get your first users”, “launched to crickets”, “no traction”, “need feedback on my project” — and only posts whose title starts with <strong>“Ask HN”</strong> count as candidates. <strong>“Show HN” showcases are excluded</strong> before the pre-filter: earlier runs were dominated by Show HN announcements, which are people launching, not people asking for help finding first users. Bluesky and GitHub search exactly as before.</p>
        )}
        <fieldset className="mt-3">
          <legend className={labelCls}>Closed channels — only with your API / connection</legend>
          <p className="text-sm text-[var(--dim)]">Closed channels are <strong className="text-[var(--text)]">not searched by default</strong>. Provide the API or account connection for a closed channel and it joins the search; until then it's left out, and it never blocks the open-channel search above.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {redditConnected ? (
              <label className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${channels.includes("reddit_poc") ? "border-[var(--accent)] bg-[var(--accent-bg)] font-semibold" : "border-[var(--border)]"}`}>
                <input type="checkbox" aria-label="Reddit POC — connected" checked={channels.includes("reddit_poc")} onChange={() => toggle("reddit_poc")} />Reddit POC · your OAuth connected ✓
              </label>
            ) : (
              <span className="rounded-full border border-dashed border-[var(--border)] px-3 py-1.5 text-sm text-[var(--dim)]">Reddit POC · not connected</span>
            )}
            <button type="button" className={btnGhost} onClick={onGoChannels}>{redditConnected ? "Manage closed-channel connections" : "Provide API / connect a closed channel"}</button>
          </div>
          <p className="mt-2 text-xs text-[var(--dim)]">Also closed: Facebook Groups, Discord, Slack, LinkedIn DMs, Instagram DMs, and X / Reddit beyond the POC. There's no outside search API for those — provide a connection where one exists in Channels, or add a person you found there by hand below and EarlyProof will draft for them; you join and send yourself.</p>
        </fieldset>
        {channels.includes("reddit_poc") && (
          <div className="mt-3">
            <label htmlFor="subs" className={labelCls}>Subreddits for POC search (max 5, comma separated)</label>
            <input id="subs" aria-label="Subreddits for Reddit POC search" value={subs} onChange={(e) => setSubs(e.target.value)} className={inputCls} placeholder="e.g. NewParents, beyondthebump" />
            <p className="mt-1 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-xs text-[var(--amber)]"><strong>POC only:</strong> Reddit search here uses the free non-commercial tier with your own OAuth, on demand for internal validation. A commercial launch needs a separate Reddit commercial agreement. Connect the POC in Channels first.</p>
          </div>
        )}
        <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-serif text-base font-bold">Where Muse will look — expansion plan</h3>
            {plan && latestExpansion && <span className="rounded-full bg-[var(--accent-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--accent)]">Round {latestExpansion.round} · anchor: “{plan.anchorTerm}”</span>}
          </div>
          <p className="mt-1 text-sm text-[var(--dim)]">Muse builds this from your profile's audience, pain, workaround and product: query variants in the person's own language, related pain phrases and adjacent problems, and the communities where those people already talk — each mapped to the open or closed channel that reaches it. <strong className="text-[var(--text)]">Every expanded query must contain the domain anchor</strong> (for this profile, a real “{plan?.anchorTerm || "domain"}” term) — generic words alone never become a query, so expansion can't bring back off-topic matches.{plan && plan.droppedUnanchored > 0 ? ` ${plan.droppedUnanchored} unanchored suggestion${plan.droppedUnanchored === 1 ? " was" : "s were"} dropped for exactly that reason.` : ""}</p>
          {!plan && (
            <div className="mt-2">
              <p className="text-sm text-[var(--dim)]">No plan yet — Muse generates round 1 automatically when you search, or generate it now to read where it wants to look first.</p>
              <button type="button" className={btnPrimary + " mt-2"} disabled={!llmConfigured || genPlan.isPending} onClick={() => genPlan.mutate()}>{genPlan.isPending ? "Planning…" : "Generate expansion plan with Muse"}</button>
            </div>
          )}
          {plan && (
            <div className="mt-2 space-y-3 text-sm">
              <div>
                <p className="font-semibold">Expanded queries the search will run</p>
                <ul className="mt-1 space-y-1">
                  {plan.queries.map((q, i) => <li key={i} className="rounded-[var(--radius)] bg-[var(--surface)] px-2.5 py-1.5"><span className="font-medium">“{q.query}”</span>{q.intent && <span className="text-[var(--dim)]"> — {q.intent}</span>}</li>)}
                </ul>
              </div>
              {plan.painPhrases.length > 0 && <div><p className="font-semibold">Related pain phrases & adjacent problems</p><div className="mt-1 flex flex-wrap gap-1.5">{[...plan.painPhrases, ...plan.adjacentProblems].map((x, i) => <span key={i} className="rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs font-medium">“{x}”</span>)}</div></div>}
              {plan.adjacentAudiences.length > 0 && <div><p className="font-semibold">Adjacent audiences (one step wider, same anchor)</p><div className="mt-1 flex flex-wrap gap-1.5">{plan.adjacentAudiences.map((x, i) => <span key={i} className="rounded-full bg-[var(--surface)] px-2.5 py-1 text-xs font-medium">{x}</span>)}</div></div>}
              {plan.communities.length > 0 && (
                <div>
                  <p className="font-semibold">Communities & places — and the channel that reaches each</p>
                  <ul className="mt-1 space-y-1.5">
                    {plan.communities.map((c, i) => (
                      <li key={i} className="rounded-[var(--radius)] bg-[var(--surface)] px-2.5 py-1.5">
                        <span className="font-medium">{c.name}</span>{c.where && <span className="text-[var(--dim)]"> · {c.where}</span>}
                        <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.access === "closed" ? "bg-[var(--amber-bg)] text-[var(--amber)]" : "bg-[var(--accent-bg)] text-[var(--accent)]"}`}>{c.access === "closed" ? "Closed — provide API / join & send" : "Open — searched by default"} · {CHANNEL_LABEL[c.channel] ?? c.channel}</span>
                        {c.why && <span className="mt-0.5 block text-[var(--dim)]">{c.why}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {plan.relaxations.length > 0 && <div><p className="font-semibold">Over-strict terms Muse could relax (anchor stays)</p><ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--dim)]">{plan.relaxations.map((x, i) => <li key={i}>{x}</li>)}</ul></div>}
              <button type="button" className={btnGhost} disabled={!llmConfigured || genPlan.isPending} onClick={() => genPlan.mutate()}>{genPlan.isPending ? "Planning…" : "Generate a broader plan (next round)"}</button>
            </div>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={btnPrimary} disabled={!channels.length || search.isPending || !llmConfigured} onClick={() => search.mutate()}>{search.isPending ? "Searching, then synthesizing with Muse…" : "Search selected channels"}</button>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label="Sort queue by match score" checked={sortByScore} onChange={(e) => setSortByScore(e.target.checked)} /> Strongest match first</label>
        </div>
        {runQ.data && runId > 0 && <p role="status" className="mt-2 rounded-[var(--radius)] bg-[var(--accent-bg)] p-2 text-sm font-medium">{runQ.data.detail}</p>}
        {result && <p role="status" className="mt-2 text-sm">{result}</p>}
      </div>

      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-serif text-base font-bold">How Muse synthesis works</h3>
        {llmConfigured ? (
          <>
            <p className="mt-1 text-sm text-[var(--dim)]">Every search ends with this step before anything is shown: your small Muse model reads each candidate in batches and synthesizes it with evidence — right person? real pain in their own words? already hacking a workaround or paying? It sorts each into likely seed user, curious clicker, or irrelevant, with a verbatim quote from the post and a confidence level. <strong className="text-[var(--text)]">Raw, unclassified keyword hits are never shown as final results.</strong> An unclassified lead also can't get a draft, can't be approved, and can't move into your tracker. Anything under 60% confidence, and anything called irrelevant, is held for your review and cannot go to outreach until you clear it. Synthesis is cached, so re-running only pays for new or changed candidates. Only the post text is sent — nothing else about the person.</p>
            {awaitingSynthesis.length > 0 && <p className="mt-2 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]"><strong>{awaitingSynthesis.length} candidate{awaitingSynthesis.length === 1 ? "" : "s"} awaiting synthesis</strong> — added by hand or left over from an interrupted synthesis. They're hidden from the results below until Muse synthesizes them.</p>}
            <button type="button" className={btnPrimary + " mt-2"} disabled={classify.isPending} onClick={() => classify.mutate()}>{classify.isPending ? "Synthesizing…" : awaitingSynthesis.length ? `Synthesize ${awaitingSynthesis.length} waiting candidate${awaitingSynthesis.length === 1 ? "" : "s"} with Muse` : "Re-run Muse synthesis"}</button>
          </>
        ) : (
          <p className="mt-1 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]"><strong>Step 2 not done yet.</strong> Muse synthesis is a must-have step, and Muse isn't configured yet. Enter your Muse API key in the AI settings — in the app only, never in chat. Until then, no candidate can be synthesized, drafted for, or contacted; there is no rule-only mode.</p>
        )}
        {classifyResult && <p role="status" className="mt-2 text-sm">{classifyResult}</p>}
      </div>

      <AddLeadForm profile={profile} invalidate={invalidate} flash={flash} />

      {lastSearch && lastSearch.synthesized === 0 && sorted.length === 0 && (
        <div className="rounded-[var(--radius)] border-2 border-[var(--amber)] bg-[var(--surface)] p-4" role="status" aria-label="No synthesized results — expansion suggestions">
          <h3 className="font-serif text-base font-bold">0 synthesized results — not a dead end</h3>
          <p className="mt-1 text-sm text-[var(--dim)]">That search found {lastSearch.found} candidate{lastSearch.found === 1 ? "" : "s"}, but none passed the light pre-filter (domain anchor + a pain or workaround signal, with top anchored candidates passed up) and Muse synthesis as a real match for this profile. Rather than an empty list, here is where Muse suggests looking next — every suggestion stays anchored to “{plan?.anchorTerm || "your domain"}”, so widening never means generic.</p>
          {plan && plan.nextSuggestions.length > 0 && (
            <div className="mt-2 text-sm">
              <p className="font-semibold">Muse's next expansion moves</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{plan.nextSuggestions.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </div>
          )}
          {plan && plan.adjacentAudiences.length > 0 && <p className="mt-2 text-sm"><span className="font-semibold">Broaden to an adjacent audience:</span> {plan.adjacentAudiences.join(" · ")}</p>}
          {plan && plan.adjacentProblems.length > 0 && <p className="mt-1 text-sm"><span className="font-semibold">Or an adjacent pain:</span> {plan.adjacentProblems.join(" · ")}</p>}
          {plan && plan.relaxations.length > 0 && <p className="mt-1 text-sm"><span className="font-semibold">Relax an over-strict term (anchor kept):</span> {plan.relaxations.join(" · ")}</p>}
          {plan && plan.communities.length > 0 && <p className="mt-1 text-sm"><span className="font-semibold">Try a different community:</span> {plan.communities.map((c) => `${c.name} (${CHANNEL_LABEL[c.channel] ?? c.channel}${c.access === "closed" ? ", closed — provide its API/connection in Channels first" : ""})`).join(" · ")}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" className={btnPrimary} disabled={!channels.length || expand.isPending || !llmConfigured} onClick={() => expand.mutate()}>{expand.isPending ? "Expanding & re-running…" : "Expand search and re-run"}</button>
            <span className="text-xs text-[var(--dim)]">One click: Muse generates the next expansion round, searches its new anchored queries across your selected channels, synthesizes the results, and deduplicates against leads you've already seen — nothing you've already reviewed comes back as new.</span>
          </div>
        </div>
      )}

      <h3 className="font-serif text-base font-bold">Step 4 — Synthesized results ({sorted.length})</h3>
      {!sorted.length && !(lastSearch && lastSearch.synthesized === 0) && <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">No synthesized results yet. Run a search above — candidates come back only after Muse synthesis, each with a verdict, an evidence quote and a confidence level. Or add a person you found yourself below the search panel, then synthesize them.</p>}
      <div className="space-y-3">
        {sorted.map((l) => <LeadCard key={l.id} lead={l} llmConfigured={llmConfigured} invalidate={invalidate} />)}
      </div>
    </section>
  );
}

function AddLeadForm({ profile, invalidate, flash }: { profile: Profile; invalidate: () => void; flash: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ channel: "reddit", externalUrl: "", author: "", community: "", title: "", body: "" });
  const add = useMutation({ mutationFn: () => api.addPastedLead({ profileId: profile.id, ...f }), onSuccess: () => { invalidate(); flash("Candidate added — it stays hidden from results until Muse synthesizes it in Step 4."); setF({ channel: "reddit", externalUrl: "", author: "", community: "", title: "", body: "" }); setOpen(false); } });
  if (!open) return <button type="button" className={btnGhost + " w-full"} onClick={() => setOpen(true)}>+ Add a person you found (Reddit / X link, group member, anyone)</button>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  return (
    <form className="space-y-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
      <h3 className="font-serif text-base font-bold">Add a lead by hand</h3>
      <p className="text-sm text-[var(--dim)]">Reddit and X run on pasted links (their APIs are paid). Closed groups and DMs are guided: record the person here, get a draft, send it yourself.</p>
      <div><label htmlFor="al-ch" className={labelCls}>Where you found them</label>
        <select id="al-ch" aria-label="Channel where you found them" value={f.channel} onChange={set("channel")} className={inputCls}>
          <option value="reddit">Reddit — I pasted the thread</option>
          <option value="x">X — I pasted the post</option>
          <option value="facebook">Facebook Group</option>
          <option value="discord">Discord</option>
          <option value="slack">Slack community</option>
          <option value="linkedin">LinkedIn DM</option>
          <option value="instagram">Instagram DM</option>
          <option value="manual">Somewhere else</option>
        </select></div>
      <div><label htmlFor="al-url" className={labelCls}>Link (if public)</label><input id="al-url" aria-label="Link to their post" value={f.externalUrl} onChange={set("externalUrl")} className={inputCls} placeholder="https://…" /></div>
      <div className="grid grid-cols-2 gap-2">
        <div><label htmlFor="al-author" className={labelCls}>Their name / handle</label><input id="al-author" aria-label="Their name or handle" value={f.author} onChange={set("author")} className={inputCls} /></div>
        <div><label htmlFor="al-comm" className={labelCls}>Community / group</label><input id="al-comm" aria-label="Community or group" value={f.community} onChange={set("community")} className={inputCls} placeholder="e.g. r/NewParents" /></div>
      </div>
      <div><label htmlFor="al-title" className={labelCls}>Post title (if any)</label><input id="al-title" aria-label="Post title" value={f.title} onChange={set("title")} className={inputCls} /></div>
      <div><label htmlFor="al-body" className={labelCls}>What they said — paste their words</label><textarea id="al-body" aria-label="What they said" required rows={3} value={f.body} onChange={set("body")} className={inputCls} placeholder="Paste the post, comment, or what they told you…" /></div>
      <div className="flex gap-2"><button type="submit" className={btnPrimary} disabled={add.isPending}>Add to queue</button><button type="button" className={btnGhost} onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function LeadCard({ lead, llmConfigured, invalidate }: { lead: Lead; llmConfigured: boolean; invalidate: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [posting, setPosting] = useState("");
  const [tone, setTone] = useState("");
  const gen = useMutation({ mutationFn: () => api.generateDraft({ leadId: lead.id }), onSuccess: (r) => { setDraft(r.draft); setTone(r.toneCheck); invalidate(); } });
  const confirmReview = useMutation({ mutationFn: () => api.confirmLeadReview({ leadId: lead.id }), onSuccess: () => invalidate() });
  const save = useMutation({ mutationFn: (body: string) => api.updateDraft({ leadId: lead.id, draftBody: body }), onSuccess: () => invalidate() });
  const approve = useMutation({ mutationFn: () => api.approveAndPost({ leadId: lead.id }), onSuccess: (r) => { setPosting(r.message + (r.postedUrl ? ` Posted: ${r.postedUrl}` : "")); invalidate(); } });
  const status = useMutation({ mutationFn: (s: Lead["status"]) => api.setLeadStatus({ leadId: lead.id, status: s as never }), onSuccess: () => invalidate() });
  const del = useMutation({ mutationFn: () => api.deleteLead({ leadId: lead.id }), onSuccess: () => invalidate() });
  const draftVal = draft ?? lead.draftBody;
  const canPostLive = lead.channel === "bluesky" || lead.channel === "github" || lead.channel === "reddit_poc";
  const needsClassification = !lead.llmCategory;
  const heldByLlm = !!lead.llmCategory && (lead.llmCategory === "irrelevant" || (lead.llmConfidence > 0 && lead.llmConfidence < 60)) && !lead.llmReviewed;
  const outreachBlocked = !llmConfigured || needsClassification || heldByLlm;

  return (
    <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-[var(--surface-alt)] px-2 py-0.5 font-semibold">{CHANNEL_LABEL[lead.channel] ?? lead.channel}</span>
        {lead.community && <span className="text-[var(--dim)]">{lead.community}</span>}
        <span className="text-[var(--dim)]">{lead.author ? `${lead.author}` : ""} {fmtDate(lead.postedAt)}</span>
        <span className="ml-auto rounded-full border-2 border-[var(--accent)] px-2 py-0.5 font-serif font-bold text-[var(--accent)]" aria-label={`Match score ${lead.matchScore} out of 100`}>{lead.matchScore} match</span>
        <span className="rounded-full bg-[var(--amber-bg)] px-2 py-0.5 font-semibold text-[var(--amber)]">{STAGE_LABEL[lead.status]}</span>
      </div>
      {lead.title && <h4 className="mt-2 font-serif text-base font-bold leading-snug">{lead.title}</h4>}
      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{lead.body.slice(0, 600)}{lead.body.length > 600 ? "…" : ""}</p>
      <p className="mt-1 text-xs text-[var(--dim)]">Why matched: {lead.matchReason}</p>
      {lead.externalUrl && <a href={lead.externalUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm font-medium text-[var(--accent)] underline">Open original post ↗</a>}

      {needsClassification && (
        <div className="mt-3 rounded-[var(--radius)] bg-[var(--amber-bg)] p-3 text-sm text-[var(--amber)]">
          <strong>Not classified by Muse yet.</strong> {llmConfigured ? "This lead passed only the rule-based pre-filter. Run “Classify waiting leads with Muse” above — until Muse classifies it, no draft can be generated and it can't be approved or contacted." : "Muse isn't configured yet, so this lead can't be classified — and unclassified leads can't be drafted for, approved, or contacted. Set up Muse in the AI tab first."}
        </div>
      )}

      {lead.llmCategory && (() => {
        const sig = parseJsonObj(lead.llmSignals);
        const lowConf = lead.llmConfidence > 0 && lead.llmConfidence < 60;
        const held = (lowConf || lead.llmCategory === "irrelevant") && !lead.llmReviewed;
        const chip = (on: unknown, label: string) => <span key={label} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${on ? "bg-[var(--accent-bg)] text-[var(--accent)]" : "bg-[var(--surface-alt)] text-[var(--dim)]"}`}>{on ? "✓ " : "✗ "}{label}</span>;
        return (
          <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-alt)] p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-bold uppercase tracking-wide text-[var(--dim)]">AI verdict</span>
              <span className={`rounded-full px-2 py-0.5 font-bold ${lead.llmCategory === "seed_user" ? "bg-[var(--accent)] text-[var(--accent-text)]" : lead.llmCategory === "irrelevant" ? "bg-[var(--red)] text-white" : "bg-[var(--amber-bg)] text-[var(--amber)]"}`}>{LLM_CAT_LABEL[lead.llmCategory] ?? lead.llmCategory}</span>
              <span className="font-semibold" aria-label={`AI confidence ${lead.llmConfidence} percent`}>{lead.llmConfidence}% confidence</span>
              {lead.llmReviewed && <span className="rounded-full bg-[var(--accent-bg)] px-2 py-0.5 font-semibold text-[var(--accent)]">Reviewed by you</span>}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {chip(sig.rightPerson, "Right person")}
              {chip(sig.realPain, "Pain in their own words")}
              {chip(sig.workaroundOrPaying, "Workaround or paying")}
              {chip(sig.recent, "Recent")}
            </div>
            {lead.llmReason && <p className="mt-2 text-sm">{lead.llmReason}</p>}
            {lead.llmQuote ? <blockquote className="mt-1 border-l-4 border-[var(--accent)] pl-3 text-sm italic">“{lead.llmQuote}”</blockquote> : <p className="mt-1 text-xs text-[var(--dim)]">No verbatim quote from the post supported this verdict — treat it with extra care.</p>}
            {held && (
              <div className="mt-2 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]">
                <strong>Held for your review</strong> — {lowConf ? `confidence is under 60%, so this can't go straight to outreach.` : `the AI called this irrelevant.`} Read the post yourself; if you disagree, clear it:
                <button type="button" className={btnSmall + " ml-2"} disabled={confirmReview.isPending} onClick={() => confirmReview.mutate()}>I reviewed this — keep it in my queue</button>
              </div>
            )}
          </div>
        );
      })()}

      <div className="mt-3">
        <label htmlFor={`draft-${lead.id}`} className={labelCls}>Outreach draft — in your voice, nothing sends without you</label>
        <textarea id={`draft-${lead.id}`} aria-label={`Outreach draft for ${lead.author || "lead"}`} rows={4} value={draftVal} onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== null && draft !== lead.draftBody) save.mutate(draft); }} className={inputCls} placeholder="Generate a draft, or write your own opener here…" />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" className={btnGhost} disabled={gen.isPending || outreachBlocked} onClick={() => gen.mutate()}>{gen.isPending ? "Drafting…" : draftVal ? "Redraft with Muse" : "Generate draft with Muse"}</button>
        <button type="button" className={btnPrimary} disabled={!draftVal.trim() || approve.isPending || outreachBlocked} onClick={() => { if (draft !== null && draft !== lead.draftBody) save.mutate(draft); approve.mutate(); }}>
          {approve.isPending ? "Working…" : canPostLive ? "Approve & post" : "Approve — I'll send it"}
        </button>
        {lead.status === "approved" && <button type="button" className={btnGhost} onClick={() => status.mutate("sent")}>Mark sent</button>}
        <button type="button" className={btnSmall} onClick={() => status.mutate("dismissed")}>Not a fit</button>
        <button type="button" className={btnSmall} aria-label={`Delete lead ${lead.author || lead.id}`} onClick={() => del.mutate()}>Delete</button>
      </div>
      {(tone || lead.draftToneCheck) && <p className="mt-2 rounded-[var(--radius)] bg-[var(--surface-alt)] p-2 text-xs"><span className="font-bold">Tone & channel check:</span> {tone || lead.draftToneCheck}</p>}
      {lead.channel === "reddit_poc" && <p className="mt-2 text-xs text-[var(--amber)]">Reddit POC: posting uses the free non-commercial tier via your own account, for internal validation only.</p>}
      {posting && <p role="status" className="mt-2 rounded-[var(--radius)] bg-[var(--green-bg)] p-2 text-sm">{posting}</p>}
      {lead.postedUrl && <a href={lead.postedUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-[var(--accent)] underline">Your posted reply ↗</a>}
    </article>
  );
}

function TrackerTab({ leads, profile, followups, flash, invalidate }: { leads: Lead[]; profile: Profile; followups: State["followups"]; flash: (m: string) => void; invalidate: () => void }) {
  const status = useMutation({ mutationFn: (v: { id: number; s: string }) => api.setLeadStatus({ leadId: v.id, status: v.s as never }), onSuccess: () => invalidate() });
  const invite = useMutation({ mutationFn: (lead: Lead) => api.createInvite({ profileId: profile.id, leadId: lead.id, seedName: lead.author || lead.authorHandle }), onSuccess: (r) => { invalidate(); if (!r.code) { flash(r.message || "That lead can't start a trial yet — it must be classified by Muse first."); return; } flash(`Tagged invite created: code ${r.code}. Send them your app link with ?ep=${r.code} — their usage lands in the Cohort tab, separate from everyone else.`); } });
  const nudge = useMutation({ mutationFn: (v: { id: number; o: "replied" | "snoozed" | "stopped" }) => api.answerNudge({ followupId: v.id, outcome: v.o }), onSuccess: (r) => { invalidate(); flash(r.message); } });
  const counts = STAGES.map((s) => ({ s, n: leads.filter((l) => l.status === s).length }));
  const active = leads.filter((l) => l.status !== "dismissed");
  const sent = leads.filter((l) => ["sent", "replied", "conversation", "trial"].includes(l.status));
  const replied = leads.filter((l) => ["replied", "conversation", "trial"].includes(l.status));
  const replyRate = sent.length ? Math.round((replied.length / sent.length) * 100) : null;
  const funnel = counts.map(({ s, n }) => ({ stage: STAGE_LABEL[s] ?? s, n }));
  return (
    <section className="mt-5">
      <h2 className="font-serif text-lg font-bold">Reply → conversation → trial</h2>
      <p className="text-sm text-[var(--dim)]">One tracker for every channel. A reply that never becomes a conversation is not a seed user — move each person honestly.{replyRate !== null && <> Reply rate so far: <strong className="text-[var(--text)]">{replyRate}%</strong> ({replied.length} of {sent.length} sent moved to a reply or further).</>}</p>
      <div className="mt-3 flex flex-wrap gap-1.5" role="list" aria-label="Funnel counts">
        {counts.map(({ s, n }) => (
          <div key={s} role="listitem" className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-center">
            <div className="font-serif text-xl font-bold">{n}</div><div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--dim)]">{STAGE_LABEL[s]}</div>
          </div>
        ))}
      </div>
      {active.length > 0 && (
        <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3" aria-label="Pipeline funnel">
          <ResponsiveContainer width="100%" height={funnel.length * 30}>
            <BarChart data={funnel} layout="vertical" margin={{ left: 8, right: 16 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="stage" width={110} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="n" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      {followups.length > 0 && (
        <div className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
          <h3 className="font-serif text-base font-bold">Reply nudges ({followups.length})</h3>
          <p className="mt-1 text-sm text-[var(--dim)]">Sent, but no reply movement yet. They replied somewhere else? Say so and the lead moves. Need more time? Snooze 3 days. Never going to chase? Stop.</p>
          <div className="mt-2 space-y-2">
            {followups.map((f) => {
              const l = leads.find((x) => x.id === f.leadId);
              return (
                <div key={f.id} className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] bg-[var(--surface-alt)] p-2.5 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{l ? `${l.author || l.authorHandle || "Unknown"} · ${l.title || l.body.slice(0, 60)}` : "A sent lead"}</p>
                    <p className="text-xs text-[var(--dim)]">Nudge due {fmtDate(f.dueAt)}</p>
                  </div>
                  <button type="button" className={btnSmall} disabled={nudge.isPending} onClick={() => nudge.mutate({ id: f.id, o: "replied" })}>They replied</button>
                  <button type="button" className={btnSmall} disabled={nudge.isPending} onClick={() => nudge.mutate({ id: f.id, o: "snoozed" })}>Snooze 3 days</button>
                  <button type="button" className={btnSmall} disabled={nudge.isPending} onClick={() => nudge.mutate({ id: f.id, o: "stopped" })}>Stop</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="mt-4 space-y-2">
        {!active.length && <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">No one in the tracker yet — leads appear here as you work the match queue.</p>}
        {active.map((l) => {
          const idx = STAGES.indexOf(l.status as typeof STAGES[number]);
          const next = STAGES[idx + 1];
          return (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{l.author || l.authorHandle || "Unknown"} <span className="font-normal text-[var(--dim)]">· {CHANNEL_LABEL[l.channel] ?? l.channel}{l.community ? ` · ${l.community}` : ""}</span></p>
                <p className="truncate text-xs text-[var(--dim)]">{l.title || l.body.slice(0, 80)}</p>
              </div>
              <span className="rounded-full bg-[var(--amber-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--amber)]">{STAGE_LABEL[l.status]}</span>
              {next && <button type="button" className={btnSmall} onClick={() => status.mutate({ id: l.id, s: next })}>Move to {STAGE_LABEL[next]}</button>}
              {(l.status === "conversation" || l.status === "replied") && <button type="button" className={btnSmall} onClick={() => invite.mutate(l)}>Create tagged invite</button>}
              <button type="button" className={btnSmall} onClick={() => status.mutate({ id: l.id, s: "dismissed" })}>Dismiss</button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CohortTab({ profile, leads, invites, events, summaries, llmConfigured, posthog, flash, invalidate }: { profile: Profile; leads: Lead[]; invites: State["invites"]; events: State["events"]; summaries: Summary[]; llmConfigured: boolean; posthog?: State["posthog"][number]; flash: (m: string) => void; invalidate: () => void }) {
  const [seedName, setSeedName] = useState("");
  const [simCode, setSimCode] = useState("");
  const [simType, setSimType] = useState<string>("started");
  const createInv = useMutation({ mutationFn: () => api.createInvite({ profileId: profile.id, leadId: null, seedName }), onSuccess: (r) => { invalidate(); setSeedName(""); if (r.code) flash(`Invite created — code ${r.code}. Your app link: yourapp.link/?ep=${r.code}`); } });
  const log = useMutation({ mutationFn: (v: { inviteId: number; eventType: (typeof EVENT_TYPES)[number] }) => api.logEvent({ inviteId: v.inviteId, eventType: v.eventType, note: "" }), onSuccess: () => invalidate() });
  const record = useMutation({ mutationFn: () => api.recordEvent({ code: simCode, eventType: (EVENT_TYPES.includes(simType as (typeof EVENT_TYPES)[number]) ? simType : "started") as (typeof EVENT_TYPES)[number], note: "" }), onSuccess: (r) => flash(r.message) });
  const delInv = useMutation({ mutationFn: (id: number) => api.deleteInvite({ inviteId: id }), onSuccess: () => invalidate() });
  const snippetQ = useQuery({ queryKey: ["snippet", profile.id], queryFn: () => api.getSnippet({ profileId: profile.id }) });
  const trialLeads = leads.filter((l) => l.status === "trial");

  const perType = EVENT_TYPES.map((t) => ({ t, n: new Set(events.filter((e) => e.eventType === t && e.profileId === profile.id).map((e) => e.inviteId)).size }));

  return (
    <section className="mt-5 space-y-4">
      <div>
        <h2 className="font-serif text-lg font-bold">Seed cohort — their usage, nobody else's</h2>
        <p className="text-sm text-[var(--dim)]">Signals only. EarlyProof shows what your seed users actually did; whether it counts as PMF is your call — there's no score here.</p>
        <div className="mt-3 grid grid-cols-5 gap-1.5" aria-label="Cohort signal counts">
          {perType.map(({ t, n }) => (
            <div key={t} className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] px-1 py-2 text-center">
              <div className="font-serif text-xl font-bold text-[var(--accent)]">{n}</div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--dim)]">{EVENT_LABEL[t]}</div>
            </div>
          ))}
        </div>
        <p className="mt-1 text-xs text-[var(--dim)]">Counts are distinct seed users (of {invites.length} tagged) who hit each signal{profile.coreAction ? ` — core action = ${profile.coreAction}` : ""}.</p>
      </div>

      <NextExperimentPanel profile={profile} summaries={summaries} llmConfigured={llmConfigured} flash={flash} invalidate={invalidate} />

      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-serif text-base font-bold">Tagged invites</h3>
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="Seed user name for a new invite" value={seedName} onChange={(e) => setSeedName(e.target.value)} className={inputCls + " max-w-[220px]"} placeholder="Seed user's name (optional)" />
          <button type="button" className={btnPrimary} disabled={createInv.isPending} onClick={() => createInv.mutate()}>Create invite</button>
        </div>
        {trialLeads.length > 0 && <p className="mt-2 text-xs text-[var(--dim)]">{trialLeads.length} person/people are marked “In trial” in the Tracker — create their invites from the Tracker so the invite is tied to the conversation.</p>}
        <div className="mt-3 space-y-2">
          {!invites.length && <p className="text-sm text-[var(--dim)]">No invites yet. When a seed user says yes, give them a tagged invite so their usage is separable from friends and random traffic.</p>}
          {invites.map((inv) => {
            const evs = events.filter((e) => e.inviteId === inv.id);
            return (
              <div key={inv.id} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{inv.label || inv.seedName || "Seed user"}</span>
                  <code className="rounded bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-bold">{inv.code}</code>
                  <span className="text-xs text-[var(--dim)]">link: ?ep={inv.code}</span>
                  <button type="button" className={btnSmall + " ml-auto"} aria-label={`Remove invite ${inv.code}`} onClick={() => delInv.mutate(inv.id)}>Remove</button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {EVENT_TYPES.map((t) => {
                    const hit = evs.some((e) => e.eventType === t);
                    return <button key={t} type="button" aria-pressed={hit} onClick={() => log.mutate({ inviteId: inv.id, eventType: t })} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${hit ? "bg-[var(--accent)] text-[var(--accent-text)]" : "border border-[var(--border)] text-[var(--dim)]"}`}>{hit ? "✓ " : ""}{EVENT_LABEL[t]}</button>;
                  })}
                </div>
                {evs.length > 0 && <p className="mt-1 text-xs text-[var(--dim)]">{evs.length} event{evs.length === 1 ? "" : "s"} · latest {fmtDate(evs[0]?.occurred_at ?? "")} · via {evs[0]?.source}</p>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-serif text-base font-bold">Connect your app — two ways</h3>
        <p className="mt-1 text-sm font-semibold">A. Snippet (you have no analytics)</p>
        <p className="text-sm text-[var(--dim)]">Paste this into your app, call <code>epTrack('started')</code> at signup and <code>epTrack('core')</code> at your core action, and report events with the test box below (same action your backend would call).</p>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-[var(--radius)] bg-[var(--surface-alt)] p-3 text-[11px] leading-relaxed">{snippetQ.data?.snippet ?? "Loading snippet…"}</pre>
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="Invite code for snippet event test" value={simCode} onChange={(e) => setSimCode(e.target.value)} className={inputCls + " max-w-[170px]"} placeholder="Invite code" />
          <select aria-label="Event type for snippet test" value={simType} onChange={(e) => setSimType(e.target.value)} className={inputCls + " max-w-[170px]"}>
            {EVENT_TYPES.map((t) => <option key={t} value={t}>{EVENT_LABEL[t]}</option>)}
          </select>
          <button type="button" className={btnGhost} disabled={!simCode || record.isPending} onClick={() => record.mutate()}>Simulate snippet event</button>
        </div>
        <p className="mt-4 text-sm font-semibold">B. PostHog import (you already track events)</p>
        <PosthogForm profile={profile} cfg={posthog} flash={flash} invalidate={invalidate} />
      </div>
    </section>
  );
}

function NextExperimentPanel({ profile, summaries, llmConfigured, flash, invalidate }: { profile: Profile; summaries: Summary[]; llmConfigured: boolean; flash: (m: string) => void; invalidate: () => void }) {
  const suggest = useMutation({ mutationFn: () => api.suggestNextExperiment({ profileId: profile.id }), onSuccess: (r) => { invalidate(); flash(r.message); } });
  const del = useMutation({ mutationFn: (id: number) => api.deleteSummary({ id }), onSuccess: () => invalidate() });
  const mine = summaries.filter((s) => s.kind === "next_experiment");
  const latest = mine[0];
  const c = latest ? parseJsonObj(latest.content) : {};
  const sig = (c.signals && typeof c.signals === "object" ? c.signals : {}) as Record<string, unknown>;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="font-serif text-base font-bold">What to test next</h3>
      <p className="mt-1 text-sm text-[var(--dim)]">From your cohort signals, your Muse model suggests the next experiment in a fixed order — change the <strong>audience</strong> first, then the <strong>message</strong>, then the <strong>problem</strong>. This is a core Muse step: there is no rule-based suggestion standing in for it. It will never give you a PMF score or verdict: whether these signals count as PMF is your call.</p>
      {llmConfigured
        ? <button type="button" className={btnPrimary + " mt-2"} disabled={suggest.isPending} onClick={() => suggest.mutate()}>{suggest.isPending ? "Thinking…" : "Suggest next experiment with Muse"}</button>
        : <p className="mt-2 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]"><strong>Setup required.</strong> Next-experiment suggestions need Muse configured — enter your Muse API key in the AI tab, in the app only. Until then this step is blocked, not replaced by a rule-based guess.</p>}
      {latest && (
        <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[var(--accent)] px-2.5 py-0.5 text-xs font-bold text-[var(--accent-text)]">Change the {String(c.lever ?? "audience")}</span>
            <span className="text-xs text-[var(--dim)]">{fmtDate(latest.created_at)} · {String(c.source ?? "")}</span>
            <button type="button" className={btnSmall + " ml-auto"} aria-label="Delete this suggestion" onClick={() => del.mutate(latest.id)}>Delete</button>
          </div>
          <p className="mt-2 text-sm"><span className="font-semibold">Why this lever:</span> {String(c.rationale ?? "")}</p>
          <p className="mt-1 text-sm"><span className="font-semibold">The experiment:</span> {String(c.experiment ?? "")}</p>
          <p className="mt-1 text-xs text-[var(--dim)]">Signals behind it: {String(sig.tagged ?? 0)} tagged · {String(sig.started ?? 0)} started · {String(sig.core ?? 0)} core · {String(sig.returned ?? 0)} returned · {String(sig.paid ?? 0)} paid · {String(sig.referred ?? 0)} referred · {String(sig.inConversation ?? 0)} in conversation.</p>
          <p className="mt-1 text-xs font-semibold text-[var(--amber)]">{String(c.disclaimer ?? "A suggested next test — not a PMF score or verdict.")}</p>
        </div>
      )}
      {!latest && <p className="mt-2 text-sm text-[var(--dim)]">No suggestion yet. It works from whatever signals you have — even an empty cohort points at the audience lever first.</p>}
    </div>
  );
}

function FeedbackSummaryView({ summary }: { summary: Summary }) {
  const c = parseJsonObj(summary.content);
  const clusters = Array.isArray(c.clusters) ? (c.clusters as Record<string, unknown>[]) : [];
  const repeated = Array.isArray(c.repeatedPainLanguage) ? (c.repeatedPainLanguage as string[]) : [];
  const followUps = Array.isArray(c.followUpQuestions) ? (c.followUpQuestions as string[]) : [];
  const strArr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  return (
    <div className="mt-3 space-y-3">
      <p className="text-xs text-[var(--dim)]">Summarised {fmtDate(summary.created_at)} from {String(c.entryCount ?? "")} feedback entries. Every quote below was checked word-for-word against what users actually said — anything the model couldn't source was dropped.</p>
      {clusters.map((cl, i) => (
        <div key={i} className="rounded-[var(--radius)] border border-[var(--border)] p-3">
          <h5 className="font-serif text-sm font-bold">{String(cl.theme ?? "What they said")}</h5>
          {strArr(cl.quotes).map((q, j) => <blockquote key={j} className="mt-1 border-l-4 border-[var(--accent)] pl-3 text-sm italic">“{q}”</blockquote>)}
          {strArr(cl.stuckPoints).length > 0 && <p className="mt-1 text-sm"><span className="font-semibold">Where they got stuck:</span> {strArr(cl.stuckPoints).join(" · ")}</p>}
          {strArr(cl.requests).length > 0 && <p className="mt-1 text-sm"><span className="font-semibold">What they asked for:</span> {strArr(cl.requests).join(" · ")}</p>}
        </div>
      ))}
      {repeated.length > 0 && <p className="text-sm"><span className="font-semibold">Pain language that repeats:</span> {repeated.map((r) => `“${r}”`).join(" · ")}</p>}
      {followUps.length > 0 && (
        <div>
          <p className="text-sm font-semibold">Follow-up questions to ask next</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{followUps.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

function AiTab({ profile, llm, feedback, summaries, flash, invalidate, goCreateProfile }: { profile?: Profile; llm?: State["llm"]; feedback: FeedbackEntry[]; summaries: Summary[]; flash: (m: string) => void; invalidate: () => void; goCreateProfile: () => void }) {
  const configured = !!llm?.configured;
  const [f, setF] = useState({ apiKey: "", founderVoice: llm?.founderVoice ?? "" });
  const [testMsg, setTestMsg] = useState("");
  const save = useMutation({ mutationFn: () => api.saveLlmSettings(f), onSuccess: () => { invalidate(); setF((v) => ({ ...v, apiKey: "" })); flash("Muse settings saved. Your Muse API key stays on the server and is never shown again — only its last 4 characters."); } });
  const clear = useMutation({ mutationFn: () => api.clearLlmSettings({}), onSuccess: () => { invalidate(); flash("Muse settings removed. Muse is required, so the core flow is now blocked until you configure Muse again in the AI settings."); } });
  const test = useMutation({ mutationFn: () => api.testLlmConnection({}), onSuccess: (r) => setTestMsg(r.message), onError: () => setTestMsg("Connection test failed — check your settings.") });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));

  // Pain expansion
  const [expandMsg, setExpandMsg] = useState("");
  const expand = useMutation({ mutationFn: () => api.expandPainLanguage({ profileId: profile?.id ?? 0 }), onSuccess: (r) => { invalidate(); setExpandMsg(r.message); } });
  const applyKw = useMutation({ mutationFn: () => api.applyExpansionToKeywords({ profileId: profile?.id ?? 0 }), onSuccess: () => { invalidate(); flash("Top pain phrases folded into your profile keywords — they'll shape the next search."); } });
  const painPhrases = profile ? parseJsonArr(profile.painPhrases) : [];
  const workPhrases = profile ? parseJsonArr(profile.workaroundPhrases) : [];
  const exclusions = profile ? parseJsonArr(profile.exclusions) : [];

  // Feedback
  const [fb, setFb] = useState({ seedName: "", source: "", rawText: "" });
  const addFb = useMutation({ mutationFn: () => api.addFeedback({ profileId: profile?.id ?? 0, ...fb }), onSuccess: () => { invalidate(); setFb({ seedName: "", source: "", rawText: "" }); flash("Feedback saved word-for-word — summaries quote from exactly this text."); } });
  const delFb = useMutation({ mutationFn: (id: number) => api.deleteFeedback({ id }), onSuccess: () => invalidate() });
  const [sumMsg, setSumMsg] = useState("");
  const summarise = useMutation({ mutationFn: () => api.summariseFeedback({ profileId: profile?.id ?? 0 }), onSuccess: (r) => { invalidate(); setSumMsg(r.message); } });
  const delSum = useMutation({ mutationFn: (id: number) => api.deleteSummary({ id }), onSuccess: () => invalidate() });
  const fbSummaries = summaries.filter((s) => s.kind === "feedback");
  const setFbField = (k: keyof typeof fb) => (e: { target: { value: string } }) => setFb((v) => ({ ...v, [k]: e.target.value }));

  return (
    <section className="mt-5 space-y-4">
      <div>
        <h2 className="font-serif text-lg font-bold">Step 2 — AI settings {configured ? "· Edit AI config" : "· Muse is required, not optional"}</h2>
        <p className="text-sm text-[var(--dim)]">{configured ? <><strong className="text-[var(--text)]">You're configured — this step is done, and you won't be asked again</strong> on any search or visit. Your Muse configuration is saved and persists. Use this page only when you want to edit your config: replace the key or update your voice notes, then save. </> : <>This is Step 2 of the workflow, after your target profile (Step 1) — and it's a one-time, must-have setup: configure it once here, it persists, and you won't be asked again; you can still edit it here anytime. Without your Muse API key, EarlyProof's core flow — search, classification, drafts, feedback summaries, next experiments — stays blocked, and there is no rule-only mode to fall back to. </>} The AI reads and writes; it never decides. It never posts or DMs on its own, never scores your PMF, and low-confidence verdicts are held for your review instead of hidden behind a number. Muse models are picked automatically — a fast tier for high-volume work (pain expansion, lead classification), a large tier for outreach drafts and feedback summaries. The rule-based topic gate stays underneath as a pre-filter and safety net, so a model can't resurrect a post the rules rejected — but it never substitutes for Muse classification.</p>
      </div>

      {/* Settings */}
      <form className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4 space-y-3" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-serif text-base font-bold">{configured ? "Edit AI config" : "Muse LLM settings"}</h3>
          {configured
            ? <span className="rounded-full bg-[var(--accent-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--accent)]">Configured ✓ · Muse · key {llm?.keyHint} · saved — not asked again</span>
            : <span className="rounded-full bg-[var(--amber-bg)] px-2 py-0.5 text-xs font-bold text-[var(--amber)]">Setup required — core flow blocked until Muse is configured</span>}
        </div>
        <p className="text-sm text-[var(--dim)]">The provider is <strong>Muse</strong> — every AI feature in EarlyProof runs on Muse models, and Muse setup is required before the core flow unlocks. Enter your Muse API key here in the app — never in chat. Models are automatic, so there is nothing to pick. The key is stored server-side for this workspace, used only when you run an AI action, and never displayed again.</p>
        <div><label htmlFor="llm-key" className={labelCls}>Muse API key {llm?.hasKey ? `(saved ${llm.keyHint} — leave blank to keep)` : ""}</label><input id="llm-key" aria-label="Muse API key" type="password" autoComplete="off" value={f.apiKey} onChange={set("apiKey")} className={inputCls} placeholder="Your Muse API key" /></div>
        <div><label htmlFor="llm-voice" className={labelCls}>Your voice — how you actually write (drafts are written in this voice)</label><textarea id="llm-voice" aria-label="Founder voice notes" rows={2} value={f.founderVoice} onChange={set("founderVoice")} className={inputCls} placeholder="e.g. Plain and a bit dry. Short sentences. I say 'I built' not 'we're excited to'. Never use emojis or hype words." /></div>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={btnPrimary} disabled={save.isPending}>{configured ? "Save changes to AI config" : "Save Muse settings"}</button>
          <button type="button" className={btnGhost} disabled={!configured || test.isPending} onClick={() => test.mutate()}>{test.isPending ? "Testing…" : "Test connection"}</button>
          {llm?.hasKey && <button type="button" className={btnGhost} onClick={() => clear.mutate()}>Remove key & settings</button>}
        </div>
        {testMsg && <p role="status" className="text-sm">{testMsg}</p>}
      </form>

      {!profile && <p className="rounded-[var(--radius)] border border-dashed border-[var(--border)] p-4 text-sm text-[var(--dim)]">Create a target profile to use pain expansion and feedback summaries. <button type="button" className="font-semibold text-[var(--accent)] underline" onClick={goCreateProfile}>Create one</button></p>}

      {profile && (
        <>
          {/* Pain expansion */}
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-serif text-base font-bold">1 · Pain language — from your description to their words</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">Your plain description (“{profile.pain.slice(0, 90)}{profile.pain.length > 90 ? "…" : ""}”) becomes the phrases real people type when they hit this pain, the workaround language that proves they're already hacking a solution, and exclusions that keep adjacent noise out of search.</p>
            {configured
              ? <button type="button" className={btnPrimary + " mt-2"} disabled={expand.isPending} onClick={() => expand.mutate()}>{expand.isPending ? "Expanding…" : painPhrases.length ? "Re-expand pain language" : "Expand pain language"}</button>
              : <p className="mt-2 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]"><strong>Setup required.</strong> Pain expansion is a core Muse step and is blocked until you enter your Muse API key in the settings above — in the app only, never in chat.</p>}
            {expandMsg && <p role="status" className="mt-2 text-sm">{expandMsg}</p>}
            {painPhrases.length > 0 && (
              <div className="mt-3 space-y-2 text-sm">
                <div><p className="font-semibold">Phrases people use</p><div className="mt-1 flex flex-wrap gap-1.5">{painPhrases.map((p) => <span key={p} className="rounded-full bg-[var(--surface-alt)] px-2.5 py-1 text-xs font-medium">“{p}”</span>)}</div></div>
                {workPhrases.length > 0 && <div><p className="font-semibold">Workaround language</p><div className="mt-1 flex flex-wrap gap-1.5">{workPhrases.map((p) => <span key={p} className="rounded-full bg-[var(--surface-alt)] px-2.5 py-1 text-xs font-medium">“{p}”</span>)}</div></div>}
                {exclusions.length > 0 && <div><p className="font-semibold">Exclusions — signals it's not this pain</p><div className="mt-1 flex flex-wrap gap-1.5">{exclusions.map((p) => <span key={p} className="rounded-full bg-[var(--amber-bg)] px-2.5 py-1 text-xs font-medium text-[var(--amber)]">{p}</span>)}</div></div>}
                <button type="button" className={btnGhost} disabled={applyKw.isPending} onClick={() => applyKw.mutate()}>Fold top phrases into my keywords</button>
              </div>
            )}
          </div>

          {/* Feedback */}
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
            <h3 className="font-serif text-base font-bold">2 · Feedback — summarised, never invented</h3>
            <p className="mt-1 text-sm text-[var(--dim)]">Paste what seed users actually said — call notes, messages, replies — word for word. The summary clusters it, shows where they got stuck and what they asked for, and quotes them exactly: any quote the model can't source from your text is dropped before you see it. It also drafts follow-up questions aimed at friction, not praise.</p>
            <form className="mt-3 space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); addFb.mutate(); }}>
              <div className="grid grid-cols-2 gap-2">
                <div><label htmlFor="fb-name" className={labelCls}>Seed user</label><input id="fb-name" aria-label="Seed user name" value={fb.seedName} onChange={setFbField("seedName")} className={inputCls} placeholder="Name or handle" /></div>
                <div><label htmlFor="fb-src" className={labelCls}>Where it came from</label><input id="fb-src" aria-label="Feedback source" value={fb.source} onChange={setFbField("source")} className={inputCls} placeholder="Call notes · DM · email…" /></div>
              </div>
              <div><label htmlFor="fb-text" className={labelCls}>What they actually said</label><textarea id="fb-text" aria-label="Feedback in their words" required rows={3} value={fb.rawText} onChange={setFbField("rawText")} className={inputCls} placeholder="Paste it verbatim — don't tidy it up. The summary can only quote what's here." /></div>
              <button type="submit" className={btnGhost} disabled={addFb.isPending}>Save feedback</button>
            </form>
            <div className="mt-3 space-y-2">
              {feedback.map((e) => (
                <div key={e.id} className="rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
                  <p className="font-semibold">{e.seedName || "Seed user"} {e.source && <span className="font-normal text-[var(--dim)]">· {e.source}</span>} <button type="button" className={btnSmall + " float-right"} aria-label={`Delete feedback ${e.id}`} onClick={() => delFb.mutate(e.id)}>Delete</button></p>
                  <p className="mt-1 whitespace-pre-wrap text-[var(--dim)]">“{e.rawText.slice(0, 300)}{e.rawText.length > 300 ? "…" : ""}”</p>
                </div>
              ))}
              {!feedback.length && <p className="text-sm text-[var(--dim)]">No feedback recorded yet for this profile.</p>}
            </div>
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              {configured
                ? <button type="button" className={btnPrimary} disabled={!feedback.length || summarise.isPending} onClick={() => summarise.mutate()}>{summarise.isPending ? "Summarising…" : "Summarise feedback with my large Muse model"}</button>
                : <p className="rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]"><strong>Setup required.</strong> Feedback summaries are a core Muse step and are blocked until Muse is configured in the settings above. You can still record feedback word-for-word above — it just can't be summarised until setup is complete, and no summary will be invented without your Muse model.</p>}
              {sumMsg && <p role="status" className="mt-2 text-sm">{sumMsg}</p>}
              {fbSummaries.map((s) => (
                <div key={s.id}>
                  <FeedbackSummaryView summary={s} />
                  <button type="button" className={btnSmall + " mt-1"} aria-label="Delete this feedback summary" onClick={() => delSum.mutate(s.id)}>Delete summary</button>
                </div>
              ))}
            </div>
          </div>

          <p className="text-sm text-[var(--dim)]">Lead classification lives in the Match queue, outreach drafts on each lead, and the next-experiment suggestion in the Cohort tab — all running on these same settings.</p>
        </>
      )}
    </section>
  );
}

function PosthogForm({ profile, cfg, flash, invalidate }: { profile: Profile; cfg?: State["posthog"][number]; flash: (m: string) => void; invalidate: () => void }) {
  const [f, setF] = useState({ host: cfg?.host ?? "https://us.posthog.com", projectId: cfg?.projectId ?? "", apiKey: "", startedEvent: cfg?.startedEvent ?? "", coreEvent: cfg?.coreEvent ?? "", returnedEvent: cfg?.returnedEvent ?? "", paidEvent: cfg?.paidEvent ?? "", referredEvent: cfg?.referredEvent ?? "" });
  const save = useMutation({ mutationFn: () => api.savePosthogConfig({ profileId: profile.id, ...f }), onSuccess: () => { invalidate(); flash("PostHog mapping saved."); } });
  const imp = useMutation({ mutationFn: () => api.importPosthog({ profileId: profile.id }), onSuccess: (r) => { invalidate(); flash(r.message); } });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));
  return (
    <form className="mt-2 space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
      <div className="grid grid-cols-2 gap-2">
        <div><label htmlFor="ph-host" className={labelCls}>Host</label><input id="ph-host" aria-label="PostHog host" value={f.host} onChange={set("host")} className={inputCls} /></div>
        <div><label htmlFor="ph-proj" className={labelCls}>Project ID</label><input id="ph-proj" aria-label="PostHog project ID" value={f.projectId} onChange={set("projectId")} className={inputCls} /></div>
      </div>
      <div><label htmlFor="ph-key" className={labelCls}>Personal API key {cfg?.hasKey ? "(saved — leave blank to keep)" : ""}</label><input id="ph-key" aria-label="PostHog personal API key" type="password" value={f.apiKey} onChange={set("apiKey")} className={inputCls} placeholder="phx_…" /></div>
      <p className="text-xs text-[var(--dim)]">Map your existing event names to the five signals. Seed users must carry their invite code as distinct_id or an <code>$ep_code</code> property.</p>
      <div className="grid grid-cols-2 gap-2">
        {([["startedEvent", "Started event"], ["coreEvent", "Core action event"], ["returnedEvent", "Came back event"], ["paidEvent", "Paid event"], ["referredEvent", "Referred event"]] as const).map(([k, label]) => (
          <div key={k}><label htmlFor={`ph-${k}`} className={labelCls}>{label}</label><input id={`ph-${k}`} aria-label={label} value={f[k]} onChange={set(k)} className={inputCls} placeholder="e.g. user_signed_up" /></div>
        ))}
      </div>
      <div className="flex gap-2">
        <button type="submit" className={btnGhost} disabled={save.isPending}>Save mapping</button>
        <button type="button" className={btnPrimary} disabled={imp.isPending} onClick={() => imp.mutate()}>{imp.isPending ? "Importing…" : "Import from PostHog"}</button>
      </div>
    </form>
  );
}

function ConnBadge({ connections, channel }: { connections: State["connections"]; channel: string }) {
  const c = connections.find((x) => x.channel === channel);
  return c?.connected
    ? <span className="rounded-full bg-[var(--green-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--accent)]">Connected{c.handle ? ` · ${c.handle}` : ""}</span>
    : <span className="rounded-full bg-[var(--surface-alt)] px-2 py-0.5 text-xs font-semibold text-[var(--dim)]">Not connected</span>;
}

function ChannelsTab({ connections, profile, insights, llmConfigured, flash, invalidate }: { connections: State["connections"]; profile?: Profile; insights: State["insights"]; llmConfigured: boolean; flash: (m: string) => void; invalidate: () => void }) {
  const disc = useMutation({ mutationFn: (channel: string) => api.disconnectChannel({ channel }), onSuccess: () => { invalidate(); flash("Disconnected."); } });
  const [bsky, setBsky] = useState({ handle: "", appPassword: "" });
  const bskyConn = useMutation({ mutationFn: () => api.connectBluesky(bsky), onSuccess: (r) => { flash(r.message); if (r.ok) { invalidate(); setBsky({ handle: "", appPassword: "" }); } } });
  const [ghToken, setGhToken] = useState("");
  const ghConn = useMutation({ mutationFn: () => api.connectGithub({ token: ghToken }), onSuccess: (r) => { flash(r.message); if (r.ok) { invalidate(); setGhToken(""); } } });

  // Reddit POC state
  const [rs, setRs] = useState({ clientId: "", clientSecret: "", username: "", password: "" });
  const [rc, setRc] = useState({ clientId: "", clientSecret: "", redirectUri: "http://localhost:8080/", code: "" });
  const [authUrl, setAuthUrl] = useState("");
  const rsConn = useMutation({ mutationFn: () => api.connectRedditScript(rs), onSuccess: (r) => { flash(r.message); if (r.ok) { invalidate(); setRs({ clientId: "", clientSecret: "", username: "", password: "" }); } } });
  const rcConn = useMutation({ mutationFn: () => api.connectRedditCode(rc), onSuccess: (r) => { flash(r.message); if (r.ok) { invalidate(); setRc((v) => ({ ...v, code: "" })); } } });
  const urlGen = useMutation({ mutationFn: () => api.getRedditAuthUrl({ clientId: rc.clientId, redirectUri: rc.redirectUri }), onSuccess: (r) => setAuthUrl(r.url) });

  return (
    <section className="mt-5 space-y-4">
      <div>
        <h2 className="font-serif text-lg font-bold">Channels — three honest modes</h2>
        <p className="text-sm text-[var(--dim)]">Step 3 searches all <strong className="text-[var(--text)]">open channels</strong> (Bluesky public search, Hacker News, GitHub public search, Stack Exchange public Q&A, AgingCare forum threads, Mumsnet forum threads) by default — no connection needed here for those. <strong className="text-[var(--text)]">Closed channels</strong> join the search only after you provide their API or account connection on this page; leaving one unconnected never blocks the open-channel search. Live channels post only after you approve the exact draft. Closed communities without a search API are guided — you join and send. Reviews are insight only, never outreach.</p>
      </div>

      {/* Bluesky */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-serif text-base font-bold">Bluesky — live, posts after your approval</h3><ConnBadge connections={connections} channel="bluesky" /></div>
        <p className="mt-1 text-sm text-[var(--dim)]">Free AT Protocol. Search needs a free Bluesky account: create an App Password in Bluesky (Settings → Privacy and security → App passwords) and connect once. The password itself is never stored — only the session it creates.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div><label htmlFor="bs-handle" className={labelCls}>Your Bluesky handle</label><input id="bs-handle" aria-label="Bluesky handle" value={bsky.handle} onChange={(e) => setBsky((v) => ({ ...v, handle: e.target.value }))} className={inputCls} placeholder="you.bsky.social" /></div>
          <div><label htmlFor="bs-pass" className={labelCls}>App password</label><input id="bs-pass" aria-label="Bluesky app password" type="password" value={bsky.appPassword} onChange={(e) => setBsky((v) => ({ ...v, appPassword: e.target.value }))} className={inputCls} placeholder="xxxx-xxxx-xxxx-xxxx" /></div>
        </div>
        <div className="mt-2 flex gap-2">
          <button type="button" className={btnPrimary} disabled={!bsky.handle || !bsky.appPassword || bskyConn.isPending} onClick={() => bskyConn.mutate()}>Connect Bluesky</button>
          <button type="button" className={btnGhost} onClick={() => disc.mutate("bluesky")}>Disconnect</button>
        </div>
      </div>

      {/* GitHub + HN */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center gap-2"><h3 className="font-serif text-base font-bold">GitHub — live search, comments after approval</h3><ConnBadge connections={connections} channel="github" /></div>
        <p className="mt-1 text-sm text-[var(--dim)]">Search is free with no key. To post an approved comment from here, add a fine-grained personal access token with Issues read/write. Without one, drafts degrade to copy-and-post yourself.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input aria-label="GitHub personal access token" type="password" value={ghToken} onChange={(e) => setGhToken(e.target.value)} className={inputCls + " max-w-[320px]"} placeholder="github_pat_…" />
          <button type="button" className={btnPrimary} disabled={ghToken.length < 10 || ghConn.isPending} onClick={() => ghConn.mutate()}>Connect GitHub</button>
          <button type="button" className={btnGhost} onClick={() => disc.mutate("github")}>Disconnect</button>
        </div>
        <p className="mt-3 text-sm"><span className="font-semibold">Hacker News</span> <span className="text-[var(--dim)]">— live free search via Algolia, already on. HN has no posting API, so drafts there are always founder-sends: approve, copy, reply on HN, mark sent.</span></p>
      </div>

      {/* Reddit POC */}
      <div className="rounded-[var(--radius)] border-2 border-[var(--amber)] bg-[var(--surface)] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-serif text-base font-bold">Reddit — proof of concept only</h3>
          <span className="rounded-full bg-[var(--amber-bg)] px-2 py-0.5 text-xs font-bold text-[var(--amber)]">POC · FREE NON-COMMERCIAL TIER</span>
          <ConnBadge connections={connections} channel="reddit_poc" />
        </div>
        <div className="mt-2 rounded-[var(--radius)] bg-[var(--amber-bg)] p-3 text-sm text-[var(--amber)]">
          <strong>Read before connecting:</strong> this connector exists only to validate the Reddit flow internally. It uses <strong>your own Reddit OAuth app</strong> on Reddit's free non-commercial tier — on-demand search of a few subreddits (no continuous polling, results cached, well under the 100 queries/minute limit), and replies post only after you approve the exact text. <strong>It is not for a commercial launch or paying customers</strong> — that requires a separate Reddit commercial agreement. For anything beyond POC validation, use the pasted-link flow in the Match queue instead.
        </div>
        <p className="mt-2 text-sm text-[var(--dim)]">Setup: sign in to reddit.com → Settings → go to reddit.com/prefs/apps → “create app” → choose <em>script</em> (simplest for a POC) or <em>web app</em> → note the client ID (under the app name) and secret.</p>

        <h4 className="mt-3 text-sm font-bold">Option A — script app (username + password grant)</h4>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <div><label htmlFor="rs-id" className={labelCls}>Client ID</label><input id="rs-id" aria-label="Reddit POC client ID" value={rs.clientId} onChange={(e) => setRs((v) => ({ ...v, clientId: e.target.value }))} className={inputCls} /></div>
          <div><label htmlFor="rs-secret" className={labelCls}>Client secret</label><input id="rs-secret" aria-label="Reddit POC client secret" type="password" value={rs.clientSecret} onChange={(e) => setRs((v) => ({ ...v, clientSecret: e.target.value }))} className={inputCls} /></div>
          <div><label htmlFor="rs-user" className={labelCls}>Your Reddit username</label><input id="rs-user" aria-label="Reddit username" value={rs.username} onChange={(e) => setRs((v) => ({ ...v, username: e.target.value }))} className={inputCls} /></div>
          <div><label htmlFor="rs-pass" className={labelCls}>Your Reddit password (used once, never stored)</label><input id="rs-pass" aria-label="Reddit password" type="password" value={rs.password} onChange={(e) => setRs((v) => ({ ...v, password: e.target.value }))} className={inputCls} /></div>
        </div>
        <button type="button" className={btnPrimary + " mt-2"} disabled={!rs.clientId || !rs.clientSecret || !rs.username || !rs.password || rsConn.isPending} onClick={() => rsConn.mutate()}>Connect Reddit POC (script app)</button>

        <h4 className="mt-4 text-sm font-bold">Option B — web app (authorisation code, refreshable)</h4>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <div><label htmlFor="rc-id" className={labelCls}>Client ID</label><input id="rc-id" aria-label="Reddit POC web app client ID" value={rc.clientId} onChange={(e) => setRc((v) => ({ ...v, clientId: e.target.value }))} className={inputCls} /></div>
          <div><label htmlFor="rc-secret" className={labelCls}>Client secret</label><input id="rc-secret" aria-label="Reddit POC web app client secret" type="password" value={rc.clientSecret} onChange={(e) => setRc((v) => ({ ...v, clientSecret: e.target.value }))} className={inputCls} /></div>
          <div><label htmlFor="rc-uri" className={labelCls}>Redirect URI (must match your app)</label><input id="rc-uri" aria-label="Reddit POC redirect URI" value={rc.redirectUri} onChange={(e) => setRc((v) => ({ ...v, redirectUri: e.target.value }))} className={inputCls} /></div>
          <div><label htmlFor="rc-code" className={labelCls}>Code from the redirect URL (?code=…)</label><input id="rc-code" aria-label="Reddit authorisation code" value={rc.code} onChange={(e) => setRc((v) => ({ ...v, code: e.target.value }))} className={inputCls} /></div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={btnGhost} disabled={!rc.clientId || !rc.redirectUri || urlGen.isPending} onClick={() => urlGen.mutate()}>Generate authorise link</button>
          <button type="button" className={btnPrimary} disabled={!rc.clientId || !rc.clientSecret || !rc.code || rcConn.isPending} onClick={() => rcConn.mutate()}>Exchange code & connect</button>
          <button type="button" className={btnGhost} onClick={() => disc.mutate("reddit_poc")}>Disconnect POC</button>
        </div>
        {authUrl && <p className="mt-2 break-all text-sm">Open this link, approve, then copy the <code>code</code> from the address you land on: <a href={authUrl} target="_blank" rel="noreferrer" className="font-medium text-[var(--accent)] underline">{authUrl}</a></p>}
      </div>

      {/* Guided tier */}
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="font-serif text-base font-bold">Guided channels — you join, you send</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--dim)]">
          <li><strong className="text-[var(--text)]">Facebook Groups, Discord, Slack:</strong> no outside search or posting API exists. Find the group, join as a real member, add the person in the Match queue (“Add a person you found”), get a draft, send it yourself.</li>
          <li><strong className="text-[var(--text)]">LinkedIn & Instagram DMs:</strong> automated DMing gets accounts flagged fast, so these stay draft-and-send too.</li>
          <li><strong className="text-[var(--text)]">Reddit & X beyond the POC:</strong> paste the thread/post link in the Match queue — drafts and tracking work the same, you post from your own account. Their APIs are paid, so EarlyProof doesn't bill you for them.</li>
        </ul>
      </div>

      {/* Insights */}
      {profile && <InsightForm profile={profile} insights={insights} llmConfigured={llmConfigured} flash={flash} invalidate={invalidate} />}
    </section>
  );
}

function InsightForm({ profile, insights, llmConfigured, flash, invalidate }: { profile: Profile; insights: State["insights"]; llmConfigured: boolean; flash: (m: string) => void; invalidate: () => void }) {
  const [f, setF] = useState({ sourceLabel: "", rawText: "" });
  const add = useMutation({ mutationFn: () => api.addInsight({ profileId: profile.id, ...f }), onSuccess: (r) => { invalidate(); setF({ sourceLabel: "", rawText: "" }); flash(r.painLanguage ? "Insight saved — pain language extracted below. Fold the sharpest phrases into your profile keywords." : r.llmStatus === "not_configured" ? "Insight saved, but pain-language extraction is blocked: Muse setup is required. Enter your Muse API key in the AI tab — in the app only — then re-run extraction by saving the review again." : "Insight saved."); } });
  const del = useMutation({ mutationFn: (id: number) => api.deleteInsight({ id }), onSuccess: () => invalidate() });
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <h3 className="font-serif text-base font-bold">Competitor reviews — insight only</h3>
      <p className="mt-1 text-sm text-[var(--dim)]">You can't message a reviewer, and poaching them publicly looks bad. Paste a 1–3★ review here instead: EarlyProof extracts the pain language so you can find the same person, saying the same words, on a channel where you can actually reach them.</p>
      {!llmConfigured && <p className="mt-2 rounded-[var(--radius)] bg-[var(--amber-bg)] p-2 text-sm text-[var(--amber)]"><strong>Setup required:</strong> extraction runs on your Muse model, so it stays blocked until Muse is configured in the AI tab.</p>}
      <form className="mt-2 space-y-2" onSubmit={(e: FormEvent) => { e.preventDefault(); add.mutate(); }}>
        <div><label htmlFor="ins-src" className={labelCls}>Source</label><input id="ins-src" aria-label="Review source" value={f.sourceLabel} onChange={(e) => setF((v) => ({ ...v, sourceLabel: e.target.value }))} className={inputCls} placeholder="e.g. App Store review of CompetitorX, 2★" /></div>
        <div><label htmlFor="ins-text" className={labelCls}>Review text</label><textarea id="ins-text" aria-label="Review text" required rows={3} value={f.rawText} onChange={(e) => setF((v) => ({ ...v, rawText: e.target.value }))} className={inputCls} placeholder="Paste the review…" /></div>
        <button type="submit" className={btnPrimary} disabled={add.isPending}>{add.isPending ? "Extracting…" : "Save insight"}</button>
      </form>
      <div className="mt-3 space-y-2">
        {insights.map((i) => (
          <div key={i.id} className="rounded-[var(--radius)] border border-[var(--border)] p-3 text-sm">
            <p className="font-semibold">{i.sourceLabel || "Review"} <button type="button" className={btnSmall + " float-right"} aria-label={`Delete insight ${i.id}`} onClick={() => del.mutate(i.id)}>Delete</button></p>
            <p className="mt-1 text-[var(--dim)]">“{i.rawText.slice(0, 220)}”</p>
            {i.painLanguage && <p className="mt-1"><span className="font-semibold text-[var(--accent)]">Pain language:</span> {i.painLanguage}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
