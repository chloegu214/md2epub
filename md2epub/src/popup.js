import { buildEpub, collectImageUrls, fetchImages } from "./epub.js";

// ---------- i18n with runtime language override ----------
// Loads _locales JSON directly so the user can switch language in the popup,
// which chrome.i18n alone cannot do at runtime.
let MSG = {};
let LANG = "en";

async function loadMessages(lang) {
  const file = lang === "zh" ? "zh_CN" : "en";
  const res = await fetch(chrome.runtime.getURL(`_locales/${file}/messages.json`));
  return res.json();
}

function t(key, ...subs) {
  const entry = MSG[key];
  if (!entry) return key;
  let m = entry.message;
  if (entry.placeholders) {
    for (const [name, def] of Object.entries(entry.placeholders)) {
      const idx = parseInt(String(def.content).slice(1), 10) - 1;
      m = m.split(`$${name}$`).join(String(subs[idx] ?? ""));
    }
  }
  return m;
}

function localizeDom() {
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.getElementById("lang-toggle").textContent = LANG === "zh" ? "EN" : "中";
  refreshDownloadLabel();
}

async function initI18n() {
  const { uiLang } = await chrome.storage.sync.get("uiLang");
  LANG = uiLang ||
    (((chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) || "").toLowerCase().startsWith("zh") ? "zh" : "en");
  MSG = await loadMessages(LANG);
}

document.getElementById("lang-toggle").addEventListener("click", async () => {
  LANG = LANG === "zh" ? "en" : "zh";
  chrome.storage.sync.set({ uiLang: LANG });
  MSG = await loadMessages(LANG);
  localizeDom();
  setStatus("");
  setSide("");
});

// ---------- status ----------
const statusEl = document.getElementById("status");
const sideEl = document.getElementById("status-side");
function setStatus(msg, isErr = false) {
  statusEl.textContent = msg;
  statusEl.className = isErr ? "err" : "";
}
function setSide(text, done = false) {
  sideEl.textContent = text;
  sideEl.className = done ? "done" : "";
}

// ---------- progress bars (custom, per design) ----------
function bar(id) { return document.getElementById(id); }
function setBar(id, done, total) {
  const el = bar(id);
  el.hidden = false;
  el.firstElementChild.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
}
function hideBar(id) { bar(id).hidden = true; }

// ---------- format (segmented) + tab state, persisted ----------
let curFmt = "md";
function fmt() { return curFmt; }
function applyFmt(f) {
  curFmt = f;
  document.getElementById("fmt-md").classList.toggle("active", f === "md");
  document.getElementById("fmt-epub").classList.toggle("active", f === "epub");
  refreshDownloadLabel();
}
document.querySelectorAll(".fmt").forEach((b) =>
  b.addEventListener("click", () => {
    applyFmt(b.dataset.fmt);
    chrome.storage.sync.set({ lastFmt: curFmt });
  })
);

function scope() {
  return document.getElementById("scope-article").checked ? "article" : "full";
}

function refreshDownloadLabel() {
  const ext = curFmt === "epub" ? ".epub" : ".md";
  document.getElementById("download").textContent = t("btnDownload", ext);
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.getElementById("pane-single").hidden = name !== "single";
  document.getElementById("pane-batch").hidden = name !== "batch";
}
document.querySelectorAll(".tab").forEach((el) =>
  el.addEventListener("click", () => {
    activateTab(el.dataset.tab);
    chrome.storage.sync.set({ lastTab: el.dataset.tab });
  })
);

// ---------- helpers ----------
function safeFilename(title) {
  return (
    (title || "page")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "page"
  ) + ".md";
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error(t("errNoTab"));
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || "")) {
    throw new Error(t("errInternalPage"));
  }
  return tab.id;
}

async function ensureInjected() {
  const tabId = await activeTabId();
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.bundle.js"] });
  return tabId;
}

async function getMarkdown() {
  const tabId = await ensureInjected();
  const res = await chrome.tabs.sendMessage(tabId, { type: "CONVERT", scope: scope() });
  if (!res || !res.ok) throw new Error((res && res.error) || t("convertFailed"));
  return res;
}

// ---------- scan ----------
let scannedLinks = [];
let batchPort = null;

function renderScanResult() {
  const box = document.getElementById("scan-result");
  const mergeBtn = document.getElementById("merge");
  if (scannedLinks.length === 0) {
    box.hidden = true;
    mergeBtn.disabled = true;
    setStatus(t("errNoLinks"), true);
    return;
  }
  box.hidden = false;
  document.getElementById("scan-count").textContent = t("foundCount", scannedLinks.length);
  const l1 = document.getElementById("scan-line1");
  const l2 = document.getElementById("scan-line2");
  l1.textContent = scannedLinks[0] ? (scannedLinks[0].title || scannedLinks[0].url) : "";
  l1.hidden = !scannedLinks[0];
  l2.textContent = scannedLinks[1] ? (scannedLinks[1].title || scannedLinks[1].url) : "";
  l2.hidden = !scannedLinks[1];
  document.getElementById("scan-more").hidden = scannedLinks.length <= 2;
  mergeBtn.disabled = false;
  setStatus("");
}

