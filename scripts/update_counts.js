// scripts/update_counts.js
// Generate data/counts.json + publications pages (journal & intl conf) + a report of unclassified items.
// Node 20+ recommended.

const fs = require("fs");
const path = require("path");

const PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";
const OUT_COUNTS = process.env.OUT_COUNTS || "data/counts.json";
const OUT_REPORT = process.env.OUT_REPORT || "data/unclassified_papers.json";
const OUT_JOURNAL_HTML = process.env.OUT_JOURNAL_HTML || "publications/journal-papers.html";
const OUT_INTL_CONF_HTML = process.env.OUT_INTL_CONF_HTML || "publications/conference-proceeding-papers.html";
const LIMIT = 1000;
const MAX_PAGES = 50;

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 300)}`);
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
    url = nextHref.startsWith("http") ? nextHref : `https://api.researchmap.jp${nextHref}`;
    await sleep(120);
  }
  return all;
}

function s(v){ return v == null ? "" : String(v); }
function low(v){ return s(v).toLowerCase(); }

/**
 * Strict classification (per your requirement):
 * - Journal Papers: journal only
 * - Conference Proceeding Papers: international conference papers only
 *
 * Accuracy depends on consistent categorization in researchmap.
 */
function classifyPublishedPaper(p) {
  const fields = [
    p.publication_type, p.paper_type, p.type, p.category, p.genre,
    p.publication_category, p.publicationCategory,
    p?.["publication_type"], p?.["type"], p?.["category"]
  ].map(low).join(" ");

  // Journal only
  if (fields.includes("journal") || fields.includes("学術雑誌") || fields.includes("論文誌")) {
    return "journal";
  }

  // International conference only
  const isConf = fields.includes("conference") || fields.includes("proceedings") || fields.includes("会議");
  const isIntl = fields.includes("international") || fields.includes("国際");
  if (isConf && isIntl) {
    return "intl_conf";
  }

  return "other";
}

function pickTitle(p) { return p?.title || p?.paper_title || p?.name || p?.["論文名"] || ""; }
function pickYear(p) {
  const y = p?.publication_year || p?.year || p?.published_year || p?.date || "";
  const m = String(y).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}
function pickAuthors(p) {
  const a = p?.authors || p?.author || p?.creator || p?.["著者"] || "";
  if (Array.isArray(a)) return a.map(x => x?.name || x?.text || x).join(", ");
  return String(a);
}
function pickVenue(p) { return p?.journal || p?.conference || p?.publication || p?.publisher || p?.["掲載誌名"] || ""; }
function pickLink(p) {
  const u = p?.url || p?.link || p?.doi || "";
  if (!u) return "";
  if (String(u).startsWith("10.")) return "https://doi.org/" + u;
  return String(u);
}

function htmlEscape(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function renderPage({ title, subtitle, items, updatedAtIso, backHref }) {
  const updated = new Date(updatedAtIso).toISOString().slice(0, 10);

  const byYear = new Map();
  for (const it of items) {
    const y = pickYear(it) || "Unknown";
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }
  const years = Array.from(byYear.keys()).sort((a,b) => (b==="Unknown") - (a==="Unknown") || b.localeCompare(a));

  const sections = years.map(y => {
    const lis = byYear.get(y).map(p => {
      const t = htmlEscape(pickTitle(p) || "");
      const au = htmlEscape(pickAuthors(p) || "");
      const ve = htmlEscape(pickVenue(p) || "");
      const link = pickLink(p);
      const linkHtml = link ? ` <a href="${htmlEscape(link)}" target="_blank" rel="noopener noreferrer">[link]</a>` : "";
      return `<li><div class="t">${t}</div><div class="m">${au}${au && ve ? " — " : ""}${ve}</div>${linkHtml}</li>`;
    }).join("\n");
    return `<section class="year"><h2>${htmlEscape(y)} <span class="badge">${byYear.get(y).length}</span></h2><ol>${lis}</ol></section>`;
  }).join("\n");

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
    @media print{header,.nav,footer{display:none} body{background:#fff} .card{box-shadow:none;border:1px solid #ddd}}
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

function ensureDir(filePath){
  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), filePath)), { recursive: true });
}
function writeJson(filePath, obj){
  ensureDir(filePath);
  fs.writeFileSync(path.resolve(process.cwd(), filePath), JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function writeText(filePath, text){
  ensureDir(filePath);
  fs.writeFileSync(path.resolve(process.cwd(), filePath), text, "utf8");
}

async function main() {
  const [published, presentations] = await Promise.all([
    fetchAll("published_papers"),
    fetchAll("presentations"),
  ]);

  const journalItems = [];
  const intlConfItems = [];
  const unclassified = [];

  for (const p of published) {
    const c = classifyPublishedPaper(p);
    if (c === "journal") journalItems.push(p);
    else if (c === "intl_conf") intlConfItems.push(p);
    else unclassified.push({
      id: p?.["rm:id"] || p?.id || null,
      year: pickYear(p),
      title: pickTitle(p),
      raw_type_fields: {
        publication_type: p?.publication_type,
        paper_type: p?.paper_type,
        type: p?.type,
        category: p?.category,
        genre: p?.genre,
        publication_category: p?.publication_category,
        publicationCategory: p?.publicationCategory,
      }
    });
  }

  const updatedAt = new Date().toISOString();

  writeJson(OUT_COUNTS, {
    permalink: PERMALINK,
    updatedAt,
    papers_total: published.length,            // reference only
    presentations_total: presentations.length,
    journal: journalItems.length,              // strict journal only
    intl_conf: intlConfItems.length,           // strict intl conf only
    note: "Journal = journal papers only. Conference = international conference papers only. Generated daily by GitHub Actions."
  });

  writeJson(OUT_REPORT, {
    permalink: PERMALINK,
    updatedAt,
    unclassified_count: unclassified.length,
    unclassified: unclassified.slice(0, 500)
  });

  writeText(OUT_JOURNAL_HTML, renderPage({
    title: "Journal Papers",
    subtitle: "Kobashi Laboratory @ University of Hyogo",
    items: journalItems,
    updatedAtIso: updatedAt,
    backHref: "../index.html#recent-ja"
  }));

  writeText(OUT_INTL_CONF_HTML, renderPage({
    title: "Conference Proceeding Papers (International)",
    subtitle: "Kobashi Laboratory @ University of Hyogo",
    items: intlConfItems,
    updatedAtIso: updatedAt,
    backHref: "../index.html#recent-ja"
  }));

  console.log("Generated:", OUT_COUNTS, OUT_JOURNAL_HTML, OUT_INTL_CONF_HTML, OUT_REPORT);
  console.log({ journal: journalItems.length, intl_conf: intlConfItems.length, presentations: presentations.length, unclassified: unclassified.length });
}

main().catch(e => { console.error(e); process.exit(1); });
