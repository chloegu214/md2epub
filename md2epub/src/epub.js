import JSZip from "jszip";
import { marked } from "marked";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function mdToXhtml(md) {
  let html = marked.parse(md, { async: false });
  // XHTML needs self-closed void elements
  html = html
    .replace(/<br\s*>/gi, "<br/>")
    .replace(/<hr\s*>/gi, "<hr/>")
    .replace(/<img([^>]*?)(?<!\/)>/gi, "<img$1/>")
    .replace(/&nbsp;/g, "&#160;");
  return html;
}

function chapterXhtml(title, bodyHtml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${esc(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><section epub:type="chapter">${bodyHtml}</section></body>
</html>`;
}

const CSS = `
body { font-family: serif; line-height: 1.7; margin: 1em; }
h1,h2,h3 { line-height: 1.3; }
code { font-family: monospace; background: #f2f2f2; padding: 0 .2em; }
pre { background: #f6f6f6; padding: .8em; overflow-x: auto; white-space: pre-wrap; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid #999; padding: .4em .6em; text-align: left; }
img { max-width: 100%; }
blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1em; color: #555; }
`;

/**
 * Build an EPUB 3 file.
 * @param {string} title  book title
 * @param {Array<{title: string, markdown: string}>} chapters
 * @returns {Promise<Blob>}
 */
export async function buildEpub(title, chapters, imageMap = null) {
  const zip = new JSZip();
  const uid = "urn:uuid:" + crypto.randomUUID();
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
  );

  const manifest = [];
  const spine = [];
  const navLis = [];
  chapters.forEach((ch, i) => {
    const id = `ch${i + 1}`;
    const file = `${id}.xhtml`;
    const md = imageMap ? rewriteImageUrls(ch.markdown, imageMap) : ch.markdown;
    zip.file(`OEBPS/${file}`, chapterXhtml(ch.title, mdToXhtml(md)));
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="${id}"/>`);
    navLis.push(`<li><a href="${file}">${esc(ch.title)}</a></li>`);
  });

  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目录</title></head>
<body><nav epub:type="toc"><h1>目录</h1><ol>${navLis.join("")}</ol></nav></body>
</html>`
  );
  if (imageMap) {
    let k = 0;
    for (const { path, mime, blob } of imageMap.values()) {
      zip.file(`OEBPS/${path}`, await blob.arrayBuffer());
      manifest.push(`<item id="im${++k}" href="${path}" media-type="${mime}"/>`);
    }
  }
  zip.file("OEBPS/style.css", CSS);
  zip.file(
    "OEBPS/package.opf",
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">${uid}</dc:identifier>
    <dc:title>${esc(title)}</dc:title>
    <dc:language>zh</dc:language>
    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="style.css" media-type="text/css"/>
    ${manifest.join("\n    ")}
  </manifest>
  <spine>${spine.join("")}</spine>
</package>`
  );

  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
}

// ---------- image embedding ----------

const IMG_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function extToMime(url, blobType) {
  if (blobType && blobType.startsWith("image/")) return blobType;
  const ext = (url.split("?")[0].split(".").pop() || "").toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
           webp: "image/webp", svg: "image/svg+xml", avif: "image/avif" }[ext] || "image/jpeg";
}

export function collectImageUrls(chapters) {
  const urls = new Set();
  for (const ch of chapters) {
    for (const m of ch.markdown.matchAll(IMG_MD_RE)) {
      const u = m[2];
      if (/^https?:\/\//i.test(u)) urls.add(u);
    }
  }
  return [...urls];
}

/**
 * Fetch images and return { map: url -> {path, mime, blob}, failed: [url] }.
 * onProgress(done, total) is called as images finish.
 */
export async function fetchImages(urls, onProgress) {
  const map = new Map();
  const failed = [];
  let i = 0;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const blob = await res.blob();
      const mime = extToMime(url, blob.type);
      const ext = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif",
                    "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif" }[mime] || "jpg";
      map.set(url, { path: `images/img${map.size + 1}.${ext}`, mime, blob });
    } catch {
      failed.push(url);
    }
    i++;
    if (onProgress) onProgress(i, urls.length);
  }
  return { map, failed };
}

export function rewriteImageUrls(markdown, map) {
  return markdown.replace(IMG_MD_RE, (full, alt, url) => {
    const hit = map.get(url);
    return hit ? `![${alt}](${hit.path})` : full;
  });
}
