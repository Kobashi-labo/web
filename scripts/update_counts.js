/**
 * scripts/update_counts.js (FINAL)
 *
 * Generates:
 * - data/counts.json (counts ONLY, small)
 * - publications/journal-papers.html
 * - publications/conference-proceedings.html
 * - publications/book-chapters.html
 * - publications/review-articles.html
 * - publications/oral-presentations.html
 * - publications/invited-talks.html
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
 * - OUT_BOOK_HTML           (optional; default "publications/book-chapters.html")
 * - OUT_REVIEW_HTML         (optional; default "publications/review-articles.html")
 * - OUT_PRES_HTML           (optional; default "publications/oral-presentations.html")
 * - OUT_INVITED_HTML        (optional; default "publications/invited-talks.html")
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

const OUT_BOOK_HTML = process.env.OUT_BOOK_HTML
  ? path.resolve(process.env.OUT_BOOK_HTML)
  : path.join("publications", "book-chapters.html");

const OUT_REVIEW_HTML = process.env.OUT_REVIEW_HTML
  ? path.resolve(process.env.OUT_REVIEW_HTML)
  : path.join("publications", "review-articles.html");

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
  // Prefer DOI URL if provided in see_also (label: "doi")
  const seeAlso = item?.see_also;
  if (Array.isArray(seeAlso)) {
    const doiLink = seeAlso.find(
      (x) => String(x?.label || "").toLowerCase() === "doi" && x?.["@id"]
    );
    if (doiLink?.["@id"]) return String(doiLink["@id"]);
  }

  // Direct DOI fields
  const doiDirect = firstNonEmpty(item?.doi, item?.DOI, item?.["rm:doi"]);
  if (doiDirect) {
    const clean = String(doiDirect).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  // identifiers.doi
  const doiArr = item?.identifiers?.doi;
  if (Array.isArray(doiArr) && doiArr.length) {
    const clean = String(doiArr[0]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }
  if (typeof doiArr === "string" && doiArr.trim()) {
    const clean = doiArr.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
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
      if (Array.isArray(c.en)) return c.en;
      if (Array.isArray(c.ja)) return c.ja;
      if (Array.isArray(c["rm:en"])) return c["rm:en"];
      if (Array.isArray(c["rm:ja"])) return c["rm:ja"];
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
  const people = getPresentationPeopleArray(item).map(pickPersonName).filter(Boolean);
  if (!people.length) return "";
  return people.map(formatOneAuthor).join(", ");
}

// ---------------------
// bibliographic fields (vol/no/pages) – robust
// ---------------------
function pickVolume(item) {
  return firstNonEmpty(
    item?.volume,
    item?.vol,
    item?.journal_volume,
    item?.journal_vol,
    item?.conference_volume,
    item?.publication_volume,
    item?.published_volume,
    item?.raw_type_fields?.volume,
    item?.raw_type_fields?.vol,
    item?.raw_type_fields?.journal_volume
  );
}

function pickNumber(item) {
  return firstNonEmpty(
    item?.number,
    item?.no,
    item?.issue,
    item?.journal_number,
    item?.journal_no,
    item?.journal_issue,
    item?.publication_number,
    item?.published_number,
    item?.raw_type_fields?.number,
    item?.raw_type_fields?.no,
    item?.raw_type_fields?.issue,
    item?.raw_type_fields?.journal_number
  );
}

function normalizePages(p) {
  const s = normalizeSpaces(p);
  if (!s) return "";
  return s.replace(/pp?\.\s*/i, "").replace(/\s*[-–—]\s*/g, "–");
}

