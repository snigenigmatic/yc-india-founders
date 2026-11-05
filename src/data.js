globalThis.YCIF_DATA = (() => {
  const INDEX = "YCUsers_production";
  const CACHE_TTL = 7 * 24 * 3600 * 1000;
  const SEASONS = { W: [1, "Winter"], X: [2, "Spring"], P: [2, "Spring"], S: [3, "Summer"], F: [4, "Fall"] };
  let opts = null;

  function parseOpts(text) {
    const m = String(text || "").match(/AlgoliaOpts\s*=\s*(\{[^;]*?\})\s*;/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[1]);
      return o.app && o.key ? o : null;
    } catch (e) {
      return null;
    }
  }

  function usable(o) {
    if (!o) return false;
    if (o.valid_until && o.valid_until * 1000 < Date.now() + 60000) return false;
    try {
      return atob(o.key).includes(INDEX);
    } catch (e) {
      return false;
    }
  }

  async function getOpts() {
    if (usable(opts)) return opts;
    for (const s of document.querySelectorAll("script:not([src])")) {
      const o = parseOpts(s.textContent);
      if (usable(o)) return (opts = o);
    }
    const res = await fetch("/founders", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`Could not load the founders page (${res.status})`);
    const o = parseOpts(await res.text());
    if (!usable(o)) throw new Error("Could not find the founders search config. YC may have changed the page.");
    return (opts = o);
  }

  const enc = (params) =>
    Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === "string" ? v : JSON.stringify(v))}`)
      .join("&");

  async function query(params) {
    const o = await getOpts();
    const url =
      `https://${o.app.toLowerCase()}-dsn.algolia.net/1/indexes/*/queries` +
      `?x-algolia-application-id=${encodeURIComponent(o.app)}&x-algolia-api-key=${encodeURIComponent(o.key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: JSON.stringify({ requests: [{ indexName: INDEX, params: enc(params) }] }),
    });
    if (!res.ok) {
      if (res.status === 403) opts = null;
      throw new Error(`Founder search failed (${res.status})`);
    }
    const json = await res.json();
    if (!json.results || !json.results[0]) throw new Error("Founder search returned nothing");
    return json.results[0];
  }

  function batchInfo(code) {
    const m = /^([A-Z])(\d{2})$/.exec(code);
    if (!m) return { rank: -1, label: code };
    const year = 2000 + Number(m[2]);
    const [order, season] = SEASONS[m[1]] || [0, m[1]];
    return { rank: year * 10 + order, label: `${season} ${year}` };
  }

  async function listBatches() {
    const r = await query({ query: "", hitsPerPage: 0, facets: ["batches"], maxValuesPerFacet: 1000 });
    const counts = (r.facets && r.facets.batches) || {};
    return Object.entries(counts)
      .map(([code, count]) => ({ code, count, ...batchInfo(code) }))
      .filter((b) => b.rank > 0)
      .sort((a, b) => b.rank - a.rank);
  }

  function toRecord(h) {
    let first = h.first_name || "";
    let last = h.last_name || "";
    if (!first && !last && h.name) {
      const parts = String(h.name).trim().split(/\s+/);
      last = parts.length > 1 ? parts.pop() : "";
      first = parts.join(" ");
    }
    return {
      id: Number(h.id || h.objectID),
      urlSlug: h.url_slug || "",
      first,
      last,
      name: `${first} ${last}`.trim(),
      title: h.current_title || (h.yc_titles || [])[0] || "",
      company: h.current_company || h.all_companies_text || "",
      companySlug: h.company_slug || "",
      batches: Array.isArray(h.batches) ? h.batches : [],
      region: h.current_region || "",
      hnid: h.hnid || "",
      avatar: h.avatar_thumb || "",
      topCompany: !!h.top_company,
      industries: h.yc_parent_industries || [],
    };
  }

  async function foundersForBatch(code) {
    const out = [];
    let page = 0;
    let nbPages = 1;
    while (page < nbPages && page < 20) {
      const r = await query({
        query: "",
        hitsPerPage: 1000,
        page,
        facetFilters: [[`batches:${code}`]],
      });
      out.push(...(r.hits || []).map(toRecord));
      nbPages = r.nbPages || 1;
      page++;
    }
    return out;
  }

  function parseCompanyPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const raw = doc.querySelector("[data-page]")?.getAttribute("data-page");
    if (!raw) throw new Error("no page data");
    const props = JSON.parse(raw).props || {};
    const c = props.company || {};
    return {
      name: c.name || "",
      website: c.website || "",
      location: c.location || c.city || "",
      oneLiner: c.one_liner || "",
      openJobs: Array.isArray(props.jobPostings) ? props.jobPostings.length : 0,
      founders: (c.founders || []).map((f) => ({
        userId: Number(f.user_id),
        name: f.full_name || "",
        title: f.title || "",
        bio: f.founder_bio || "",
        linkedin: f.linkedin_url || "",
        twitter: f.twitter_url || "",
      })),
    };
  }

  async function loadCachedCompanies() {
    const all = await chrome.storage.local.get(null);
    const out = new Map();
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith("co:") && v && Date.now() - v.ts < CACHE_TTL) out.set(k.slice(3), v);
    }
    return out;
  }

  async function companyDetails(slug) {
    const res = await fetch(`/companies/${encodeURIComponent(slug)}`, { credentials: "same-origin" });
    if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
    const data = { ts: Date.now(), ...parseCompanyPage(await res.text()) };
    await chrome.storage.local.set({ [`co:${slug}`]: data });
    return data;
  }

  return { listBatches, foundersForBatch, companyDetails, loadCachedCompanies, batchInfo, parseOpts, parseCompanyPage };
})();
