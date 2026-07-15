// Language: manual choice (localStorage) > browser language > English
(function () {
  var saved = null;
  try { saved = localStorage.getItem("md2epub-lang"); } catch (e) {}
  var lang = saved || (((navigator.language || "").toLowerCase().indexOf("zh") === 0) ? "zh" : "en");
  apply(lang);

  var btn = document.getElementById("lang-toggle");
  if (btn) btn.addEventListener("click", function () {
    lang = (lang === "zh") ? "en" : "zh";
    try { localStorage.setItem("md2epub-lang", lang); } catch (e) {}
    apply(lang);
  });

  function apply(l) {
    document.documentElement.className = l;
    document.documentElement.lang = (l === "zh") ? "zh-CN" : "en";
    var t = document.querySelector("title");
    if (t && t.dataset[l]) document.title = t.dataset[l];
    if (btn) btn.textContent = (l === "zh") ? "EN" : "中";
    var b = document.getElementById("lang-toggle");
    if (b) b.textContent = (l === "zh") ? "EN" : "中";
  }
})();
