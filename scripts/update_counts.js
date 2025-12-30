/**
 * scripts/update_counts.js (updated)
 *
 * Changes:
 * - Review Articles defined as: invited=true AND referee is NOT true
 * - Save raw researchmap data for debug
 */

const fs = require("fs");
const path = require("path");

const RESEARCHMAP_PERMALINK = process.env.RESEARCHMAP_PERMALINK || "";
const RESEARCHMAP_API_KEY = process.env.RESEARCHMAP_API_KEY || "";

const OUT_COUNTS_JSON = process.env.OUT_COUNTS
  ? path.resolve(process.env.OUT_COUNTS)
  : path.join("data", "counts.json");

const OUT_JOURNAL_HTML = process.env.OUT_JOURNAL_HTML
  ? path.resolve(process.env.OUT_JOURNAL_HTML)
  : path.join("publications", "journal-papers.html");

const OUT_REVIEW_HTML = process.env.OUT_REVIEW_HTML
  ? path.resolve(process.env.OUT_REVIEW_HTML)
  : path.join("publications", "review-articles.html");

const OUT_RAW_JSON = process.env.OUT_RAW_JSON
  ? path.resolve(process.env.OUT_RAW_JSON)
  : path.join("data", "researchmap_raw.json");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeSpaces(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function pickLangText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return "";
  if (typeof v === "object") {
    if (v.ja && !Array.isArray(v.ja)) return String(v.ja);
    if (v.en && !Array.isArray(v.en)) return String(v.en);
  }
  return "";
}

function truthy01(v) {
  const s = normalizeSpaces(pickLangText(v)).toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...(RESEARCHMAP_API_KEY ? { "X-API-KEY": RESEARCHMAP_API_KEY } : {}),
    },
  });
  if (!res.ok) throw new Error("fetch failed");
  return res.json();
}

async function fetchAllItems(baseUrl) {
  const all = [];
  let url = baseUrl;
  for (let i = 0; i < 50 && url; i++) {
    const json = await fetchJson(url);
    const items = json?.items ?? [];
    all.push(...items);
    url = json?.next;
    if (url && !url.startsWith("http")) {
      url = `https://api.researchmap.jp${url}`;
    }
    await sleep(200);
  }
  return all;
}

function isJournalPaper(item) {
  const refereeVal = item?.referee ?? item?.raw_type_fields?.referee;
  return truthy01(refereeVal);
}

function isReviewArticle(item) {
  const invitedVal =
    item?.invited ??
    item?.is_invited ??
    item?.invited_paper ??
    item?.raw_type_fields?.invited ??
    item?.raw_type_fields?.is_invited;

  const refereeVal =
    item?.referee ??
    item?.raw_type_fields?.referee;

  const isInvited = truthy01(invitedVal);
  const isRefereed = truthy01(refereeVal);

  return isInvited && !isRefereed;
}

async function main() {
  if (!RESEARCHMAP_PERMALINK) {
    throw new Error("RESEARCHMAP_PERMALINK is empty");
  }

  const base = `https://api.researchmap.jp/${encodeURIComponent(
    RESEARCHMAP_PERMALINK
  )}/published_papers?per_page=200`;

  const updatedAt = new Date().toISOString();
  const published = await fetchAllItems(base);

  ensureDir(path.dirname(OUT_RAW_JSON));
  fs.writeFileSync(
    OUT_RAW_JSON,
    JSON.stringify(
      {
        permalink: RESEARCHMAP_PERMALINK,
        fetchedAt: updatedAt,
        total: published.length,
        items: published,
      },
      null,
      2
    )
  );

  const reviews = published.filter(isReviewArticle);
  const journals = published
    .filter(isJournalPaper)
    .filter((it) => !isReviewArticle(it));

  ensureDir(path.dirname(OUT_COUNTS_JSON));
  fs.writeFileSync(
    OUT_COUNTS_JSON,
    JSON.stringify(
      {
        permalink: RESEARCHMAP_PERMALINK,
        updatedAt,
        journal: journals.length,
        reviews: reviews.length,
      },
      null,
      2
    )
  );

  console.log("journal =", journals.length);
  console.log("reviews =", reviews.length);
}

main().catch(console.error);
