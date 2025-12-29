/**
 * scripts/update_counts.js
 * - Fetch researchmap API
 * - Generate:
 *    data/counts.json
 *    publications/journal-papers.html
 *
 * Node 18+ (GitHub Actions) assumed.
 */

import fs from "fs";
import path from "path";

const RESEARCHMAP_PERMALINK = "read0134502";
const OUT_COUNTS_JSON = path.join("data", "counts.json");
const OUT_JOURNAL_HTML = path.join("publications", "journal-papers.html");

function isoNow() {
  return new Date().toISOString();
}

// -------------------------
// Robust text normalization
// -------------------------
function textify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(textify).filter(Boolean).join(" ").trim();

  if (typeof v === "object") {
    // common bilingual / value wrappers
    const candidates = [
      v.en, v.ja,
      v.value, v.text, v.name,
      v.title, v.label,
      v["@value"], v["rm:value"],
    ];
    for (const c of candidates) {
      const s = textify(c);
      if (s) return s;
    }

    // as a last resort: try first string-like property
    for (const k of Object.keys(v)) {
      const s = textify(v[k]);
      if (s) return s;
    }
    return "";
  }

  // fallback
  return String(v).trim();
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = textify(v);
    if (s) return s;
  }
  return "";
}

// -------------------------
// researchmap fetch helpers
// -------------------------
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    throw new Error(`researchmap API error ${res.status}: ${url}`);
  }
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
  let url = `https://api.researchmap.jp/${RESEARCHMAP_PERMALINK}/${category}?format=json&limit=${limit}&start=1`;

  const all = [];
  const seen = new Set();

  for (let guard = 0; guard < 50; guard++) {
    const json = await fetchJson(url);
    const { items, nextHref } = normalizeItems(json);

    for (const it of items) {
      const id = it?.["rm:id"] ?? it?.id ?? null;
      if (id != null) {
        if (seen.has(String(id))) continue;
        seen.add(String(id));
      }
      all.push(it);
    }

    if (!nextHref) break;
    url = nextHref.startsWith("http") ? nextHref : `https://api.researchmap.jp${nextHref}`;
  }

  return all;
}

