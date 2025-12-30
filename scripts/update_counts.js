/**
 * scripts/update_counts.js
 *
 * Generates:
 * - data/counts.json
 * - publications/journal-papers.html
 * - publications/conference-proceedings.html
 *
 * Requirements (from user)
 * 1. Include ALL authors
 * 2. Keep family name as-is; other parts as initials
 * 3. Serial number: per-page global, oldest = 1,2,3...
 * 4. Display: newest first
 *
 * NOTE:
 * - Avoid <ul>/<ol> to prevent bullets/double numbering.
 *
 * ENV:
 * - RESEARCHMAP_PERMALINK   (e.g., "read0134502")
 * - RESEARCHMAP_API_KEY     (optional; if set, appended as api_key=)
 * - OUT_COUNTS              (optional; default "data/counts.json")
 * - OUT_JOURNAL_HTML        (optional; default "publications/journal-papers.html")
 * - OUT_CONF_HTML           (optional; default "publications/conference-proceedings.html")
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

// ---------------------
// utils
// ---------------------
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function pickTitle(item) {
  const t = item?.paper_title || item?.title || {};
  // prefer English if present, else Japanese, else any string
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
  // many records have publication_date like "2024-03-01"
  const d = item?.publication_date || item?.rm_publication_date || item?.year;
  if (!d) return "";
  const s = String(d);
  const m = s.match(/^(\d{4})/);
  return m ? m[1] : s;
}

function getAuthorsArray(item) {
  // researchmap typical: authors: { ja: [{name:..}, ...], en: [...] }
  const a = item?.authors;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (a.en && Array.isArray(a.en)) return a.en;
  if (a.ja && Array.isArray(a.ja)) return a.ja;
  // sometimes: { "ja": ["name1","name2"] }
  if (a.en && Array.isArray(a.en)) return a.en;
  if (a.ja && Array.isArray(a.ja)) return a.ja;
  return [];
}

/**
 * Keep family name as-is; other parts as initials
 * Examples:
 * - "Shoichi NISHIO" -> "S. NISHIO"
 * - "Belayat HOSSAIN" -> "B. HOSSAIN"
 * - "Syoji KOBASHI" -> "S. KOBASHI"
 * - "Naomi YAGI" -> "N. YAGI"
 */
function formatOneAuthor(name) {
  const s = String(name || "").trim();
  if (!s) return "";

  // Split by whitespace
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];

  // family name is the last token (keep as-is)
  const family = parts[parts.length - 1];

  // given/middle names -> initials
  const initials = parts
    .slice(0, -1)
    .map((p) => (p ? p[0].toUpperCase() + "." : ""))
    .join(" ");

  return (initials ? initials + " " : "") + family;
}

function formatAuthors(item) {
  const authors = getAuthorsArray(item)
    .map((a) => (typeof a === "string" ? a : a?.name || a?.en || a?.ja || ""))
    .filter(Boolean);

  return authors.map(formatOneAuthor).join("; ");
}

// ---------------------
// researchmap fetch
// ---------------------
async function fetchAllPublishedPapers() {
  if (!RESEARCHMAP_PERMALINK) {
    throw new Error("RESEARCHMAP_PERMALINK is empty. Set env var.");
  }

  const base = `https://api.researchmap.jp/${encodeURIComponent(
    RESEARCHMAP_PERMALINK
  )}/published_papers`;

  const limit = 1000; // spec maximum
  let start = 1; // spec default is 1 (see docs/examples)
  let all = [];

  while (true) {
    const u = new URL(base);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("start", String(start));
    // Prefer JSON (most endpoints default to json)
    u.searchParams.set("format", "json");
    if (RESEARCHMAP_API_KEY) u.searchParams.set("api_key", RESEARCHMAP_API_KEY);

    const res = await fetch(u.toString(), {
      headers: { "User-Agent": "Kobashi-labo/web update_counts.js" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `researchmap API error: ${res.status} ${res.statusText}\n${body}`
      );
    }

    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];

    all = all.concat(items);

    if (items.length < limit) break;
    start += limit;
  }

  return all;
}

// ---------------------
// classification
// ---------------------
function isJournal(item) {
  const t =
    item?.published_paper_type ||
    item?.raw_type_fields?.published_paper_type ||
    "";
  // Most common value: "scientific_journal"
  return String(t).toLowerCase().includes("scientific_journal");
}

function isConferenceProceedings(item) {
  const t =
    item?.published_paper_type ||
    item?.raw_type_fields?.published_paper_type ||
    "";
  const s = String(t).toLowerCase();
  // Handle typical values like "international_conference_proceedings"
  return s.includes("conference") || s.includes("proceedings");
}

