const ti = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

// ---------- helpers ----------

function cleanCellText(td, turndown) {
  // Convert cell content to inline markdown, then flatten to one line
  let md = turndown.turndown(td.innerHTML || "");
  md = md
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, "<br>")
    .replace(/\s+/g, " ")
    .trim();
  return md;
}

/**
 * Normalize a table in-place so GFM conversion works:
 * - expand colspan/rowspan into duplicated cells
 * - ensure there is a header row (many sites use <td> or no <thead>)
 */
function tableToMarkdown(table, turndown) {
  const grid = [];
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return null;

  rows.forEach((tr, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    Array.from(tr.children).forEach((cell) => {
      if (!/^(TD|TH)$/i.test(cell.tagName)) return;
      while (grid[r][c] !== undefined) c++; // skip cells filled by rowspan
      const colspan = Math.max(1, parseInt(cell.getAttribute("colspan") || "1", 10) || 1);
      const rowspan = Math.max(1, parseInt(cell.getAttribute("rowspan") || "1", 10) || 1);
      const text = cleanCellText(cell, turndown);
      for (let rr = 0; rr < rowspan; rr++) {
        for (let cc = 0; cc < colspan; cc++) {
          grid[r + rr] = grid[r + rr] || [];
          grid[r + rr][c + cc] = text;
        }
      }
      c += colspan;
    });
  });

  const width = Math.max(...grid.map((row) => row.length));
  const norm = grid.map((row) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(row[i] !== undefined ? row[i] : "");
    return out;
  });

  if (norm.length === 0 || width === 0) return null;

  // Decide header: use first row; if the table clearly has no header row
  // (no <th> anywhere in first row), we still promote row 1 — GFM requires one.
  const lines = [];
  lines.push("| " + norm[0].join(" | ") + " |");
  lines.push("| " + Array(width).fill("---").join(" | ") + " |");
  for (let i = 1; i < norm.length; i++) {
    lines.push("| " + norm[i].join(" | ") + " |");
  }
  return lines.join("\n");
}

// ---------- turndown setup ----------

function buildTurndown() {
  const inline = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
  });
  td.use(gfm);

  // Custom table rule: overrides GFM's table handling so that tables
  // without <thead>, with colspan/rowspan, or nested markup still convert.
  td.addRule("robustTable", {
    filter: "table",
    replacement: function (_content, node) {
      // Skip layout tables that contain nested tables — convert inner ones instead
      if (node.querySelector("table")) {
        // treat as container: return children conversion
        return "\n\n" + _content + "\n\n";
      }
      const md = tableToMarkdown(node, inline);
      return md ? "\n\n" + md + "\n\n" : "";
    },
  });

  // Drop noise
  td.remove(["script", "style", "noscript", "iframe", "svg", "form", "button"]);
  return td;
}

function pickContentRoot() {
  const candidates = [
    "article",
    "main",
    '[role="main"]',
    "#content",
    ".post-content",
    ".article-content",
    ".markdown-body",
  ];
  for (const sel of candidates) {
    const el = document.querySelector(sel);
    if (el && el.innerText && el.innerText.trim().length > 200) return el;
  }
  return document.body;
}

function absolutifyUrls(root) {
  root.querySelectorAll("a[href]").forEach((a) => {
    try { a.setAttribute("href", new URL(a.getAttribute("href"), location.href).href); } catch {}
  });
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || img.getAttribute("data-src") || "";
    try { if (src) img.setAttribute("src", new URL(src, location.href).href); } catch {}
  });
}

function convert(scope) {
  const td = buildTurndown();
  const source = scope === "full" ? document.body : pickContentRoot();
  const clone = source.cloneNode(true);
  // strip obvious chrome
  clone.querySelectorAll("nav, header, footer, aside, [role=navigation], .sidebar, .comments, .ad, [class*=advert]").forEach((n) => n.remove());
  absolutifyUrls(clone);

  const title = document.title || "untitled";
  const front = `# ${title}\n\n> ${ti("srcLabel")}: ${location.href}\n> ${ti("fetchedAt")}: ${new Date().toISOString()}\n\n---\n\n`;
  const body = td.turndown(clone.innerHTML).replace(/\n{3,}/g, "\n\n").trim();
  return { title, markdown: front + body + "\n" };
}

// ---------- batch: scan links & merge a whole topic ----------

function scanArticleLinks() {
  // Same-origin links whose path lives under the current directory
  const dir = location.pathname.replace(/[^/]*$/, ""); // e.g. /ai/rag/
  const root = pickContentRoot();
  const seen = new Set();
  const links = [];
  root.querySelectorAll("a[href]").forEach((a) => {
    let u;
    try { u = new URL(a.getAttribute("href"), location.href); } catch { return; }
    if (u.origin !== location.origin) return;
    if (!u.pathname.startsWith(dir)) return;
    if (u.pathname === location.pathname) return;        // the index itself
    if (u.pathname.endsWith("/")) return;                 // sub-directories
    const key = u.origin + u.pathname;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ url: key, title: (a.textContent || "").trim().slice(0, 120) });
  });
  return sortByNumber(links);
}

// Sort articles by their leading number (from title, else filename).
// Non-numbered items (e.g. an intro page) keep document order and go first.
function extractNumber(link) {
  // title like "3. 什么是RAG" / "第3章" / "03 - xxx"
  const t = (link.title || "").match(/^\s*(?:第)?\s*(\d+)/);
  if (t) return parseInt(t[1], 10);
  // filename like "3_whatisrag.html" / "ch03.html" / "12-foo.html"
  const file = link.url.split("/").pop() || "";
  const f = file.match(/^(\d+)[-_.]/) || file.match(/(\d+)/);
  if (f) return parseInt(f[1], 10);
  return null;
}

