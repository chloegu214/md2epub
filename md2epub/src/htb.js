// HTB Enterprise (enterprise.hackthebox.com) module handler.
//
// The module pages are a SPA, so fetch() of a section URL only returns the app
// shell. The SPA itself loads everything from two JSON endpoints, which we call
// directly with the user's session cookie:
//
//   GET /api/v1/content/module/{moduleId}/{suffix}    -> data.sections[] (TOC)
//   GET /api/v1/content/section/{contentId}/{suffix}  -> data.content (Markdown)
//
// `suffix` is the trailing id in the page URL (organization/assignment scope);
// the API requires it whenever the page URL carries one.
//
// Section bodies are Markdown with a few inline HTML islands: <img> tags whose
// src points at /storage/... (served from a public CDN) and Bootstrap "card"
// callouts. Images are rewritten to Markdown syntax with absolute URLs so the
// EPUB pipeline can embed them; cards become blockquotes.

export const HTB_CDN = "https://cdn.services-k8s.prod.aws.htb.systems/content";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PAGE_RE = new RegExp(
  `^/content-page/module/(${UUID})(?:/section/(${UUID}))?(?:/(${UUID}))?/?$`, "i");

export function isHtbModulePage(loc) {
  return /^enterprise\.hackthebox\.com$/i.test(loc.hostname) && PAGE_RE.test(loc.pathname);
}

/** -> { moduleId, sectionId|null, suffix|null } or null when not a module page. */
export function parseHtbPath(pathname) {
  const m = pathname.match(PAGE_RE);
  if (!m) return null;
  return { moduleId: m[1], sectionId: m[2] || null, suffix: m[3] || null };
}

const tail = (suffix) => (suffix ? `/${suffix}` : "");

export const moduleApiPath = (moduleId, suffix) => `/api/v1/content/module/${moduleId}${tail(suffix)}`;
export const sectionApiPath = (sectionId, suffix) => `/api/v1/content/section/${sectionId}${tail(suffix)}`;
export const sectionPagePath = (moduleId, sectionId, suffix) =>
  `/content-page/module/${moduleId}/section/${sectionId}${tail(suffix)}`;

/** Module API JSON -> [{url, title}] in reading order. */
export function sectionLinks(moduleJson, origin, moduleId, suffix) {
  const sections = (moduleJson && moduleJson.data && moduleJson.data.sections) || [];
  return sections
    .map((s, i) => ({ s, i }))
    .sort((a, b) => ((a.s.page ?? a.i) - (b.s.page ?? b.i)) || (a.i - b.i))
    .map(({ s }) => ({
      url: origin + sectionPagePath(moduleId, s.content_id, suffix),
      title: String(s.title || "").replace(/\s+/g, " ").trim(),
    }));
}

/** Resolve an asset/link URL found in section content. */
export function resolveHtbUrl(src, origin) {
  if (!src) return src;
  if (/^\/storage\//.test(src)) return HTB_CDN + src.slice("/storage".length);
  try { return new URL(src, origin + "/").href; } catch { return src; }
}

const decode = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
   .replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] ?? m[3]) : "";
};

/** Inline HTML (inside a card) -> Markdown inline text. */
function inlineHtmlToMd(html) {
  return html
    .replace(/<\s*(b|strong)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, "**$2**")
    .replace(/<\s*(i|em)\b[^>]*>([\s\S]*?)<\/\s*\1\s*>/gi, "*$2*")
    .replace(/<\s*code\b[^>]*>([\s\S]*?)<\/\s*code\s*>/gi, "`$1`")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/?\s*(p|div|span)\b[^>]*>/gi, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n\n")
    .trim();
}

function imgToMd(tag, origin) {
  const src = attr(tag, "src") || attr(tag, "data-src");
  if (!src) return "";
  const alt = attr(tag, "alt").replace(/[\[\]\n]/g, " ").replace(/\s+/g, " ").trim();
  return `\n\n![${alt}](${resolveHtbUrl(src, origin)})\n\n`;
}

/** Convert one stretch of non-code Markdown. */
function convertProse(text, origin) {
  // Bootstrap cards (<div class="card ..."><div class="card-body">…</div></div>)
  text = text.replace(
    /<div\b[^>]*class="[^"]*\bcard\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
    (_m, inner) => {
      const md = inlineHtmlToMd(inner.replace(/<div\b[^>]*>/i, ""));
      return "\n\n" + md.split("\n").map((l) => (l ? "> " + l : ">")).join("\n") + "\n\n";
    });
  text = text.replace(/<img\b[^>]*>/gi, (tag) => imgToMd(tag, origin));
  // Root-relative Markdown links/images (but not protocol-relative //host).
  text = text.replace(/(!?\[[^\]]*\]\()(\/(?!\/)[^)\s]*)/g,
    (_m, head, url) => head + resolveHtbUrl(url, origin));
  return text;
}

/** Section `content` -> Markdown body. Code fences are left untouched. */
export function htbContentToMarkdown(content, origin) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let prose = [];
  let fence = null; // the opening fence marker while inside a code block
  const flush = () => {
    if (prose.length) out.push(convertProse(prose.join("\n"), origin));
    prose = [];
  };
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      out.push(line);
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.trim().slice(m[1].length).trim()) fence = null;
    } else if (m) {
      flush();
      fence = m[1];
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const stripTags = (s) => decode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Section API JSON -> { title, body }. Questions are listed without answers. */
export function sectionToMarkdown(sectionJson, origin, hint) {
  const d = (sectionJson && sectionJson.data) || {};
  const title = (hint || d.title || "untitled").replace(/\s+/g, " ").trim();
  let body = htbContentToMarkdown(d.content, origin);
  const qs = (d.questions || [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((q) => stripTags(q.question))
    .filter(Boolean);
  if (qs.length) body += "\n\n### Questions\n\n" + qs.map((q, i) => `${i + 1}. ${q}`).join("\n");
  return { title, body };
}

async function getJson(path) {
  const res = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const htbHandler = {
  name: "hackthebox",
  match: isHtbModulePage,
  scan: async () => {
    const p = parseHtbPath(location.pathname);
    const json = await getJson(moduleApiPath(p.moduleId, p.suffix));
    return sectionLinks(json, location.origin, p.moduleId, p.suffix);
  },
  fetchMarkdown: async (url, hint) => {
    const u = new URL(url);
    const p = parseHtbPath(u.pathname);
    if (!p || !p.sectionId) return null;
    const json = await getJson(sectionApiPath(p.sectionId, p.suffix));
    return sectionToMarkdown(json, u.origin, hint);
  },
};
