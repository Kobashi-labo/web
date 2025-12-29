/**
 * scripts/update_counts.js
 * - Fetch researchmap API
 * - Build data/counts.json
 * - Build publications/journal-papers.html (journal-only, year-grouped, IEEE-ish)
 *
 * Node 18+ (fetch available)
 */

const fs = require("fs");
const path = require("path");

const RESEARCHMAP_PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";
const OUT_COUNTS_JSON = path.join("data", "counts.json");
const OUT_JOURNAL_HTML = path.join("publications", "journal-papers.html");

// ------------------------
// utils
// ------------------------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

// researchmap は title: {ja,en} のように来ることがある
function pickLangText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    // 配列で来るケースは要素を結合
    return v.map(pickLangText).filter(Boolean).join(" ");
  }
  if (isObject(v)) {
    // よくある順で拾う
    const cand =
      v.en ?? v.ja ?? v["rm:en"] ?? v["rm:ja"] ?? v.value ?? v.text ?? "";
    if (cand) return pickLangText(cand);

    // それでもダメなら、object を stringify して [object Object] 回避
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const t = pickLangText(v).trim();
    if (t) return t;
  }
  return "";
}

function toYear(item) {
  // いろんな候補から year を抽出
  const candidates = [
    item?.year,
    item?.published_year,
    item?.publication_year,
    item?.issued_year,
    item?.["rm:published_year"],
    item?.["rm:publication_year"],
    item?.publication_date,
    item?.published_date,
    item?.issued,
    item?.date,
    item?.created_at,
    item?.updated_at,
  ]
    .map((v) => pickLangText(v).trim())
    .filter(Boolean);

  // "2025-12-29" 等から 4桁年を抜く
  for (const c of candidates) {
    const m = c.match(/(19|20)\d{2}/);
    if (m) return m[0];
  }
  return "----";
}

function toUrl(item) {
  // DOI / URL / researchmap link っぽいものを拾う
  const doi = firstNonEmpty(
    item?.doi,
    item?.DOI,
    item?.identifier?.doi,
    item?.["rm:doi"]
  );
  if (doi) {
    const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
    return `https://doi.org/${clean}`;
  }

  const url = firstNonEmpty(
    item?.url,
    item?.URL,
    item?.link,
    item?.["rm:url"],
    item?._links?.self?.href
  );
  return url || "";
}

function toAuthors(item) {
  // よくある author フィールド候補
  const arr =
    item?.authors ||
    item?.author ||
    item?.creators ||
    item?.creator ||
    item?.member ||
    item?.contributors ||
    item?.contributor ||
    item?.["rm:authors"] ||
    [];

  if (!Array.isArray(arr)) {
    // 文字列で来る場合もある
    const s = pickLangText(arr).trim();
    return s ? s : "";
  }

  const names = arr
    .map((a) =>
      firstNonEmpty(
        a?.name,
        a?.full_name,
        a?.display_name,
        a?.["rm:display_name"],
        a?.family_name && a?.given_name
          ? `${pickLangText(a.family_name)} ${pickLangText(a.given_name)}`
          : "",
        a
      )
    )
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return names.join(", ");
}

function toTitle(item) {
  return firstNonEmpty(
    item?.title,
    item?.paper_title,
    item?.published_paper_title,
    item?.["rm:title"],
    item?.name
  );
}

function toJournalName(item) {
  return firstNonEmpty(
    item?.journal,
    item?.journal_name,
    item?.publication_name,
    item?.published_paper_name,
    item?.container_title,
    item?.["rm:publication_name"],
    item?.["rm:journal"]
  );
}

function toVolNoPp(item) {
  const vol = firstNonEmpty(item?.volume, item?.vol, item?.journal_volume);
  const no = firstNonEmpty(
    item?.number,
    item?.no,
    item?.issue,
    item?.journal_number
  );

  // pages
  let pp = "";
  const sp = firstNonEmpty(
    item?.starting_page,
    item?.start_page,
    item?.page_start
  );
  const ep = firstNonEmpty(
    item?.ending_page,
    item?.end_page,
    item?.page_end
  );
  const pr = firstNonEmpty(item?.page_range, item?.pages);

  if (sp && ep) pp = `${sp}\u2013${ep}`;
  else if (pr) pp = pr;

  // IEEE-ish string
  const parts = [];
  if (vol) parts.push(`vol. ${vol}`);
  if (no) parts.push(`no. ${no}`);
  if (pp) parts.push(`pp. ${pp}`);

  return parts.join(", ");
}