function sortByNumber(links) {
  const indexed = links.map((l, i) => ({ ...l, _n: extractNumber(l), _i: i }));
  const unnumbered = indexed.filter((l) => l._n === null);
  const numbered = indexed.filter((l) => l._n !== null);
  numbered.sort((a, b) => (a._n - b._n) || (a._i - b._i)); // stable on ties
  return [...unnumbered, ...numbered].map(({ _n, _i, ...l }) => l);
}

async function fetchAndConvert(url, td) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  let src = null;
  for (const sel of ["article", "main", '[role="main"]', "#content", ".theme-hope-content", ".markdown-body"]) {
    const el = doc.querySelector(sel);
    if (el && el.textContent.trim().length > 100) { src = el; break; }
  }
  if (!src) src = doc.body;
  const clone = src.cloneNode(true);
  clone.querySelectorAll("nav, header, footer, aside, [role=navigation], .sidebar, .comments, .ad, [class*=advert], .page-meta, .page-nav").forEach((n) => n.remove());
  clone.querySelectorAll("a[href]").forEach((a) => {
    try { a.setAttribute("href", new URL(a.getAttribute("href"), url).href); } catch {}
  });
  clone.querySelectorAll("img").forEach((img) => {
    const s = img.getAttribute("src") || img.getAttribute("data-src") || "";
    try { if (s) img.setAttribute("src", new URL(s, url).href); } catch {}
  });
  const title = (doc.querySelector("h1")?.textContent || doc.title || url).trim();
  const firstH1 = clone.querySelector("h1");
  if (firstH1) firstH1.remove(); // section heading already carries the title
  const body = td.turndown(clone.innerHTML).replace(/\n{3,}/g, "\n\n").trim();
  return { title, body };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!window.__wp2md_registered) {
window.__wp2md_registered = true;

// Batch state lives in the page, independent of the popup lifecycle.
window.__wp2md_state = window.__wp2md_state || {
  status: "idle",           // idle | running | done | error
  done: 0, total: 0, current: "",
  result: null,             // { title, markdown, chapters }
  error: null,
};
const batchPorts = new Set();

function broadcast(msg) {
  for (const p of batchPorts) { try { p.postMessage(msg); } catch {} }
}

async function runBatch(links) {
  const st = window.__wp2md_state;
  if (st.status === "running") return; // ignore duplicate starts
  st.status = "running"; st.done = 0; st.total = links.length; st.result = null; st.error = null;

  const td = buildTurndown();
  const parts = [];
  const chapters = [];
  const toc = [];
  for (let i = 0; i < links.length; i++) {
    st.done = i; st.current = links[i].title;
    broadcast({ type: "PROGRESS", done: i, total: links.length, current: links[i].title });
    try {
      const { title, body } = await fetchAndConvert(links[i].url, td);
      const anchor = `art-${i + 1}`;
      toc.push(`${i + 1}. [${title.replace(/[\[\]]/g, "")}](#${anchor})`);
      parts.push(`<a id="${anchor}"></a>\n\n## ${title}\n\n> ${ti("srcLabel")}: ${links[i].url}\n\n${body}`);
      chapters.push({ title, markdown: `> ${ti("srcLabel")}: ${links[i].url}\n\n${body}` });
    } catch (e) {
      toc.push(`${i + 1}. ${links[i].title}（${ti("fetchFailed", e.message)}）`);
      parts.push(`## ${links[i].title}\n\n> ${ti("srcLabel")}: ${links[i].url}\n\n*${ti("fetchFailed", e.message)}*`);
      chapters.push({ title: links[i].title, markdown: `> ${ti("srcLabel")}: ${links[i].url}\n\n*${ti("fetchFailed", e.message)}*` });
    }
    // no setTimeout pacing: background tabs throttle timers; serial fetching is pacing enough
  }
  const head =
    `# ${document.title || ti("collectionFallback")}\n\n` +
    `> ${ti("topicSource")}: ${location.href}\n> ${ti("fetchedAt")}: ${new Date().toISOString()}\n> ${ti("totalArticles", links.length)}\n\n` +
    `## ${ti("tocTitle")}\n\n${toc.join("\n")}\n\n---\n\n`;
  st.status = "done"; st.done = links.length;
  st.result = {
    title: document.title || ti("collectionFallback"),
    markdown: head + parts.join("\n\n---\n\n") + "\n",
    chapters,
  };
  broadcast({ type: "DONE", ...st.result });
  try { chrome.runtime.sendMessage({ type: "BATCH_DONE" }); } catch {}
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "batch") return;
  batchPorts.add(port);
  port.onDisconnect.addListener(() => batchPorts.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "SCAN") {
      port.postMessage({ type: "LINKS", links: scanArticleLinks() });
    } else if (msg.type === "RUN") {
      runBatch(msg.links);
    } else if (msg.type === "GET_STATE") {
      const st = window.__wp2md_state;
      port.postMessage({ type: "STATE", status: st.status, done: st.done, total: st.total,
                         current: st.current, result: st.status === "done" ? st.result : null });
    } else if (msg.type === "RESET") {
      window.__wp2md_state = { status: "idle", done: 0, total: 0, current: "", result: null, error: null };
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "CONVERT") {
    try {
      sendResponse({ ok: true, ...convert(msg.scope) });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message || e) });
    }
  }
  return true;
});

} // end __wp2md_registered guard
