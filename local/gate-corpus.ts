// Frozen relevance corpus: every case asserts the light gate's contract
// directly (analyseText, no network, no Muse). If a product change flips a
// case, the corpus — not a live run — says so first.

import type { ProfileLike } from "../server/src/actions.ts";

export type { ProfileLike };

export const WILLOW: ProfileLike = {
  productName: "Willow",
  productDesc: "shared medication and care log for families with dementia",
  audience: "adult children caring for a parent with dementia",
  pain: "mom's meds change constantly, siblings don't help, I'm drowning in schedules",
  workaround: "",
  keywords: "",
  coreAction: "",
};

export const SECONDHIFT: ProfileLike = {
  productName: "SecondShift",
  productDesc: "Side-hustle finder for laid-off workers",
  audience: "Recently laid-off workers who need income now",
  pain: "Laid off with bills due, no idea where to start for a side hustle",
  workaround: "Applying to hundreds of jobs with no response",
  keywords: "laid off, side hustle, freelance gigs",
  coreAction: "Applied to a starter gig through a friend",
};

export const DEV: ProfileLike = {
  productName: "ShipLog",
  productDesc: "changelog tool for side projects",
  audience: "indie hackers shipping side projects",
  pain: "launched and got no response",
  workaround: "posted on hacker news",
  keywords: "first users, traction, feedback",
  coreAction: "",
};

export const DEVSHOW: ProfileLike = {
  ...DEV,
  keywords: "first users, traction, feedback, show hn",
};

export const MAKEUP: ProfileLike = {
  productName: "GlamCam",
  productDesc: "makeup try-on",
  audience: "beginners learning daily makeup",
  pain: "foundation looks cakey by noon",
  workaround: "",
  keywords: "makeup tutorial, foundation routine",
  coreAction: "",
};

export const DAWNLITE: ProfileLike = {
  productName: "DawnFeed",
  productDesc: "Tracks night feeds and predicts the next wake window",
  audience: "First-time parents in the first 6 months",
  pain: "I never know if she'll sleep through or wake screaming at 5am",
  workaround: "Notes app timestamps and guesswork",
  keywords: "baby wakes at 5am, night feed tracking, sleep regression",
  coreAction: "Logged a night feed three nights in a row",
};

export interface GateCase {
  label: string;
  profile: ProfileLike;
  title: string;
  body: string;
  keep: boolean;
  reasonIncludes?: string;
  reasonExcludes?: string;
}

const REALDEED_TITLE = "Show HN: RealDeed PropPass – Own Indian Real Estate Digitally from INR 10k";
const REALDEED_BODY = "Hi YC / HN I'm Malhar, founder of RealDeed PropPass — and We're building what we believe is India's first structured tokenized real estate marketplace enabling users to digitally own a fractional piece of Indian property starting from just ₹10,000. The Problem Real estate in India is: High entry barrier (₹50L–₹5Cr+ tickets) Illiquid Paper-heavy Hard to verify titles Difficult for young investors or NRIs to participate What We Built – PropPass by RealDeed PropPass allows investors to: Own fractional real estate digitally Invest from ₹10,000 Receive structured ownership rights via SPV model.";

export const GATE_CORPUS: GateCase[] = [
  {
    label: "caregiver thread keeps for Willow",
    profile: WILLOW,
    title: "Caring for my mom with dementia",
    body: "Caring for my mom with dementia, siblings won't help, drowning in med schedules, no idea how others cope.",
    keep: true,
  },
  {
    // Micro-profile with a single strong anchor ("mom") so the variant note
    // in the reason is deterministic, not tier-order luck.
    label: "daughter writing about father (mom-worded profile)",
    profile: { productName: "T", productDesc: "t", audience: "x", pain: "no idea where to start", workaround: "", keywords: "mom", coreAction: "" },
    title: "His dementia meds keep changing",
    body: "My father is struggling and I have no idea where to start.",
    keep: true,
    reasonIncludes: "(as “father”",
  },
  {
    label: "LO/DH abbreviations keep for Willow",
    profile: WILLOW,
    title: "Caring for my LO alone",
    body: "Caring for my LO with dementia, DH works full time so it's all on me. Drowning in med schedules, no idea how others cope.",
    keep: true,
  },
  {
    label: "DM-spam network post drops for Willow",
    profile: WILLOW,
    title: "CHEAP followers, DM me!!!",
    body: "CHEAP followers!!! DM me for promo deals, cheap prices!!!",
    keep: false,
  },
  {
    // Micro-profile again: every secondary token is literal in the text, so
    // no kinship variant can appear and the reason must name no "(as …)".
    label: "literal mom match names no variant",
    profile: { productName: "T", productDesc: "t", audience: "x", pain: "no idea where to start", workaround: "", keywords: "mom, meds", coreAction: "" },
    title: "My mom has dementia and I manage her meds alone",
    body: "My mom has dementia and I manage her meds alone. No idea where to start.",
    keep: true,
    reasonExcludes: "(as",
  },
  {
    label: "laid-off worker keeps for SecondShift",
    profile: SECONDHIFT,
    title: "Laid off last week, rent due",
    body: "Laid off last week, rent due, no idea where to start with side hustles. Applied everywhere, no response.",
    keep: true,
  },
  {
    // THE Show HN bug: a founder showcase must not anchor a profile that
    // never mentions Show HN — even though pitch language ("hard to",
    // "difficult", "problem") reads like pain.
    label: "Show HN showcase drops for laid-off profile",
    profile: SECONDHIFT,
    title: REALDEED_TITLE,
    body: REALDEED_BODY,
    keep: false,
    reasonExcludes: "show hn",
  },
  {
    // Same showcase against a dev profile: it may pass the gate on the
    // "users" anchor, but never on the "show hn" phrase — Muse judges the
    // pitch (the classifier prompt hardens against founder pitches).
    label: "Show HN showcase never anchors on the phrase",
    profile: DEV,
    title: REALDEED_TITLE,
    body: REALDEED_BODY,
    keep: true,
    reasonExcludes: "show hn",
  },
  {
    label: "show hn anchors when keywords name it",
    profile: DEVSHOW,
    title: "Show HN: my tool got zero users",
    body: "Show HN: my little tool got zero users and no traction, don't know where to find first users.",
    keep: true,
    reasonIncludes: "show hn",
  },
  {
    label: "negated anchor keeps",
    profile: DEV,
    title: "Launched and got no users",
    body: "I launched and got no users, zero traction, nobody cares. Posted on hacker news and got no response.",
    keep: true,
  },
  {
    label: "workaround signal keeps without pain words",
    profile: DEV,
    title: "Shipped my side project, posted on hacker news",
    body: "Indie hacker shipped a side project, posted on hacker news, users are signing up steadily.",
    keep: true,
    reasonIncludes: "workaround",
  },
  {
    label: "makeup cluster term keeps",
    profile: MAKEUP,
    title: "Foundation looks cakey by noon",
    body: "My foundation looks cakey and uneven by noon, help, I've tried everything and it still looks messy.",
    keep: true,
  },
  {
    label: "generic words never anchor makeup",
    profile: MAKEUP,
    title: "This skill sucks, nobody cares",
    body: "This skill sucks, nobody cares, zero response, launched it and nothing.",
    keep: false,
  },
  {
    label: "night-feed parent keeps for DawnFeed",
    profile: DAWNLITE,
    title: "Baby wakes at 5am screaming",
    body: "My baby wakes at 5am screaming every night, no idea if she'll sleep through. Tracking night feeds in a notes app and guessing.",
    keep: true,
  },
];
