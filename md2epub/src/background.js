// PageBinder background service worker: owns long-running jobs so they
// survive popup close and tab switches. Progress lives in
// chrome.storage.session; the popup is just a viewer.

function safeFilename(title) {
  return (
    (title || "page")
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "page"
  ) + ".md";
}

async function setJob(patch) {
  const { job = {} } = await chrome.storage.session.get("job");
  const next = { ...job, ...patch, ts: Date.now() };
  await chrome.storage.session.set({ job: next });
  updateBadge(next);
  return next;
}

function updateBadge(job) {
  let text = "";
  if (job.status === "running") {
    if (job.phase === "images" && job.total) text = Math.round((job.done / job.total) * 100) + "%";
    else if (job.phase === "articles" && job.total) text = `${job.done}/${job.total}`.length <= 4 ? `${job.done}` : `${job.done}`;
    else text = "…";
  } else if (job.status === "done") {
    text = "✓";
  } else if (job.status === "error") {
    text = "!";
  }
  chrome.action.setBadgeBackgroundColor({ color: job.status === "error" ? "#b0413e" : "#2f6f4f" });
  chrome.action.setBadgeText({ text });
}

let running = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "START_JOB") {
    startJob(msg)
      .then(() => sendResponse({ ok: true }))
      .catch(async (e) => {
        await setJob({ status: "error", error: String((e && e.message) || e) });
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true;
  }
  if (msg.type === "JOB_PROGRESS" && msg.from === "offscreen") {
    setJob(msg.patch);
    return;
  }
  if (msg.type === "CLEAR_JOB") {
    chrome.storage.session.remove("job");
    chrome.action.setBadgeText({ text: "" });
    return;
  }
});

async function ensureContent(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.bundle.js"] });
}

function runBatchViaPort(tabId, links) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.tabs.connect(tabId, { name: "batch" });
    port.onMessage.addListener((m) => {
      if (m.type === "PROGRESS") {
        setJob({ phase: "articles", done: m.done, total: m.total, current: m.current || "" });
      } else if (m.type === "DONE") {
        settled = true;
        resolve(m);
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!settled) reject(new Error("page closed"));
    });
    port.postMessage({ type: "RUN", links });
  });
}

async function ensureOffscreen() {
  if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Fetch images and build EPUB blobs; create object URLs for downloads.",
  });
}

function buildEpubOffscreen(payload) {
  return new Promise((resolve, reject) => {
    ensureOffscreen()
      .then(() => {
        chrome.runtime.sendMessage({ type: "BUILD_EPUB", target: "offscreen", payload }, (res) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!res || !res.ok) return reject(new Error((res && res.error) || "EPUB build failed"));
          resolve(res.url);
        });
      })
      .catch(reject);
  });
}

async function startJob(req) {
  if (running) throw new Error(chrome.i18n.getMessage("busyError") || "A task is already running");
  running = true;
  try {
    await setJob({
      status: "running",
      kind: req.kind,
      fmt: req.fmt,
      phase: req.kind === "batch" ? "articles" : "convert",
      done: 0,
      total: (req.links && req.links.length) || 0,
      current: "",
      error: null,
    });
    await ensureContent(req.tabId);

    let title, markdown, chapters = null;
    if (req.kind === "batch") {
      const res = await runBatchViaPort(req.tabId, req.links);
      title = res.title;
      markdown = res.markdown;
      chapters = res.chapters;
    } else {
      const res = await chrome.tabs.sendMessage(req.tabId, { type: "CONVERT", scope: req.scope });
      if (!res || !res.ok) throw new Error((res && res.error) || "convert failed");
      title = res.title;
      markdown = res.markdown;
    }

    const suffix = req.kind === "batch" ? req.collectionSuffix || "" : "";
    const base = safeFilename(title + suffix);

    if (req.fmt === "epub") {
      await setJob({ phase: "images", done: 0, total: 0 });
      const url = await buildEpubOffscreen({
        title: title + suffix,
        chapters: chapters || [{ title: title + suffix, markdown }],
        embedImages: !!req.embedImages,
      });
      await chrome.downloads.download({
        url,
        filename: base.replace(/\.md$/, ".epub"),
        saveAs: false,
        conflictAction: "uniquify",
      });
    } else {
      const url = "data:text/markdown;charset=utf-8," + encodeURIComponent(markdown);
      await chrome.downloads.download({ url, filename: base, saveAs: false, conflictAction: "uniquify" });
    }
    await setJob({ status: "done", phase: "done" });
  } finally {
    running = false;
  }
}
