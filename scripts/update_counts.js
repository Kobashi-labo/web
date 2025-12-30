/**
 * scripts/update_counts.js (FINAL)
 *
 * Generates:
 * - data/counts.json (counts ONLY, small)
 * - publications/journal-papers.html
 * - publications/conference-proceedings.html
 * - publications/oral-presentations.html
 *
 * Styling:
 * - Uses ../style.css (shared)
 *
 * Links:
 * - For papers: Prefer DOI when available; fallback to researchmap
 * - For presentations: researchmap link
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
 * - OUT_PRES_HTML           (optional; default "publications/oral-presentations.html")
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

const OUT_PRES_HTML = process.env.OUT_PRES_HTML
  ? path.resolve(process.env.OUT_PRES_HTML)
  : path.join("publications", "oral-presentations.html");

const OUT_INVITED_HTML = process.env.OUT_INVITED_HTML
  ? path.resolve(process.env.OUT_INVITED_HTML)
  : path.join("publications", "invited-talks.html");

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

function normalizeSpaces(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function pickLangText(v) {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "";

  if (typeof v === "object") {
    if (v.ja && !Array.isArray(v.ja)) return String(v.ja);
    if (v.en && !Array.isArray(v.en)) return String(v.en);
    if (v["rm:ja"] && !Array.isArray(v["rm:ja"])) return String(v["rm:ja"]);
    if (v["rm:en"] && !Array.isArray(v["rm:en"])) return String(v["rm:en"]);

    if (v.name) return pickLangText(v.name);
    if (v.full_name) return pickLangText(v.full_name);
    if (v.display_name) return pickLangText(v.display_name);
    return "";
  }
  return "";
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = normalizeSpaces(pickLangText(v));
    if (s) return s;
  }
  return "";
}

// ---------------------
// DOI extraction/normalization
// ---------------------
function pickDoiUrl(item) {
  const doiDirect = firstNonEmpty(item?.doi, item?.DOI, item?.["rm:doi"]);
  if (doiDirect) {
    const clean = doiDirect.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  const doiArr = item?.identifiers?.doi;
  if (Array.isArray(doiArr) && doiArr.length) {
    const clean = String(doiArr[0]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }
  if (typeof doiArr === "string" && doiArr.trim()) {
    const clean = doiArr.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  const seeAlso = item?.see_also;
  if (Array.isArray(seeAlso)) {
    const doiLink = seeAlso.find((x) => x?.label === "doi" && x?.["@id"]);
    if (doiLink?.["@id"]) return String(doiLink["@id"]);
  }

  return "";
}

// ---------------------
// paper helpers
// ---------------------
function pickPaperTitle(item) {
  const t = item?.paper_title || item?.title || {};
  if (typeof t === "string") return t;
  return t.en || t.ja || Object.values(t)[0] || "";
}

function pickPaperVenue(item) {
  const v =
    item?.publication_name ||
    item?.journal_name ||
    item?.conference_name ||
    item?.journal ||
    item?.conference ||
    item?.journal_title ||
    item?.conference_title ||
    {};
  if (typeof v === "string") return v;
  return v.en || v.ja || Object.values(v)[0] || "";
}

function pickYearFromAnyDate(d) {
  if (!d) return "";
  const s = String(d);
  const m = s.match(/^(\d{4})/);
  return m ? m[1] : "";
}

function pickPaperYear(item) {
  const d = item?.publication_date || item?.rm_publication_date || item?.year;
  return pickYearFromAnyDate(d);
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
 * Example: "Shoichi NISHIO" -> "S. NISHIO"
 */

function formatOneAuthor(name) {
  const s = String(name || "").trim();
  if (!s) return "";

  // If name contains Japanese characters and no ASCII letters, do NOT abbreviate
  const hasJP = /[\u3040-\u30FF\u3400-\u9FFF]/.test(s);
  const hasASCII = /[A-Za-z]/.test(s);
  if (hasJP && !hasASCII) {
    return s;
  }

  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];

  // family name is last token
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
  return authors.map(formatOneAuthor).join(", ");
}

