import { RawJob, UA, fetchJson, stripHtml } from "./types";

// Detects pasted job URLs that belong to a natively-supported ATS and fetches the single
// posting through that ATS's public API — so a manual add gets the right source, the
// ATS-native externalId (deduping against future board scrapes), a real company name,
// and form introspection at draft time. Unknown hosts return null → generic extraction.
// No titleLooksRelevant filtering here: the user explicitly chose this job.

function prettyToken(token: string): string {
  return token
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

async function fromGreenhouse(token: string, id: string): Promise<RawJob | null> {
  const j = await fetchJson<{
    id: number;
    title: string;
    absolute_url: string;
    company_name?: string;
    location?: { name: string };
    content?: string;
    updated_at?: string;
  }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs/${id}`);
  if (!j?.id) return null;
  return {
    source: "greenhouse",
    externalId: String(j.id),
    url: j.absolute_url,
    applyUrl: j.absolute_url,
    title: j.title,
    companyName: j.company_name || prettyToken(token),
    location: j.location?.name,
    description: j.content
      ? stripHtml(j.content.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"))
      : undefined,
    postedAt: j.updated_at ? new Date(j.updated_at) : undefined,
    raw: { id: j.id, token },
  };
}

async function fromLever(token: string, id: string): Promise<RawJob | null> {
  const p = await fetchJson<{
    id: string;
    text: string;
    hostedUrl: string;
    applyUrl?: string;
    categories?: { location?: string };
    descriptionPlain?: string;
    createdAt?: number;
  }>(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}/${id}`);
  if (!p?.id) return null;
  return {
    source: "lever",
    externalId: p.id,
    url: p.hostedUrl,
    applyUrl: p.applyUrl || p.hostedUrl,
    title: p.text,
    companyName: prettyToken(token),
    location: p.categories?.location,
    description: p.descriptionPlain,
    postedAt: p.createdAt ? new Date(p.createdAt) : undefined,
    raw: { id: p.id, token },
  };
}

async function fromAshby(token: string, id: string): Promise<RawJob | null> {
  const data = await fetchJson<{
    data?: {
      jobPosting?: {
        id: string;
        title: string;
        locationName?: string;
        descriptionHtml?: string;
        compensationTierSummary?: string;
      };
    };
  }>("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationName: "ApiJobPosting",
      variables: { organizationHostedJobsPageName: token, jobPostingId: id },
      query:
        "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id title locationName descriptionHtml compensationTierSummary } }",
    }),
  });
  const j = data.data?.jobPosting;
  if (!j?.id) return null;
  const url = `https://jobs.ashbyhq.com/${token}/${j.id}`;
  return {
    source: "ashby",
    externalId: j.id,
    url,
    applyUrl: `${url}/application`,
    title: j.title,
    companyName: prettyToken(token),
    location: j.locationName,
    salary: j.compensationTierSummary,
    description: j.descriptionHtml ? stripHtml(j.descriptionHtml) : undefined,
    raw: { id: j.id, token },
  };
}

async function fromRecruitee(token: string, slug: string): Promise<RawJob | null> {
  const data = await fetchJson<{
    offer?: {
      id: number;
      title: string;
      careers_url?: string;
      careers_apply_url?: string;
      city?: string;
      country?: string;
      description?: string;
      requirements?: string;
      published_at?: string;
    };
  }>(`https://${encodeURIComponent(token)}.recruitee.com/api/offers/${encodeURIComponent(slug)}`);
  const o = data.offer;
  if (!o?.id) return null;
  return {
    source: "recruitee",
    externalId: String(o.id),
    url: o.careers_url || `https://${token}.recruitee.com/o/${slug}`,
    applyUrl: o.careers_apply_url || o.careers_url || `https://${token}.recruitee.com/o/${slug}`,
    title: o.title,
    companyName: prettyToken(token),
    location: [o.city, o.country].filter(Boolean).join(", ") || undefined,
    description: stripHtml([o.description, o.requirements].filter(Boolean).join("\n")) || undefined,
    postedAt: o.published_at ? new Date(o.published_at) : undefined,
    raw: { id: o.id, token },
  };
}

