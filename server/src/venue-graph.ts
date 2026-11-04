// ─── Venue graph: structural one-hop discovery ─────────────────────────────
// A venue is evidence of another venue. Stack Exchange publishes related
// sites per site; forums link each other from homepages. Walking one hop
// along those operator-published edges surfaces adjacent communities the
// search queries never named — with no search engine and no learning from
// other profiles. Everything here is pure and unit-tested; the only network
// is the two fetches the caller already knows how to do (SE /sites is one
// cached call, forum homepages are fetched per verified forum).

export interface RelatedSite { apiParam: string; name: string; siteUrl: string }

// Hosts that are infrastructure, not communities — never graph candidates.
const BIG_HOSTS = [
  "google", "gstatic", "facebook", "instagram", "threads",
  "twitter", "tiktok", "youtube", "youtu", "amazon", "apple",
  "microsoft", "wikipedia", "linkedin", "pinterest", "github",
  "gitlab", "discord", "slack", "mozilla", "cloudflare", "x",
];

// Last-two-labels registrable approximation (good enough for dedup/skip).
export function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}

// Parse the SE /sites payload: related sites for one api_site_parameter.
// Returns [] when the payload is missing, malformed, or the site is absent.
export function parseSeRelatedSites(data: unknown, apiParam: string): RelatedSite[] {
  if (!data || typeof data !== "object") return [];
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const site = items.find((s) => (s as { api_site_parameter?: unknown })?.api_site_parameter === apiParam) as
    | { related_sites?: unknown }
    | undefined;
  if (!site || !Array.isArray(site.related_sites)) return [];
  const out: RelatedSite[] = [];
  for (const r of site.related_sites) {
    const rel = r as { api_site_parameter?: unknown; name?: unknown; site_url?: unknown };
    if (typeof rel.api_site_parameter !== "string" || typeof rel.site_url !== "string") continue;
    out.push({
      apiParam: rel.api_site_parameter,
      name: typeof rel.name === "string" ? rel.name : rel.api_site_parameter,
      siteUrl: rel.site_url,
    });
  }
  return out;
}

// Mine absolute outlinks from a forum homepage. Returns registrable domains
// (deduped, capped), excluding the forum itself and big-platform hosts.
export function extractOutlinkDomains(html: string, selfHost: string): string[] {
  const self = registrable(selfHost);
  const seen = new Set<string>();
  const re = /href\s*=\s*["'](https?:\/\/[^"'\/\s]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && seen.size < 50) {
    const href = m[1];
    if (!href) continue;
    let host = "";
    try { host = new URL(href).hostname; } catch { continue; }
    const reg = registrable(host);
    if (!reg || reg === self) continue;
    if (BIG_HOSTS.some((b) => reg === b || reg.endsWith(`.${b}`) || reg.startsWith(`${b}.`))) continue;
    seen.add(reg);
  }
  return [...seen];
}

// Assemble graph candidates, skipping anything already on the board.
// SE subdomains of stackexchange.com stay executable by the existing worker;
// anything else becomes a join-by-hand venue.
export function seGraphVenues(
  related: RelatedSite[],
  via: string,
  knownHosts: Set<string>,
  makeVenue: (name: string, where: string, why: string, url: string) => void,
): number {
  let added = 0;
  for (const r of related) {
    let host = "";
    try { host = new URL(r.siteUrl).hostname; } catch { continue; }
    if (knownHosts.has(registrable(host))) continue;
    knownHosts.add(registrable(host));
    makeVenue(r.name, host, `Linked from the ${via} community graph — ${via} lists it as a related site. Join and add by hand.`, r.siteUrl);
    added++;
  }
  return added;
}

export function forumGraphVenues(
  domains: string[],
  via: string,
  knownHosts: Set<string>,
  makeVenue: (name: string, where: string, why: string, url: string) => void,
): number {
  let added = 0;
  for (const d of domains) {
    if (knownHosts.has(d)) continue;
    knownHosts.add(d);
    makeVenue(d, d, `Linked from ${via}'s homepage — live, thread sitemap not yet checked. Join and add by hand.`, `https://${d}/`);
    added++;
  }
  return added;
}
