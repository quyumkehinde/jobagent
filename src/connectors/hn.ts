import { RawJob, fetchJson, stripHtml } from "./types";

interface AlgoliaHit {
  objectID: string;
  title?: string;
  author?: string;
  created_at?: string;
  comment_text?: string;
  parent_id?: number;
  story_id?: number;
}

interface AlgoliaResult {
  hits: AlgoliaHit[];
  nbPages: number;
}

// Finds the latest "Ask HN: Who is hiring?" thread and treats each top-level comment as a job post.
export async function fetchHnWhoIsHiring(): Promise<RawJob[]> {
  const search = await fetchJson<AlgoliaResult>(
    "https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=5"
  );
  const story = search.hits.find((h) => /who is hiring/i.test(h.title || ""));
  if (!story) return [];
  const storyId = Number(story.objectID);

  const jobs: RawJob[] = [];
  for (let page = 0; page < 3; page++) {
    const comments = await fetchJson<AlgoliaResult>(
      `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${storyId}&hitsPerPage=1000&page=${page}`
    );
    for (const c of comments.hits) {
      if (c.parent_id !== storyId || !c.comment_text) continue;
      const text = stripHtml(c.comment_text);
      if (text.length < 80) continue; // skip meta/short comments
      const firstLine = text.split("\n")[0].slice(0, 200);
      // Convention: "Company | Role | Location | ..."
      const segs = firstLine.split("|").map((s) => s.trim());
      const companyName = segs[0]?.slice(0, 80) || "HN post";
      const title = segs.length > 1 ? segs.slice(1, 3).join(" · ") : firstLine;
      if (!/engineer|developer|backend|full.?stack|mobile|infra|swe|software/i.test(text)) continue;
      jobs.push({
        source: "hn",
        externalId: c.objectID,
        url: `https://news.ycombinator.com/item?id=${c.objectID}`,
        title: title.slice(0, 150),
        companyName,
        location: segs.find((s) => /remote|onsite|hybrid|london|europe|berlin|amsterdam|paris/i.test(s)),
        description: text,
        postedAt: c.created_at ? new Date(c.created_at) : undefined,
      });
    }
    if (page + 1 >= comments.nbPages) break;
  }
  return jobs;
}