// ---------------------
// HTML builders
// ---------------------
function htmlPage({ title, updatedAtISO, items, permalink, pageId }) {
  // items already in display order (newest first) and have `no` (oldest=1)
  const rows = items
    .map((p) => {
      const title = escapeHtml(p.title);
      const authors = escapeHtml(p.authors);
      const venue = escapeHtml(p.venue);
      const year = escapeHtml(p.year);
      const rmLink = p.id
        ? `https://researchmap.jp/${encodeURIComponent(permalink)}/published_papers/${encodeURIComponent(
            p.id
          )}`
        : "";
      const linkHtml = rmLink
        ? ` <a class="rm-link" href="${rmLink}" target="_blank" rel="noopener">[researchmap]</a>`
        : "";
      return `
      <div class="paper-item">
        <span class="paper-number">[${p.no}]</span>
        <span class="paper-authors">${authors}</span><br/>
        <span class="paper-title"><strong>${title}</strong></span>${linkHtml}<br/>
        <span class="paper-venue">${venue}</span>
        <span class="paper-year"> (${year})</span>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"; margin: 24px; line-height: 1.45; }
    h1 { margin: 0 0 8px; }
    .meta { color: #666; font-size: 0.95rem; margin-bottom: 18px; }
    .paper-item { margin: 0 0 14px; }
    .paper-number { font-weight: 700; margin-right: 6px; }
    .rm-link { text-decoration: none; margin-left: 6px; }
    .rm-link:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Last updated: ${escapeHtml(updatedAtISO)}</div>
  <div id="${escapeHtml(pageId)}">
${rows || "    <div>(No items found)</div>"}
  </div>
</body>
</html>`;
}

function toNumberedDisplayList(items) {
  // oldest first -> assign no, then reverse for display newest first
  const sorted = [...items].sort((a, b) => {
    const ya = Number(pickYear(a) || 0);
    const yb = Number(pickYear(b) || 0);
    if (ya !== yb) return ya - yb;
    // stable fallback: by id string
    return String(a?.rm_id || a?.["rm:id"] || a?.id || "").localeCompare(
      String(b?.rm_id || b?.["rm:id"] || b?.id || "")
    );
  });

  const numbered = sorted.map((item, idx) => ({
    id: String(item?.["rm:id"] || item?.id || item?.rm_id || ""),
    no: idx + 1,
    year: pickYear(item),
    title: pickTitle(item),
    authors: formatAuthors(item),
    venue: pickVenue(item),
  }));

  return numbered.reverse();
}

// ---------------------
// main
// ---------------------
async function main() {
  const all = await fetchAllPublishedPapers();

  const journalRaw = all.filter(isJournal);
  const confRaw = all.filter((it) => !isJournal(it) && isConferenceProceedings(it));

  const journal = toNumberedDisplayList(journalRaw);
  const conf = toNumberedDisplayList(confRaw);

  const updatedAtISO = new Date().toISOString();

  const counts = {
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt: updatedAtISO,
    journal_paper_count: journal.length,
    conference_paper_count: conf.length,
    journal_papers: journal,
    conference_papers: conf,
    // For debugging / future tuning
    unclassified_count: all.length - journalRaw.length - confRaw.length,
  };

  // write JSON
  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify(counts, null, 2), "utf-8");

  // write HTML pages
  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  ensureDir(path.dirname(OUT_CONF_HTML));

  const journalHtml = htmlPage({
    title: "Journal Papers",
    updatedAtISO,
    items: journal,
    permalink: RESEARCHMAP_PERMALINK,
    pageId: "journal-papers",
  });

  const confHtml = htmlPage({
    title: "Conference Proceeding Papers",
    updatedAtISO,
    items: conf,
    permalink: RESEARCHMAP_PERMALINK,
    pageId: "conference-proceedings",
  });

  fs.writeFileSync(OUT_JOURNAL_HTML, journalHtml, "utf-8");
  fs.writeFileSync(OUT_CONF_HTML, confHtml, "utf-8");

  console.log("✅ Updated:");
  console.log(" -", OUT_COUNTS_JSON);
  console.log(" -", OUT_JOURNAL_HTML);
  console.log(" -", OUT_CONF_HTML);
  console.log(`Counts: journal=${journal.length}, conference=${conf.length}, unclassified=${counts.unclassified_count}`);
}

main().catch((e) => {
  console.error("❌ update_counts.js failed");
  console.error(e);
  process.exit(1);
});
