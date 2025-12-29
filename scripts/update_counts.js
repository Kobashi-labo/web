// web/scripts/update_counts.js
// Generate data/counts.json + publications pages (journal, intl conf, book chapters)
// + a report of unclassified items.
// Node 20+ recommended.

const fs = require("fs");
const path = require("path");

const PERMALINK = process.env.RESEARCHMAP_PERMALINK || "read0134502";

const OUT_COUNTS = process.env.OUT_COUNTS || "data/counts.json";
const OUT_REPORT = process.env.OUT_REPORT || "data/unclassified_papers.json";

const OUT_JOURNAL_HTML =
  process.env.OUT_JOURNAL_HTML || "publications/journal-papers.html";
const OUT_INTL_CONF_HTML =
  process.env.OUT_INTL_CONF_HTML ||
  "publications/conference-proceeding-papers.html";
const OUT_BOOK_CHAPTERS_HTML =
  process.env.OUT_BOOK_CHAPTERS_HTML || "publications/book-chapters.html";

const LIMIT = 1000;
const MAX_PAGES = 80;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} for ${url}\n${text.slice(0, 500)}`
    );
  }
  return res.json();
}

function normalizeItems(json) {
  // researchmap: sometimes {items:[], _links:{next:{href:""}}}, sometimes array
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
    url = nextHref.startsWith("http")
      ? nextHref
      : `https://api.researchmap.jp${nextHref}`;

    // avoid hammering the API
    await sleep(120);
  }
  return all;
}

function s(v) {
  return v == null ? "" : String(v);
}

