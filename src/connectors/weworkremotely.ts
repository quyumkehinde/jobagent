import { RawJob, UA, stripHtml, titleLooksRelevant } from "./types";

const FEEDS = [
  "https://weworkremotely.com/categories/remote-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
];

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
  region?: string;
}

function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const tag = (name: string) => {
      const r = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(block);
      return r ? r[1].trim() : "";
    };
    items.push({
      title: tag("title"),
      link: tag("link"),
      description: tag("description"),
      pubDate: tag("pubDate"),
      region: tag("region"),
    });
  }
  return items;
}

export async function fetchWeWorkRemotely(): Promise<RawJob[]> {
  const seen = new Set<string>();
  const jobs: RawJob[] = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed, { headers: { "User-Agent": UA } });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const item of parseRss(xml)) {
        if (!item.link || seen.has(item.link)) continue;
        seen.add(item.link);
        // WWR titles look like "Company: Role"
        const [companyPart, ...titleParts] = item.title.split(":");
        const title = titleParts.join(":").trim() || item.title;
        if (!titleLooksRelevant(title)) continue;
        jobs.push({
          source: "weworkremotely",
          externalId: item.link.split("/").filter(Boolean).pop() || item.link,
          url: item.link,
          title,
          companyName: titleParts.length ? companyPart.trim() : "Unknown",
          location: item.region || "Remote",
          description: stripHtml(item.description),
          postedAt: item.pubDate ? new Date(item.pubDate) : undefined,
        });
      }
    } catch {
      // individual feed failure shouldn't kill the run
    }
  }
  return jobs;
}
