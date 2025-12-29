/**
 * scripts/update_counts.js
 *
 * Fetch researchmap data and generate:
 *  - data/counts.json
 *  - data/unclassified_papers.json
 *  - publications/journal-papers.html (IEEE-ish style, incl. vol/no/pp if available)
 *
 * Usage:
 *   node scripts/update_counts.js
 *
 * Env (optional):
 *   RESEARCHMAP_PERMALINK=read0134502
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUB_DIR = path.join(ROOT, "publications");

const PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";
const API_BASE = `https://api.researchmap.jp/${PERMALINK}`;

const LIMIT = 1000; // researchmap API page size
const MAX_PAGES_GUARD = 30;

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text}`);
  }
  return await res.json();
}

function normalizeItems(json) {
  if (Array.isArray(json)) return { items: json, nextHref: null };
  const items = Array.isArray(json?.items) ? json.items : [];
  const nextHref = json?._links?.next?.href || null;
  return { items, nextHref };
}

async function fetchAllCategory(category) {
  let url = `${API_BASE}/${category}?format=json&limit=${LIMIT}&start=1`;

  const all = [];
  const seen = new Set();

  for (let guard = 0; guard < MAX_PAGES_GUARD; guard++) {
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

/**
 * Try to extract year from various fields
 */
function getYear(item) {
  const y =
    item?.year ||
    item?.publication_date?.slice?.(0, 4) ||
    item?.published_at?.slice?.(0, 4) ||
    item?.["publication_date"]?.slice?.(0, 4) ||
    item?.["published_at"]?.slice?.(0, 4);
  if (!y) return null;
  const m = String(y).match(/\d{4}/);
  return m ? m[0] : null;
}

function getTitle(item) {
  // researchmap often has title: { ja/en } or title_en/title_ja etc.
  const t =
    item?.title?.en ||
    item?.title?.ja ||
    item?.title ||
    item?.title_en ||
    item?.title_ja;
  return t ? String(t).trim() : "";
}