async function fromWorkable(account: string, shortcode: string): Promise<RawJob | null> {
  const j = await fetchJson<{
    shortcode: string;
    title: string;
    description?: string;
    requirements?: string;
    benefits?: string;
    location?: { city?: string; country?: string } | string;
    remote?: boolean;
    published?: string;
  }>(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${encodeURIComponent(shortcode)}`);
  if (!j?.shortcode) return null;
  const loc =
    typeof j.location === "string"
      ? j.location
      : [j.location?.city, j.location?.country].filter(Boolean).join(", ");
  const url = `https://apply.workable.com/${account}/j/${j.shortcode}/`;
  return {
    source: "workable",
    externalId: j.shortcode,
    url,
    applyUrl: `${url}apply/`,
    title: j.title,
    companyName: prettyToken(account),
    location: [j.remote ? "Remote" : null, loc].filter(Boolean).join(" · ") || undefined,
    description:
      stripHtml([j.description, j.requirements, j.benefits].filter(Boolean).join("\n")) || undefined,
    postedAt: j.published ? new Date(j.published) : undefined,
    raw: { shortcode: j.shortcode, token: account },
  };
}

async function fromSmartrecruiters(token: string, id: string): Promise<RawJob | null> {
  const p = await fetchJson<{
    id: string;
    name: string;
    company?: { name?: string };
    location?: { city?: string; country?: string; remote?: boolean };
    releasedDate?: string;
    postingUrl?: string;
    applyUrl?: string;
    jobAd?: { sections?: Record<string, { text?: string }> };
  }>(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${id}`);
  if (!p?.id) return null;
  const desc = Object.values(p.jobAd?.sections || {})
    .map((s) => s?.text)
    .filter(Boolean)
    .join("\n");
  return {
    source: "smartrecruiters",
    externalId: p.id,
    url: p.postingUrl || `https://jobs.smartrecruiters.com/${token}/${p.id}`,
    applyUrl: p.applyUrl || p.postingUrl || `https://jobs.smartrecruiters.com/${token}/${p.id}`,
    title: p.name,
    companyName: p.company?.name || prettyToken(token),
    location: [p.location?.remote ? "Remote" : null, p.location?.city, p.location?.country]
      .filter(Boolean)
      .join(" · ") || undefined,
    description: desc ? stripHtml(desc) : undefined,
    postedAt: p.releasedDate ? new Date(p.releasedDate) : undefined,
    raw: { id: p.id, token },
  };
}

const UUID_RE = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

export async function fetchJobFromUrl(rawUrl: string): Promise<RawJob | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  try {
    let m: RegExpExecArray | null;

    if (/^(job-)?boards\.(eu\.)?greenhouse\.io$/.test(host) && (m = /^\/([^/]+)\/jobs\/(\d+)/.exec(path)))
      return await fromGreenhouse(m[1], m[2]);

    if (/^jobs\.(eu\.)?lever\.co$/.test(host) && (m = new RegExp(`^/([^/]+)/(${UUID_RE})`).exec(path)))
      return await fromLever(m[1], m[2]);

    if (host === "jobs.ashbyhq.com" && (m = new RegExp(`^/([^/]+)/(${UUID_RE})`).exec(path)))
      return await fromAshby(m[1], m[2]);

    if ((m = /^([a-z0-9-]+)\.recruitee\.com$/.exec(host)) && !["www", "api", "docs"].includes(m[1])) {
      const slug = /^\/o\/([^/]+)/.exec(path);
      if (slug) return await fromRecruitee(m[1], slug[1]);
    }

    if (host === "apply.workable.com") {
      if ((m = /^\/([^/]+)\/j\/([^/]+)/.exec(path))) return await fromWorkable(m[1], m[2]);
      if ((m = /^\/j\/([^/]+)/.exec(path))) {
        // short link — the account is only revealed by the redirect (GET: HEAD gets dropped)
        const res = await fetch(rawUrl, { redirect: "manual", headers: { "User-Agent": UA } });
        const loc = res.headers.get("location") || ""; // may be relative ("/seeq/j/…")
        const r = /\/([^/]+)\/j\/([^/?#]+)/.exec(loc);
        if (r) return await fromWorkable(r[1], r[2]);
      }
    }

    if (host === "jobs.smartrecruiters.com" && (m = /^\/([^/]+)\/(\d+)/.exec(path)))
      return await fromSmartrecruiters(m[1], m[2]);
  } catch {
    // any API failure → let the generic path handle the page
  }
  return null;
}
