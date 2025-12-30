/**
 * scripts/update_counts.js
 *
 * Generates:
 * - data/counts.json              (counts ONLY, small)
 * - publications/journal-papers.html
 * - publications/conference-proceedings.html
 *
 * Requirements
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
  const s = String(d);
  const m = s.match(/^(\d{4})/);
  return m ? m[1] : s;
}

function getAuthorsArray(item) {
  const a = item?.authors;
  if (!a) return [];
  if (Array.isArray(a)) return a;
  if (a.en && Array.isArray(a.en)) return a.en;
  if (a.ja && Array.isArray(a.ja)) return a.ja;
  return [];
}

/**
 * Keep family name as-is; other parts as initials
 * Examples:
 * - "Shoichi NISHIO" -> "S. NISHIO"
 */
function formatOneAuthor(name) {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];
  const family = parts[parts.length - 1];
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

  const limit = 1000;
  let start = 1;
  let all = [];

  while (true) {
    const u = new URL(base);
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("start", String(start));
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
  return String(t).toLowerCase().includes("scientific_journal");
}

function isConferenceProceedings(item) {
  const t =
    item?.published_paper_type ||
    item?.raw_type_fields?.published_paper_type ||
    "";
  const s = String(t).toLowerCase();
  return s.includes("conference") || s.includes("proceedings");
}

// ---------------------
// HTML builders
// ---------------------
function htmlPage({ title, updatedAtISO, items, permalink }) {
  const rows = items
    .map((p) => {
      const t = escapeHtml(p.title);
      const a = escapeHtml(p.authors);
      const v = escapeHtml(p.venue);
      const y = escapeHtml(p.year);
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
        <span class="paper-authors">${a}</span><br/>
        <span class="paper-title"><strong>${t}</strong></span>${linkHtml}<br/>
        <span class="paper-venue">${v}</span>
        <span class="paper-year"> (${y})</span>
      </div>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Last updated: ${escapeHtml(updatedAtISO)}</div>
  <div>
${rows || "    <div>(No items found)</div>"}
  </div>
</body>
</html>`;
}

function toNumberedDisplayList(items) {
  const sorted = [...items].sort((a, b) => {
    const ya = Number(pickYear(a) || 0);
    const yb = Number(pickYear(b) || 0);
    if (ya !== yb) return ya - yb;
    return String(a?.["rm:id"] || a?.id || "").localeCompare(
      String(b?.["rm:id"] || b?.id || "")
    );
  });

  const numbered = sorted.map((item, idx) => ({
    id: String(item?.["rm:id"] || item?.id || ""),
    no: idx + 1,
    year: pickYear(item),
    title: pickTitle(item),
    authors: formatAuthors(item),
    venue: pickVenue(item),
  }));

  return numbered.reverse(); // newest first display
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

  // counts.json is COUNTS ONLY (small)
  const counts = {
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt: updatedAtISO,
    journal_paper_count: journal.length,
    conference_paper_count: conf.length,
    unclassified_count: all.length - journalRaw.length - confRaw.length,
  };

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify(counts, null, 2), "utf-8");

  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  ensureDir(path.dirname(OUT_CONF_HTML));

  fs.writeFileSync(
    OUT_JOURNAL_HTML,
    htmlPage({ title: "Journal Papers", updatedAtISO, items: journal, permalink: RESEARCHMAP_PERMALINK }),
    "utf-8"
  );

  fs.writeFileSync(
    OUT_CONF_HTML,
    htmlPage({ title: "Conference Proceeding Papers", updatedAtISO, items: conf, permalink: RESEARCHMAP_PERMALINK }),
    "utf-8"
  );

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
