import { RawJob, UA, stripHtml, titleLooksRelevant } from "./types";

// Personio (DACH+NL mid-market) exposes a public XML feed per careers site.
// Hand-rolled regex XML extraction, same idiom as weworkremotely.ts.

function tag(block: string, name: string): string {
  const r = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(block);
  return r ? r[1].trim() : "";
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const text = await res.text();
    return text.includes("<workzag-jobs") || text.includes("<position>") ? text : null;
  } catch {
    return null;
  }
}

export function personioFeedUrls(token: string): string[] {
  const t = encodeURIComponent(token);
  return [`https://${t}.jobs.personio.de/xml`, `https://${t}.jobs.personio.com/xml`];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchPersonio(
  token: string,
  companyName: string,
  companyId: number,
  knownExternalIds: Set<string> = new Set(),
  maxDetailFetches = 25
): Promise<RawJob[]> {
  let xml: string | null = null;
  let base = "";
  for (const url of personioFeedUrls(token)) {
    xml = await fetchXml(url);
    if (xml) {
      base = url.replace(/\/xml$/, "");
      break;
    }
  }
  if (!xml) throw new Error(`no Personio feed for ${token}`);

  const jobs: RawJob[] = [];
  let details = 0;
  const posRe = /<position>([\s\S]*?)<\/position>/g;
  let m: RegExpExecArray | null;
  while ((m = posRe.exec(xml))) {
    const block = m[1];
    const title = stripHtml(tag(block, "name"));
    if (!title || !titleLooksRelevant(title)) continue;
    const id = tag(block, "id");
    if (!id) continue;

    // description = all <jobDescription> value blocks concatenated
    const parts: string[] = [];
    const descRe = /<jobDescription>([\s\S]*?)<\/jobDescription>/g;
    let d: RegExpExecArray | null;
    while ((d = descRe.exec(block))) {
      const label = stripHtml(tag(d[1], "name"));
      const value = stripHtml(tag(d[1], "value"));
      if (value) parts.push(label ? `${label}\n${value}` : value);
    }

    const offices = [tag(block, "office"), ...(tag(block, "additionalOffices").match(/<office>([\s\S]*?)<\/office>/g) || []).map((o) => stripHtml(o))]
      .map((s) => stripHtml(s))
      .filter(Boolean);

    const job: RawJob = {
      source: "personio",
      externalId: id,
      url: `${base}/job/${id}`,
      applyUrl: `${base}/job/${id}#apply`,
      title,
      companyName: stripHtml(tag(block, "subcompany")) || companyName,
      companyId,
      location: offices.join(", ") || undefined,
      description: parts.join("\n\n") || undefined,
      raw: { id, token },
    };

    // Some feeds ship empty <jobDescriptions> — pull the job page instead for NEW jobs
    // so a position is never permanently ingested descriptionless.
    if (!job.description && !knownExternalIds.has(id)) {
      if (details >= maxDetailFetches) continue; // waits for the next run
      details++;
      try {
        const res = await fetch(job.url, { headers: { "User-Agent": UA } });
        if (res.ok) {
          const text = stripHtml(await res.text());
          if (text.length > 200) job.description = text.slice(0, 20000);
          else continue; // JS-only page and empty feed — skip, retry next run
        } else continue;
      } catch {
        continue;
      }
      await sleep(150);
    }
    jobs.push(job);
  }
  return jobs;
}
