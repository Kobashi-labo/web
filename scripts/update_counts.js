/**
 * scripts/update_counts.js
 * Generate counts.json + publications pages from researchmap API
 * - Fixes [object Object] by normalizing multilingual/object fields to text
 * - Journal page uses IEEE-like formatting with vol/no/pp when available
 *
 * Run: node scripts/update_counts.js
 */

const fs = require("fs/promises");
const path = require("path");

// Node 18+ has global fetch
const PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";

// output paths (repo root 기준)
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUB_DIR = path.join(ROOT, "publications");

// =========================
// Utility: normalize text
// =========================
function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);

  // array -> join
  if (Array.isArray(v)) {
    return v.map(toText).filter(Boolean).join(", ").trim();
  }

  // object (often multilingual: {ja: "...", en: "..."} or rich structures)
  if (typeof v === "object") {
    // common multilingual keys
    const preferredKeys = ["en", "ja", "title", "name", "value", "text"];
    for (const k of preferredKeys) {
      if (v[k] != null) {
        const t = toText(v[k]);
        if (t) return t;
      }
    }
    // if it looks like { "0": "..."} or has first value
    const vals = Object.values(v).map(toText).filter(Boolean);
    if (vals.length) return vals[0].trim();
    return "";
  }
  return "";
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const t = toText(v);
    if (t) return t;
  }
  return "";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// =========================
// researchmap API fetch
// =========================
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`researchmap API error ${res.status}: ${url}`);
  return await res.json();
}

function normalizeItems(json) {
  if (Array.isArray(json)) return { items: json, nextHref: null };
  const items = Array.isArray(json.items) ? json.items : [];
  const nextHref = json?._links?.next?.href || null;
  return { items, nextHref };
}

async function fetchAllCategory(category) {
  const limit = 1000;
  let url = `https://api.researchmap.jp/${PERMALINK}/${category}?format=json&limit=${limit}&start=1`;

  const all = [];
  const seen = new Set();

  for (let guard = 0; guard < 30; guard++) {
    const json = await fetchJson(url);
    const { items, nextHref } = normalizeItems(json);

    for (const it of items) {
      const id = it?.["rm:id"] || it?.id || null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      all.push(it);
    }

    if (!nextHref) break;
    url = nextHref.startsWith("http") ? nextHref : `https://api.researchmap.jp${nextHref}`;
  }
  return all;
}

// =========================
// Field extraction (robust)
// =========================
function getTitle(item) {
  // researchmap frequently uses multilingual object in item.title
  return firstNonEmpty(
    item?.title,
    item?.["dc:title"],
    item?.["bibo:title"],
    item?.["rm:title"],
    item?.["prism:title"]
  );
}

function getJournalName(item) {
  return firstNonEmpty(
    item?.journal,
    item?.journal_name,
    item?.journalTitle,
    item?.["prism:publicationName"],
    item?.["dc:publisher"],
    item?.["rm:journal"]
  );
}

function getAuthors(item) {
  // Depending on category, authors may come in multiple shapes
  // Try common keys
  const raw =
    item?.authors ||
    item?.author ||
    item?.creator ||
    item?.["dc:creator"] ||
    item?.["rm:creator"];

  // if already a string
  const s = toText(raw);
  if (s) return s;

  // sometimes array of objects: [{name:{ja/en}}, ...]
  if (Array.isArray(raw)) {
    const names = raw
      .map((a) => firstNonEmpty(a?.name, a?.fullname, a?.["rm:name"], a))
      .filter(Boolean);
    if (names.length) return names.join(", ");
  }

  // Sometimes item has creators list elsewhere
  const alt = item?.creators || item?.["rm:creators"];
  if (Array.isArray(alt)) {
    const names = alt.map((a) => firstNonEmpty(a?.name, a?.fullname, a)).filter(Boolean);
    if (names.length) return names.join(", ");
  }

  return "";
}

