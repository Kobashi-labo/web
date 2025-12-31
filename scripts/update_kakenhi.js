/**
 * scripts/update_kakenhi.js
 *
 * Generate:
 *   - data/kakenhi.json
 *
 * Source:
 *   - NRID page (project list): https://nrid.nii.ac.jp/ja/nrid/1000000332966/
 *   - KAKEN project pages: https://kaken.nii.ac.jp/ja/grant/KAKENHI-PROJECT-xxxx/
 *
 * Notes:
 * - Intended to be run in GitHub Actions (Node 18+), where fetch is available.
 * - Outputs minimal fields used by index.html:
 *   {
 *     source, updatedAt,
 *     projects: [{ kakenUrl, kakenNo, titleJa, titleEn, fromYear, toYear, collaborators:[{name, affiliation, nrid}] }]
 *   }
 */

const fs = require("fs");
const path = require("path");

const NRID_URL = process.env.NRID_URL || "https://nrid.nii.ac.jp/ja/nrid/1000000332966/";
const OUT = process.env.OUT_KAKENHI
  ? path.resolve(process.env.OUT_KAKENHI)
  : path.join("data", "kakenhi.json");

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return await res.text();
}

function uniq(arr) {
  return [...new Set(arr)];
}

function parseProjectIdsFromNrid(html) {
  // Extract KAKEN project ids from NRID page.
  // Example: https://kaken.nii.ac.jp/ja/grant/KAKENHI-PROJECT-23K11253/
  const re = /https:\/\/kaken\.nii\.ac\.jp\/ja\/grant\/(KAKENHI-PROJECT-[0-9A-Z]+)\/?/g;
  const ids = [];
  let m;
  while ((m = re.exec(html))) ids.push(m[1]);
  return uniq(ids);
}

function pickTitleFromH1(html) {
  const m = html.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/);
  return m ? m[1].trim() : "";
}

function parseKakenNo(html) {
  // Try to find 8-char grant number like 23K11253.
  const m =
    html.match(/研究課題\/領域番号[^0-9A-Z]*([0-9A-Z]{8})/) ||
    html.match(/Grant Number[^0-9A-Z]*([0-9A-Z]{8})/i);
  return m ? m[1] : "";
}

function parsePeriodYears(html) {
  // Try to capture year range from date strings.
  const m = html.match(/研究期間[^0-9]*([0-9]{4})-[0-9]{2}-[0-9]{2}[\s\S]{0,60}?([0-9]{4})-[0-9]{2}-[0-9]{2}/);
  if (!m) return { fromYear: null, toYear: null };
  return { fromYear: Number(m[1]), toYear: Number(m[2]) };
}

function parseCollaborators(html) {
  // Best-effort: pull "研究分担者" block and extract affiliation lines.
  const collaborators = [];

  const idx = html.indexOf("研究分担者");
  if (idx < 0) return collaborators;

  const block = html.slice(idx, idx + 20000); // guard window
  // Pattern often includes: <a ...>Name</a> ... Affiliation ... (NRID)
  const re = /<a[^>]+nrid[^>]+>\s*([^<]+)\s*<\/a>[\s\S]{0,200}?([^<]+?)\s*\((\d+)\)/g;

  let m;
  while ((m = re.exec(block))) {
    const name = m[1].trim();
    const affiliation = m[2].trim();
    const nrid = m[3].trim();
    collaborators.push({ name, affiliation, nrid });
  }
  return collaborators;
}

async function main() {
  const nridHtml = await fetchText(NRID_URL);
  const projectIds = parseProjectIdsFromNrid(nridHtml);

  const projects = [];
  for (const pid of projectIds) {
    const kakenUrl = `https://kaken.nii.ac.jp/ja/grant/${pid}/`;
    const html = await fetchText(kakenUrl);

    const titleJa = pickTitleFromH1(html);
    const kakenNo = parseKakenNo(html);
    const { fromYear, toYear } = parsePeriodYears(html);
    const collaborators = parseCollaborators(html);

    projects.push({
      kakenUrl,
      kakenNo,
      titleJa,
      titleEn: "",
      fromYear,
      toYear,
      collaborators
    });
  }

  const out = {
    source: NRID_URL,
    updatedAt: new Date().toISOString(),
    projects
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf-8");
  console.log(`Wrote ${OUT} (${projects.length} projects)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