function scanPort(tabId) {
  if (batchPort) return batchPort;
  const port = chrome.tabs.connect(tabId, { name: "batch" });
  batchPort = port;
  port.onDisconnect.addListener(() => { if (batchPort === port) batchPort = null; });
  port.onMessage.addListener((msg) => {
    if (msg.type !== "LINKS") return;
    scannedLinks = msg.links;
    renderScanResult();
  });
  return port;
}

document.getElementById("scan").addEventListener("click", async () => {
  try {
    setStatus(t("statusScanning"));
    const tabId = await ensureInjected();
    scanPort(tabId).postMessage({ type: "SCAN" });
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
});

// ---------- jobs (background worker) ----------
async function ensureImagePermission() {
  const has = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  if (has) return true;
  try {
    return await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch {
    return false;
  }
}

async function epubConsent() {
  if (fmt() !== "epub") return false;
  const { imgConsent } = await chrome.storage.sync.get("imgConsent");
  if (imgConsent !== true) {
    const ok = confirm(t("imgConfirm", "?"));
    if (!ok) return false;
    chrome.storage.sync.set({ imgConsent: true });
  }
  const granted = await ensureImagePermission();
  if (!granted) {
    setStatus(t("imgPermDenied"), true);
    return false;
  }
  return true;
}

async function submitJob(extra) {
  const tabId = await activeTabId();
  const embedImages = await epubConsent();
  const res = await chrome.runtime.sendMessage({
    type: "START_JOB", tabId, fmt: fmt(), embedImages,
    collectionSuffix: t("collectionSuffix"), ...extra,
  });
  if (!res || !res.ok) throw new Error((res && res.error) || t("convertFailed"));
}

document.getElementById("download").addEventListener("click", async () => {
  try {
    setStatus(t("statusConverting"));
    await submitJob({ kind: "single", scope: scope() });
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
});

document.getElementById("merge").addEventListener("click", async () => {
  const btn = document.getElementById("merge");
  try {
    btn.disabled = true;
    await ensureInjected();
    await submitJob({ kind: "batch", links: scannedLinks });
  } catch (e) {
    setStatus(String(e.message || e), true);
    btn.disabled = false;
  }
});

// ---------- live job rendering ----------
function renderJob(job) {
  const mergeBtn = document.getElementById("merge");
  if (!job) return;
  const barId = job.kind === "single" ? "prog-single" : "prog";
  if (job.status === "running") {
    mergeBtn.disabled = true;
    setSide(t("runningShort"));
    if (job.kind === "batch") document.getElementById("scan-result").hidden = scannedLinks.length === 0;
    if (job.phase === "articles") {
      setBar(barId, job.done || 0, job.total || 1);
      setStatus(t("statusProgress", (job.done || 0) + 1, job.total || 0, job.current || ""));
    } else if (job.phase === "images") {
      setBar(barId, job.done || 0, job.total || 1);
      setStatus(t("imgFetching", job.done || 0, job.total || 0));
    } else if (job.phase === "packing") {
      setStatus(t("phasePacking"));
    } else {
      setStatus(t("statusConverting"));
    }
  } else if (job.status === "done") {
    hideBar(barId);
    mergeBtn.disabled = scannedLinks.length === 0;
    setStatus(t("statusDownloaded"));
    setSide(t("doneShort"), true);
    chrome.runtime.sendMessage({ type: "CLEAR_JOB" });
  } else if (job.status === "error") {
    hideBar(barId);
    mergeBtn.disabled = scannedLinks.length === 0;
    setStatus(job.error || t("convertFailed"), true);
    setSide("");
    chrome.runtime.sendMessage({ type: "CLEAR_JOB" });
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.job) renderJob(changes.job.newValue);
});

// ---------- copy ----------
document.getElementById("copy").addEventListener("click", async () => {
  try {
    setStatus(t("statusConverting"));
    const { markdown } = await getMarkdown();
    await navigator.clipboard.writeText(markdown);
    setStatus(t("statusCopied"));
  } catch (e) {
    setStatus(String(e.message || e), true);
  }
});

// ---------- Google Drive (OAuth only) ----------
function driveConfigured() {
  const cid = chrome.runtime.getManifest().oauth2?.client_id || "";
  return cid !== "" && !cid.startsWith("YOUR_CLIENT_ID");
}
function refreshDriveVisibility() {
  const show = driveConfigured();
  document.getElementById("drive").hidden = !show;
  if (!show) document.getElementById("merge-drive").hidden = true;
}

function imgBarId() {
  return document.getElementById("pane-batch").hidden ? "prog-single" : "prog";
}

async function prepareEpubImages(chapters) {
  const urls = collectImageUrls(chapters);
  if (urls.length === 0) return null;
  const { imgConsent } = await chrome.storage.sync.get("imgConsent");
  if (imgConsent !== true) {
    const ok = confirm(t("imgConfirm", urls.length));
    if (!ok) return null;
    chrome.storage.sync.set({ imgConsent: true });
  }
  if (!(await ensureImagePermission())) {
    setStatus(t("imgPermDenied"), true);
    return null;
  }
  const id = imgBarId();
  setBar(id, 0, urls.length);
  setStatus(t("imgFetching", 0, urls.length));
  const { map, failed } = await fetchImages(urls, (done, total) => {
    setBar(id, done, total);
    setStatus(t("imgFetching", done, total));
  });
  hideBar(id);
  if (failed.length) setStatus(t("imgFailed", failed.length));
  return map.size ? map : null;
}

async function buildEpubWithImages(title, chapters) {
  const imageMap = await prepareEpubImages(chapters);
  return buildEpub(title, chapters, imageMap);
}

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || t("authFailed")));
      } else {
        resolve(token);
      }
    });
  });
}