// ---------------------
// presentations: authors (robust)
// researchmap presentations may use fields like presenters/speakers/contributors.
// We try several candidates and fall back gracefully.
// ---------------------
function getPresentationPeopleArray(item) {
  const cands = [
    item?.presenters,
    item?.presenter,
    item?.speakers,
    item?.speaker,
    item?.contributors,
    item?.contributor,
    item?.authors, // sometimes reused
  ];

  for (const c of cands) {
    if (!c) continue;
    if (Array.isArray(c)) return c;
    if (typeof c === "object") {
      // language keyed arrays or nested
      if (Array.isArray(c.en)) return c.en;
      if (Array.isArray(c.ja)) return c.ja;
      if (Array.isArray(c["rm:en"])) return c["rm:en"];
      if (Array.isArray(c["rm:ja"])) return c["rm:ja"];
      // sometimes single person object
      if (c.name || c.full_name || c.display_name) return [c];
    }
    if (typeof c === "string") return [c];
  }
  return [];
}

function pickPersonName(p) {
  if (p == null) return "";
  if (typeof p === "string") return p;
  if (typeof p === "object") {
    return (
      p.name ||
      p.full_name ||
      p.display_name ||
      p.en ||
      p.ja ||
      p["rm:en"] ||
      p["rm:ja"] ||
      ""
    );
  }
  return "";
}

function formatPresentationAuthors(item) {
  const people = getPresentationPeopleArray(item)
    .map(pickPersonName)
    .filter(Boolean);
  if (!people.length) return ""; // presentations can be event-only
  return people.map(formatOneAuthor).join(", ");
}


// ---------------------
// presentations helpers
// ---------------------
function pickPresentationTitle(item) {
  const t =
    item?.presentation_title ||
    item?.title ||
    item?.name ||
    item?.presentation_name ||
    {};
  if (typeof t === "string") return t;
  return t.en || t.ja || Object.values(t)[0] || "";
}

function pickPresentationVenue(item) {
  const v =
    item?.event ||
    item?.meeting ||
    item?.conference_name ||
    item?.event_name ||
    item?.meeting_name ||
    item?.convention ||
    item?.publication_name ||
    {};
  if (typeof v === "string") return v;
  return v.en || v.ja || Object.values(v)[0] || "";
}

function pickPresentationYear(item) {
  // try common date-ish fields
  const d =
    item?.publication_date ||
    item?.presented_date ||
    item?.presentation_date ||
    item?.start_date ||
    item?.date ||
    item?.year;
  return pickYearFromAnyDate(d);
}

// ---------------------
// researchmap fetch
// ---------------------
async function fetchAllCategory(category) {
  if (!RESEARCHMAP_PERMALINK) {
    throw new Error("RESEARCHMAP_PERMALINK is empty. Set env var.");
  }

  const base = `https://api.researchmap.jp/${encodeURIComponent(
    RESEARCHMAP_PERMALINK
  )}/${encodeURIComponent(category)}`;

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
        `researchmap API error (${category}): ${res.status} ${res.statusText}\n${body}`
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

function isInvitedPresentation(item) {
  // robust heuristics for researchmap presentations
  const v1 = item?.invited;
  if (v1 === true || v1 === "true" || v1 === 1) return true;

  const t = String(
    item?.presentation_type ||
      item?.presentation_kind ||
      item?.type ||
      item?.raw_type_fields?.presentation_type ||
      item?.raw_type_fields?.type ||
      ""
  ).toLowerCase();

  if (t.includes("invited")) return true;

  // sometimes a free text flag exists
  const note = String(item?.note || item?.remarks || item?.comment || "").toLowerCase();
  if (note.includes("invited")) return true;

  // Japanese hints
  const j = String(item?.invited_talk || item?.招待 || item?.招待講演 || "").toLowerCase();
  if (j && j !== "false") return true;

  const title = pickPresentationTitle(item);
  if (/[招待]/.test(title) && /講演|発表/.test(title)) {
    // weak hint; keep conservative
    return true;
  }
  return false;
}


// ---------------------
// HTML builders (match style.css)
// ---------------------
function groupByYearDesc(items) {
  const map = new Map();
  for (const p of items) {
    const y = p.year || "Unknown";
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(p);
  }

  const years = [...map.keys()].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isNaN(na) && Number.isNaN(nb)) return 0;
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    return nb - na;
  });

  return years.map((y) => ({ year: y, items: map.get(y) }));
}