function htmlEscape(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function pickTitle(p) {
  // researchmap uses paper_title (object with en/ja) in published_papers
  const t = p?.paper_title || p?.title || p?.name || "";
  if (typeof t === "string") return t;
  if (t?.en) return t.en;
  if (t?.ja) return t.ja;
  // fallback: first string value
  const vals = Object.values(t || {}).filter((x) => typeof x === "string");
  return vals[0] || "";
}

function pickYear(p) {
  // prefer publication_date like "2025-12" or "2025-11-20"
  const d = p?.publication_date || p?.date || p?.year || "";
  const m = String(d).match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function pickAuthors(p) {
  // authors.en: [{name:""}...]
  const a = p?.authors || p?.author || "";
  if (Array.isArray(a)) {
    return a.map((x) => x?.name || x?.text || x).join(", ");
  }
  if (typeof a === "object" && a) {
    const arr =
      a.en || a.ja || Object.values(a).find((v) => Array.isArray(v)) || [];
    if (Array.isArray(arr)) return arr.map((x) => x?.name || x).join(", ");
  }
  return String(a || "");
}

function pickVenue(p) {
  const v = p?.publication_name || p?.journal || p?.conference || p?.publisher;
  if (typeof v === "string") return v;
  if (v?.en) return v.en;
  if (v?.ja) return v.ja;
  const vals = Object.values(v || {}).filter((x) => typeof x === "string");
  return vals[0] || "";
}

function pickLink(p) {
  // Prefer DOI if present
  const doi = p?.identifiers?.doi?.[0];
  if (doi) return `https://doi.org/${doi}`;
  // else: see_also[0].@id
  const sa = Array.isArray(p?.see_also) ? p.see_also : [];
  const id = sa.find((x) => x?.["@id"])?.["@id"];
  return id ? String(id) : "";
}

/**
 * Strict classification (your rule):
 * - Journal Papers: journal only
 * - Conference Proceeding Papers: international conference papers only
 * - Book Chapters: published_paper_type === "in_book"
 *
 * NOTE:
 * researchmap's `published_paper_type` is the most reliable field.
 * Some older entries may miss these fields -> unclassified.
 */
function classifyPublishedPaper(p) {
  const t = p?.published_paper_type ?? null; // e.g., "scientific_journal", "in_book", ...
  if (t === "scientific_journal") return "journal";
  if (t === "in_book") return "book_chapter";

  // conference (heuristic for typical researchmap values)
  // Examples in researchmap ecosystems often contain "conference" or "proceedings"
  if (typeof t === "string") {
    const low = t.toLowerCase();
    const looksConf = low.includes("conference") || low.includes("proceeding");
    if (looksConf) {
      // "international" judgement:
      // prefer explicit boolean field if present (sometimes for journals only),
      // otherwise use `is_international_collaboration` or language/venue hints are too weak.
      // So: if you classify intl_conf in researchmap itself, it should appear here;
      // otherwise keep unclassified for safety.
      const isIntlFlag = p?.is_international_conference ?? null; // if ever exists
      if (isIntlFlag === true) return "intl_conf";

      // fallback: published_paper_type contains "international"
      if (low.includes("international")) return "intl_conf";

      return "other";
    }
  }

  // Some records don't have published_paper_type but still have journal flags:
  // Keep journal strict: require scientific_journal only (per your instruction).
  return "other";
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(path.resolve(process.cwd(), filePath)), {
    recursive: true,
  });
}
function writeJson(filePath, obj) {
  ensureDir(filePath);
  fs.writeFileSync(
    path.resolve(process.cwd(), filePath),
    JSON.stringify(obj, null, 2) + "\n",
    "utf8"
  );
}
function writeText(filePath, text) {
  ensureDir(filePath);
  fs.writeFileSync(path.resolve(process.cwd(), filePath), text, "utf8");
}

function renderPage({ title, subtitle, items, updatedAtIso, backHref }) {
  const updated = new Date(updatedAtIso).toISOString().slice(0, 10);

  const byYear = new Map();
  for (const it of items) {
    const y = pickYear(it) || "Unknown";
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(it);
  }
  const years = Array.from(byYear.keys()).sort((a, b) => {
    if (a === "Unknown" && b !== "Unknown") return 1;
    if (b === "Unknown" && a !== "Unknown") return -1;
    return b.localeCompare(a);
  });

  const sections = years
    .map((y) => {
      const lis = byYear
        .get(y)
        .map((p) => {
          const t = htmlEscape(pickTitle(p) || "");
          const au = htmlEscape(pickAuthors(p) || "");
          const ve = htmlEscape(pickVenue(p) || "");
          const link = pickLink(p);
          const linkHtml = link
            ? ` <a href="${htmlEscape(
                link
              )}" target="_blank" rel="noopener noreferrer">[link]</a>`
            : "";
          return `<li><div class="t">${t}</div><div class="m">${au}${
            au && ve ? " — " : ""
          }${ve}</div>${linkHtml}</li>`;
        })
        .join("\n");
      return `<section class="year"><h2>${htmlEscape(
        y
      )} <span class="badge">${byYear.get(y).length}</span></h2><ol>${lis}</ol></section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${htmlEscape(title)} | Kobashi Laboratory</title>
  <style>
    :root{--bg:#f7f7fb;--card:#fff;--ink:#222;--muted:#666;--brand:#1e3a8a;--shadow:0 10px 30px rgba(0,0,0,.10);--r:16px;}
    body{margin:0;font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;line-height:1.75;background:var(--bg);color:var(--ink);}
    header{background:var(--brand);color:#fff;padding:22px 18px;}
    header .wrap{max-width:1100px;margin:0 auto;display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap;}
    h1{margin:0;font-size:22px;}
    .sub{margin:4px 0 0;font-size:13px;opacity:.9}
    .nav a{color:#fff;text-decoration:none;border:1px solid rgba(255,255,255,.35);padding:8px 12px;border-radius:999px;font-size:13px}
    .nav a:hover{background:rgba(255,255,255,.12)}
    main{max-width:1100px;margin:0 auto;padding:22px 18px 60px;}
    .card{background:var(--card);border-radius:var(--r);box-shadow:var(--shadow);padding:18px 20px;margin:14px 0;}
    .meta{color:var(--muted);font-size:13px}
    .year h2{margin:18px 0 10px;font-size:18px;color:var(--brand);display:flex;align-items:center;gap:10px;}
    .badge{font-size:12px;color:#fff;background:var(--brand);padding:4px 10px;border-radius:999px;opacity:.9}
    ol{margin:0;padding-left:20px}
    li{margin:10px 0}
    .t{font-weight:700}
    .m{color:var(--muted);font-size:14px;margin-top:2px}
    a{color:var(--brand)}
    footer{text-align:center;color:var(--muted);font-size:12px;padding:18px}
    @media print{header,.nav,footer{display:none} body{background:#fff} .card{box-shadow:none;border:1px solid #ddd}}
  </style>
</head>
<body>
<header>
  <div class="wrap">
    <div>
      <h1>${htmlEscape(title)}</h1>
      <p class="sub">${htmlEscape(subtitle)}</p>
    </div>
    <div class="nav">
      <a href="${htmlEscape(backHref)}">← Publications に戻る</a>
    </div>
  </div>
</header>

<main>
  <div class="card">
    <p class="meta">Updated: ${updated} / Items: ${items.length}</p>
    <p class="meta">Source: researchmap API (generated daily via GitHub Actions)</p>
  </div>

  ${sections}
</main>

<footer>© 2025 Kobashi Laboratory, University of Hyogo</footer>
</body>
</html>`;
}

async function main() {
  const [published, presentations] = await Promise.all([
    fetchAll("published_papers"),
    fetchAll("presentations"),
  ]);

  const journalItems = [];
  const intlConfItems = [];
  const bookChapterItems = [];
  const unclassified = [];

  for (const p of published) {
    const kind = classifyPublishedPaper(p);

    if (kind === "journal") journalItems.push(p);
    else if (kind === "intl_conf") intlConfItems.push(p);
    else if (kind === "book_chapter") bookChapterItems.push(p);
    else {
      // keep only those that look relevant but missing info (avoid spamming)
      // (If you want ALL "other", remove this condition)
      const hasSomeSignal =
        p?.published_paper_type == null ||
        p?.is_international_journal == null ||
        p?.referee == null;
      if (hasSomeSignal) {
        unclassified.push({
          id: p?.["rm:id"] || "",
          year: pickYear(p) || "",
          title: { en: pickTitle(p) || "" },
          raw_type_fields: {
            published_paper_type: p?.published_paper_type ?? null,
            is_international_journal: p?.is_international_journal ?? null,
            referee: p?.referee ?? null,
          },
        });
      }
    }
  }

  const updatedAt = new Date().toISOString();

  // counts.json
  writeJson(OUT_COUNTS, {
    permalink: PERMALINK,
    updatedAt,
    papers_total: published.length,
    presentations_total: presentations.length,
    journal: journalItems.length, // journal papers only
    intl_conf: intlConfItems.length, // international conference papers only
    book_chapters: bookChapterItems.length, // in_book
    note:
      "Journal = journal papers only. Conference = international conference papers only. Book Chapters = in_book. Generated daily by GitHub Actions.",
  });

  // pages
  writeText(
    OUT_JOURNAL_HTML,
    renderPage({
      title: "Journal Papers",
      subtitle: "論文誌（Journal papers only）",
      items: journalItems,
      updatedAtIso: updatedAt,
      backHref: "../index.html#publications",
    })
  );

  writeText(
    OUT_INTL_CONF_HTML,
    renderPage({
      title: "Conference Proceeding Papers",
      subtitle: "国際会議論文（International conference papers only）",
      items: intlConfItems,
      updatedAtIso: updatedAt,
      backHref: "../index.html#publications",
    })
  );

  writeText(
    OUT_BOOK_CHAPTERS_HTML,
    renderPage({
      title: "Book Chapters",
      subtitle: "Book chapters（published_paper_type = in_book）",
      items: bookChapterItems,
      updatedAtIso: updatedAt,
      backHref: "../index.html#publications",
    })
  );

  // report
  writeJson(OUT_REPORT, {
    permalink: PERMALINK,
    updatedAt,
    unclassified_count: unclassified.length,
    unclassified,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        permalink: PERMALINK,
        updatedAt,
        papers_total: published.length,
        presentations_total: presentations.length,
        journal: journalItems.length,
        intl_conf: intlConfItems.length,
        book_chapters: bookChapterItems.length,
        unclassified_count: unclassified.length,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