async function uploadToDrive(filename, content, mimeType = "text/markdown") {
  let token;
  try { token = await getAuthToken(false); }
  catch { token = await getAuthToken(true); }

  const doUpload = async (tk) => {
    const boundary = "-------md2epub" + Date.now();
    const metadata = { name: filename, mimeType };
    const payload = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      payload,
      `\r\n--${boundary}--`,
    ]);
    return fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink",
      { method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body }
    );
  };

  let res = await doUpload(token);
  if (res.status === 401) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    token = await getAuthToken(true);
    res = await doUpload(token);
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(t("driveUploadFailed", res.status, err.slice(0, 200)));
  }
  return res.json();
}

async function saveToDrive(title, markdown, chapters = null) {
  if (fmt() === "epub") {
    const blob = await buildEpubWithImages(title, chapters || [{ title, markdown }]);
    const filename = safeFilename(title).replace(/\.md$/, ".epub");
    return uploadToDrive(filename, blob, "application/epub+zip");
  }
  return uploadToDrive(safeFilename(title), markdown, "text/markdown");
}

function appendDriveLink(file) {
  if (!file.webViewLink) return;
  const a = document.createElement("a");
  a.href = file.webViewLink;
  a.target = "_blank";
  a.textContent = t("openInDrive");
  a.style.marginLeft = "6px";
  statusEl.appendChild(a);
}

document.getElementById("drive").addEventListener("click", async () => {
  const btn = document.getElementById("drive");
  btn.disabled = true;
  try {
    setStatus(t("statusConverting"));
    const { title, markdown } = await getMarkdown();
    setStatus(t("statusUploading"));
    const file = await saveToDrive(title, markdown);
    setStatus(t("savedToDrive", file.name));
    appendDriveLink(file);
  } catch (e) {
    setStatus(String(e.message || e), true);
  } finally {
    btn.disabled = false;
  }
});

async function getLastMerge() {
  const tabId = await ensureInjected();
  return new Promise((resolve) => {
    const port = chrome.tabs.connect(tabId, { name: "batch" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "STATE") {
        port.disconnect();
        resolve(msg.result
          ? { title: msg.result.title + t("collectionSuffix"), markdown: msg.result.markdown, chapters: msg.result.chapters }
          : null);
      }
    });
    port.postMessage({ type: "GET_STATE" });
  });
}

document.getElementById("merge-drive").addEventListener("click", async () => {
  const btn = document.getElementById("merge-drive");
  btn.disabled = true;
  try {
    const lastMerge = await getLastMerge();
    if (!lastMerge) { setStatus(t("errNoLinks"), true); return; }
    setStatus(t("statusUploadingCollection"));
    const file = await saveToDrive(lastMerge.title, lastMerge.markdown, lastMerge.chapters);
    setStatus(t("collectionSavedToDrive", file.name));
    appendDriveLink(file);
  } catch (e) {
    setStatus(String(e.message || e), true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- init ----------
const HELP_URL = "https://chloegu214.github.io/md2epub/";
document.getElementById("help-link").href = HELP_URL;

(async function init() {
  await initI18n();
  localizeDom();
  refreshDriveVisibility();

  const { lastFmt, lastTab } = await chrome.storage.sync.get(["lastFmt", "lastTab"]);
  applyFmt(lastFmt === "epub" ? "epub" : "md");
  activateTab(lastTab === "batch" ? "batch" : "single");

  const { job } = await chrome.storage.session.get("job");
  renderJob(job);
  if (job && job.kind === "batch" && (job.status === "done" || job.status === "running")) {
    document.getElementById("merge-drive").hidden = !driveConfigured();
  }
})();