/**
 * Journal-only 判定（conference 混入を強めに排除）
 * researchmap の published_paper_type が実データで揺れるので、
 * “conference/proceedings” を含むものは除外するルールを入れている。
 */
function isJournalOnly(item) {
  const typeStr = [
    item?.published_paper_type,
    item?.paper_type,
    item?.type,
    item?.category,
    item?.raw_type_fields?.published_paper_type,
  ]
    .map((v) => pickLangText(v).toLowerCase())
    .filter(Boolean)
    .join(" | ");

  const journalHint = [
    item?.is_international_journal,
    item?.international_journal,
    item?.raw_type_fields?.is_international_journal,
    item?.referee,
    item?.raw_type_fields?.referee,
  ]
    .map((v) => pickLangText(v).toLowerCase())
    .join(" ");

  // 強制除外（混入対策の主役）
  if (typeStr.includes("conference")) return false;
  if (typeStr.includes("proceeding")) return false;
  if (typeStr.includes("proceedings")) return false;

  // “in_book / book_chapter” っぽいものも除外（念のため）
  if (typeStr.includes("book")) return false;
  if (typeStr.includes("chapter")) return false;

  // ここから先は「残った published_papers を journal とみなす」方針
  // ただし “journal” が含まれるなら明確に true
  if (typeStr.includes("journal")) return true;

  // referee true っぽければ journal 扱い
  if (journalHint.includes("true") || journalHint.includes("1")) return true;

  // 最後の保険：ジャーナル名があれば journal 扱い（ただし proceedings 混入は上で切ってる）
  const jn = toJournalName(item);
  if (jn) return true;

  return false;
}