function pickPages(item) {
  const start = firstNonEmpty(
    item?.starting_page,
    item?.start_page,
    item?.page_start,
    item?.first_page,
    item?.startingPage,
    item?.raw_type_fields?.starting_page,
    item?.raw_type_fields?.start_page
  );

  const end = firstNonEmpty(
    item?.ending_page,
    item?.end_page,
    item?.page_end,
    item?.last_page,
    item?.endingPage,
    item?.raw_type_fields?.ending_page,
    item?.raw_type_fields?.end_page
  );

  const endClean = normalizeSpaces(end);
  if (start && endClean && endClean !== "+") {
    return normalizePages(`${start}-${endClean}`);
  }

  return normalizePages(
    firstNonEmpty(
      item?.pages,
      item?.page,
      item?.page_range,
      item?.pagination,
      item?.article_number,
      item?.raw_type_fields?.pages,
      item?.raw_type_fields?.page
    )
  );
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
// classification (UPDATED)
// ---------------------
function pickPublishedPaperTypeLower(item) {
  const t =
    item?.published_paper_type ||
    item?.raw_type_fields?.published_paper_type ||
    "";
  return String(t || "").toLowerCase().trim();
}

// (1) book chapter: in_book
function isBookChapter(item) {
  return pickPublishedPaperTypeLower(item) === "in_book";
}

// referee flag (robust): treat missing/unknown as "not explicitly non-refereed"
function isExplicitlyNonRefereed(item) {
  const v = item?.referee ?? item?.raw_type_fields?.referee;
  if (v === true || v === "true" || v === 1 || v === "1") return false;
  if (v === false || v === "false" || v === 0 || v === "0") return true;

  // Sometimes "有"/"無" etc.
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "no" || s === "none" || s === "n") return true;
  if (s === "yes" || s === "y") return false;
  if (s.includes("無")) return true;
  if (s.includes("有")) return false;

  // If unknown/empty, don't force into review_articles
  return false;
}