function researchmapPaperLink(permalink, id) {
  if (!id) return "";
  return `https://researchmap.jp/${encodeURIComponent(permalink)}/published_papers/${encodeURIComponent(id)}`;
}

function researchmapPresentationLink(permalink, id) {
  if (!id) return "";
  return `https://researchmap.jp/${encodeURIComponent(permalink)}/presentations/${encodeURIComponent(id)}`;
}

function buildPaperCiteLine(p, permalink) {
  const base = `${escapeHtml(p.authors)}. <i>${escapeHtml(
    p.title
  )}</i>, ${escapeHtml(p.venue)} (${escapeHtml(p.year)}).`;

  if (p.doi_url) {
    return `${base} <a href="${escapeHtml(
      p.doi_url
    )}" target="_blank" rel="noopener">DOI</a>`;
  }

  const rm = researchmapPaperLink(permalink, p.id);
  if (rm) {
    return `${base} <a href="${rm}" target="_blank" rel="noopener">researchmap</a>`;
  }

  return base;
}


function buildPresentationCiteLine(p, permalink) {
  const base = `${escapeHtml(p.authors)}. <i>${escapeHtml(
    p.title
  )}</i>, ${escapeHtml(p.venue)} (${escapeHtml(p.year)}).`;

  if (p.doi_url) {
    return `${base} <a href="${escapeHtml(
      p.doi_url
    )}" target="_blank" rel="noopener">DOI</a>`;
  }

  const rm = researchmapPresentationLink(permalink, p.id);
  if (rm) {
    return `${base} <a href="${rm}" target="_blank" rel="noopener">researchmap</a>`;
  }
  return base;
}


