import { buildEpub, collectImageUrls, fetchImages } from "./epub.js";

// The offscreen document exists because MV3 service workers cannot
// createObjectURL. It also hosts image fetching so long downloads
// survive popup/tab changes.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "BUILD_EPUB" || msg.target !== "offscreen") return;
  (async () => {
    try {
      const { title, chapters, embedImages } = msg.payload;
      let map = null;
      if (embedImages) {
        const urls = collectImageUrls(chapters);
        if (urls.length) {
          chrome.runtime.sendMessage({ type: "JOB_PROGRESS", from: "offscreen",
            patch: { phase: "images", done: 0, total: urls.length } });
          const r = await fetchImages(urls, (done, total) =>
            chrome.runtime.sendMessage({ type: "JOB_PROGRESS", from: "offscreen",
              patch: { phase: "images", done, total } })
          );
          map = r.map.size ? r.map : null;
        }
      }
      chrome.runtime.sendMessage({ type: "JOB_PROGRESS", from: "offscreen", patch: { phase: "packing" } });
      const blob = await buildEpub(title, chapters, map);
      sendResponse({ ok: true, url: URL.createObjectURL(blob) });
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // async response
});
