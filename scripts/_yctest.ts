import { fetchYcJobs } from "@/connectors/yc";
(async () => {
  const jobs = await fetchYcJobs(new Set(), 6);
  for (const j of jobs) console.log(j.title, "|", j.companyName, "|", JSON.stringify(j.raw).slice(0, 220));
})();
