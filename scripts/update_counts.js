
/**
 * scripts/update_counts.js (FINAL)
 *
 * - counts.json: counts only
 * - journal / conference pages styled by ../style.css
 * - DOI preferred; fallback to researchmap
 */

const fs = require("fs");
const path = require("path");

const RESEARCHMAP_PERMALINK = process.env.RESEARCHMAP_PERMALINK || "";
const RESEARCHMAP_API_KEY = process.env.RESEARCHMAP_API_KEY || "";

const OUT_COUNTS_JSON = process.env.OUT_COUNTS
  ? path.resolve(process.env.OUT_COUNTS)
  : path.join("data", "counts.json");

const OUT_JOURNAL_HTML = process.env.OUT_JOURNAL_HTML
  ? path.resolve(process.env.OUT_JOURNAL_HTML)
  : path.join("publications", "journal-papers.html");

const OUT_CONF_HTML = process.env.OUT_CONF_HTML
  ? path.resolve(process.env.OUT_CONF_HTML)
  : path.join("publications", "conference-proceedings.html");

// ---------------- utils ----------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pickTitle(item) {
  const t = item?.paper_title || item?.title || {};
  if (typeof t === "string") return t;
  return t.en || t.ja || Object.values(t)[0] || "";
}

function pickVenue(item) {
  const v =
    item?.publication_name ||
    item?.journal_name ||
    item?.conference_name ||
    item?.journal ||
    item?.conference ||
    {};
  if (typeof v === "string") return v;
  return v.en || v.ja || Object.values(v)[0] || "";
}

function pickYear(item) {
  const d = item?.publication_date || item?.rm_publication_date || item?.year;
  if (!d) return "";
  const m = String(d).match(/^(\d{4})/);
  return m ? m[1] : "";
}

function pickDoi(item) {
  const d =
    item?.doi ||
    item?.identifier?.doi ||
    item?.identifiers?.doi ||
    item?.identifier?.DOI ||
    "";
  if (!d) return "";
  if (d.startsWith("http")) return d;
  return `https://doi.org/${d}`;
}

function getAuthorsArray(item) {
  const a = item?.authors;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (a.en && Array.isArray(a.en)) return a.en;
  if (a.ja && Array.isArray(a.ja)) return a.ja;
  return [];
}

function formatOneAuthor(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const family = parts[parts.length - 1];
  const initials = parts.slice(0, -1).map(p => p[0].toUpperCase() + ".").join(" ");
  return `${initials} ${family}`;
}

function formatAuthors(item) {
  return getAuthorsArray(item)
    .map(a => formatOneAuthor(typeof a === "string" ? a : a?.name || ""))
    .filter(Boolean)
    .join("; ");
}

// ---------------- fetch ----------------
async function fetchAllPublishedPapers() {
  const base = `https://api.researchmap.jp/${RESEARCHMAP_PERMALINK}/published_papers`;
  const limit = 1000;
  let start = 1;
  let all = [];
  while (true) {
    const u = new URL(base);
    u.searchParams.set("limit", limit);
    u.searchParams.set("start", start);
    u.searchParams.set("format", "json");
    if (RESEARCHMAP_API_KEY) u.searchParams.set("api_key", RESEARCHMAP_API_KEY);
    const res = await fetch(u.toString());
    if (!res.ok) throw new Error("researchmap API error");
    const json = await res.json();
    const items = json.items || [];
    all.push(...items);
    if (items.length < limit) break;
    start += limit;
  }
  return all;
}

// ---------------- classify ----------------
function isJournal(item) {
  const t = item?.published_paper_type || item?.raw_type_fields?.published_paper_type || "";
  return String(t).toLowerCase().includes("scientific_journal");
}
function isConference(item) {
  const t = item?.published_paper_type || item?.raw_type_fields?.published_paper_type || "";
  return /conference|proceedings/i.test(String(t));
}

// ---------------- html helpers ----------------
function groupByYearDesc(items) {
  const map = new Map();
  for (const p of items) {
    const y = p.year || "Unknown";
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(p);
  }
  return [...map.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([year, items]) => ({ year, items }));
}

function buildCiteLine(p) {
  const base = `${escapeHtml(p.authors)}. <i>${escapeHtml(p.title)}</i>, ${escapeHtml(p.venue)} (${escapeHtml(p.year)}).`;
  if (p.doi) return `${base} <a href="${p.doi}" target="_blank">DOI</a>`;
  if (p.id) {
    const rm = `https://researchmap.jp/${RESEARCHMAP_PERMALINK}/published_papers/${p.id}`;
    return `${base} <a href="${rm}" target="_blank">researchmap</a>`;
  }
  return base;
}

function htmlPage(title, updatedAtISO, items) {
  const blocks = groupByYearDesc(items).map(({ year, items }) => `
<section class="year-block">
  <h2>${year}</h2>
  <div class="pub-list">
${items.map(p => `
    <div class="pub-item">
      <span class="pub-num">[${p.no}]</span>
      <span class="pub-cite">${buildCiteLine(p)}</span>
    </div>`).join("")}
  </div>
</section>`).join("");

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="../style.css">
</head>
<body>
<header class="site-header">
  <div>
    <a href="../index.html">← Home</a>
    <h1>${title}</h1>
    <p>Last updated: ${updatedAtISO}</p>
  </div>
</header>
<main class="wrap">
${blocks || "<p>(No items)</p>"}
</main>
</body>
</html>`;
}

// ---------------- main ----------------
(async () => {
  const all = await fetchAllPublishedPapers();
  const journalRaw = all.filter(isJournal);
  const confRaw = all.filter(p => !isJournal(p) && isConference(p));

  function toList(items) {
    const sorted = [...items].sort((a, b) => pickYear(a) - pickYear(b));
    return sorted.map((it, i) => ({
      id: it["rm:id"] || it.id,
      doi: pickDoi(it),
      no: i + 1,
      year: pickYear(it),
      title: pickTitle(it),
      authors: formatAuthors(it),
      venue: pickVenue(it),
    })).reverse();
  }

  const journal = toList(journalRaw);
  const conf = toList(confRaw);

  const updatedAt = new Date().toISOString();

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify({
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt,
    journal_paper_count: journal.length,
    conference_paper_count: conf.length,
  }, null, 2));

  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  fs.writeFileSync(OUT_JOURNAL_HTML, htmlPage("Journal Papers", updatedAt, journal));
  fs.writeFileSync(OUT_CONF_HTML, htmlPage("Conference Proceeding Papers", updatedAt, conf));

  console.log("Updated counts and pages.");
})();
