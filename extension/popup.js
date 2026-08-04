const BASE = "http://localhost:3000";

const $ = (id) => document.getElementById(id);

let tab = null;
let apps = [];

function companySlug(name) {
  return (name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// How likely is this application the one open in the current tab?
function matchScore(app, tabUrl) {
  if (!tabUrl) return 0;
  let score = 0;
  const t = new URL(tabUrl);
  for (const u of [app.job?.url, app.job?.applyUrl]) {
    if (!u) continue;
    try {
      const j = new URL(u);
      if (j.host === t.host) score += 2;
      if (j.pathname !== "/" && t.pathname.includes(j.pathname.split("/").filter(Boolean)[0] || "")) score += 1;
    } catch {}
  }
  const slug = companySlug(app.job?.companyName);
  if (slug && (t.host + t.pathname).toLowerCase().replace(/[^a-z0-9]/g, "").includes(slug)) score += 2;
  return score;
}

async function api(path, opts) {
  const res = await fetch(BASE + path, opts);
  if (!res.ok) throw new Error(`${res.status} from ${path}`);
  return res;
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const data = await (await api("/api/applications?status=ready,submitted")).json();
    apps = (data.applications || []).filter((a) => a.job);
  } catch {
    $("status").innerHTML =
      '<span class="err">Can\'t reach JobAgent at localhost:3000.\nStart it with: npm run dev</span>';
    return;
  }
  if (!apps.length) {
    $("status").innerHTML = '<span class="muted">No ready applications. Draft one in JobAgent first.</span>';
    return;
  }

  apps.sort((a, b) => matchScore(b, tab?.url) - matchScore(a, tab?.url) || (a.status === "ready" ? -1 : 1));
  const sel = $("apps");
  for (const a of apps) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = `${a.job.title} — ${a.job.companyName}${a.status !== "ready" ? ` (${a.status})` : ""}`;
    sel.appendChild(opt);
  }
  const best = matchScore(apps[0], tab?.url);
  $("match").textContent = best >= 2 ? "✓ matches the page you're on" : "";
  $("status").style.display = "none";
  $("main").style.display = "block";
}

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

$("fill").addEventListener("click", async () => {
  const id = $("apps").value;
  $("fill").disabled = true;
  $("result").innerHTML = '<span class="muted">Filling…</span>';
  try {
    const detail = await (await api(`/api/applications/${id}`)).json();

    let resume = null;
    try {
      const res = await api(`/api/applications/${id}/resume`);
      const name = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || "resume.pdf";
      resume = { name, base64: bufToBase64(await res.arrayBuffer()) };
    } catch {} // no resume on file — fill everything else

    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["fill.js"] });
    const outcome = await chrome.tabs.sendMessage(tab.id, {
      type: "jobagent-fill",
      answers: detail.answers || [],
      coverLetter: detail.application?.coverLetter || null,
      resume,
    });

    const parts = [`<span class="ok">Filled ${outcome.filled} field(s).</span>`];
    if (outcome.attachedResume) parts.push('<span class="ok">Resume attached.</span>');
    if (outcome.skipped?.length)
      parts.push(
        `<span class="warn">Couldn't match ${outcome.skipped.length}:\n${outcome.skipped
          .slice(0, 8)
          .map((s) => `• ${s}`)
          .join("\n")}</span>`
      );
    parts.push('<span class="muted">Review the page, solve any captcha, and click the site\'s submit button yourself.</span>');
    $("result").innerHTML = parts.join("<br>");
  } catch (err) {
    $("result").innerHTML = `<span class="err">${String(err.message || err)}\n(Chrome pages and some iframed forms can't be filled.)</span>`;
  }
  $("fill").disabled = false;
});

$("applied").addEventListener("click", async () => {
  const id = $("apps").value;
  $("applied").disabled = true;
  try {
    await api(`/api/applications/${id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "manual" }),
    });
    $("result").innerHTML = '<span class="ok">Marked as applied ✓ — tracked in your pipeline.</span>';
  } catch (err) {
    $("result").innerHTML = `<span class="err">${String(err.message || err)}</span>`;
  }
  $("applied").disabled = false;
});

init();