function getYear(item) {
  const y = firstNonEmpty(
    item?.year,
    item?.published_year,
    item?.publication_year,
    item?.["prism:publicationDate"],
    item?.["dc:date"]
  );

  // if it's like "2025-06-01"
  const m = String(y).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function getVolume(item) {
  return firstNonEmpty(item?.volume, item?.vol, item?.["prism:volume"]);
}

function getNumber(item) {
  return firstNonEmpty(item?.number, item?.issue, item?.no, item?.["prism:number"]);
}

function getPages(item) {
  // pages may appear as "2413-2422" or start/end
  const pages = firstNonEmpty(item?.pages, item?.page_range, item?.["prism:pageRange"]);
  if (pages) return pages;

  const sp = firstNonEmpty(item?.starting_page, item?.start_page, item?.page_start);
  const ep = firstNonEmpty(item?.ending_page, item?.end_page, item?.page_end);
  if (sp && ep) return `${sp}-${ep}`;
  if (sp) return sp;
  return "";
}

function getLink(item) {
  return firstNonEmpty(
    item?.url,
    item?.link,
    item?.["rm:url"],
    item?.["dc:identifier"],
    item?.doi ? `https://doi.org/${toText(item.doi)}` : ""
  );
}

// =========================
// Classification
// =========================
function isBookChapter(item) {
  // per your earlier rule: in_book counts as Book Chapters
  const t = firstNonEmpty(item?.published_paper_type, item?.type, item?.publication_type);
  return String(t).toLowerCase().includes("in_book");
}

function isInternationalConference(item) {
  // best-effort: conference proceeding
  const t = firstNonEmpty(item?.published_paper_type, item?.type, item?.publication_type);
  const s = String(t).toLowerCase();
  return s.includes("international_conference_paper") || s.includes("conference_paper") || s.includes("proceedings");
}

function isJournalPaper(item) {
  // prefer explicit journal type
  const t = firstNonEmpty(item?.published_paper_type, item?.type, item?.publication_type);
  const s = String(t).toLowerCase();
  if (s.includes("journal")) return true;

  // some items carry is_international_journal / referee
  // But avoid misclassifying book chapters
  if (isBookChapter(item) || isInternationalConference(item)) return false;

  // fallback: if journal name exists, treat as journal
  return Boolean(getJournalName(item));
}

// =========================
// HTML generators
// =========================
function ieeeLine(item) {
  const authors = getAuthors(item);
  const title = getTitle(item);
  const journal = getJournalName(item);
  const vol = getVolume(item);
  const no = getNumber(item);
  const pp = getPages(item);
  const year = getYear(item);
  const link = getLink(item);

  // IEEE-like: Authors, "Title," Journal, vol. X, no. Y, pp. A–B, Year.
  const parts = [];

  if (authors) parts.push(`${escapeHtml(authors)},`);
  if (title) parts.push(`“${escapeHtml(title)},”`);
  if (journal) parts.push(`<i>${escapeHtml(journal)}</i>,`);

  if (vol) parts.push(`vol. ${escapeHtml(vol)},`);
  if (no) parts.push(`no. ${escapeHtml(no)},`);
  if (pp) parts.push(`pp. ${escapeHtml(pp)},`);
  if (year) parts.push(`${escapeHtml(year)}.`);

  // If almost empty, still show title safely
  if (parts.length === 0) {
    parts.push(escapeHtml(firstNonEmpty(title, journal, year, "Untitled")));
  }

  const line = parts.join(" ").replace(/\s+,/g, ",").trim();
  const linkHtml = link ? ` <a href="${escapeHtml(link)}" target="_blank" rel="noopener">[link]</a>` : "";

  return `${line}${linkHtml}`;
}

function groupByYearDesc(items) {
  const map = new Map();
  for (const it of items) {
    const y = getYear(it) || "----";
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(it);
  }
  // sort years desc, "----" last
  const years = Array.from(map.keys()).sort((a, b) => {
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });
  return { years, map };
}

function buildJournalHtml({ updatedDate, items }) {
  const { years, map } = groupByYearDesc(items);

  let body = "";
  for (const y of years) {
    const arr = map.get(y);
    // Keep stable order: newest first if date exists; else as-is
    // We won't overfit; just keep insertion order.

    body += `
      <div class="year-block">
        <div class="year-header">
          <div class="year">${escapeHtml(y)}</div>
          <div class="badge">${escapeHtml(String(arr.length))}</div>
        </div>
        <ol class="list">
          ${arr
            .map(
              (it) => `
            <li class="item">
              <div class="card">${ieeeLine(it)}</div>
            </li>`
            )
            .join("\n")}
        </ol>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Journal Papers | Kobashi Laboratory</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", "Noto Sans JP", sans-serif; margin:0; background:#f5f7fb; color:#111; }
  header { background:#1e3a8a; color:#fff; padding:32px 24px; }
  header h1 { margin:0; font-size:42px; letter-spacing:0.5px; }
  header .sub { margin-top:8px; opacity:0.95; }
  header .topbar { display:flex; justify-content:space-between; align-items:center; gap:16px; flex-wrap:wrap; }
  .back a { color:#fff; text-decoration:none; border:1px solid rgba(255,255,255,0.35); padding:10px 16px; border-radius:999px; display:inline-block; }
  .back a:hover { background:rgba(255,255,255,0.12); }
  .meta { max-width:1100px; margin: 18px auto 0; background:#fff; border-radius:18px; padding:16px 18px; box-shadow:0 8px 25px rgba(0,0,0,0.08); }
  .meta b { margin-right:6px; }
  .wrap { max-width:1100px; margin: 26px auto 64px; padding:0 16px; }
  .year-block { margin: 28px 0 36px; }
  .year-header { display:flex; align-items:center; gap:12px; margin: 0 0 10px; }
  .year { font-size:40px; font-weight:800; color:#1e3a8a; }
  .badge { width:40px; height:40px; border-radius:999px; background:#1e3a8a; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:700; }
  .list { margin:0; padding-left: 22px; }
  .item { margin: 10px 0 14px; }
  .card { background:#fff; border-radius:16px; padding:16px 18px; box-shadow:0 6px 18px rgba(0,0,0,0.07); line-height:1.65; }
  .card a { color:#1e3a8a; }
  @media (max-width: 640px) {
    header h1 { font-size:32px; }
    .year { font-size:32px; }
  }
</style>
</head>
<body>
<header>
  <div class="topbar">
    <div>
      <h1>Journal Papers</h1>
      <div class="sub">論文誌（Journal papers only）</div>
    </div>
    <div class="back"><a href="../index.html#recent-ja">← Publications に戻る</a></div>
  </div>
</header>

<div class="meta">
  <b>Updated:</b> ${escapeHtml(updatedDate)} &nbsp;&nbsp;&nbsp;
  <b>Items:</b> ${escapeHtml(String(items.length))} &nbsp;&nbsp;&nbsp;
  <b>Source:</b> researchmap API (generated daily via GitHub Actions)
</div>

<div class="wrap">
  ${body}
</div>
</body>
</html>`;
}

// =========================
// Main
// =========================
async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PUB_DIR, { recursive: true });
}

