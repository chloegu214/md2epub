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

// ---------- site-specific handlers ----------
//
// Some platforms render their table of contents and lesson bodies in a way the
// generic scanner mishandles (truncated titles, wrong content root, JS-driven
// nav links). Each entry below plugs in a custom scanner + fetcher for one such
// site. `match(loc)` decides if the handler applies to the current page.

const SITE_HANDLERS = [
  {
    // Skilljar course platform (e.g. anthropic-partners.skilljar.com).
    // The curriculum lives in <a class="lesson"> wrappers whose full titles sit
    // in the child .lesson-row (the anchor text itself is polluted with icon /
    // completion labels). Lesson bodies render inside #lesson-main-inner.
    name: "skilljar",
    match: (loc) => /(^|\.)skilljar\.com$/i.test(loc.hostname),
    scan: () => {
      const seen = new Set();
      const links = [];
      document.querySelectorAll("a.lesson[href]").forEach((a) => {
        let u;
        try { u = new URL(a.getAttribute("href"), location.href); } catch { return; }
        if (u.origin !== location.origin) return;
        const key = u.origin + u.pathname;
        if (seen.has(key)) return;
        seen.add(key);
        const row = a.querySelector(".lesson-row");
        const title = (
          row?.getAttribute("title") ||
          row?.querySelector(".title")?.textContent ||
          a.textContent ||
          ""
        ).replace(/\s+/g, " ").trim().slice(0, 200);
        links.push({ url: key, title });
      });
      return links; // keep DOM order — it is the curriculum order
    },
    // Extract a single lesson from already-fetched HTML.
    extract: (doc, url, hint) => {
      let src = doc.querySelector("#lesson-main-inner") || doc.querySelector("#lesson-main") || doc.body;
      const clone = src.cloneNode(true);
      clone.querySelectorAll("#open-details-pane-button, .details-pane, nav, header, footer, script, style, noscript").forEach((n) => n.remove());
      // Turn embedded players (YouTube etc.) into a plain link so they survive as markdown.
      clone.querySelectorAll("iframe").forEach((fr) => {
        const s = fr.getAttribute("src") || fr.getAttribute("data-src") || "";
        const p = doc.createElement("p");
        if (s) {
          try { p.innerHTML = `🎬 <a href="${new URL(s, url).href}">${new URL(s, url).href}</a>`; }
          catch { p.textContent = `🎬 ${s}`; }
        }
        fr.replaceWith(p);
      });
      const title = (
        hint ||
        doc.querySelector(".lesson-row.lesson-active .title, .lesson-row.lesson-active")?.textContent ||
        doc.title ||
        url
      ).replace(/\s+/g, " ").trim();
      return { clone, title };
    },
  },
  {
    // Mintlify-hosted docs (modelcontextprotocol.io, docs.anthropic.com, ...).
    // Every page is also served as clean Markdown at the same path + ".md", so
    // we skip the HTML→turndown round trip entirely and fetch the source instead.
    // The sidebar (#navigation-items) already lists the pages in reading order.
    name: "mintlify",
    match: () =>
      !!document.querySelector('meta[name="generator"][content="Mintlify" i]') ||
      (!!document.querySelector("#navigation-items") &&
        !!document.querySelector('link[rel="alternate"][type="text/markdown"]')),
    scan: () => {
      const nav = document.querySelector("#navigation-items") || document.querySelector("#sidebar-content");
      if (!nav) return [];
      const seen = new Set();
      const links = [];
      nav.querySelectorAll("a[href]").forEach((a) => {
        let u;
        try { u = new URL(a.getAttribute("href"), location.href); } catch { return; }
        if (u.origin !== location.origin) return;
        const key = u.origin + u.pathname.replace(/\/$/, "");
        if (seen.has(key)) return;
        seen.add(key);
        links.push({ url: key, title: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) });
      });
      return links; // DOM order is the documented reading order
    },
    // Fetch the Markdown source directly; returns null so the caller can fall
    // back to HTML scraping if this page has no .md twin.
    fetchMarkdown: async (url, hint) => {
      const res = await fetch(url.replace(/\/$/, "") + ".md", { credentials: "include" });
      if (!res.ok) return null;
      if (!/text\/(markdown|plain)/i.test(res.headers.get("content-type") || "")) return null;
      return cleanMintlifyMarkdown(await res.text(), hint, url);
    },
  },
  {
    // MkDocs Material sites (bojieli.github.io/ai-agent-book and many OSS docs).
    // The left sidebar holds the whole page tree in reading order. Each page also
    // links to its Markdown source on GitHub via the "edit this page" button —
    // fetching that beats scraping the rendered HTML, whose code blocks are
    // line-number tables that turndown flattens into unreadable pipes.
    name: "mkdocs-material",
    match: () =>
      /mkdocs-material/i.test(
        document.querySelector('meta[name="generator"]')?.getAttribute("content") || ""
      ),
    scan: () => {
      const nav = document.querySelector(".md-nav--primary");
      if (!nav) return [];
      const seen = new Set();
      const links = [];
      nav.querySelectorAll("a.md-nav__link[href]").forEach((a) => {
        const href = a.getAttribute("href") || "";
        if (href.startsWith("#")) return; // headings of the page being viewed
        let u;
        try { u = new URL(href, location.href); } catch { return; }
        if (u.origin !== location.origin) return;
        const key = u.origin + u.pathname;
        if (seen.has(key)) return;
        seen.add(key);
        // Nested spans carry icons; textContent alone is the readable label.
        const title = (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
        links.push({ url: key, title });
      });
      return links; // sidebar order is the authored reading order
    },
    // The edit button points at /edit/<branch>/<path>.md in the source repo; its
    // /raw/ twin is the original Markdown. Returns null when a page has no such
    // link (edit_uri disabled) so the caller falls back to HTML scraping.
    extractMarkdown: async (doc, url, hint) => {
      const href = [...doc.querySelectorAll('a[href*="github.com/"]')]
        .map((a) => a.getAttribute("href") || "")
        .find((h) => /\/(edit|raw|blob)\/[^/]+\/.+\.md$/i.test(h));
      if (!href) return null;
      const raw = href.replace(/\/(edit|blob)\//, "/raw/");
      const res = await fetch(raw);
      if (!res.ok) return null;
      const text = await res.text();
      if (/^\s*<(!doctype|html)\b/i.test(text)) return null; // a login/404 page
      return cleanPandocMarkdown(text, hint, raw);
    },
    // Fallback: the rendered article, minus Material's page furniture.
    extract: (doc, url, hint) => {
      const src = doc.querySelector(".md-content__inner") || doc.querySelector("article") || doc.body;
      const clone = src.cloneNode(true);
      clone.querySelectorAll(
        ".md-content__button, .headerlink, .md-source-file, .md-feedback, .md-nav, nav, script, style"
      ).forEach((n) => n.remove());
      // Line-numbered code renders as a two-column table; keep only the code.
      clone.querySelectorAll("table.highlighttable, table.highlight").forEach((t) => {
        const code = t.querySelector("td.code pre, .code pre");
        if (code) t.replaceWith(code);
      });
      const title = (hint || clone.querySelector("h1")?.textContent || doc.title || url)
        .replace(/\s+/g, " ").trim();
      clone.querySelector("h1")?.remove(); // the chapter heading already carries it
      return { clone, title };
    },
  },
];

// MDX containers whose body is meaningful but whose tag is not. Titled ones keep
// their title as a bold lead-in; the rest just vanish.
const MDX_PLAIN = "Frame|CodeGroup|Tabs|CardGroup|Steps|AccordionGroup|Columns|Expandable|Tooltip|Update";
const MDX_TITLED = "Tab|Step|Accordion|ResponseField|ParamField|Card";
const MDX_CALLOUT = "Note|Tip|Info|Warning|Danger|Check";

/**
 * Turn Mintlify's Markdown source into something an e-reader can render:
 * drop the boilerplate preamble, unwrap MDX components, and absolutify links.
 *
 * Done line by line rather than with whole-document regexes because components
 * wrap fenced code blocks (so open/close tags sit far apart) and because their
 * bodies are indented — left alone, that indentation reads as a code block.
 */
function cleanMintlifyMarkdown(raw, hint, pageUrl) {
  let md = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  md = md.replace(/^---\n[\s\S]*?\n---\n/, "");   // YAML frontmatter
  md = md.replace(/^(?:>[^\n]*\n)+\n/, "");        // "Documentation Index" preamble

  // The first H1 names the chapter; the merged document adds its own heading.
  let title = (hint || "").trim();
  md = md.replace(/^#\s+(.+?)\n+/, (_m, h1) => { if (!title) title = h1.trim(); return ""; });

  const open = new RegExp(`^\\s*<(${MDX_PLAIN}|${MDX_TITLED}|${MDX_CALLOUT})\\b([^>]*?)(/?)>\\s*$`);
  const close = new RegExp(`^\\s*</(${MDX_PLAIN}|${MDX_TITLED}|${MDX_CALLOUT})>\\s*$`);
  const stack = [];                                 // one entry per open container
  const out = [];
  let inFence = false;

  for (const line of md.split("\n")) {
    const dedented = stack.length ? line.replace(new RegExp(`^ {1,${stack.length * 2}}`), "") : line;
    if (/^\s*(```|~~~)/.test(dedented)) inFence = !inFence;

    // Everything inside a callout is quoted, so it survives as one block.
    const quoted = (text) =>
      stack.some((t) => new RegExp(`^(${MDX_CALLOUT})$`).test(t))
        ? text.split("\n").map((l) => (l ? "> " + l : ">")).join("\n")
        : text;

    if (!inFence) {
      const c = dedented.match(close);
      if (c) { stack.pop(); out.push(""); continue; }
      const o = dedented.match(open);
      if (o) {
        const [, tag, attrs, selfClosing] = o;
        const lead = quoted(mdxLeadIn(tag, attrs, pageUrl));
        if (!selfClosing) stack.push(tag);
        out.push(lead);
        continue;
      }
    }
    out.push(quoted(inFence ? dedented : inlineMdx(dedented, pageUrl)));
  }

  const body = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title: title || "untitled", body };
}

// The text a container's opening tag leaves behind.
function mdxLeadIn(tag, attrs, pageUrl) {
  const attr = (name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] || "";
  if (new RegExp(`^(${MDX_CALLOUT})$`).test(tag)) return `\n> **${tag}**`;
  const title = attr("title");
  if (!title) return "";
  const href = attr("href");
  return href ? `\n**[${title}](${absolutify(href, pageUrl)})**\n` : `\n**${title}**\n`;
}

// Tags and links that appear mid-line.
function inlineMdx(line, pageUrl) {
  return line
    .replace(/<img\b[^>]*?\bsrc="([^"]*)"[^>]*?\/?>/g, (_m, src) => `![](${absolutify(src, pageUrl)})`)
    .replace(new RegExp(`</?(${MDX_PLAIN}|${MDX_TITLED}|${MDX_CALLOUT}|Icon|Badge|Snippet)\\b[^>]*?/?>`, "g"), "")
    .replace(/(\]\()(\/[^)\s]*)(\))/g, (_m, a, href, b) => a + absolutify(href, pageUrl) + b);
}

// Resolve every non-absolute target — including directory-relative ones like
// "images/fig1-1.svg" — against the file the Markdown came from.
function resolveAgainst(target, sourceUrl) {
  if (!sourceUrl || /^(https?:|mailto:|data:|#)/i.test(target)) return target;
  try { return new URL(target, sourceUrl).href; } catch { return target; }
}

// Site-root links ("/docs/learn/x") break once the page is inside an EPUB.
function absolutify(href, pageUrl) {
  if (!pageUrl || !href.startsWith("/")) return href;
  try { return new URL(href, pageUrl).href; } catch { return href; }
}

/**
 * Normalize Markdown written for a Pandoc/MkDocs book build:
 * strip frontmatter, lift the H1 into the chapter title, drop the attribute
 * blocks Pandoc uses on headings, and make relative links absolute so images
 * survive being pulled out of the repo.
 *
 * Fences are tracked so that braces and paths inside code samples stay put.
 */
function cleanPandocMarkdown(raw, hint, sourceUrl) {
  let md = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  md = md.replace(/^---\n[\s\S]*?\n---\n/, ""); // YAML frontmatter

  let title = (hint || "").trim();
  md = md.replace(/^#\s+(.+?)\n+/, (_m, h1) => {
    const clean = h1.replace(/\s*\{[^}]*\}\s*$/, "").trim();
    if (!title) title = clean;
    return "";
  });

  const out = [];
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }
    out.push(
      line
        .replace(/^(#{1,6}\s+.*?)\s*\{[^}]*\}\s*$/, "$1")   // ## Heading {.unnumbered}
        .replace(/(!?\[[^\]]*\]\()([^)\s]+)(\))/g, (_m, a, target, b) =>
          a + resolveAgainst(target, sourceUrl) + b)
    );
  }

  return { title: title || "untitled", body: out.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}

function activeSiteHandler() {
  return SITE_HANDLERS.find((h) => h.match(location)) || null;
}

// ---------- batch: scan links & merge a whole topic ----------

function scanArticleLinks() {
  const handler = activeSiteHandler();
  if (handler) return handler.scan();
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

async function fetchAndConvert(url, td, hint) {
  const handler = activeSiteHandler();
  if (handler && handler.fetchMarkdown) {
    // Sites that publish a Markdown source need no conversion at all.
    const direct = await handler.fetchMarkdown(url, hint);
    if (direct) return direct;
  }

  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Some sites only reveal where their Markdown source lives once the page is
  // parsed (an "edit this page" link), so this hook runs after the fetch.
  if (handler && handler.extractMarkdown) {
    try {
      const direct = await handler.extractMarkdown(doc, url, hint);
      if (direct) return direct;
    } catch { /* fall through to HTML scraping */ }
  }

  let clone, title;
  if (handler && handler.extract) {
    ({ clone, title } = handler.extract(doc, url, hint));
  } else {
    let src = null;
    for (const sel of ["article", "main", '[role="main"]', "#content", ".theme-hope-content", ".markdown-body"]) {
      const el = doc.querySelector(sel);
      if (el && el.textContent.trim().length > 100) { src = el; break; }
    }
    if (!src) src = doc.body;
    clone = src.cloneNode(true);
    clone.querySelectorAll("nav, header, footer, aside, [role=navigation], .sidebar, .comments, .ad, [class*=advert], .page-meta, .page-nav").forEach((n) => n.remove());
    title = (doc.querySelector("h1")?.textContent || doc.title || url).trim();
    const firstH1 = clone.querySelector("h1");
    if (firstH1) firstH1.remove(); // section heading already carries the title
  }

  clone.querySelectorAll("a[href]").forEach((a) => {
    try { a.setAttribute("href", new URL(a.getAttribute("href"), url).href); } catch {}
  });
  clone.querySelectorAll("img").forEach((img) => {
    const s = img.getAttribute("src") || img.getAttribute("data-src") || "";
    try { if (s) img.setAttribute("src", new URL(s, url).href); } catch {}
  });
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
      const { title, body } = await fetchAndConvert(links[i].url, td, links[i].title);
      const anchor = `art-${i + 1}`;
      toc.push(`${i + 1}. [${title.replace(/[\[\]]/g, "")}](#${anchor})`);
      parts.push(`<a id="${anchor}"></a>\n\n## ${title}\n\n> ${ti("srcLabel")}: ${links[i].url}\n\n${body}`);
      // In the EPUB the source belongs at the end — the reader wants the text
      // first, and the chapter title is rendered from `title`.
      chapters.push({ title, markdown: `${body}\n\n---\n\n*${ti("srcLabel")}: ${links[i].url}*` });
    } catch (e) {
      toc.push(`${i + 1}. ${links[i].title}（${ti("fetchFailed", e.message)}）`);
      parts.push(`## ${links[i].title}\n\n> ${ti("srcLabel")}: ${links[i].url}\n\n*${ti("fetchFailed", e.message)}*`);
      chapters.push({ title: links[i].title, markdown: `*${ti("fetchFailed", e.message)}*\n\n---\n\n*${ti("srcLabel")}: ${links[i].url}*` });
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
