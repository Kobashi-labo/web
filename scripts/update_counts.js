/**
 * scripts/update_counts.js
 * - Fetch researchmap API
 * - Build data/counts.json
 * - Build publications/journal-papers.html
 *    - Journal only (exclude: non-refereed invited articles)
 *    - Year-grouped
 *    - Display: newest first (year desc, within-year sorted by date if possible)
 *    - Numbering: cumulative ONLY, oldest = 1, newest = N
 *    - No per-year list numbering (only cumulative number shown)
 * - Build publications/commentary-articles.html
 *    - Non-refereed invited articles => 解説記事
 *
 * Node 18+
 */

const fs = require("fs");
const path = require("path");

const RESEARCHMAP_PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";

// output paths (can be overridden by env)
const OUT_COUNTS_JSON =
  process.env.OUT_COUNTS_JSON ||
  process.env.OUT_COUNTS ||
  path.join("data", "counts.json");

const OUT_JOURNAL_HTML =
  process.env.OUT_JOURNAL_HTML || path.join("publications", "journal-papers.html");

const OUT_COMMENTARY_HTML =
  process.env.OUT_COMMENTARY_HTML ||
  path.join("publications", "commentary-articles.html");

/* =========================
 * utils
 * ========================= */

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

function normalizeSpaces(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/* ---- object → string 完全正規化 ---- */
function pickLangText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(pickLangText).filter(Boolean).join(" ");

  if (isObject(v)) {
    if (v.name) return pickLangText(v.name);
    if (v.full_name) return pickLangText(v.full_name);
    if (v.display_name) return pickLangText(v.display_name);

    const cand =
      v.en ?? v.ja ?? v["rm:en"] ?? v["rm:ja"] ?? v.value ?? v.text ?? "";
    if (cand) return pickLangText(cand);

    return "";
  }
  return "";
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const t = normalizeSpaces(pickLangText(v));
    if (t) return t;
  }
  return "";
}

function truthy(v) {
  const s = String(pickLangText(v)).toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes";
}
function falsy(v) {
  const s = String(pickLangText(v)).toLowerCase().trim();
  return s === "false" || s === "0" || s === "no";
}

/* =========================
 * 年
 * ========================= */
function toYear(item) {
  const cands = [
    item?.year,
    item?.published_year,
    item?.publication_year,
    item?.publication_date,
    item?.issued,
    item?.date,
  ]
    .map((v) => normalizeSpaces(pickLangText(v)))
    .filter(Boolean);

  for (const c of cands) {
    const m = c.match(/(19|20)\d{2}/);
    if (m) return m[0];
  }
  return "----";
}

/* =========================
 * 日付（並び替え用）
 * ========================= */
function toDateKey(item) {
  const cands = [
    item?.publication_date,
    item?.issued,
    item?.date,
    item?.created,
    item?.updated,
    item?.["rm:created"],
    item?.["rm:updated"],
  ]
    .map((v) => normalizeSpaces(pickLangText(v)))
    .filter(Boolean);

  for (const c of cands) {
    // 2025-12-30 / 2025/12/30 / 2025-12
    let m = c.match(/(19|20)\d{2}[-/]\d{1,2}([-/]\d{1,2})?/);
    if (m) {
      const normalized = m[0].replaceAll("/", "-");
      const parts = normalized.split("-");
      const y = parts[0].padStart(4, "0");
      const mo = (parts[1] ?? "01").padStart(2, "0");
      const d = (parts[2] ?? "01").padStart(2, "0");
      return `${y}-${mo}-${d}`;
    }
  }
  // fallback: year only
  const y = toYear(item);
  if (y !== "----") return `${y}-01-01`;
  return "0000-01-01";
}

/* =========================
 * URL
 * ========================= */
function toUrl(item) {
  const doi = firstNonEmpty(item?.doi, item?.DOI, item?.["rm:doi"]);
  if (doi) {
    const clean = doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
    return `https://doi.org/${clean}`;
  }

  return firstNonEmpty(item?.url, item?.URL, item?._links?.self?.href);
}

/* =========================
 * 著者（IEEE 形式）
 * ========================= */

