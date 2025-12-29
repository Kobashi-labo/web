/**
 * scripts/update_counts.js
 * - Fetch researchmap API
 * - Build data/counts.json
 * - Build publications/journal-papers.html (journal-only, year-grouped, IEEE style)
 *
 * Node 18+
 */

const fs = require("fs");
const path = require("path");

const RESEARCHMAP_PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";
const OUT_COUNTS_JSON = process.env.OUT_COUNTS
  ? path.resolve(process.env.OUT_COUNTS)
  : path.join("data", "counts.json");

const OUT_JOURNAL_HTML = process.env.OUT_JOURNAL_HTML
  ? path.resolve(process.env.OUT_JOURNAL_HTML)
  : path.join("publications", "journal-papers.html");


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
    // 姓は省略しない
    return normalizeSpaces(`${initials} ${family}`);
  }

  // "Given Middle Family" 形式（researchmapで多い）
  const tokens = name.split(" ").filter(Boolean);
  if (tokens.length === 1) return tokens[0];

  const family = tokens[tokens.length - 1]; // 姓（省略しない）
  const givenTokens = tokens.slice(0, -1);

  // given/middle は頭文字にする
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
      a?.full_name,
      a?.display_name,
      a?.name,
      a?.["rm:display_name"],
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

  // 2) 文字列（author が "A;B;C" などで来るパターン）を拾う
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

  // 3) それでも無理なら、著者っぽいフィールドを最後に探す（超保険）
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

  // type がある場合の保険（researchmapの揺れ対策）
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

  if (/(conference|proceeding|proceedings|symposium|workshop)/.test(typeStr)) return false;
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

  return Boolean(toJournalName(item));
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
 * HTML
 * ========================= */
function buildJournalHtml({ updatedAt, items }) {
  const byYear = new Map();
  for (const it of items) {
    const y = toYear(it);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }

  const years = [...byYear.keys()].sort((a, b) => {
    if (a === "----") return 1;
    if (b === "----") return -1;
    return Number(b) - Number(a);
  });

  let idx = 1;

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

          return `
          <li class="paper">
            <div class="box">
              <span class="num">${idx++}.</span>
              <div class="cite">${cite}${
            url ? ` <a href="${escHtml(url)}" target="_blank">[link]</a>` : ""
          }</div>
            </div>
          </li>`;
        })
        .join("");

      return `
      <section>
        <h2>${y} <span class="badge">${list.length}</span></h2>
        <ol>${lis}</ol>
      </section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8"/>
<title>Journal Papers</title>
<style>
body{font-family:Segoe UI,Noto Sans JP,sans-serif;background:#f3f6fb;margin:0}
header{background:#1e3a8a;color:#fff;padding:40px}
h1{margin:0;font-size:48px}
.wrap{max-width:1200px;margin:0 auto;padding:30px}
.box{background:#fff;border-radius:16px;padding:16px;display:grid;grid-template-columns:40px 1fr;gap:12px;margin:12px 0}
.num{font-weight:800;color:#1e3a8a}
.badge{background:#1e3a8a;color:#fff;padding:6px 12px;border-radius:999px}
</style>
</head>
<body>
<header>
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

/* =========================
 * main
 * ========================= */
async function main() {
  const published = await fetchAllCategory("published_papers");
  const journals = published.filter(isJournalOnly);

  const updatedAt = new Date().toISOString();
  
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

  console.log("Done.");
}

main().catch(console.error);
