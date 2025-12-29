// scripts/update_counts.js
// Daily generator for GitHub Pages (researchmap -> json/html)
//
// Outputs:
// - data/counts.json
// - data/unclassified_papers.json
// - data/debug_published_papers_sample.json (first 3 raw items)
// - data/debug_published_papers_keys.json   (all keys inventory)
// - publications/journal-papers.html
// - publications/conference-proceeding-papers.html

const fs = require("fs");
const path = require("path");

const PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";

const OUT_COUNTS = process.env.OUT_COUNTS || "data/counts.json";
const OUT_REPORT = process.env.OUT_REPORT || "data/unclassified_papers.json";

const OUT_DEBUG_SAMPLE =
  process.env.OUT_DEBUG_SAMPLE || "data/debug_published_papers_sample.json";
const OUT_DEBUG_KEYS =
  process.env.OUT_DEBUG_KEYS || "data/debug_published_papers_keys.json";

const OUT_JOURNAL_HTML =
  process.env.OUT_JOURNAL_HTML || "publications/journal-papers.html";
const OUT_INTL_CONF_HTML =
  process.env.OUT_INTL_CONF_HTML ||
  "publications/conference-proceeding-papers.html";

const LIMIT = 1000;
const MAX_PAGES = 50;

// -------- util --------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 400)}`);
  }
  return res.json();
}

function normalizeItems(json) {
  if (Array.isArray(json)) return { items: json, nextHref: null };
  const items = Array.isArray(json.items) ? json.items : [];
  const nextHref = json?._links?.next?.href || null;
  return { items, nextHref };
}

async function fetchAll(category) {
  let url = `https://api.researchmap.jp/${PERMALINK}/${category}?format=json&limit=${LIMIT}&start=1`;
  const all = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJson(url);
    const { items, nextHref } = normalizeItems(json);

    for (const it of items) {
      const id = it?.["rm:id"] || it?.id || it?.["@id"] || null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      all.push(it);
    }

    if (!nextHref) break;
    url = nextHref.startsWith("http")
      ? nextHref
      : `https://api.researchmap.jp${nextHref}`;
    await sleep(120);
  }
  return all;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), filePath)), {
    recursive: true,
  });
}

function writeJson(filePath, obj) {
  ensureDir(filePath);
  fs.writeFileSync(
    path.resolve(process.cwd(), filePath),
    JSON.stringify(obj, null, 2) + "\n",
    "utf8"
  );
}

function writeText(filePath, text) {
  ensureDir(filePath);
  fs.writeFileSync(path.resolve(process.cwd(), filePath), text, "utf8");
}

function htmlEscape(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractStrings(v, out = []) {
  if (v == null) return out;

  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    out.push(String(v));
    return out;
  }

  if (Array.isArray(v)) {
    for (const x of v) extractStrings(x, out);
    return out;
  }

  if (typeof v === "object") {
    for (const k of ["label", "name", "text", "value", "title", "code", "en", "ja"]) {
      if (k in v) extractStrings(v[k], out);
    }
    return out;
  }

  return out;
}

// -------- pickers --------
function pickId(p) {
  return p?.["rm:id"] || p?.id || p?.["@id"] || null;
}

function pickTitle(p) {
  const v = p?.paper_title ?? p?.title ?? p?.name ?? "";
  const arr = [];
  extractStrings(v, arr);
  return arr.join(" / ").trim();
}

