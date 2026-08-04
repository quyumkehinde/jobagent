// JobAgent form filler — injected on demand from the popup. Fills whatever ATS form is
// on the page from drafted answers: matches by ATS field name first (Lever/Greenhouse
// names equal our fieldKeys), then by visible label. Sets values the React-safe way so
// modern ATS UIs register them. Never clicks submit — that's the human's job.
(() => {
  if (window.__jobagentFillReady) return;
  window.__jobagentFillReady = true;

  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .replace(/[*✱]|\(required\)|\(optional\)/g, "")
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  function labelsFor(el) {
    const out = [];
    if (el.labels) for (const l of el.labels) out.push(l.textContent);
    const closest = el.closest("label");
    if (closest) out.push(closest.textContent);
    if (el.getAttribute("aria-label")) out.push(el.getAttribute("aria-label"));
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy)
      for (const id of labelledBy.split(/\s+/)) {
        const n = document.getElementById(id);
        if (n) out.push(n.textContent);
      }
    if (el.placeholder) out.push(el.placeholder);
    // ATSs often wrap field + label in a small container div
    const wrapper = el.closest("div, li, fieldset");
    if (wrapper) {
      const lab = wrapper.querySelector("label, legend, .label, [class*='label' i]");
      if (lab && lab.textContent.length < 200) out.push(lab.textContent);
    }
    return out.map(norm).filter(Boolean);
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return (r.width > 0 && r.height > 0) || el.type === "file"; // file inputs are often hidden behind styled buttons
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function highlight(el, color) {
    try {
      el.style.outline = `2px solid ${color}`;
      el.style.outlineOffset = "1px";
    } catch {}
  }

  function fillSelect(sel, answer) {
    const wanted = norm(answer);
    const parts = answer.split(",").map((s) => norm(s)).filter(Boolean); // multiselect answers are comma-joined
    let hit = false;
    for (const opt of sel.options) {
      const o = norm(opt.textContent) || norm(opt.value);
      if (!o) continue; // placeholder options ("--", "Select…") must never match
      const match = o === wanted || parts.includes(o) || (wanted && (o.includes(wanted) || wanted.includes(o)));
      if (match && !hit) {
        sel.value = opt.value;
        hit = true;
        if (!sel.multiple) break;
      }
      if (sel.multiple && match) opt.selected = true;
    }
    if (hit) {
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return hit;
  }

  function fillRadio(radios, answer) {
    const wanted = norm(answer);
    for (const r of radios) {
      const labels = [...labelsFor(r), norm(r.value)];
      if (labels.some((l) => l === wanted || (wanted && l && (l.includes(wanted) || wanted.includes(l))))) {
        r.click();
        return true;
      }
    }
    return false;
  }

  function attachFile(input, resume) {
    try {
      const bin = atob(resume.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], resume.name, { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.files.length === 1;
    } catch {
      return false;
    }
  }

  function run(payload) {
    const controls = [...document.querySelectorAll("input, textarea, select")].filter(
      (el) =>
        !el.disabled &&
        !["hidden", "submit", "button", "password"].includes(el.type) &&
        visible(el)
    );
    const used = new Set();
    let filled = 0;
    let attachedResume = false;
    const skipped = [];

    const findControl = (fieldKey, label) => {
      const nl = norm(label);
      // 1) ATS-native field name (exact) — Lever/classic-Greenhouse forms match our fieldKeys
      let el = controls.find((c) => !used.has(c) && (c.name === fieldKey || c.id === fieldKey));
      if (el) return el;
      // 2) exact label
      el = controls.find((c) => !used.has(c) && labelsFor(c).some((l) => l === nl));
      if (el) return el;
      // 3) containment either way (labels can carry extra text)
      return controls.find(
        (c) => !used.has(c) && nl.length > 3 && labelsFor(c).some((l) => l.includes(nl) || nl.includes(l))
      );
    };

    for (const a of payload.answers) {
      if (a.fieldType === "file") {
        if (payload.resume && !attachedResume) {
          const el = findControl(a.fieldKey, a.label) || controls.find((c) => !used.has(c) && c.type === "file");
          if (el && el.type === "file" && attachFile(el, payload.resume)) {
            used.add(el);
            attachedResume = true;
            highlight(el.closest("div") || el, "#059669");
          } else skipped.push(a.label);
        }
        continue;
      }
      if (!a.answer) continue;

      const el = findControl(a.fieldKey, a.label);
      if (!el) {
        skipped.push(a.label);
        continue;
      }

      let ok = false;
      if (el.tagName === "SELECT") ok = fillSelect(el, a.answer);
      else if (el.type === "radio") {
        const radios = controls.filter((c) => c.type === "radio" && c.name === el.name);
        ok = fillRadio(radios, a.answer);
        radios.forEach((r) => used.add(r));
      } else if (el.type === "checkbox") {
        const yes = /^(yes|true|1)/i.test(a.answer);
        if (el.checked !== yes) el.click();
        ok = true;
      } else {
        setNativeValue(el, a.answer);
        ok = true;
      }

      used.add(el);
      if (ok) {
        filled++;
        highlight(el, "#059669");
      } else {
        skipped.push(a.label);
        highlight(el, "#d97706");
      }
    }

    // cover letter → first unfilled cover/comments textarea
    if (payload.coverLetter) {
      const el = controls.find(
        (c) =>
          !used.has(c) &&
          c.tagName === "TEXTAREA" &&
          labelsFor(c).some((l) => /cover|additional info|comments|anything else|note to/.test(l))
      );
      if (el) {
        setNativeValue(el, payload.coverLetter);
        highlight(el, "#059669");
        filled++;
      }
    }

    return { filled, skipped, attachedResume };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "jobagent-fill") return;
    try {
      sendResponse(run(msg));
    } catch (err) {
      sendResponse({ filled: 0, skipped: [`error: ${String(err)}`], attachedResume: false });
    }
  });
})();