// (2) review_articles: non-refereed + type is scientific_journal OR international_conference_proceedings
function isTruthy(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

// (2) review_articles: non-refereed + (type is scientific_journal OR international_conference_proceedings OR invited:true)
function isReviewArticle(item) {
  if (!isExplicitlyNonRefereed(item)) return false;

  // ✅ invited:true を最優先で review_articles 扱いにする
  const invited = item?.invited ?? item?.raw_type_fields?.invited;
  if (isTruthy(invited)) return true;

  const t = pickPublishedPaperTypeLower(item);
  return t === "scientific_journal" || t === "international_conference_proceedings";
}


// journal papers (after excluding book/review)
function isJournal(item) {
  const t = pickPublishedPaperTypeLower(item);
  // keep broad enough for subtypes
  return t.includes("scientific_journal");
}

// conference proceedings (after excluding book/review/journal)
function isConferenceProceedings(item) {
  const t = pickPublishedPaperTypeLower(item);
  // handle exact + broader legacy strings
  return (
    t === "international_conference_proceedings" ||
    t.includes("international_conference") ||
    t.includes("conference") ||
    t.includes("proceedings")
  );
}


// ---------------------
// Oral presentation sub-classification
// ---------------------
function isInternationalPresentation(item) {
  const t =
    item?.published_paper_type ||
    item?.raw_type_fields?.published_paper_type ||
    "";
  return String(t).toLowerCase() === "international_conference_proceedings";
}

function isInvitedPresentation(item) {
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

  const note = String(item?.note || item?.remarks || item?.comment || "").toLowerCase();
  if (note.includes("invited")) return true;

  const j = String(item?.invited_talk || item?.招待 || item?.招待講演 || "").toLowerCase();
  if (j && j !== "false") return true;

  const title = pickPresentationTitle(item);
  if (/[招待]/.test(title) && /講演|発表/.test(title)) {
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
  return `https://researchmap.jp/${encodeURIComponent(permalink)}/published_papers/${encodeURIComponent(
    id
  )}`;
}

function researchmapPresentationLink(permalink, id) {
  if (!id) return "";
  return `https://researchmap.jp/${encodeURIComponent(permalink)}/presentations/${encodeURIComponent(
    id
  )}`;
}

function buildPaperCiteLine(p, permalink) {
  const authors = escapeHtml(p.authors);
  const title = escapeHtml(p.title);
  const venue = escapeHtml(p.venue);
  const year = escapeHtml(p.year);

  const vol = normalizeSpaces(p.volume);
  const no = normalizeSpaces(p.number);
  const pages = normalizePages(p.pages);

  const parts = [];

  // If p.pub_kind is "conference" → conference style, else journal-ish
  if (p.pub_kind === "conference") {
    parts.push(`${authors}, &quot;${title},&quot; in <i>Proc. ${venue}</i>`);
  } else {
    parts.push(`${authors}, &quot;${title},&quot; <i>${venue}</i>`);
    if (vol) parts.push(`vol. ${escapeHtml(vol)}`);
    if (no) parts.push(`no. ${escapeHtml(no)}`);
  }

  if (pages) parts.push(`pp. ${escapeHtml(pages)}`);
  if (year) parts.push(year);

  const base = parts.join(", ") + ".";

  if (p.doi_url) {
    return `${base} <a href="${escapeHtml(p.doi_url)}" target="_blank" rel="noopener">DOI</a>`;
  }

  const rm = researchmapPaperLink(permalink, p.id);
  if (rm) {
    return `${base} <a href="${rm}" target="_blank" rel="noopener">researchmap</a>`;
  }

  return base;
}

function buildPresentationCiteLine(p, permalink) {
  const authors = escapeHtml(p.authors);
  const title = escapeHtml(p.title);
  const venue = escapeHtml(p.venue);
  const year = escapeHtml(p.year);

  const vol = normalizeSpaces(p.volume);
  const no = normalizeSpaces(p.number);
  const pages = normalizePages(p.pages);

  const parts = [];
  if (authors) parts.push(authors);
  parts.push(`&quot;${title},&quot; <i>${venue}</i>`);
  if (vol) parts.push(`vol. ${escapeHtml(vol)}`);
  if (no) parts.push(`no. ${escapeHtml(no)}`);
  if (pages) parts.push(`pp. ${escapeHtml(pages)}`);
  if (year) parts.push(year);

  const base = parts.join(", ") + ".";

  if (p.doi_url) {
    return `${base} <a href="${escapeHtml(p.doi_url)}" target="_blank" rel="noopener">DOI</a>`;
  }

  const rm = researchmapPresentationLink(permalink, p.id);
  if (rm) {
    return `${base} <a href="${rm}" target="_blank" rel="noopener">researchmap</a>`;
  }
  return base;
}

function htmlPage({ title, updatedAtISO, items, permalink, kind }) {
  const citeFn = kind === "presentation" ? buildPresentationCiteLine : buildPaperCiteLine;

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

function toNumberedPaperList(items, pubKindOrFn) {
  // oldest first for numbering
  const sorted = [...items].sort((a, b) => {
    const ya = Number(pickPaperYear(a) || 0);
    const yb = Number(pickPaperYear(b) || 0);
    if (ya !== yb) return ya - yb;
    return String(a?.["rm:id"] || a?.id || "").localeCompare(String(b?.["rm:id"] || b?.id || ""));
  });

  const numbered = sorted.map((item, idx) => {
    const kind = typeof pubKindOrFn === "function" ? pubKindOrFn(item) : pubKindOrFn || "paper";
    return {
      id: String(item?.["rm:id"] || item?.id || ""),
      doi_url: pickDoiUrl(item),
      pub_kind: kind,
      volume: pickVolume(item),
      number: pickNumber(item),
      pages: pickPages(item),
      no: idx + 1,
      year: pickPaperYear(item),
      title: pickPaperTitle(item),
      authors: formatAuthors(item),
      venue: pickPaperVenue(item),
    };
  });

  return numbered.reverse(); // newest first display
}

function toNumberedPresentationList(items) {
  const sorted = [...items].sort((a, b) => {
    const ya = Number(pickPresentationYear(a) || 0);
    const yb = Number(pickPresentationYear(b) || 0);
    if (ya !== yb) return ya - yb;
    return String(a?.["rm:id"] || a?.id || "").localeCompare(String(b?.["rm:id"] || b?.id || ""));
  });

  const numbered = sorted.map((item, idx) => ({
    id: String(item?.["rm:id"] || item?.id || ""),
    doi_url: pickDoiUrl(item),
    volume: pickVolume(item),
    number: pickNumber(item),
    pages: pickPages(item),
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

  // (3) Do the special classifications FIRST: book_chapters & review_articles
  const bookRaw = allPapers.filter(isBookChapter);
  const reviewRaw = allPapers.filter((it) => !isBookChapter(it) && isReviewArticle(it));

  // Remaining papers after removing book + review
  const remaining = allPapers.filter((it) => !isBookChapter(it) && !isReviewArticle(it));

  // Then classify the remainder into journal / conference
  const journalRaw = remaining.filter(isJournal);
  const confRaw = remaining.filter((it) => !isJournal(it) && isConferenceProceedings(it));

  const journal = toNumberedPaperList(journalRaw, "journal");
  const conf = toNumberedPaperList(confRaw, "conference");
  const book = toNumberedPaperList(bookRaw, "book");

  // For review_articles, keep citation style based on underlying type
  const review = toNumberedPaperList(reviewRaw, (it) =>
    isConferenceProceedings(it) ? "conference" : "journal"
  );

  const invitedRaw = allPresentations.filter(isInvitedPresentation);
  const oralRaw = allPresentations.filter((it) => !isInvitedPresentation(it));

  const oralInternationalRaw = oralRaw.filter(isInternationalPresentation);
  const oralDomesticRaw = oralRaw.filter((it) => !isInternationalPresentation(it));

  const presInternational = toNumberedPresentationList(oralInternationalRaw);
  const presDomestic = toNumberedPresentationList(oralDomesticRaw);
  const invited = toNumberedPresentationList(invitedRaw);

  const updatedAtISO = new Date().toISOString();

  // counts.json (counts only)
  const counts = {
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt: updatedAtISO,
    journal_paper_count: journal.length,
    conference_paper_count: conf.length,
    book_chapter_count: book.length,
    review_article_count: review.length,
    presentations_domestic_count: presDomestic.length,
    presentations_international_count: presInternational.length,
    presentations_count: presDomestic.length + presInternational.length,
    invited_presentations_count: invited.length,
    papers_total: journal.length + conf.length + book.length + review.length,
    unclassified_count:
      allPapers.length - journalRaw.length - confRaw.length - bookRaw.length - reviewRaw.length,
  };

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify(counts, null, 2), "utf-8");

  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  ensureDir(path.dirname(OUT_CONF_HTML));
  ensureDir(path.dirname(OUT_BOOK_HTML));
  ensureDir(path.dirname(OUT_REVIEW_HTML));
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
    OUT_BOOK_HTML,
    htmlPage({
      title: "Book Chapters",
      updatedAtISO,
      items: book,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "paper",
    }),
    "utf-8"
  );

  fs.writeFileSync(
    OUT_REVIEW_HTML,
    htmlPage({
      title: "Review Articles (Non-refereed)",
      updatedAtISO,
      items: review,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "paper",
    }),
    "utf-8"
  );

  fs.writeFileSync(
    path.join("publications", "oral-presentations-domestic.html"),
    htmlPage({
      title: "Oral Presentations (Domestic)",
      updatedAtISO,
      items: presDomestic,
      permalink: RESEARCHMAP_PERMALINK,
      kind: "presentation",
    }),
    "utf-8"
  );

  fs.writeFileSync(
    path.join("publications", "oral-presentations-international.html"),
    htmlPage({
      title: "Oral Presentations (International Conference)",
      updatedAtISO,
      items: presInternational,
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
  console.log(" -", OUT_BOOK_HTML);
  console.log(" -", OUT_REVIEW_HTML);
  console.log(" -", OUT_PRES_HTML);
  console.log(" -", OUT_INVITED_HTML);
  console.log(
    `Counts: journal=${journal.length}, conference=${conf.length}, book=${book.length}, review=${review.length}, presentations=${pres.length}, invited=${invited.length}, unclassified=${counts.unclassified_count}`
  );
}

main().catch((e) => {
  console.error("❌ update_counts.js failed");
  console.error(e);
  process.exit(1);
});