function isoNow() {
  return new Date().toISOString();
}
function yyyyMmDd(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

async function main() {
  await ensureDirs();

  // Fetch
  const [published, presentations] = await Promise.all([
    fetchAllCategory("published_papers"),
    fetchAllCategory("presentations"),
  ]);

  // Classify published_papers
  const journal = [];
  const intlConf = [];
  const bookChapters = [];
  const unclassified = [];

  for (const it of published) {
    if (isBookChapter(it)) {
      bookChapters.push(it);
    } else if (isInternationalConference(it)) {
      intlConf.push(it);
    } else if (isJournalPaper(it)) {
      journal.push(it);
    } else {
      unclassified.push({
        id: it?.["rm:id"] || it?.id || null,
        year: getYear(it),
        title: it?.title ?? null,
        raw_type_fields: {
          published_paper_type: it?.published_paper_type ?? null,
          is_international_journal: it?.is_international_journal ?? null,
          referee: it?.referee ?? null,
        },
      });
    }
  }

  const updatedAt = isoNow();
  const updatedDate = yyyyMmDd(updatedAt);

  // counts.json (used by index.html)
  const counts = {
    permalink: PERMALINK,
    updatedAt,
    // counts used by your index.html
    journal: journal.length,
    intl_conf: intlConf.length,
    book_chapters: bookChapters.length,
    papers_total: published.length, // "査読付き" の合計に使う想定
    presentations_total: presentations.length,
    // keep extra fields for compatibility
    journal_count: journal.length,
    intl_conf_count: intlConf.length,
    book_chapters_count: bookChapters.length,
  };

  await fs.writeFile(path.join(DATA_DIR, "counts.json"), JSON.stringify(counts, null, 2), "utf-8");

  // Optional debug file for unclassified
  await fs.writeFile(
    path.join(DATA_DIR, "unclassified_papers.json"),
    JSON.stringify({ permalink: PERMALINK, updatedAt, unclassified_count: unclassified.length, unclassified }, null, 2),
    "utf-8"
  );

  // Generate journal page
  const journalHtml = buildJournalHtml({ updatedDate, items: journal });
  await fs.writeFile(path.join(PUB_DIR, "journal-papers.html"), journalHtml, "utf-8");

  console.log("✅ Generated:");
  console.log("- data/counts.json");
  console.log("- data/unclassified_papers.json");
  console.log("- publications/journal-papers.html");
}

main().catch((e) => {
  console.error("❌ update_counts.js failed:", e);
  process.exit(1);
});
