/**
 * scripts/update_counts.js (final)
 *
 * Requirements
 * 1. Include ALL authors
 * 2. Keep family name as-is; other parts as initials
 * 3. Serial number: global, oldest = 1,2,3...
 * 4. Display: newest first
 *
 * NOTE:
 * - Avoid <ul>/<ol> to prevent bullets/double numbering.
 */

const fs = require("fs");
const path = require("path");

// =========================
// ENV
// =========================
const RESEARCHMAP_PERMALINK = process.env.RESEARCHMAP_PERMALINK || "";
const RESEARCHMAP_API_KEY = process.env.RESEARCHMAP_API_KEY || "";

const OUT_COUNTS_JSON = process.env.OUT_COUNTS
  ? path.resolve(process.env.OUT_COUNTS)
  : path.join("data", "counts.json");

const OUT_JOURNAL_HTML = process.env.OUT_JOURNAL_HTML
  ? path.resolve(process.env.OUT_JOURNAL_HTML)
  : path.join("publications", "journal-papers.html");

const OUT_REVIEW_HTML = process.env.OUT_REVIEW_HTML
  ? path.resolve(process.env.OUT_REVIEW_HTML)
  : path.join("publications", "review-articles.html");

// =========================
// utils
// =========================
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeSpaces(s) {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function pickLangText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "";

  if (typeof v === "object") {
    // most common language wrappers
    if (v.ja && !Array.isArray(v.ja)) return String(v.ja);
    if (v.en && !Array.isArray(v.en)) return String(v.en);
    if (v["rm:ja"] && !Array.isArray(v["rm:ja"])) return String(v["rm:ja"]);
    if (v["rm:en"] && !Array.isArray(v["rm:en"])) return String(v["rm:en"]);

    // nested
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

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =========================
// fetch
// =========================
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(RESEARCHMAP_API_KEY ? { "X-API-KEY": RESEARCHMAP_API_KEY } : {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fetch failed: ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

function normalizeItems(json) {
  const items = json?.items ?? json?.data ?? json ?? [];
  const next = json?.next ?? json?._links?.next?.href ?? null;
  return { items: Array.isArray(items) ? items : [], next };
}

async function fetchAllItems(baseUrl) {
  const all = [];
  const seen = new Set();
  let url = baseUrl;

  for (let i = 0; i < 50; i++) {
    const json = await fetchJson(url);
    const { items, next } = normalizeItems(json);

    for (const it of items) {
      const id = it?.["rm:id"] || it?.id;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      all.push(it);
    }
    if (!next) break;
    url = next.startsWith("http") ? next : `https://api.researchmap.jp${next}`;
    await sleep(200);
  }
  return all;
}

// =========================
// mapping
// =========================
function toYear(item) {
  const cands = [
    item?.year,
    item?.published_year,
    item?.publication_year,
    item?.["rm:published_year"],
    item?.["rm:publication_year"],
    item?.published_at,
    item?.publication_date,
    item?.date,
    item?.issued,
    item?.issued_date,
  ].map((v) => pickLangText(v));

  for (const c of cands) {
    const m = c.match(/(19|20)\d{2}/);
    if (m) return m[0];
  }
  return "----";
}

function toUrl(item) {
  // direct
  const doiDirect = firstNonEmpty(item?.doi, item?.DOI, item?.["rm:doi"]);
  if (doiDirect) {
    const clean = doiDirect.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  // identifiers.doi (array or string)
  const doiArr = item?.identifiers?.doi;
  if (Array.isArray(doiArr) && doiArr.length) {
    const clean = String(doiArr[0]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }
  if (typeof doiArr === "string" && doiArr.trim()) {
    const clean = doiArr.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  // see_also doi
  const seeAlso = item?.see_also;
  if (Array.isArray(seeAlso)) {
    const doiLink = seeAlso.find((x) => x?.label === "doi" && x?.["@id"]);
    if (doiLink?.["@id"]) return String(doiLink["@id"]);
  }

  return firstNonEmpty(item?.url, item?.URL, item?._links?.self?.href);
}

function toTitle(item) {
  return firstNonEmpty(item?.title, item?.paper_title, item?.["rm:title"]);
}

function toJournalName(item) {
  return firstNonEmpty(
    item?.journal,
    item?.journal_title,
    item?.journal_name,
    item?.publication_name,
    item?.["rm:journal"],
    item?.["rm:journal_title"]
  );
}

function toVolNoPp(item) {
  const vol = firstNonEmpty(item?.volume, item?.vol, item?.["rm:volume"]);
  const no = firstNonEmpty(item?.number, item?.issue, item?.no, item?.["rm:number"]);

  const start = firstNonEmpty(item?.starting_page, item?.start_page, item?.first_page);
  const end = firstNonEmpty(item?.ending_page, item?.end_page, item?.last_page);

  let pp = firstNonEmpty(item?.page, item?.pages, item?.pp, item?.["rm:page"]);
  if (!pp && start && end) pp = `${start}–${end}`;
  if (!pp && start && !end) pp = `${start}`;

  const parts = [];
  if (vol) parts.push(`vol. ${vol}`);
  if (no) parts.push(`no. ${no}`);
  if (pp) {
    const clean = normalizeSpaces(pp).replace(/^pp?\.\s*/i, "");
    parts.push(`pp. ${clean}`);
  }
  return parts.join(", ");
}

// =========================
// Authors (NO deep recursion; avoid [object Object])
// =========================
function formatAuthorName(raw) {
  const name = normalizeSpaces(pickLangText(raw));
  if (!name) return "";

  // Japanese -> 그대로
  if (/[ぁ-んァ-ン一-龥]/.test(name)) return name;

  // "Family, Given Middle"
  if (name.includes(",")) {
    const [family, given] = name.split(",").map(normalizeSpaces);
    const initials = given
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + ".")
      .join(" ");
    return normalizeSpaces(`${initials} ${family}`);
  }

  // "Given Middle Family"
  const tokens = name.split(" ").filter(Boolean);
  if (tokens.length === 1) return tokens[0];

  const family = tokens[tokens.length - 1];
  const givenTokens = tokens.slice(0, -1);
  const initials = givenTokens
    .map((w) => (w[0] ? w[0].toUpperCase() + "." : ""))
    .filter(Boolean)
    .join(" ");

  return normalizeSpaces(`${initials} ${family}`);
}

function joinAuthorsIEEE(list) {
  const a = list.filter(Boolean);
  if (a.length === 0) return "";
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
}

function extractAuthorArray(v) {
  // v can be:
  // - [ {name: ...}, ... ]
  // - [ "A B", ... ]
  // - { en: [..], ja: [..] }
  // - "A;B;C"
  if (v == null) return [];

  if (typeof v === "string") {
    return v
      .split(/\s*;\s*|\s+and\s+/i)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  if (Array.isArray(v)) return v;

  if (typeof v === "object") {
    const arr =
      (Array.isArray(v.ja) && v.ja) ||
      (Array.isArray(v.en) && v.en) ||
      (Array.isArray(v["rm:ja"]) && v["rm:ja"]) ||
      (Array.isArray(v["rm:en"]) && v["rm:en"]) ||
      null;

    if (arr) return arr;

    return [];
  }

  return [];
}

function normalizeAuthorElem(a) {
  if (a == null) return "";
  if (typeof a === "string") return a;

  if (typeof a === "object") {
    // common patterns
    const s = firstNonEmpty(a?.name, a?.full_name, a?.display_name);
    if (s) return s;

    // sometimes {name:{en:".."}} etc
    const s2 = pickLangText(a?.name);
    if (s2) return s2;

    // given/family split
    const fam = firstNonEmpty(a?.family_name, a?.family, a?.lastname, a?.last_name, a?.surname);
    const giv = firstNonEmpty(a?.given_name, a?.given, a?.firstname, a?.first_name, a?.forename);
    if (fam && giv) return `${giv} ${fam}`;

    return "";
  }

  return "";
}

function toAuthors(item) {
  const sources = [
    item?.authors,
    item?.author,
    item?.creators,
    item?.creator,
    item?.contributors,
    item?.contributor,
    item?.members,
    item?.member,
    item?.["rm:authors"],
    item?.["rm:author"],
    item?.["rm:creators"],
    item?.["rm:contributors"],
    item?.["rm:members"],
  ].filter((v) => v != null);

  const rawList = [];
  for (const src of sources) {
    const arr = extractAuthorArray(src);
    for (const el of arr) rawList.push(el);
  }

  const formatted = rawList
    .map(normalizeAuthorElem)
    .flatMap((s) => {
      if (!s) return [];
      // string that contains multiple authors
      if (typeof s === "string" && /;|\s+and\s+/i.test(s)) {
        return s
          .split(/\s*;\s*|\s+and\s+/i)
          .map((x) => x.trim())
          .filter(Boolean);
      }
      return [s];
    })
    .map(formatAuthorName)
    .filter(Boolean);

  // de-dup
  const seen = new Set();
  const uniq = formatted.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return joinAuthorsIEEE(uniq);
}

// =========================
// filter
// =========================
function isJournalPaper(item) {
  const typeStr = normalizeSpaces(
    [
      item?.published_paper_type,
      item?.paper_type,
      item?.type,
      item?.raw_type_fields?.published_paper_type,
    ]
      .map((v) => pickLangText(v).toLowerCase())
      .join(" ")
  );

  if (/(conference|proceedings)/.test(typeStr)) return false;
  if (/(book|chapter|in_book)/.test(typeStr)) return false;

  if (typeStr.includes("journal")) return true;

  const journalHint = [
    item?.is_international_journal,
    item?.international_journal,
    item?.raw_type_fields?.is_international_journal,
    item?.referee,
    item?.raw_type_fields?.referee,
  ]
    .map((v) => pickLangText(v).toLowerCase())
    .join(" ");

  if (journalHint.includes("true") || journalHint.includes("1")) return true;

  // last resort: has journal name
  return !!toJournalName(item);
}


// =========================
// Review / Expository (Invited & Non-refereed)
// =========================

function isReviewArticle(item) {
  // Definition:
  // "Invited" AND "Non-refereed" => Review / Expository article
  const refereeStr = normalizeSpaces(
    pickLangText(item?.referee ?? item?.raw_type_fields?.referee).toLowerCase()
  );
  const invitedStr = normalizeSpaces(
    pickLangText(
      item?.invited ?? item?.is_invited ?? item?.raw_type_fields?.invited
    ).toLowerCase()
  );

  const isRefereed =
    refereeStr === "true" || refereeStr === "1" || refereeStr === "yes";
  const isInvited =
    invitedStr === "true" || invitedStr === "1" || invitedStr === "yes";

  return !isRefereed && isInvited;
}

// =========================
// HTML (no ul/ol)
// =========================
function buildJournalHtml({ updatedAt, items, pageTitle = "Journal Papers", pageDesc = "論文誌（Journal papers only）" }) {
  // group by year
  const byYear = new Map();
  for (const it of items) {
    const y = toYear(it);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }

  // sort key
  function itemKey(it) {
    const yStr = toYear(it);
    const y = yStr === "----" ? 0 : Number(yStr);

    const dateStr = firstNonEmpty(
      it?.publication_date,
      it?.published_date,
      it?.published_at,
      it?.date,
      it?.issued,
      it?.issued_date,
      it?.["rm:publication_date"],
      it?.["rm:published_date"],
      it?.created_at,
      it?.updated_at
    );

    let m = 0, d = 0;
    if (typeof dateStr === "string") {
      const mm = dateStr.match(/(19|20)\d{2}[-/](\d{1,2})(?:[-/](\d{1,2}))?/);
      if (mm) {
        m = Number(mm[2] || 0);
        d = Number(mm[3] || 0);
      }
    }

    const title = (toTitle(it) || "").toLowerCase();
    const id = String(it?.["rm:id"] || it?.id || "");
    return { y, m, d, title, id };
  }

  function cmpAsc(a, b) {
    if (a.y !== b.y) return a.y - b.y;
    if (a.m !== b.m) return a.m - b.m;
    if (a.d !== b.d) return a.d - b.d;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  }
  function cmpDesc(a, b) {
    return -cmpAsc(a, b);
  }

  // serial: oldest -> newest (global)
  const numMap = new Map();
  const flat = items
    .map((it) => {
      const key = String(it?.["rm:id"] || it?.id || `${toYear(it)}|${toTitle(it)}`);
      return { key, it, k: itemKey(it) };
    })
    .sort((a, b) => cmpAsc(a.k, b.k));

  let serial = 1;
  for (const row of flat) {
    if (!numMap.has(row.key)) numMap.set(row.key, serial++);
  }

  // display: newest first (year desc, within year desc)
  const years = [...byYear.keys()].sort((a, b) => {
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });

  const blocks = years
    .map((y) => {
      const list = byYear.get(y) || [];
      const sorted = [...list].sort((a, b) => cmpDesc(itemKey(a), itemKey(b)));

      const rows = sorted
        .map((it) => {
          const key = String(it?.["rm:id"] || it?.id || `${toYear(it)}|${toTitle(it)}`);
          const n = numMap.get(key) ?? 0;

          const authors = toAuthors(it);
          const title = toTitle(it);
          const journal = toJournalName(it);
          const vnp = toVolNoPp(it);
          const year = toYear(it);
          const url = toUrl(it);

          const citeParts = [];
          if (authors) citeParts.push(`${escHtml(authors)},`);
          if (title) citeParts.push(`“${escHtml(title)},”`);
          if (journal) citeParts.push(`<i>${escHtml(journal)}</i>,`);
          if (vnp) citeParts.push(`${escHtml(vnp)},`);
          citeParts.push(year !== "----" ? `${year}.` : ".");
          const cite = citeParts.join(" ");

          // No <ul>/<ol>/<li>, and keep number + cite on same line.
          return `<div class="pub-item"><span class="pub-num">${n}.</span> <span class="pub-cite">${cite}${url ? `&nbsp;<a href="${escHtml(url)}" target="_blank">[link]</a>` : ""}</span></div>`;
        })
        .join("\n");

      return `
<section class="year-block">
  <h2>${escHtml(y)}</h2>
  <div class="pub-list">
${rows}
  </div>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escHtml(pageTitle)}</title>
  <link rel="stylesheet" href="../style.css"/>
</head>
<body>
<header class="site-header">
  <a href="../index.html#recent-ja" style="color:#fff">← Publications に戻る</a>
  <h1>${escHtml(pageTitle)}</h1>
  <p>${escHtml(pageDesc)}</p>
</header>
<div class="wrap">
  <p><b>Updated:</b> ${updatedAt} &nbsp; <b>Items:</b> ${items.length}</p>
  ${blocks}
</div>
</body>
</html>`;
}

// =========================
// main
// =========================
async function main() {
  if (!RESEARCHMAP_PERMALINK) {
    throw new Error("RESEARCHMAP_PERMALINK is empty");
  }

  const base = `https://api.researchmap.jp/${encodeURIComponent(
    RESEARCHMAP_PERMALINK
  )}/published_papers?per_page=200`;

  const updatedAt = new Date().toISOString();

  const published = await fetchAllItems(base);
  const journals = published.filter(isJournalPaper);
  const reviews = published.filter(isReviewArticle);

  console.log("RESEARCHMAP_PERMALINK =", RESEARCHMAP_PERMALINK);
  console.log("published total =", published.length);
  console.log("journal =", journals.length);
  console.log("reviews =", reviews.length);
  console.log("OUT_COUNTS_JSON =", OUT_COUNTS_JSON);
  console.log("OUT_JOURNAL_HTML =", OUT_JOURNAL_HTML);
  console.log("OUT_REVIEW_HTML =", OUT_REVIEW_HTML);

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(
    OUT_COUNTS_JSON,
    JSON.stringify(
      {
        permalink: RESEARCHMAP_PERMALINK,
        updatedAt,
        papers_total: published.length,
        journal: journals.length,
        reviews: reviews.length,
      },
      null,
      2
    )
  );

  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  fs.writeFileSync(
    OUT_JOURNAL_HTML,
    buildJournalHtml({ updatedAt: updatedAt.slice(0, 10), items: journals })
  );

  ensureDir(path.dirname(OUT_REVIEW_HTML));
  fs.writeFileSync(
    OUT_REVIEW_HTML,
    buildJournalHtml({
      updatedAt: updatedAt.slice(0, 10),
      items: reviews,
      pageTitle: "Review Articles",
      pageDesc: "解説記事（Invited, non-refereed）",
    })
  );
}

main().catch(console.error);