// ------------------------
// fetch
// ------------------------
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
  let url = `https://api.researchmap.jp/${RESEARCHMAP_PERMALINK}/${category}?format=json&limit=${limit}&start=1`;

  const all = [];
  const seen = new Set();

  for (let guard = 0; guard < 50; guard++) {
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

// ------------------------
// HTML generation
// ------------------------
function buildJournalHtml({ updatedAt, items }) {
  // year-group
  const byYear = new Map();
  for (const it of items) {
    const y = toYear(it);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }

  // year sort desc, "----" last
  const years = Array.from(byYear.keys()).sort((a, b) => {
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });

  // within year: try keep stable by title
  for (const y of years) {
    byYear.get(y).sort((a, b) => {
      const ta = toTitle(a).toLowerCase();
      const tb = toTitle(b).toLowerCase();
      return ta.localeCompare(tb);
    });
  }

  const total = items.length;

  function renderEntry(idx, it) {
    const authors = toAuthors(it);
    const title = toTitle(it);
    const journal = toJournalName(it);
    const year = toYear(it);
    const vnp = toVolNoPp(it);
    const url = toUrl(it);

    // IEEE-ish:
    // Authors, “Title,” Journal, vol. x, no. y, pp. a–b, Year.
    const parts = [];

    if (authors) parts.push(`${escHtml(authors)},`);
    if (title) parts.push(`“${escHtml(title)},”`);
    if (journal) parts.push(`<i>${escHtml(journal)}</i>`);
    if (vnp) parts.push(`${escHtml(vnp)}`);
    if (year !== "----") parts.push(`${escHtml(year)}.`);
    else parts.push(`.`);

    const main = parts.join(" ");

    const linkHtml = url
      ? ` <a class="plink" href="${escHtml(url)}" target="_blank" rel="noopener">[link]</a>`
      : "";

    return `
      <li class="paper">
        <div class="paper-box">
          <span class="num">${idx}.</span>
          <div class="cite">${main}${linkHtml}</div>
        </div>
      </li>`;
  }

  let runningIndex = 1;
  const yearBlocks = years
    .map((y) => {
      const list = byYear.get(y) || [];
      const badge = `<span class="badge">${escHtml(String(list.length))}</span>`;
      const head = `<div class="year-head"><span class="year">${escHtml(y)}</span>${badge}</div>`;
      const itemsHtml = list.map((it) => renderEntry(runningIndex++, it)).join("\n");
      return `
        <section class="year-section">
          ${head}
          <ol class="papers">
            ${itemsHtml}
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
  :root {
    --blue: #1e3a8a;
    --bg: #f3f6fb;
    --card: #ffffff;
    --muted: #6b7280;
    --shadow: 0 10px 30px rgba(0,0,0,0.08);
    --radius: 18px;
  }
  body {
    margin: 0;
    font-family: "Segoe UI", "Noto Sans JP", sans-serif;
    background: var(--bg);
    color: #111827;
  }
  header {
    background: var(--blue);
    color: white;
    padding: 48px 32px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  header h1 { margin: 0; font-size: 56px; letter-spacing: .5px; }
  header p { margin: 8px 0 0; opacity: .9; font-size: 18px; }
  .back {
    position: absolute;
    right: 28px;
    top: 28px;
    color: white;
    text-decoration: none;
    border: 1px solid rgba(255,255,255,.35);
    padding: 10px 16px;
    border-radius: 999px;
    backdrop-filter: blur(6px);
  }
  .wrap { max-width: 1200px; margin: 0 auto; padding: 28px 18px 60px; }
  .meta {
    background: var(--card);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 18px 22px;
    display: flex;
    gap: 22px;
    flex-wrap: wrap;
    align-items: center;
    margin-top: -24px;
  }
  .meta b { color: #111827; }
  .meta span { color: var(--muted); }
  .year-section { margin-top: 28px; }
  .year-head {
    display: flex;
    align-items: center;
    gap: 14px;
    margin: 22px 0 10px;
  }
  .year {
    font-size: 44px;
    font-weight: 800;
    color: var(--blue);
    letter-spacing: .5px;
  }
  .badge {
    background: var(--blue);
    color: white;
    padding: 8px 14px;
    border-radius: 999px;
    font-weight: 700;
  }
  ol.papers { margin: 0; padding-left: 0; list-style: none; }
  .paper { margin: 14px 0; }
  .paper-box {
    background: var(--card);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    padding: 18px 20px;
    display: grid;
    grid-template-columns: 40px 1fr;
    gap: 14px;
    align-items: start;
  }
  .num {
    font-weight: 800;
    color: var(--blue);
    font-size: 18px;
    line-height: 1.6;
  }
  .cite {
    font-size: 18px;
    line-height: 1.75;
  }
  .plink { margin-left: 6px; }
  .plink:visited { color: #374151; }
  @media (max-width: 768px) {
    header h1 { font-size: 38px; }
    .year { font-size: 32px; }
    .paper-box { grid-template-columns: 32px 1fr; }
    .cite { font-size: 16px; }
  }
</style>
</head>
<body>
<header>
  <a class="back" href="../index.html#recent-ja">← Publications に戻る</a>
  <h1>Journal Papers</h1>
  <p>論文誌（Journal papers only）</p>
</header>

<div class="wrap">
  <div class="meta">
    <div><b>Updated:</b> <span>${escHtml(updatedAt)}</span></div>
    <div><b>Items:</b> <span>${escHtml(String(total))}</span></div>
    <div><b>Source:</b> <span>researchmap API (generated daily via GitHub Actions)</span></div>
  </div>

  ${yearBlocks}
</div>
</body>
</html>`;
}

// ------------------------
// main
// ------------------------
async function main() {
  console.log(`Fetching researchmap: ${RESEARCHMAP_PERMALINK}`);

  const [publishedPapers, presentations] = await Promise.all([
    fetchAllCategory("published_papers"),
    fetchAllCategory("presentations"),
  ]);

  // journal-only filter（conference 混入をここで排除）
  const journals = publishedPapers.filter(isJournalOnly);

  // counts
  const updatedAt = new Date().toISOString();
  const counts = {
    permalink: RESEARCHMAP_PERMALINK,
    updatedAt,
    // “papers_total” は published_papers 全体（必要なら journal-only に変えてもOK）
    papers_total: publishedPapers.length,
    // journal-only count
    journal: journals.length,
    journal_count: journals.length,
    presentations_total: presentations.length,
  };

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(OUT_COUNTS_JSON, JSON.stringify(counts, null, 2), "utf-8");
  console.log(`Wrote ${OUT_COUNTS_JSON}`);

  // journal html
  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  const html = buildJournalHtml({
    updatedAt: updatedAt.slice(0, 10),
    items: journals,
  });
  fs.writeFileSync(OUT_JOURNAL_HTML, html, "utf-8");
  console.log(`Wrote ${OUT_JOURNAL_HTML}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
