/**
 * Update researchmap counts + generate pages
 *
 * Env:
 *  - RESEARCHMAP_PERMALINK (e.g., read0134502)
 *  - OUT_PATH (e.g., data/counts.json)
 *
 * Outputs:
 *  - counts.json
 *  - publications/journal-papers.html
 *  - publications/conference-proceeding-papers.html
 *  - publications/book-chapters.html
 *  - data/unclassified_papers.json
 */

import fs from "node:fs";
import path from "node:path";

const PERMALINK = process.env.RESEARCHMAP_PERMALINK;
const OUT_PATH = process.env.OUT_PATH || "data/counts.json";

if (!PERMALINK) {
  console.error("Missing env: RESEARCHMAP_PERMALINK");
  process.exit(1);
}

const API_BASE = "https://api.researchmap.jp";

// --- helpers ---
function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function toInt(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function getTitle(obj) {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  return obj.ja || obj.en || "";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeYear(rec) {
  // publication_date: "2025-12" or "2025-11-20"
  const pd = rec?.publication_date;
  if (typeof pd === "string" && pd.length >= 4) return pd.slice(0, 4);
  // fallback: sometimes there is "rm:created" etc.
  const created = rec?.["rm:created"];
  if (typeof created === "string" && created.length >= 4) return created.slice(0, 4);
  return "";
}

function getTypeFields(rec) {
  // direct fields (newer) + raw fallback (older/partial)
  const t = rec?.published_paper_type ?? rec?.raw_type_fields?.published_paper_type ?? null;
  const intl = rec?.is_international_journal ?? rec?.raw_type_fields?.is_international_journal ?? null;
  const ref = rec?.referee ?? rec?.raw_type_fields?.referee ?? null;
  return { published_paper_type: t, is_international_journal: intl, referee: ref };
}

/**
 * researchmap API sometimes supports pagination.
 * We'll try: ?page=1&per_page=200 then loop until empty.
 */
async function fetchAll(endpoint) {
  const perPage = 200;
  let page = 1;
  const all = [];

  while (true) {
    const url = `${API_BASE}/${PERMALINK}/${endpoint}?page=${page}&per_page=${perPage}`;
    const res = await fetch(url, {
      headers: { Accept: "application/ld+json, application/json" },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Fetch failed: ${url} -> ${res.status} ${res.statusText}\n${text}`);
    }

    const data = await res.json();

    // API returns array (JSON-LD list) in practice
    if (!Array.isArray(data) || data.length === 0) break;

    all.push(...data);

    if (data.length < perPage) break;
    page += 1;
  }

  return all;
}

// --- HTML generation ---
function renderPublicationPage({ title, items }) {
  // group by year desc
  const groups = new Map(); // year -> items
  for (const it of items) {
    const y = it.year || "Unknown";
    if (!groups.has(y)) groups.set(y, []);
    groups.get(y).push(it);
  }

  const years = Array.from(groups.keys()).sort((a, b) => {
    // numeric desc, Unknown last
    if (a === "Unknown") return 1;
    if (b === "Unknown") return -1;
    return toInt(b, 0) - toInt(a, 0);
  });

  const body = years
    .map((y) => {
      const lis = groups
        .get(y)
        .map((it) => {
          const t = escapeHtml(it.title);
          const pub = it.pub ? ` <span class="pub">(${escapeHtml(it.pub)})</span>` : "";
          const doi = it.doi
            ? ` <a class="doi" href="${escapeHtml(it.doi)}" target="_blank" rel="noopener">doi</a>`
            : "";
          return `<li>${t}${pub}${doi}</li>`;
        })
        .join("\n");
      return `<section class="year-block"><h2>${escapeHtml(y)}</h2><ul>${lis}</ul></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | Kobashi Laboratory</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,'Noto Sans JP',sans-serif;line-height:1.7;margin:0;background:#f7fafc;color:#111827}
  header{background:#1e3a8a;color:#fff;padding:24px 16px}
  header a{color:#bfdbfe;text-decoration:none}
  .container{max-width:980px;margin:0 auto;padding:24px 16px}
  h1{margin:0;font-size:24px}
  .meta{opacity:.9;margin-top:6px}
  .year-block{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:16px 0}
  .year-block h2{margin:0 0 12px 0;font-size:18px;color:#1e3a8a}
  ul{margin:0;padding-left:18px}
  li{margin:8px 0}
  .pub{color:#6b7280}
  .doi{margin-left:6px;font-size:12px;color:#2563eb}
  footer{padding:24px 16px;text-align:center;color:#6b7280}
</style>
</head>
<body>
<header>
  <div class="container">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta"><a href="../index.html">← Back to Home</a></div>
  </div>
</header>
<main class="container">
${body || "<p>No items.</p>"}
</main>
<footer>© 2025 Kobashi Laboratory, University of Hyogo</footer>
</body>
</html>`;
}

// --- main ---
(async () => {
  try {
    // fetch
    const papers = await fetchAll("published_papers");
    const presentations = await fetchAll("presentations");

    const papers_total = papers.length;
    const presentations_total = presentations.length;

    // classify
    const journalItems = [];
    const confItems = [];
    const bookItems = [];
    const unclassified = [];

    for (const rec of papers) {
      const { published_paper_type, referee } = getTypeFields(rec);
      const year = normalizeYear(rec) || "";
      const title = getTitle(rec.paper_title);
      const pub = getTitle(rec.publication_name);
      const doiRaw = rec?.identifiers?.doi?.[0];
      const doi = doiRaw ? `https://doi.org/${doiRaw}` : null;

      // 1) Book Chapters: in_book を必ずカウント
      if (published_paper_type === "in_book") {
        bookItems.push({ year, title, pub, doi });
        continue;
      }

      // 2) Journal papers = 論文誌のみ（scientific_journal）※査読フラグは true のものを採用
      if (published_paper_type === "scientific_journal" && referee === true) {
        journalItems.push({ year, title, pub, doi });
        continue;
      }

      // 3) International conference papers = 国際会議論文のみ
      // researchmap 側の表現ゆれに備えて複数候補を許可
      const confTypes = new Set([
        "international_conference_paper",
        "international_conference",
        "conference_paper",
        "conference_proceedings",
      ]);

      if (published_paper_type && confTypes.has(published_paper_type) && referee === true) {
        confItems.push({ year, title, pub, doi });
        continue;
      }

      // 4) 判定不能（null含む）だけ unclassified に残す（修正対象として使う）
      // type があるが対象外（symposium / research_society 等）は unclassified にしない
      if (published_paper_type == null || referee == null) {
        unclassified.push({
          id: rec?.["rm:id"] || rec?.id || "",
          year: year || "",
          title: rec?.paper_title || {},
          raw_type_fields: getTypeFields(rec),
        });
      }
    }

    // sort (newest first within year)
    const sortByYearDesc = (a, b) => toInt(b.year, 0) - toInt(a.year, 0);
    journalItems.sort(sortByYearDesc);
    confItems.sort(sortByYearDesc);
    bookItems.sort(sortByYearDesc);

    // write counts.json
    const out = {
      permalink: PERMALINK,
      updatedAt: new Date().toISOString(),
      papers_total,
      presentations_total,
      journal: journalItems.length,
      intl_conf: confItems.length,
      book_chapters: bookItems.length,
      note: "Journal = journal papers only (scientific_journal & referee=true). Conference = international conference papers only. Book chapters = in_book. Generated daily by GitHub Actions.",
    };

    ensureDir(OUT_PATH);
    fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf-8");

    // write unclassified
    const unclassifiedPath = "data/unclassified_papers.json";
    ensureDir(unclassifiedPath);
    fs.writeFileSync(
      unclassifiedPath,
      JSON.stringify(
        {
          permalink: PERMALINK,
          updatedAt: out.updatedAt,
          unclassified_count: unclassified.length,
          unclassified,
        },
        null,
        2
      ),
      "utf-8"
    );

    // generate pages
    const journalHtml = renderPublicationPage({
      title: "Journal Papers (Refereed journals only)",
      items: journalItems,
    });
    const confHtml = renderPublicationPage({
      title: "Conference Proceeding Papers (International conferences only)",
      items: confItems,
    });
    const bookHtml = renderPublicationPage({
      title: "Book Chapters",
      items: bookItems,
    });

    const journalPath = "publications/journal-papers.html";
    const confPath = "publications/conference-proceeding-papers.html";
    const bookPath = "publications/book-chapters.html";

    ensureDir(journalPath);
    ensureDir(confPath);
    ensureDir(bookPath);

    fs.writeFileSync(journalPath, journalHtml, "utf-8");
    fs.writeFileSync(confPath, confHtml, "utf-8");
    fs.writeFileSync(bookPath, bookHtml, "utf-8");

    console.log("Done.");
    console.log(out);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
