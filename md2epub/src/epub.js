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
<body><section epub:type="chapter">
<h1>${esc(title)}</h1>
${bodyHtml}</section></body>
</html>`;
}

// Tuned for a 6" e-reader: the body text stays roomy while code and tables shrink
// to fit, and nothing (long URLs, wide code) is allowed to run off the page.
//
// The body rule deliberately declares no font-family, font-size, line-height or
// margin. Kindle treats any of those as publisher intent and greys out the
// matching control in its typography menu, so a book that sets them is one the
// reader cannot resize or respace. Everything below sizes in em, which scales
// with whatever the reader picks.
const CSS = `
body { overflow-wrap: break-word; }
h1 { font-size: 1.5em; line-height: 1.25; margin: 0 0 1em; }
h2 { font-size: 1.25em; line-height: 1.3; margin: 1.6em 0 .5em; }
h3 { font-size: 1.1em; line-height: 1.3; margin: 1.3em 0 .4em; }
h4, h5, h6 { font-size: 1em; line-height: 1.3; margin: 1.2em 0 .3em; }
p { margin: .6em 0; }
a { color: inherit; }
code { font-family: monospace; font-size: .85em; background: #f2f2f2; padding: 0 .2em; }
pre { background: #f6f6f6; padding: .6em; margin: .8em 0; white-space: pre-wrap; word-break: break-all; }
pre code { font-size: .78em; background: none; padding: 0; line-height: 1.4; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: .82em; table-layout: fixed; }
th, td { border: 1px solid #999; padding: .35em .4em; text-align: left; }
img { max-width: 100%; height: auto; }
figure, p > img { display: block; margin: 1em auto; text-align: center; }
ul, ol { margin: .6em 0; padding-left: 1.4em; }
li { margin: .25em 0; }
blockquote { border-left: 3px solid #ccc; margin: .8em 0 .8em 0; padding-left: .8em; color: #555; }
blockquote pre { background: #eee; }
hr { border: 0; border-top: 1px solid #ddd; margin: 1.5em 0; }
.src { font-size: .8em; color: #777; }
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

// Kindle's renderer ignores SVG almost everywhere, so a book whose diagrams are
// vector arrives with blank pages. Rasterizing at this width keeps figures sharp
// on a 300ppi e-reader without bloating the file.
const SVG_RASTER_WIDTH = 1400;
const SVG_RASTER_MAX_HEIGHT = 2000;

/**
 * Draw an SVG into a PNG. Returns null when the SVG cannot be sized or decoded,
 * in which case the caller keeps the original file.
 *
 * Chrome reports naturalWidth 0 for SVGs sized only by viewBox, so the intrinsic
 * size is pinned onto the markup before handing it to the decoder.
 */
async function rasterizeSvg(blob) {
  const svg = new DOMParser()
    .parseFromString(await blob.text(), "image/svg+xml")
    .documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== "svg") return null;

  const viewBox = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const attr = (name) => parseFloat(svg.getAttribute(name) || "");
  const boxed = viewBox.length === 4 && viewBox.every(Number.isFinite);
  // Percentage widths parse as NaN, which correctly falls through to the viewBox.
  const w = Number.isFinite(attr("width")) ? attr("width") : boxed ? viewBox[2] : 0;
  const h = Number.isFinite(attr("height")) ? attr("height") : boxed ? viewBox[3] : 0;
  if (!(w > 0 && h > 0)) return null;

  const scale = Math.min(SVG_RASTER_WIDTH / w, SVG_RASTER_MAX_HEIGHT / h);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  if (!boxed) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(outW));
  svg.setAttribute("height", String(outH));

  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" })
  );
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("svg decode failed"));
      im.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    // Diagrams draw in black with no background of their own; without this they
    // vanish into the page on readers that invert or tint the background.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
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
      let blob = await res.blob();
      let mime = extToMime(url, blob.type);
      if (mime === "image/svg+xml") {
        const png = await rasterizeSvg(blob).catch(() => null);
        if (png) { blob = png; mime = "image/png"; }
      }
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