function htmlPage({ title, updatedAtISO, items, permalink, kind }) {
  const citeFn =
    kind === "presentation" ? buildPresentationCiteLine : buildPaperCiteLine;

  const blocks = groupByYearDesc(items)
    .map(
      ({ year, items }) => `
<section class="year-block">
  <h2>${escapeHtml(year)}</h2>
  <div class="pub-list">
${items
  .map(
    (p) => `
    <div class="pub-item">
      <span class="pub-num">[${p.no}]</span>
      <span class="pub-cite">${citeFn(p, permalink)}</span>
    </div>`
  )
  .join("\n")}
  </div>
</section>`
    )
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="../style.css">
</head>
<body>
  <header class="site-header">
    <div>
      <a href="../index.html">← Home</a>
      <h1>${escapeHtml(title)}</h1>
      <p>Last updated: ${escapeHtml(updatedAtISO)}</p>
    </div>
  </header>

  <main class="wrap">
${blocks || "    <p>(No items found)</p>"}
  </main>
</body>
</html>`;
}

function toNumberedPaperList(items) {
  // oldest first for numbering
  const sorted = [...items].sort((a, b) => {
    const ya = Number(pickPaperYear(a) || 0);
    const yb = Number(pickPaperYear(b) || 0);
    if (ya !== yb) return ya - yb;
    return String(a?.["rm:id"] || a?.id || "").localeCompare(
      String(b?.["rm:id"] || b?.id || "")
    );
  });

  const numbered = sorted.map((item, idx) => ({
    id: String(item?.["rm:id"] || item?.id || ""),
    doi_url: pickDoiUrl(item),
    doi_url: pickDoiUrl(item),
    no: idx + 1,
    year: pickPaperYear(item),
    title: pickPaperTitle(item),
    authors: formatPresentationAuthors(item),
    venue: pickPaperVenue(item),
  }));

  return numbered.reverse(); // newest first display
}

function toNumberedPresentationList(items) {
  const sorted = [...items].sort((a, b) => {
    const ya = Number(pickPresentationYear(a) || 0);
    const yb = Number(pickPresentationYear(b) || 0);
    if (ya !== yb) return ya - yb;
    return String(a?.["rm:id"] || a?.id || "").localeCompare(
      String(b?.["rm:id"] || b?.id || "")
    );
  });

  const numbered = sorted.map((item, idx) => ({
    id: String(item?.["rm:id"] || item?.id || ""),
    doi_url: pickDoiUrl(item),
    no: idx + 1,
    year: pickPresentationYear(item),
    title: pickPresentationTitle(item),
    authors: formatPresentationAuthors(item),
    venue: pickPresentationVenue(item),
  }));

  return numbered.reverse();
}

// ---------------------
// main
// ---------------------
async function main() {
  const [allPapers, allPresentations] = await Promise.all([
    fetchAllCategory("published_papers"),
    fetchAllCategory("presentations"),
  ]);

  const journalRaw = allPapers.filter(isJournal);
  const confRaw = allPapers.filter((it) => !isJournal(it) && isConferenceProceedings(it));

  const journal = toNumberedPaperList(journalRaw);
  const conf = toNumberedPaperList(confRaw);
  const invitedRaw = allPresentations.filter(isInvitedPresentation);
  const oralRaw = allPresentations.filter((it) => !isInvitedPresentation(it));

  const pres = toNumberedPresentationList(oralRaw);
  const invited = toNumberedPresentationList(invitedRaw);

  const updatedAtISO = new Date().toISOString();

  // counts.json (counts only)
  const counts = {
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt: updatedAtISO,
    journal_paper_count: journal.length,
    conference_paper_count: conf.length,
    presentations_count: pres.length,
    invited_presentations_count: invited.length,
    papers_total: journal.length + conf.length,
    unclassified_count: allPapers.length - journalRaw.length - confRaw.length,
  };

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify(counts, null, 2), "utf-8");

  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  ensureDir(path.dirname(OUT_CONF_HTML));
  ensureDir(path.dirname(OUT_PRES_HTML));
  ensureDir(path.dirname(OUT_INVITED_HTML));

  fs.writeFileSync(
    OUT_JOURNAL_HTML,
    htmlPage({
      title: "Journal Papers",
      updatedAtISO,
      items: journal,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "paper",
    }),
    "utf-8"
  );

  fs.writeFileSync(
    OUT_CONF_HTML,
    htmlPage({
      title: "Conference Proceeding Papers",
      updatedAtISO,
      items: conf,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "paper",
    }),
    "utf-8"
  );

  fs.writeFileSync(
    OUT_PRES_HTML,
    htmlPage({
      title: "Oral Presentations",
      updatedAtISO,
      items: pres,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "presentation",
    }),
    "utf-8"
  );


  fs.writeFileSync(
    OUT_INVITED_HTML,
    htmlPage({
      title: "Invited Talks",
      updatedAtISO,
      items: invited,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "presentation",
    }),
    "utf-8"
  );

  console.log("✅ Updated:");
  console.log(" -", OUT_COUNTS_JSON);
  console.log(" -", OUT_JOURNAL_HTML);
  console.log(" -", OUT_CONF_HTML);
  console.log(" -", OUT_PRES_HTML);
  console.log(" -", OUT_INVITED_HTML);
  console.log(
    `Counts: journal=${journal.length}, conference=${conf.length}, presentations=${pres.length}, invited=${invited.length}, unclassified=${counts.unclassified_count}`
  );
}

main().catch((e) => {
  console.error("❌ update_counts.js failed");
  console.error(e);
  process.exit(1);
});