function pickYear(p) {
  const v = p?.publication_date ?? p?.["rm:created"] ?? p?.["rm:modified"] ?? "";
  const s = String(v);
  const m = s.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function pickAuthors(p) {
  if (p?.authors && typeof p.authors === "object") {
    const lang = p.authors.en || p.authors.ja;
    if (Array.isArray(lang)) {
      const names = lang.map((x) => x?.name).filter(Boolean);
      if (names.length) return names.join(", ");
    }
  }
  const arr = [];
  extractStrings(p?.authors, arr);
  return arr.join(" / ").trim();
}

function pickVenue(p) {
  const arr = [];
  extractStrings(p?.publication_name ?? p?.publisher ?? "", arr);
  return arr.join(" / ").trim();
}

function pickLink(p) {
  const doi = p?.identifiers?.doi?.[0];
  if (doi) return `https://doi.org/${doi}`;
  const see = Array.isArray(p?.see_also) ? p.see_also : [];
  const doiLink = see.find((x) => x?.label === "doi")?.["@id"];
  return doiLink || "";
}

// -------- classification --------
// strict rules you requested:
// - Journal Papers = scientific_journal only
// - Conference Proceeding Papers = international conference proceedings only
function classifyPublishedPaper(p) {
  const t = String(p?.published_paper_type || "").toLowerCase();

  // Journal only
  if (t === "scientific_journal") return "journal";

  // International conference proceedings only (by type string)
  const looksConf =
    t.includes("conference") || t.includes("proceedings") || t.includes("conf");
  const looksIntl = t.includes("international") || t.includes("intl");

  if (looksConf && looksIntl) return "intl_conf";

  return "other";
}

// -------- HTML rendering --------
function renderPage({ title, subtitle, items, updatedAtIso, backHref }) {
  const updated = new Date(updatedAtIso).toISOString().slice(0, 10);

  const byYear = new Map();
  for (const it of items) {
    const y = pickYear(it) || "Unknown";
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }

  const years = Array.from(byYear.keys()).sort((a, b) => {
    if (a === "Unknown" && b !== "Unknown") return 1;
    if (b === "Unknown" && a !== "Unknown") return -1;
    return b.localeCompare(a);
  });

  const sections = years
    .map((y) => {
      const lis = byYear
        .get(y)
        .map((p) => {
          const t = htmlEscape(pickTitle(p));
          const au = htmlEscape(pickAuthors(p));
          const ve = htmlEscape(pickVenue(p));
          const link = pickLink(p);
          const linkHtml = link
            ? ` <a href="${htmlEscape(link)}" target="_blank" rel="noopener noreferrer">[link]</a>`
            : "";
          return `<li><div class="t">${t}</div><div class="m">${au}${au && ve ? " — " : ""}${ve}</div>${linkHtml}</li>`;
        })
        .join("\n");
      return `<section class="year"><h2>${htmlEscape(y)} <span class="badge">${byYear.get(y).length}</span></h2><ol>${lis}</ol></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${htmlEscape(title)} | Kobashi Laboratory</title>
  <style>
    :root{--bg:#f7f7fb;--card:#fff;--ink:#222;--muted:#666;--brand:#1e3a8a;--shadow:0 10px 30px rgba(0,0,0,.10);--r:16px;}
    body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.75;background:var(--bg);color:var(--ink);}
    header{background:var(--brand);color:#fff;padding:22px 18px;}
    header .wrap{max-width:1100px;margin:0 auto;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;}
    h1{margin:0;font-size:22px;}
    .sub{margin:4px 0 0;font-size:13px;opacity:.9}
    .nav a{color:#fff;text-decoration:none;border:1px solid rgba(255,255,255,.35);padding:8px 12px;border-radius:999px;font-size:13px}
    .nav a:hover{background:rgba(255,255,255,.12)}
    main{max-width:1100px;margin:0 auto;padding:22px 18px 60px;}
    .card{background:var(--card);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px;margin:14px 0;}
    .meta{color:var(--muted);font-size:13px}
    .year h2{margin:18px 0 10px;font-size:18px;color:var(--brand);display:flex;align-items:center;gap:10px;}
    .badge{font-size:12px;color:#fff;background:var(--brand);padding:4px 10px;border-radius:999px;opacity:.9}
    ol{margin:0;padding-left:20px}
    li{margin:10px 0}
    .t{font-weight:700}
    .m{color:var(--muted);font-size:14px;margin-top:2px}
    a{color:var(--brand)}
    footer{text-align:center;color:var(--muted);font-size:12px;padding:18px}
  </style>
</head>
<body>
<header>
  <div class="wrap">
    <div>
      <h1>${htmlEscape(title)}</h1>
      <p class="sub">${htmlEscape(subtitle)}</p>
    </div>
    <div class="nav">
      <a href="${htmlEscape(backHref)}">← Publications に戻る</a>
    </div>
  </div>
</header>

<main>
  <div class="card">
    <p class="meta">Updated: ${updated} / Items: ${items.length}</p>
    <p class="meta">Source: researchmap API (generated daily via GitHub Actions)</p>
  </div>

  ${sections}
</main>

<footer>© 2025 Kobashi Laboratory, University of Hyogo</footer>
</body>
</html>`;
}

// -------- main --------
async function main() {
  const [published, presentations] = await Promise.all([
    fetchAll("published_papers"),
    fetchAll("presentations"),
  ]);

  const updatedAt = new Date().toISOString();

  // debug outputs
  writeJson(OUT_DEBUG_SAMPLE, {
    permalink: PERMALINK,
    updatedAt,
    sample: published.slice(0, 3),
  });

  const keySet = new Set();
  for (const p of published) Object.keys(p || {}).forEach((k) => keySet.add(k));
  writeJson(OUT_DEBUG_KEYS, {
    permalink: PERMALINK,
    updatedAt,
    keys: Array.from(keySet).sort(),
  });

  // classify
  const journalItems = [];
  const intlConfItems = [];
  const unclassified = [];

  for (const p of published) {
    const c = classifyPublishedPaper(p);
    if (c === "journal") journalItems.push(p);
    else if (c === "intl_conf") intlConfItems.push(p);
    else {
      unclassified.push({
        id: pickId(p),
        year: pickYear(p),
        title: p?.paper_title ?? p?.title ?? "",
        raw_type_fields: {
          published_paper_type: p?.published_paper_type ?? null,
          is_international_journal: p?.is_international_journal ?? null,
          referee: p?.referee ?? null,
        },
      });
    }
  }

  // counts.json
  writeJson(OUT_COUNTS, {
    permalink: PERMALINK,
    updatedAt,
    papers_total: published.length,
    presentations_total: presentations.length,
    journal: journalItems.length,
    intl_conf: intlConfItems.length,
    note:
      "Journal = scientific_journal only. Conference = international conference proceedings only (by published_paper_type). Generated daily by GitHub Actions.",
  });

  // report
  writeJson(OUT_REPORT, {
    permalink: PERMALINK,
    updatedAt,
    unclassified_count: unclassified.length,
    unclassified: unclassified.slice(0, 500),
  });

  // html pages
  writeText(
    OUT_JOURNAL_HTML,
    renderPage({
      title: "Journal Papers",
      subtitle: "Kobashi Laboratory @ University of Hyogo",
      items: journalItems,
      updatedAtIso: updatedAt,
      backHref: "./index.html#recent",
    })
  );

  writeText(
    OUT_INTL_CONF_HTML,
    renderPage({
      title: "Conference Proceeding Papers (International)",
      subtitle: "Kobashi Laboratory @ University of Hyogo",
      items: intlConfItems,
      updatedAtIso: updatedAt,
      backHref: "./index.html#recent",
    })
  );

  console.log("Generated:", {
    papers_total: published.length,
    presentations_total: presentations.length,
    journal: journalItems.length,
    intl_conf: intlConfItems.length,
    unclassified: unclassified.length,
  });

  // helpful for tuning intl_conf detection
  const freq = {};
  for (const p of published) {
    const t = String(p?.published_paper_type || "UNKNOWN");
    freq[t] = (freq[t] || 0) + 1;
  }
  console.log("published_paper_type frequencies:", freq);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