// -------------------------
// Extractors for papers
// -------------------------
function extractYear(item) {
  // year can come in multiple fields; try many
  const y = firstNonEmpty(
    item?.year,
    item?.publication_year,
    item?.published_year,
    item?.["rm:year"],
    item?.date?.year,
    item?.issued?.year,
    item?.published_date
  );
  // if it's a date string, pick first 4 digits
  const m = (y || "").match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function extractTitle(item) {
  // IMPORTANT: cover lots of variants
  return firstNonEmpty(
    item?.title,
    item?.paper_title,
    item?.published_paper_title,
    item?.published_paper?.title,
    item?.article_title,
    item?.name,
    item?.["rm:title"],
    item?.["dc:title"],
    item?.["dcterms:title"]
  );
}

function extractJournalName(item) {
  return firstNonEmpty(
    item?.journal,
    item?.journal_name,
    item?.publication_name,
    item?.published_paper_name,
    item?.container_title,
    item?.source,
    item?.["rm:journal"],
    item?.["prism:publicationName"]
  );
}

function extractAuthors(item) {
  // common patterns: authors: [ {name}, {family_name, given_name}, ... ]
  const arr =
    item?.authors ??
    item?.author ??
    item?.creators ??
    item?.["dc:creator"] ??
    [];

  if (!Array.isArray(arr)) {
    const s = textify(arr);
    return s ? [s] : [];
  }

  const names = arr.map(a => {
    if (typeof a === "string") return a.trim();

    const n = firstNonEmpty(
      a?.name,
      a?.full_name,
      a?.author_name,
      a?.["rm:name"]
    );
    if (n) return n;

    const family = firstNonEmpty(a?.family_name, a?.family, a?.last_name, a?.surname);
    const given = firstNonEmpty(a?.given_name, a?.given, a?.first_name);
    const combined = `${given} ${family}`.trim();
    return combined;
  }).filter(Boolean);

  // de-dup
  return [...new Set(names)];
}

function extractVolNoPages(item) {
  const vol = firstNonEmpty(item?.volume, item?.vol, item?.["prism:volume"]);
  const no  = firstNonEmpty(item?.number, item?.issue, item?.no, item?.["prism:number"]);
  const sp  = firstNonEmpty(item?.start_page, item?.page_start, item?.first_page);
  const ep  = firstNonEmpty(item?.end_page, item?.page_end, item?.last_page);

  // sometimes pages comes as "2413-2422"
  const pagesRaw = firstNonEmpty(item?.pages, item?.page, item?.pagination);
  let pages = "";
  if (sp || ep) {
    pages = [sp, ep].filter(Boolean).join("–");
  } else if (pagesRaw) {
    pages = pagesRaw.replace(/-/g, "–");
  }

  return { vol, no, pages };
}

function extractLink(item) {
  return firstNonEmpty(
    item?.url,
    item?.link,
    item?.doi ? `https://doi.org/${textify(item.doi).replace(/^doi:/i, "")}` : "",
    item?.identifier?.doi ? `https://doi.org/${textify(item.identifier.doi)}` : ""
  );
}

// -------------------------
// IEEE-ish formatting (simple)
// -------------------------
function formatAuthorsIEEE(authors) {
  if (!authors.length) return "";
  // keep as-is (researchmap tends to provide proper order already)
  return authors.join(", ");
}

function formatIEEEEntry(item) {
  const authors = extractAuthors(item);
  const title = extractTitle(item);              // <-- FIX: always textified
  const journal = extractJournalName(item);      // <-- FIX: always textified
  const year = extractYear(item);

  const { vol, no, pages } = extractVolNoPages(item);
  const link = extractLink(item);

  // Build optional segments only when available
  const seg = [];
  if (journal) seg.push(journal);
  if (vol) seg.push(`vol. ${vol}`);
  if (no) seg.push(`no. ${no}`);
  if (pages) seg.push(`pp. ${pages}`);
  if (year) seg.push(year);

  const parts = [];
  const a = formatAuthorsIEEE(authors);
  if (a) parts.push(`${a},`);
  if (title) parts.push(`“${title},”`);
  if (seg.length) parts.push(seg.join(", ") + ".");
  else parts.push(".");

  // link shown as [link] when exists
  const main = parts.join(" ").replace(/\s+/g, " ").trim();
  return { main, link };
}

// -------------------------
// HTML generator (journal-papers.html)
// -------------------------
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function groupByYearDesc(items) {
  const mp = new Map();
  for (const it of items) {
    const y = extractYear(it) || "----";
    if (!mp.has(y)) mp.set(y, []);
    mp.get(y).push(it);
  }
  const years = [...mp.keys()].sort((a, b) => {
    // "----" should go last
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });
  return { years, mp };
}

function buildJournalHtml({ updatedDate, items }) {
  const { years, mp } = groupByYearDesc(items);
  const total = items.length;

  const blocks = years.map(y => {
    const list = mp.get(y);
    const rendered = list.map((it, idx) => {
      const { main, link } = formatIEEEEntry(it);

      const linkHtml = link
        ? `<div class="plink"><a href="${escapeHtml(link)}" target="_blank" rel="noopener">[link]</a></div>`
        : "";

      return `
        <li class="item">
          <div class="card">
            <div class="ref">${escapeHtml(main)}</div>
            ${linkHtml}
          </div>
        </li>
      `.trim();
    }).join("\n");

    return `
      <section class="year-block">
        <div class="year-head">
          <div class="year">${escapeHtml(y)}</div>
          <div class="badge">${list.length}</div>
        </div>
        <ol class="olist">
          ${rendered}
        </ol>
      </section>
    `.trim();
  }).join("\n\n");

  // NOTE: "IEEE style ..." line is NOT included (user requested removal)
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Journal Papers | Kobashi Laboratory</title>
  <style>
    body{font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;margin:0;background:#eef2f7;color:#111827}
    header{background:#1f3b84;color:#fff;padding:36px 28px}
    header h1{margin:0;font-size:54px;letter-spacing:.5px}
    header .sub{margin-top:10px;opacity:.95;font-size:18px}
    .topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
    .back a{display:inline-block;color:#fff;text-decoration:none;border:1px solid rgba(255,255,255,.35);
      padding:12px 18px;border-radius:999px}
    .wrap{max-width:1100px;margin:0 auto;padding:24px 18px 60px}
    .meta{background:#fff;border-radius:20px;padding:18px 20px;box-shadow:0 16px 40px rgba(15,23,42,.08);
      margin-top:-26px}
    .meta b{margin-right:18px}
    .year-block{margin-top:26px}
    .year-head{display:flex;align-items:center;gap:14px;margin:14px 0}
    .year{font-size:38px;font-weight:800;color:#1f3b84}
    .badge{width:42px;height:42px;border-radius:999px;background:#1f3b84;color:#fff;
      display:flex;align-items:center;justify-content:center;font-weight:800}
    .olist{margin:0;padding-left:24px}
    .item{margin:14px 0}
    .card{background:#fff;border-radius:18px;padding:18px 18px;box-shadow:0 14px 36px rgba(15,23,42,.07)}
    .ref{font-size:18px;line-height:1.65}
    .plink{margin-top:8px}
    .plink a{color:#1f3b84;text-decoration:underline}
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

  <div class="wrap">
    <div class="meta">
      <b>Updated:</b> ${escapeHtml(updatedDate)}　
      <b>Items:</b> ${total}　
      <b>Source:</b> researchmap API (generated daily via GitHub Actions)
    </div>

    ${blocks}
  </div>
</body>
</html>`;
}

// -------------------------
// Main
// -------------------------
async function main() {
  // Fetch categories (you can extend as needed)
  const [publishedPapers, presentations] = await Promise.all([
    fetchAllCategory("published_papers"),
    fetchAllCategory("presentations"),
  ]);

  // counts (minimum set; adapt to your existing keys)
  // NOTE: journal/int_conf/book_chapters は既存ロジックに合わせて別カテゴリ等で算出しているならここに追記してください
  const counts = {
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt: isoNow(),
    papers_total: publishedPapers.length,
    presentations_total: presentations.length,
  };

  // Ensure directories
  fs.mkdirSync(path.dirname(OUT_COUNTS_JSON), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_JOURNAL_HTML), { recursive: true });

  // Write counts.json
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify(counts, null, 2), "utf-8");

  // Build journal-papers.html (use published_papers as journal list here)
  // If you already filter "journal only" in your pipeline, replace `publishedPapers` with that filtered array.
  const updatedDate = counts.updatedAt.slice(0, 10);
  const html = buildJournalHtml({ updatedDate, items: publishedPapers });
  fs.writeFileSync(OUT_JOURNAL_HTML, html, "utf-8");

  console.log("Generated:");
  console.log(" -", OUT_COUNTS_JSON);
  console.log(" -", OUT_JOURNAL_HTML);
  console.log(`papers_total=${counts.papers_total} presentations_total=${counts.presentations_total}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
