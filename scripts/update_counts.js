/**
 * scripts/update_counts.js
 * - Fetch researchmap API
 * - Count items
 * - Build publications/journal-papers.html
 *
 * Changes (per request):
 * 1) Include ALL authors
 * 2) Keep family name, initials for others
 * 3) Serial number is global ascending from oldest
 * 4) Display newest first
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

  // Arrays are not directly stringified (prevents "[object Object]")
  if (Array.isArray(v)) return "";

  if (typeof v === "object") {
    // If language fields exist but are arrays, ignore here and let caller handle arrays.
    if (v.ja && !Array.isArray(v.ja)) return String(v.ja);
    if (v.en && !Array.isArray(v.en)) return String(v.en);
    if (v["rm:ja"] && !Array.isArray(v["rm:ja"])) return String(v["rm:ja"]);
    if (v["rm:en"] && !Array.isArray(v["rm:en"])) return String(v["rm:en"]);

    if (v.name) return pickLangText(v.name);
    if (v.full_name) return pickLangText(v.full_name);
    if (v.display_name) return pickLangText(v.display_name);

    const cand = (v.en && !Array.isArray(v.en) ? v.en : null) ??
                 (v.ja && !Array.isArray(v.ja) ? v.ja : null) ??
                 (v["rm:en"] && !Array.isArray(v["rm:en"]) ? v["rm:en"] : null) ??
                 (v["rm:ja"] && !Array.isArray(v["rm:ja"]) ? v["rm:ja"] : null);
    if (cand) return String(cand);

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
  // 1) direct doi fields (if any)
  const doiDirect = firstNonEmpty(item?.doi, item?.DOI, item?.["rm:doi"]);
  if (doiDirect) {
    const clean = doiDirect.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  // 2) identifiers.doi (researchmap often provides doi as an array)
  const doiArr = item?.identifiers?.doi;
  if (Array.isArray(doiArr) && doiArr.length) {
    const clean = String(doiArr[0]).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }
  if (typeof doiArr === "string" && doiArr.trim()) {
    const clean = doiArr.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  // 3) see_also: doi
  const seeAlso = item?.see_also;
  if (Array.isArray(seeAlso)) {
    const doiLink = seeAlso.find((x) => x?.label === "doi" && x?.["@id"]);
    if (doiLink?.["@id"]) return String(doiLink["@id"]);
  }

  // 4) fallback
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

  // pages (researchmap often uses starting_page / ending_page)
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
// Authors: robust extraction + initials
// =========================
function formatAuthorName(raw) {
  const name = normalizeSpaces(pickLangText(raw));
  if (!name) return "";
  if (name.toLowerCase() === "[object object]") return "";

  // Japanese names: keep as-is
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

// Recursively find author-like strings/objects under author-ish keys
function extractAuthorsDeep(obj) {
  const out = [];
  const visited = new Set();

  function pushName(v) {
    const s = normalizeSpaces(pickLangText(v));
    if (!s) return;
    if (s.toLowerCase() === "[object object]") return;
    // Ignore very long non-name blobs
    if (s.length > 120) return;
    // Heuristic: looks like a name (has space/comma or Japanese chars)
    if (!(/[ぁ-んァ-ン一-龥]/.test(s) || s.includes(",") || /\s/.test(s))) return;
    out.push(s);
  }

  function walk(node, keyHint, depth) {
    if (node == null || depth > 6) return;
    if (typeof node !== "object") return;

    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const el of node) walk(el, keyHint, depth + 1);
      return;
    }

    for (const [k, v] of Object.entries(node)) {
      const kk = String(k).toLowerCase();
      const isAuthorKey = /author|creator|contributor|member/.test(kk) || /authors/.test(kk);

      if (v == null) continue;

      // Common structured patterns
      if (isAuthorKey && typeof v === "object" && !Array.isArray(v)) {
        // family/given patterns
        const fam = firstNonEmpty(v.family_name, v.family, v.lastname, v.last_name, v.surname);
        const giv = firstNonEmpty(v.given_name, v.given, v.firstname, v.first_name, v.forename);
        if (fam && giv) pushName(`${giv} ${fam}`);

        // full name variants
        pushName(v.full_name);
        pushName(v.display_name);
        pushName(v.name);
      }

      if (isAuthorKey && typeof v === "string") {
        // split by ; or and
        v.split(/\s*;\s*|\s+and\s+/i).forEach(pushName);
      } else if (isAuthorKey && Array.isArray(v)) {
        for (const el of v) {
          if (typeof el === "string") {
            el.split(/\s*;\s*|\s+and\s+/i).forEach(pushName);
          } else if (typeof el === "object" && el) {
            const fam = firstNonEmpty(el.family_name, el.family, el.lastname, el.last_name, el.surname);
            const giv = firstNonEmpty(el.given_name, el.given, el.firstname, el.first_name, el.forename);
            if (fam && giv) pushName(`${giv} ${fam}`);
            pushName(el.full_name);
            pushName(el.display_name);
            pushName(el.name);
            // Some APIs: { en: "...", ja: "..." }
            pushName(el.en);
            pushName(el.ja);
          }
        }
      }

      // Always walk deeper; but bias by author keys to ensure we don't miss nested fields
      walk(v, isAuthorKey ? kk : keyHint, depth + 1);
    }
  }

  walk(obj, "", 0);

  // Deduplicate while preserving order
  const seen = new Set();
  return out.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toAuthors(item) {
  // Special case: researchmap "authors" often comes as { en: [ {name: ...}, ... ] }
  const authObj = item?.authors;
  if (authObj && typeof authObj === "object" && !Array.isArray(authObj)) {
    const pickArr = (k) => (Array.isArray(authObj?.[k]) ? authObj[k] : null);
    const arr = pickArr("ja") || pickArr("en") || pickArr("rm:ja") || pickArr("rm:en");
    if (arr) {
      const names = arr
        .map((a) => firstNonEmpty(a?.name, a?.full_name, a?.display_name, a))
        .map(formatAuthorName)
        .filter(Boolean);
      const joined = joinAuthorsIEEE(names);
      if (joined) return joined;
    }
  }

  // 1) Try known top-level pools first
  const pools = [
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

  const names = [];

  // Arrays / objects / strings
  for (const p of pools) {
    if (Array.isArray(p)) {
      for (const el of p) names.push(el);
    } else {
      names.push(p);
    }
  }

  // 2) Deep extraction fallback (covers schema variations)
  const deep = extractAuthorsDeep(item);
  for (const d of deep) names.push(d);

  // 3) Normalize into formatted names
  const formatted = names
    .flatMap((a) => {
      const s = firstNonEmpty(
        a?.full_name,
        a?.display_name,
        a?.name,
        a?.["rm:display_name"],
        a?.family_name && a?.given_name
          ? `${pickLangText(a.given_name)} ${pickLangText(a.family_name)}`
          : "",
        a?.family && a?.given ? `${pickLangText(a.given)} ${pickLangText(a.family)}` : "",
        a
      );
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

  // remove dup after formatting
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

  const j = toJournalName(item);
  if (j) return true;

  return false;
}

// =========================
// HTML
// =========================
function buildJournalHtml({ updatedAt, items }) {
  // group by year
  const byYear = new Map();
  for (const it of items) {
    const y = toYear(it);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }

  // sort key (as much as possible)
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

    let m = 0,
      d = 0;
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

  function cmpKeyAsc(a, b) {
    if (a.y !== b.y) return a.y - b.y;
    if (a.m !== b.m) return a.m - b.m;
    if (a.d !== b.d) return a.d - b.d;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  }
  function cmpKeyDesc(a, b) {
    return -cmpKeyAsc(a, b);
  }

  // Serial numbers: oldest -> newest (global)
  const numMap = new Map();
  const flat = items
    .map((it) => {
      const key = String(it?.["rm:id"] || it?.id || `${toYear(it)}|${toTitle(it)}`);
      return { key, it, k: itemKey(it) };
    })
    .sort((a, b) => cmpKeyAsc(a.k, b.k));

  let serial = 1;
  for (const row of flat) {
    if (!numMap.has(row.key)) numMap.set(row.key, serial++);
  }

  // Display: newest first (year desc, within year desc)
  const years = [...byYear.keys()].sort((a, b) => {
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });

  const blocks = years
    .map((y) => {
      const list = byYear.get(y);

      const sorted = [...list].sort((a, b) => {
        const ka = itemKey(a);
        const kb = itemKey(b);
        return cmpKeyDesc(ka, kb);
      });

      const lis = sorted
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

          return `
          <li class="paper">
            <div class="box">
              <span class="num">${n}.</span>
              <div class="cite">${cite}${url ? ` <a href="${escHtml(url)}" target="_blank">[link]</a>` : ""}</div>
            </div>
          </li>`;
        })
        .join("\n");

      // IMPORTANT: use UL to avoid double numbering from <ol>
      return `
<section class="year-block">
  <h2>${escHtml(y)}</h2>
  <ul class="paper-list">
${lis}
  </ul>
</section>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Journal Papers</title>
  <link rel="stylesheet" href="../style.css"/>
</head>
<body>
<header class="site-header">
  <a href="../index.html#recent-ja" style="color:#fff">← Publications に戻る</a>
  <h1>Journal Papers</h1>
  <p>論文誌（Journal papers only）</p>
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

  console.log("RESEARCHMAP_PERMALINK =", RESEARCHMAP_PERMALINK);
  console.log("published total =", published.length);
  console.log("journal =", journals.length);
  console.log("OUT_COUNTS_JSON =", OUT_COUNTS_JSON);
  console.log("OUT_JOURNAL_HTML =", OUT_JOURNAL_HTML);

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(
    OUT_COUNTS_JSON,
    JSON.stringify(
      {
        permalink: RESEARCHMAP_PERMALINK,
        updatedAt,
        papers_total: published.length,
        journal: journals.length,
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
}

main().catch(console.error);
