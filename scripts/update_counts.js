// scripts/update_counts.js
// Node 18+ (GitHub Actions の setup-node でOK)

const fs = require("fs");
const path = require("path");

const PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";
const OUT_PATH = process.env.OUT_PATH || "data/counts.json";

// 1回で取り切るため大きめ。ただしAPI仕様が変わっても壊れにくいようページングも実装。
const LIMIT = 1000;
const MAX_PAGES = 50;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} for ${url}\n${text.slice(0, 300)}`);
  }
  return res.json();
}

function normalizeItems(json) {
  // APIが「配列」or「{items, _links}」どちらでも対応
  if (Array.isArray(json)) return { items: json, nextHref: null };
  const items = Array.isArray(json.items) ? json.items : [];
  const nextHref = json?._links?.next?.href || null;
  return { items, nextHref };
}

async function fetchAll(category) {
  let url = `https://api.researchmap.jp/${PERMALINK}/${category}?format=json&limit=${LIMIT}&start=1`;
  const all = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await fetchJson(url);
    const { items, nextHref } = normalizeItems(json);

    for (const it of items) {
      const id = it?.["rm:id"] || it?.id || it?.["@id"] || null;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      all.push(it);
    }

    if (!nextHref) break;

    url = nextHref.startsWith("http") ? nextHref : `https://api.researchmap.jp${nextHref}`;

    // 念のため軽く間隔（API負荷対策）
    await sleep(150);
  }

  return all;
}

function toLowerString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.toLowerCase();
  if (typeof v === "number") return String(v).toLowerCase();
  return JSON.stringify(v).toLowerCase();
}

/**
 * published_papers の1件を
 * - journal（論文誌）
 * - intl_conf（国際会議）
 * - other
 * に分類する（researchmap 側の登録が前提）
 *
 * 可能性のあるキー候補を複数見る：
 * - publication_type / paper_type / type / category / genre
 * - journal / conference 名っぽいフィールド
 * - 日本語ラベル（学術雑誌/国際会議/国内会議 等）も拾う
 */
function classifyPublishedPaper(p) {
  const candidates = [
    p.publication_type,
    p.paper_type,
    p.type,
    p.category,
    p.genre,
    p.publicationCategory,
    p.publication_category,
    p.publicationKind,
    p.publication_kind,
    p?.["publication_type"],
    p?.["type"],
  ].map(toLowerString);

  const joined = candidates.join(" | ");

  // journal 判定
  const isJournal =
    joined.includes("journal") ||
    joined.includes("学術雑誌") ||
    joined.includes("論文誌") ||
    joined.includes("journal article") ||
    joined.includes("journal_paper");

  // 国際会議 判定（international + conference/proceedings）
  const isIntlConf =
    joined.includes("international") ||
    joined.includes("国際会議") ||
    joined.includes("international conference") ||
    joined.includes("intl") ||
    joined.includes("proceedings");

  // conference 判定（国際/国内の区別なしで conference とある場合）
  const isConfGeneric = joined.includes("conference") || joined.includes("会議");

  // より具体を優先
  if (isJournal) return "journal";
  if (isIntlConf && isConfGeneric) return "intl_conf";

  // “international” が無くても “国際会議” を拾えていれば上で分類される想定。
  // ここで conference だけの場合は other_conf として扱う（必要なら後で表示追加できる）
  if (isConfGeneric) return "conf_other";

  return "other";
}

async function main() {
  const [publishedPapers, presentations] = await Promise.all([
    fetchAll("published_papers"),
    fetchAll("presentations"),
  ]);

  let journal = 0;
  let intl_conf = 0;
  let conf_other = 0;

  for (const p of publishedPapers) {
    const c = classifyPublishedPaper(p);
    if (c === "journal") journal++;
    else if (c === "intl_conf") intl_conf++;
    else if (c === "conf_other") conf_other++;
  }

  const out = {
    permalink: PERMALINK,
    updatedAt: new Date().toISOString(),
    // totals
    papers_total: publishedPapers.length,
    presentations_total: presentations.length,

    // splits (published_papers 内訳)
    journal,
    intl_conf,
    conf_other,

    // debug (必要なら true にして JSON を見て調整)
    // note: "classification is best-effort; ensure researchmap categories are consistent."
    note:
      "Counts are generated via researchmap API. Journal/intl_conf are best-effort classification based on available fields; keep researchmap categories consistent for accuracy.",
  };

  const outAbs = path.resolve(process.cwd(), OUT_PATH);
  const dir = path.dirname(outAbs);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(out, null, 2) + "\n", "utf8");

  console.log(`Wrote ${OUT_PATH}`);
  console.log(out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