function formatAuthorName(raw) {
  const name = normalizeSpaces(pickLangText(raw));
  if (!name) return "";

  // 日本語名はそのまま
  if (/[ぁ-んァ-ン一-龥]/.test(name)) return name;

  // "Family, Given Middle" 形式
  if (name.includes(",")) {
    const [family, given] = name.split(",").map(normalizeSpaces);
    const initials = given
      .split(" ")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + ".")
      .join(" ");
    return normalizeSpaces(`${initials} ${family}`); // 姓は省略しない
  }

  // "Given Middle Family" 形式
  const tokens = name.split(" ").filter(Boolean);
  if (tokens.length === 1) return tokens[0];

  const family = tokens[tokens.length - 1];
  const givenTokens = tokens.slice(0, -1);

  const initials = givenTokens
    .map((w) => {
      const c = w[0];
      return c ? c.toUpperCase() + "." : "";
    })
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

function toAuthors(item) {
  // あり得るキーを全部拾う（researchmapの揺れ対策）
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
  ].filter((v) => v != null);

  // 1) 配列があれば最優先
  const arr = pools.find((v) => Array.isArray(v) && v.length);

  if (arr) {
    const names = arr
      .flatMap((a) => {
        const s = firstNonEmpty(
          // researchmapで多い順（ここが重要）
          a?.full_name,
          a?.display_name,
          a?.name,
          a?.["rm:display_name"],
          // family/given が別のとき（確実）
          a?.family_name && a?.given_name
            ? `${pickLangText(a.given_name)} ${pickLangText(a.family_name)}`
            : "",
          a?.family && a?.given
            ? `${pickLangText(a.given)} ${pickLangText(a.family)}`
            : "",
          a
        );

        // 1要素に複数著者が入っている場合の救済（区切りがある時だけ分割）
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

    return joinAuthorsIEEE(names);
  }

  // 2) 文字列（author が "A;B;C" など）
  const str = pools
    .map((v) => (typeof v === "string" ? v : ""))
    .find((s) => s && s.trim());

  if (str) {
    const parts = str
      .split(/\s*[,;]\s*|\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(formatAuthorName)
      .filter(Boolean);

    return joinAuthorsIEEE(parts.length ? parts : [formatAuthorName(str)]);
  }

  // 3) 最後の保険
  const alt = firstNonEmpty(
    item?.author_name,
    item?.authors_name,
    item?.creator_name,
    item?.contributor_name
  );
  if (alt) return joinAuthorsIEEE([formatAuthorName(alt)]);

  return "";
}

/* =========================
 * Title / Journal
 * ========================= */
function toTitle(item) {
  return firstNonEmpty(
    item?.title,
    item?.paper_title,
    item?.published_paper_title,
    item?.["rm:title"]
  );
}

function toJournalName(item) {
  return firstNonEmpty(
    item?.journal,
    item?.journal_name,
    item?.publication_name,
    item?.container_title,
    item?.["rm:journal"]
  );
}

/* =========================
 * vol / no / pp
 * ========================= */
function toVolNoPp(item) {
  const vol = firstNonEmpty(item?.volume, item?.vol);
  const no = firstNonEmpty(item?.number, item?.no, item?.issue);

  const sp = firstNonEmpty(item?.starting_page, item?.start_page);
  const ep = firstNonEmpty(item?.ending_page, item?.end_page);
  const pr = firstNonEmpty(item?.page_range, item?.pages);

  let pp = "";
  if (sp && ep) pp = `${sp}\u2013${ep}`;
  else if (pr) pp = pr;

  const parts = [];
  if (vol) parts.push(`vol. ${vol}`);
  if (no) parts.push(`no. ${no}`);
  if (pp) parts.push(`pp. ${pp}`);

  return parts.join(", ");
}

/* =========================
 * Journal-only 判定
 * ========================= */
function isJournalOnly(item) {
  const j = toJournalName(item).toLowerCase();
  const t = toTitle(item).toLowerCase();
  const hay = `${j} | ${t}`;

  const badPatterns = [
    /\bproceedings\b/,
    /\bproceedings of\b/,
    /\bannual international conference\b/,
    /\binternational conference\b/,
    /\bconference\b/,
    /\bsymposium\b/,
    /\bworkshop\b/,
    /\bmeeting\b/,
    /\bcongress\b/,
  ];

  if (badPatterns.some((re) => re.test(hay))) return false;

  // type がある場合の保険
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

  if (/(conference|proceeding|proceedings|symposium|workshop)/.test(typeStr))
    return false;
  if (/(book|chapter|in_book)/.test(typeStr)) return false;

  if (typeStr.includes("journal")) return true;

  const journalHint = [
    item?.is_international_journal,
    item?.international_journal,
    item?.raw_type_fields?.is_international_journal,
  ]
    .map((v) => pickLangText(v).toLowerCase())
    .join(" ");

  if (journalHint.includes("true") || journalHint.includes("1")) return true;

  return Boolean(toJournalName(item));
}

/* =========================
 * 解説記事（査読なし招待論文）判定
 * ========================= */
function isRefereed(item) {
  const v = firstNonEmpty(
    item?.referee,
    item?.raw_type_fields?.referee,
    item?.is_refereed,
    item?.raw_type_fields?.is_refereed
  );
  if (truthy(v)) return true;
  if (falsy(v)) return false;
  return null; // 不明
}

function isInvitedLike(item) {
  const v = firstNonEmpty(
    item?.invited,
    item?.raw_type_fields?.invited,
    item?.is_invited,
    item?.raw_type_fields?.is_invited
  );
  if (truthy(v)) return true;
  if (falsy(v)) return false;

  // フラグが無い場合の補助
  const hay = [
    toTitle(item),
    item?.published_paper_type,
    item?.raw_type_fields?.published_paper_type,
    item?.paper_type,
    item?.type,
    item?.category,
  ]
    .map((x) => String(pickLangText(x)).toLowerCase())
    .join(" | ");

  return /(invited|commentary|survey|review|解説|総説|招待)/.test(hay);
}

function isNonRefereedInvitedArticle(item) {
  const ref = isRefereed(item);
  if (ref === true) return false;
  if (!isInvitedLike(item)) return false;

  // 査読が明確に false なら確定。ref が null（不明）でも invited 強い場合は採用
  return ref === false || ref === null;
}

/* =========================
 * fetch
 * ========================= */
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

function normalizeItems(json) {
  if (Array.isArray(json)) return { items: json, next: null };
  return {
    items: Array.isArray(json.items) ? json.items : [],
    next: json?._links?.next?.href || null,
  };
}

async function fetchAllCategory(cat) {
  let url = `https://api.researchmap.jp/${RESEARCHMAP_PERMALINK}/${cat}?format=json&limit=1000&start=1`;
  const all = [];
  const seen = new Set();

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
  }
  return all;
}

/* =========================
 * sorting helpers
 * ========================= */
function sortNewestFirst(a, b) {
  // primary: year desc (unknown last)
  const ya = toYear(a);
  const yb = toYear(b);
  if (ya !== yb) {
    if (ya === "----") return 1;
    if (yb === "----") return -1;
    return Number(yb) - Number(ya);
  }
  // secondary: date desc
  const da = toDateKey(a);
  const db = toDateKey(b);
  if (da !== db) return db.localeCompare(da);
  // tertiary: title
  return String(toTitle(a)).localeCompare(String(toTitle(b)));
}

/* =========================
 * HTML builders
 * ========================= */

function buildYearGroupedHtml({
  titleEn,
  titleJa,
  backHref,
  updatedAt,
  items,
}) {
  // group by year
  const byYear = new Map();
  for (const it of items) {
    const y = toYear(it);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }

  // year order: newest first (---- last)
  const years = [...byYear.keys()].sort((a, b) => {
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });

  // Within each year: newest first
  for (const y of years) {
    byYear.get(y).sort(sortNewestFirst);
  }

  // cumulative numbering: oldest = 1, newest = N
  // We are displaying newest-first, so for an item at display index i (0-based),
  // number = N - i.
  const N = items.length;

  let displayIndex = 0;

  const blocks = years
    .map((y) => {
      const list = byYear.get(y);

      const lis = list
        .map((it) => {
          const authors = toAuthors(it);
          const title = toTitle(it);
          const journal = toJournalName(it);
          const vnp = toVolNoPp(it);
          const year = toYear(it);
          const url = toUrl(it);

          const cite = [
            authors && `${escHtml(authors)},`,
            title && `“${escHtml(title)},”`,
            journal && `<i>${escHtml(journal)}</i>,`,
            vnp && `${escHtml(vnp)},`,
            year !== "----" ? `${year}.` : ".",
          ]
            .filter(Boolean)
            .join(" ");

          const num = N - displayIndex; // newest is N

          displayIndex += 1;

          // IMPORTANT:
          // - No per-year list numbering: use <div> not <ol> numbering
          // - Only cumulative number is shown in .num
          return `
          <li class="paper">
            <div class="box">
              <span class="num">${num}.</span>
              <div class="cite">${cite}${
                url
                  ? ` <a href="${escHtml(url)}" target="_blank" rel="noopener">[link]</a>`
                  : ""
              }</div>
            </div>
          </li>`;
        })
        .join("");

      // Also suppress browser list numbering by CSS (list-style:none)
      return `
      <section>
        <h2>${escHtml(y)} <span class="badge">${list.length}</span></h2>
        <ul class="paperlist">${lis}</ul>
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escHtml(titleEn)}</title>
<style>
:root{--blue:#1e3a8a;--bg:#f3f6fb;--card:#fff;}
body{font-family:Segoe UI,Noto Sans JP,sans-serif;background:var(--bg);margin:0}
header{background:var(--blue);color:#fff;padding:40px}
h1{margin:0;font-size:48px;line-height:1.05}
header p{margin:14px 0 0 0;opacity:.95}
.wrap{max-width:1200px;margin:0 auto;padding:30px}
.box{background:var(--card);border-radius:16px;padding:16px;display:grid;grid-template-columns:72px 1fr;gap:12px;margin:12px 0}
.num{font-weight:800;color:var(--blue);font-size:20px;white-space:nowrap}
.badge{background:var(--blue);color:#fff;padding:6px 12px;border-radius:999px;margin-left:8px;font-size:14px}
h2{margin:26px 0 8px 0;font-size:36px}
.paperlist{list-style:none;padding:0;margin:0}
a{color:#0b3cc1}
@media (max-width: 720px){
  header{padding:26px}
  h1{font-size:40px}
  .box{grid-template-columns:60px 1fr}
}
</style>
</head>
<body>
<header>
<a href="${escHtml(backHref)}" style="color:#fff;text-decoration:underline">← Publications に戻る</a>
<h1>${escHtml(titleEn)}</h1>
<p>${escHtml(titleJa)}</p>
</header>
<div class="wrap">
<p><b>Updated:</b> ${escHtml(updatedAt)} &nbsp; <b>Items:</b> ${items.length}</p>
${blocks}
</div>
</body>
</html>`;
}

/* =========================
 * main
 * ========================= */
async function main() {
  const published = await fetchAllCategory("published_papers");

  // 解説記事（査読無しの招待論文）
  const commentary = published
    .filter(isNonRefereedInvitedArticle)
    .sort(sortNewestFirst);

  // journal（解説記事は除外）
  const journals = published
    .filter((it) => isJournalOnly(it) && !isNonRefereedInvitedArticle(it))
    .sort(sortNewestFirst);

  const updatedAtISO = new Date().toISOString();
  const updatedAtDate = updatedAtISO.slice(0, 10);

  // counts.json
  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(
    OUT_COUNTS_JSON,
    JSON.stringify(
      {
        permalink: RESEARCHMAP_PERMALINK,
        updatedAt: updatedAtISO,
        papers_total: published.length,
        journal: journals.length,
        commentary: commentary.length,
      },
      null,
      2
    )
  );

  // journal html
  ensureDir(path.dirname(OUT_JOURNAL_HTML));
  fs.writeFileSync(
    OUT_JOURNAL_HTML,
    buildYearGroupedHtml({
      titleEn: "Journal Papers",
      titleJa: "論文誌（Journal papers only）",
      backHref: "../index.html#recent-ja",
      updatedAt: updatedAtDate,
      items: journals,
    })
  );

  // commentary html
  ensureDir(path.dirname(OUT_COMMENTARY_HTML));
  fs.writeFileSync(
    OUT_COMMENTARY_HTML,
    buildYearGroupedHtml({
      titleEn: "Commentary Articles",
      titleJa: "解説記事（査読なし招待論文）",
      backHref: "../index.html#recent-ja",
      updatedAt: updatedAtDate,
      items: commentary,
    })
  );

  // logs (useful for Actions)
  console.log("OUT_COUNTS_JSON =", path.resolve(OUT_COUNTS_JSON));
  console.log("OUT_JOURNAL_HTML =", path.resolve(OUT_JOURNAL_HTML));
  console.log("OUT_COMMENTARY_HTML =", path.resolve(OUT_COMMENTARY_HTML));
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