function getAuthors(item) {
  // candidates:
  //  - item.authors: array of { name } or strings
  //  - item.author: string
  //  - item.creator / item.contributors
  const a = item?.authors;
  if (Array.isArray(a) && a.length) {
    return a
      .map((x) => {
        if (!x) return "";
        if (typeof x === "string") return x.trim();
        return (x.name || x.full_name || x["rm:name"] || "").toString().trim();
      })
      .filter(Boolean);
  }
  if (typeof item?.author === "string" && item.author.trim()) {
    // sometimes "A; B; C"
    return item.author
      .split(/[;,、]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function ieeeAuthorName(name) {
  const s = String(name).trim();
  if (!s) return "";

  // If Japanese name likely has no spaces, keep as-is
  if (!s.includes(" ")) return s;

  // Heuristic: "First Middle Last" -> "F. M. Last"
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0];

  const last = parts[parts.length - 1];
  const firsts = parts.slice(0, -1);
  const initials = firsts
    .map((p) => p.replace(/[^A-Za-z]/g, ""))
    .filter(Boolean)
    .map((p) => p[0].toUpperCase() + ".")
    .join(" ");

  return `${initials} ${last}`.trim();
}

function formatAuthorsIEEE(authors) {
  const list = (authors || []).map(ieeeAuthorName).filter(Boolean);
  if (!list.length) return "";

  // IEEE often uses up to 6 then "et al."
  if (list.length > 6) {
    return `${list.slice(0, 6).join(", ")}, et al.`;
  }
  // last author with "and" is also seen; but comma-only is acceptable-ish
  return list.join(", ");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function findFirstNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

function getJournalName(item) {
  return findFirstNonEmpty(
    item?.journal_name,
    item?.publication_name,
    item?.journal,
    item?.container_title,
    item?.book_title
  );
}

function getVolume(item) {
  return findFirstNonEmpty(item?.volume, item?.vol, item?.journal_volume);
}

function getNumber(item) {
  return findFirstNonEmpty(item?.number, item?.no, item?.issue, item?.journal_issue);
}

function getPages(item) {
  const sp = findFirstNonEmpty(item?.starting_page, item?.start_page, item?.page_start);
  const ep = findFirstNonEmpty(item?.ending_page, item?.end_page, item?.page_end);
  const pr = findFirstNonEmpty(item?.pages, item?.page_range);

  if (sp && ep) return `${sp}–${ep}`;
  if (pr) return pr;
  if (sp) return sp;
  return "";
}

function getLink(item) {
  // prefer DOI then URL
  const doi = findFirstNonEmpty(item?.doi, item?.DOI);
  const url = findFirstNonEmpty(item?.url, item?.link, item?.official_url);
  if (doi) {
    const d = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
    return `https://doi.org/${d}`;
  }
  return url || "";
}

/**
 * Classify published_papers into:
 *  - book_chapters (in_book)
 *  - intl_conf (conference proceedings)
 *  - journal (everything else that looks like journal article)
 * If cannot confidently classify, put into unclassified.
 */
function classifyPublishedPaper(item) {
  // Common hints
  const inBook =
    item?.in_book === true ||
    item?.publication_type === "in_book" ||
    String(item?.published_paper_type || "").toLowerCase().includes("in_book");

  if (inBook) return "book_chapters";

  const typeStr = String(item?.published_paper_type || item?.publication_type || "").toLowerCase();
  const pubName = String(getJournalName(item) || "").toLowerCase();

  // conference heuristics
  const confHit =
    typeStr.includes("conference") ||
    typeStr.includes("proceeding") ||
    typeStr.includes("proceedings") ||
    typeStr.includes("international conference") ||
    pubName.includes("proceedings");

  if (confHit) return "intl_conf";

  // journal heuristics
  const isJournalFlag =
    item?.is_international_journal === true ||
    item?.referee === true ||
    typeStr.includes("journal") ||
    typeStr.includes("article");

  if (isJournalFlag) return "journal";

  // fallback: if it has a journal/publication name, likely journal
  if (getJournalName(item)) return "journal";

  return "unclassified";
}

function toIeeeCitation(item) {
  const authors = formatAuthorsIEEE(getAuthors(item));
  const title = getTitle(item);
  const journal = getJournalName(item);
  const vol = getVolume(item);
  const no = getNumber(item);
  const pp = getPages(item);
  const year = getYear(item);

  // Build IEEE-ish string with optional segments
  // Authors, "Title," Journal, vol. X, no. Y, pp. A–B, Year.
  const parts = [];

  if (authors) parts.push(`${escapeHtml(authors)},`);
  if (title) parts.push(`“${escapeHtml(title)},”`);
  if (journal) parts.push(`${escapeHtml(journal)}`);

  const vnpp = [];
  if (vol) vnpp.push(`vol. ${escapeHtml(vol)}`);
  if (no) vnpp.push(`no. ${escapeHtml(no)}`);
  if (pp) vnpp.push(`pp. ${escapeHtml(pp)}`);

  if (vnpp.length) parts.push(vnpp.join(", "));
  if (year) parts.push(`${escapeHtml(year)}.`);

  const citation = parts.join(" ").replace(/\s+/g, " ").trim();

  const link = getLink(item);
  return { citation, link };
}

function groupByYearDesc(items) {
  const map = new Map();
  for (const it of items) {
    const y = getYear(it) || "Unknown";
    if (!map.has(y)) map.set(y, []);
    map.get(y).push(it);
  }

  const years = Array.from(map.keys()).sort((a, b) => {
    if (a === "Unknown") return 1;
    if (b === "Unknown") return -1;
    return Number(b) - Number(a);
  });

  return { map, years };
}

function journalHtmlTemplate({ updatedDate, count, byYear }) {
  const yearSections = byYear.years
    .map((y) => {
      const items = byYear.map.get(y) || [];
      const lis = items
        .map((it, idx) => {
          const { citation, link } = toIeeeCitation(it);
          const linkHtml = link
            ? `<div class="paper-link"><a href="${escapeHtml(link)}" target="_blank" rel="noopener">[link]</a></div>`
            : "";
          return `
            <li class="paper">
              <div class="paper-cite">
                <span class="idx">${idx + 1}.</span>
                <span class="cite">${citation}</span>
              </div>
              ${linkHtml}
            </li>
          `;
        })
        .join("\n");

      return `
        <section class="year-block">
          <div class="year-head">
            <div class="year">${escapeHtml(y)}</div>
            <div class="year-count">${items.length}</div>
          </div>
          <ol class="paper-list">
            ${lis}
          </ol>
        </section>
      `;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Journal Papers | Kobashi Laboratory</title>
  <style>
    body{
      margin:0;
      font-family: 'Segoe UI','Noto Sans JP',sans-serif;
      background:#f5f7fb;
      color:#111827;
    }
    header{
      background:#1e3a8a;
      color:#fff;
      padding:28px 20px;
    }
    .wrap{max-width:1100px;margin:0 auto;padding:0 10px;}
    h1{margin:0;font-size:34px;letter-spacing:0.5px;}
    .sub{margin-top:8px;opacity:0.9}
    .topbar{
      margin-top:14px;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
      flex-wrap:wrap;
    }
    .btn{
      display:inline-block;
      color:#fff;
      text-decoration:none;
      padding:10px 14px;
      border:1px solid rgba(255,255,255,0.35);
      border-radius:999px;
      transition:transform .15s ease;
      white-space:nowrap;
    }
    .btn:hover{transform:translateY(-1px)}
    .card{
      margin-top:-18px;
      background:#fff;
      border-radius:18px;
      box-shadow:0 18px 40px rgba(0,0,0,0.08);
      padding:22px 22px;
    }
    .meta{
      display:flex;gap:22px;flex-wrap:wrap;
      color:#374151;
      font-size:14px;
    }
    main{padding:22px 0 50px;}
    .year-block{margin-top:22px;}
    .year-head{
      display:flex;align-items:center;gap:12px;
      margin:18px 0 10px;
    }
    .year{
      font-size:26px;font-weight:800;color:#1e3a8a;
    }
    .year-count{
      width:34px;height:34px;border-radius:999px;
      background:#1e3a8a;color:#fff;
      display:flex;align-items:center;justify-content:center;
      font-weight:700;
    }
    .paper-list{
      margin:0;
      padding-left:22px;
    }
    .paper{
      margin:14px 0;
      padding:14px 16px;
      background:#fff;
      border-radius:14px;
      box-shadow:0 8px 22px rgba(0,0,0,0.06);
      list-style:decimal;
    }
    .paper-cite{
      line-height:1.65;
      font-size:16px;
    }
    .paper-link{margin-top:6px;}
    .paper-link a{color:#2563eb;text-decoration:none;}
    .paper-link a:hover{text-decoration:underline;}
    footer{
      color:#6b7280;
      font-size:13px;
      padding:18px 0;
      text-align:center;
    }
    @media (max-width: 640px){
      h1{font-size:26px;}
      .paper{padding:12px 12px}
      .paper-cite{font-size:15px}
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Journal Papers</h1>
      <div class="sub">論文誌（Journal papers only）</div>
      <div class="topbar">
        <div style="opacity:.9">IEEE style (vol/no/pp shown when available)</div>
        <a class="btn" href="../index.html#recent-ja">← Publications に戻る</a>
      </div>
    </div>
  </header>

  <div class="wrap">
    <div class="card">
      <div class="meta">
        <div><strong>Updated:</strong> ${escapeHtml(updatedDate)}</div>
        <div><strong>Items:</strong> ${count}</div>
        <div><strong>Source:</strong> researchmap API (generated daily via GitHub Actions)</div>
      </div>
    </div>

    <main>
      ${yearSections}
    </main>

    <footer>
      &copy; ${new Date().getFullYear()} Kobashi Laboratory, University of Hyogo
    </footer>
  </div>
</body>
</html>`;
}

async function writeJson(fp, obj) {
  await fs.writeFile(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function main() {
  await ensureDir(DATA_DIR);
  await ensureDir(PUB_DIR);

  console.log(`[update_counts] permalink=${PERMALINK}`);

  // Fetch
  const [publishedPapers, presentations] = await Promise.all([
    fetchAllCategory("published_papers"),
    fetchAllCategory("presentations"),
  ]);

  // Classify published papers
  const journal = [];
  const intl_conf = [];
  const book_chapters = [];
  const unclassified = [];

  for (const it of publishedPapers) {
    const cls = classifyPublishedPaper(it);
    if (cls === "journal") journal.push(it);
    else if (cls === "intl_conf") intl_conf.push(it);
    else if (cls === "book_chapters") book_chapters.push(it);
    else unclassified.push(it);
  }

  // Sort journal papers by year desc then stable
  journal.sort((a, b) => {
    const ya = Number(getYear(a) || 0);
    const yb = Number(getYear(b) || 0);
    if (yb !== ya) return yb - ya;
    // fallback by title
    return getTitle(a).localeCompare(getTitle(b));
  });

  const updatedAt = new Date().toISOString();

  // counts.json
  const counts = {
    permalink: PERMALINK,
    updatedAt,
    // publication counts
    papers_total: publishedPapers.length,
    journal: journal.length,
    intl_conf: intl_conf.length,
    book_chapters: book_chapters.length,
    // presentations
    presentations_total: presentations.length,
    // diagnostics
    unclassified_count: unclassified.length,
  };

  await writeJson(path.join(DATA_DIR, "counts.json"), counts);

  // unclassified_papers.json (lightweight)
  const unclassifiedOut = unclassified.map((it) => ({
    id: it?.["rm:id"] || it?.id || null,
    year: getYear(it),
    title: { ja: it?.title?.ja || null, en: it?.title?.en || null },
    raw_type_fields: {
      published_paper_type: it?.published_paper_type ?? null,
      publication_type: it?.publication_type ?? null,
      in_book: it?.in_book ?? null,
      is_international_journal: it?.is_international_journal ?? null,
      referee: it?.referee ?? null,
    },
  }));
  await writeJson(path.join(DATA_DIR, "unclassified_papers.json"), {
    permalink: PERMALINK,
    updatedAt,
    unclassified_count: unclassifiedOut.length,
    unclassified: unclassifiedOut,
  });

  // journal-papers.html
  const byYear = groupByYearDesc(journal);
  const html = journalHtmlTemplate({
    updatedDate: updatedAt.slice(0, 10),
    count: journal.length,
    byYear,
  });
  await fs.writeFile(path.join(PUB_DIR, "journal-papers.html"), html, "utf8");

  console.log(`[update_counts] done`);
  console.log(`  published_papers total: ${publishedPapers.length}`);
  console.log(`  journal: ${journal.length}`);
  console.log(`  intl_conf: ${intl_conf.length}`);
  console.log(`  book_chapters: ${book_chapters.length}`);
  console.log(`  unclassified: ${unclassified.length}`);
  console.log(`  presentations total: ${presentations.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
