(() => {
  if (window.__ycifLoaded) return;
  window.__ycifLoaded = true;

  const D = globalThis.YCIF_DATA;
  const SC = globalThis.YCIF_SCORE;
  const TIER_RANK = { none: 0, low: 1, medium: 2, high: 3 };
  const DEFAULT_SETTINGS = {
    minTier: "medium",
    indiaOnly: false,
    team: true,
    hideContacted: false,
    sort: "batch",
    extraSurnames: "",
    extraFirstNames: "",
  };

  const S = {
    open: false,
    built: false,
    batches: [],
    showAllBatches: false,
    selected: new Set(),
    loaded: new Set(),
    loading: new Set(),
    founders: new Map(),
    companies: new Map(),
    contacted: {},
    settings: { ...DEFAULT_SETTINGS },
    search: "",
    status: "",
    error: "",
    enriching: false,
    stopEnrich: false,
    showSettings: false,
  };

  let host, root, panel, fab;

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const safeUrl = (u) => {
    if (!u) return "";
    const v = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    try {
      const p = new URL(v);
      return p.protocol === "http:" || p.protocol === "https:" ? p.href : "";
    } catch (e) {
      return "";
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadState() {
    const st = await chrome.storage.local.get(["settings", "contacted", "selectedBatches"]);
    S.settings = { ...DEFAULT_SETTINGS, ...(st.settings || {}) };
    S.contacted = st.contacted || {};
    S.savedSelection = st.selectedBatches || null;
    S.companies = await D.loadCachedCompanies();
    SC.configure({ surnames: S.settings.extraSurnames, firstNames: S.settings.extraFirstNames });
  }

  const saveSettings = () => chrome.storage.local.set({ settings: S.settings });
  const saveSelection = () => chrome.storage.local.set({ selectedBatches: [...S.selected] });

  function enrichmentFor(r) {
    const co = r.companySlug && S.companies.get(r.companySlug);
    if (!co) return { co: null, f: null };
    const f = co.founders.find((x) => x.userId === r.id) ||
      co.founders.find((x) => x.name.toLowerCase() === r.name.toLowerCase()) || null;
    return { co, f };
  }

  function rescore(r) {
    const { co, f } = enrichmentFor(r);
    Object.assign(r, SC.score({
      first: r.first,
      last: r.last,
      region: r.region,
      bio: f ? f.bio : "",
      companyLocation: co ? co.location : "",
    }));
    r.linkedin = f ? f.linkedin : "";
    r.twitter = f ? f.twitter : "";
    r.bio = f ? f.bio : "";
    r.website = co ? co.website : "";
    r.openJobs = co ? co.openJobs : null;
    r.enriched = !!co;
  }

  const rescoreAll = () => S.founders.forEach(rescore);

  function batchRank(r) {
    let best = 0;
    for (const b of r.batches) if (S.selected.has(b)) best = Math.max(best, D.batchInfo(b).rank);
    return best;
  }

  function visibleRows() {
    const st = S.settings;
    const min = TIER_RANK[st.minTier];
    const pool = [...S.founders.values()].filter((r) => r.batches.some((b) => S.selected.has(b)));
    const matched = pool.filter((r) => TIER_RANK[r.tier] >= min && (!st.indiaOnly || r.inIndia));
    const matchedIds = new Set(matched.map((r) => r.id));
    let rows = matched.map((r) => ({ r, teammate: false }));
    if (st.team) {
      const slugs = new Set(matched.map((r) => r.companySlug).filter(Boolean));
      rows = pool
        .filter((r) => matchedIds.has(r.id) || slugs.has(r.companySlug))
        .map((r) => ({ r, teammate: !matchedIds.has(r.id) }));
    }
    const q = S.search.trim().toLowerCase();
    if (q) {
      rows = rows.filter(({ r }) =>
        [r.name, r.company, r.title, r.region, r.reasons.join(" "), r.industries.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    if (st.hideContacted) rows = rows.filter(({ r }) => !S.contacted[r.id]);
    const byCompany = (a, b) => a.r.company.localeCompare(b.r.company) || a.teammate - b.teammate || b.r.score - a.r.score;
    if (st.sort === "score") rows.sort((a, b) => a.teammate - b.teammate || b.r.score - a.r.score || byCompany(a, b));
    else if (st.sort === "company") rows.sort(byCompany);
    else rows.sort((a, b) => batchRank(b.r) - batchRank(a.r) || byCompany(a, b));
    return { rows, pool, matched };
  }

  async function ensureLoaded() {
    const todo = [...S.selected].filter((c) => !S.loaded.has(c) && !S.loading.has(c));
    for (const code of todo) {
      S.loading.add(code);
      setStatus(`Loading ${code} founders...`);
      try {
        const recs = await D.foundersForBatch(code);
        for (const r of recs) {
          const prev = S.founders.get(r.id);
          if (prev) r.batches = [...new Set([...prev.batches, ...r.batches])];
          rescore(r);
          S.founders.set(r.id, r);
        }
        S.loaded.add(code);
      } catch (e) {
        S.error = `Could not load ${code}: ${e.message}`;
      } finally {
        S.loading.delete(code);
      }
      render();
    }
    setStatus("");
  }

  async function enrich() {
    if (S.enriching) {
      S.stopEnrich = true;
      return;
    }
    const slugs = [...new Set(visibleRows().rows.map(({ r }) => r.companySlug).filter((s) => s && !S.companies.has(s)))];
    if (!slugs.length) {
      setStatus("Everything visible already has LinkedIn and bio data.");
      return;
    }
    S.enriching = true;
    S.stopEnrich = false;
    let done = 0;
    let failed = 0;
    const queue = [...slugs];
    const worker = async () => {
      while (queue.length && !S.stopEnrich) {
        const slug = queue.shift();
        try {
          S.companies.set(slug, await D.companyDetails(slug));
        } catch (e) {
          failed++;
        }
        done++;
        setStatus(`Fetching company pages ${done}/${slugs.length}${failed ? ` (${failed} failed)` : ""}`);
        await sleep(350);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    rescoreAll();
    S.enriching = false;
    setStatus(`${S.stopEnrich ? "Stopped" : "Done"}. Added LinkedIn and bios for ${done - failed} companies.`);
    render();
  }

  function exportCsv() {
    const { rows } = visibleRows();
    const cols = [
      "name", "title", "company", "company_url", "batches", "region", "signal", "score", "reasons",
      "teammate_only", "linkedin", "twitter", "yc_profile", "hn", "website", "open_jobs", "contacted",
    ];
    const cell = (v) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const { r, teammate } of rows) {
      lines.push([
        r.name, r.title, r.company,
        r.companySlug ? `https://www.ycombinator.com/companies/${r.companySlug}` : "",
        r.batches.join(" "), r.region, r.tier, r.score, r.reasons.join("; "), teammate ? "yes" : "",
        r.linkedin, r.twitter, r.urlSlug ? `https://www.ycombinator.com/people/${r.urlSlug}` : "",
        r.hnid ? `https://news.ycombinator.com/user?id=${r.hnid}` : "", r.website,
        r.openJobs ?? "", S.contacted[r.id] ? new Date(S.contacted[r.id]).toISOString().slice(0, 10) : "",
      ].map(cell).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `yc-india-origin-founders-${[...S.selected].join("-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function setStatus(msg) {
    S.status = msg;
    const el = root && root.querySelector(".status-msg");
    if (el) el.textContent = msg;
  }

  function chipsHtml() {
    if (!S.batches.length) return `<span class="muted">${S.error ? "" : "Loading batches..."}</span>`;
    const list = S.showAllBatches ? S.batches : S.batches.slice(0, 10);
    const chips = list
      .map((b) => {
        const on = S.selected.has(b.code);
        const busy = S.loading.has(b.code);
        return `<button class="chip ${on ? "on" : ""} ${busy ? "busy" : ""}" data-batch="${esc(b.code)}" title="${esc(b.label)}">${esc(b.code)}<span>${b.count}</span></button>`;
      })
      .join("");
    const more = S.batches.length > 10
      ? `<button class="link-btn" data-act="more">${S.showAllBatches ? "fewer" : `all ${S.batches.length}`}</button>`
      : "";
    return chips + more;
  }

  function rowHtml({ r, teammate }) {
    const contacted = !!S.contacted[r.id];
    const initials = (r.first[0] || "") + (r.last[0] || "");
    const avatar = safeUrl(r.avatar)
      ? `<img src="${esc(safeUrl(r.avatar))}" alt="" loading="lazy">`
      : `<span class="initials">${esc(initials)}</span>`;
    const links = [
      r.linkedin && `<a href="${esc(safeUrl(r.linkedin))}" target="_blank" rel="noopener" class="pill li">LinkedIn</a>`,
      r.twitter && `<a href="${esc(safeUrl(r.twitter))}" target="_blank" rel="noopener" class="pill">X</a>`,
      r.urlSlug && `<a href="https://www.ycombinator.com/people/${esc(encodeURIComponent(r.urlSlug))}" target="_blank" rel="noopener" class="pill">YC</a>`,
      r.hnid && `<a href="https://news.ycombinator.com/user?id=${esc(encodeURIComponent(r.hnid))}" target="_blank" rel="noopener" class="pill">HN</a>`,
      r.website && `<a href="${esc(safeUrl(r.website))}" target="_blank" rel="noopener" class="pill">Site</a>`,
    ].filter(Boolean).join("");
    const companyLink = r.companySlug
      ? `<a href="/companies/${esc(encodeURIComponent(r.companySlug))}" target="_blank" rel="noopener">${esc(r.company)}</a>`
      : esc(r.company);
    const jobs = r.openJobs ? `<span class="jobs">${r.openJobs} open job${r.openJobs > 1 ? "s" : ""}</span>` : "";
    const tierLabel = teammate ? "co-founder" : { high: "strong", medium: "likely", low: "weak", none: "none" }[r.tier];
    return `<tr class="${teammate ? "teammate" : ""} ${contacted ? "contacted" : ""}">
      <td class="person"><div class="pwrap"><div class="av">${avatar}</div><div><div class="nm">${esc(r.name)}</div><div class="sub">${esc(r.title)}</div></div></div></td>
      <td><div class="co">${companyLink}</div><div class="sub">${esc(r.batches.join(", "))}${r.region ? ` · ${esc(r.region)}` : ""}</div>${jobs}</td>
      <td><span class="tier t-${teammate ? "team" : r.tier}">${esc(tierLabel)}</span><div class="why">${esc(r.reasons.join(" · ") || (teammate ? "on the same founding team" : ""))}</div></td>
      <td class="links">${links || (r.enriched ? "" : '<span class="muted">fetch links</span>')}</td>
      <td class="ct"><label><input type="checkbox" data-contact="${r.id}" ${contacted ? "checked" : ""}> ${contacted ? "contacted" : ""}</label></td>
    </tr>`;
  }

  function render() {
    if (!S.built) return;
    const st = S.settings;
    const { rows, pool, matched } = visibleRows();
    const pending = new Set(rows.map(({ r }) => r.companySlug).filter((s) => s && !S.companies.has(s))).size;
    root.querySelector(".chips").innerHTML = chipsHtml();
    root.querySelector(".summary").textContent = pool.length
      ? `${matched.length} matching founders${st.team ? ` + ${rows.filter((x) => x.teammate).length} of their co-founders` : ""} out of ${pool.length} in ${[...S.selected].join(", ")}`
      : S.selected.size ? "" : "Pick at least one batch.";
    root.querySelector('[data-act="enrich"]').textContent = S.enriching
      ? "Stop"
      : pending ? `Get LinkedIn + bios (${pending})` : "LinkedIn + bios loaded";
    root.querySelector('[data-act="enrich"]').disabled = !S.enriching && !pending;
    root.querySelector(".error").textContent = S.error;
    root.querySelector(".error").hidden = !S.error;
    root.querySelector(".settings").hidden = !S.showSettings;
    const body = root.querySelector("tbody");
    body.innerHTML = rows.length
      ? rows.map(rowHtml).join("")
      : `<tr><td colspan="5" class="empty">${S.loading.size ? "Loading..." : "No founders match these filters."}</td></tr>`;
  }

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "panel";
    panel.innerHTML = `
      <header>
        <div>
          <h1>India-origin founders</h1>
          <p>Name and bio heuristic. Treat it as a lead list and check LinkedIn before reaching out.</p>
        </div>
        <button class="x" data-act="close" aria-label="Close">×</button>
      </header>
      <section class="controls">
        <div class="row"><span class="lbl">Batches</span><div class="chips"></div></div>
        <div class="row wrap">
          <label>Signal
            <select data-set="minTier">
              <option value="high">Strong only</option>
              <option value="medium">Strong + likely</option>
              <option value="low">Any signal</option>
            </select>
          </label>
          <label>Sort
            <select data-set="sort">
              <option value="batch">Newest batch</option>
              <option value="score">Signal strength</option>
              <option value="company">Company A-Z</option>
            </select>
          </label>
          <label class="cb"><input type="checkbox" data-set="team"> Show full founding team</label>
          <label class="cb"><input type="checkbox" data-set="indiaOnly"> Based in India</label>
          <label class="cb"><input type="checkbox" data-set="hideContacted"> Hide contacted</label>
          <input type="search" class="search" placeholder="Search name, company, industry">
        </div>
        <div class="row">
          <button class="btn primary" data-act="enrich">Get LinkedIn + bios</button>
          <button class="btn" data-act="csv">Export CSV</button>
          <button class="btn ghost" data-act="settings">Tune names</button>
          <span class="status-msg"></span>
        </div>
        <div class="settings" hidden>
          <p>Add names the built-in lists miss (space or comma separated). They count as strong signals.</p>
          <div class="two">
            <label>Extra surnames<textarea data-set="extraSurnames" rows="2"></textarea></label>
            <label>Extra first names<textarea data-set="extraFirstNames" rows="2"></textarea></label>
          </div>
        </div>
        <div class="error" hidden></div>
        <div class="summary"></div>
      </section>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Founder</th><th>Company</th><th>Signal</th><th>Links</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>`;
    root.appendChild(panel);

    const st = S.settings;
    for (const el of panel.querySelectorAll("[data-set]")) {
      const key = el.dataset.set;
      if (el.type === "checkbox") el.checked = !!st[key];
      else el.value = st[key];
      el.addEventListener(el.tagName === "TEXTAREA" ? "change" : "input", () => {
        st[key] = el.type === "checkbox" ? el.checked : el.value;
        saveSettings();
        if (key === "extraSurnames" || key === "extraFirstNames") {
          SC.configure({ surnames: st.extraSurnames, firstNames: st.extraFirstNames });
          rescoreAll();
        }
        render();
      });
    }

    let t;
    panel.querySelector(".search").addEventListener("input", (e) => {
      clearTimeout(t);
      t = setTimeout(() => {
        S.search = e.target.value;
        render();
      }, 150);
    });

    panel.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-batch]");
      if (chip) {
        const code = chip.dataset.batch;
        if (S.selected.has(code)) S.selected.delete(code);
        else S.selected.add(code);
        saveSelection();
        render();
        ensureLoaded();
        return;
      }
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "close") toggle(false);
      else if (act === "enrich") enrich();
      else if (act === "csv") exportCsv();
      else if (act === "more") {
        S.showAllBatches = !S.showAllBatches;
        render();
      } else if (act === "settings") {
        S.showSettings = !S.showSettings;
        render();
      }
    });

    panel.addEventListener("change", (e) => {
      const id = e.target.dataset && e.target.dataset.contact;
      if (!id) return;
      if (e.target.checked) S.contacted[id] = Date.now();
      else delete S.contacted[id];
      chrome.storage.local.set({ contacted: S.contacted });
      render();
    });

    S.built = true;
  }

  async function init() {
    await loadState();
    buildPanel();
    render();
    try {
      S.batches = await D.listBatches();
      const valid = new Set(S.batches.map((b) => b.code));
      const saved = (S.savedSelection || []).filter((c) => valid.has(c));
      const defaults = S.batches.filter((b) => b.count > 0).slice(0, 4).map((b) => b.code);
      S.selected = new Set(saved.length ? saved : defaults);
      render();
      await ensureLoaded();
    } catch (e) {
      S.error = e.message;
      render();
    }
  }

  function toggle(force) {
    S.open = typeof force === "boolean" ? force : !S.open;
    host.classList.toggle("open", S.open);
    if (S.open && !S.built) init();
  }

  async function mount() {
    host = document.createElement("div");
    host.id = "ycif-host";
    host.style.cssText = "all:initial;position:fixed;z-index:2147483646;inset:auto 0 0 auto;";
    root = host.attachShadow({ mode: "open" });
    const css = await fetch(chrome.runtime.getURL("src/panel.css")).then((r) => r.text());
    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);
    fab = document.createElement("button");
    fab.className = "fab";
    fab.textContent = "India-origin founders";
    fab.addEventListener("click", () => toggle());
    root.appendChild(fab);
    document.documentElement.appendChild(host);
    if (location.hash === "#ycif") toggle(true);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "ycif-toggle") toggle();
  });

  mount();
})();
