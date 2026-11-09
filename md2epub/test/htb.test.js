import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseHtbPath, isHtbModulePage, sectionLinks, resolveHtbUrl,
  htbContentToMarkdown, sectionToMarkdown, moduleApiPath, sectionApiPath, HTB_CDN,
} from "../src/htb.js";

const ORIGIN = "https://enterprise.hackthebox.com";
const MOD = "9e65e8b8-9449-43e6-9edb-3327d9d1253f";
const SEC = "9e65ea05-79ff-4e22-9135-828075d0e291";
const SUF = "01a1b114-2b73-7357-af58-a68e28513eb8";

test("parses module and section page paths", () => {
  assert.deepEqual(parseHtbPath(`/content-page/module/${MOD}/${SUF}`),
    { moduleId: MOD, sectionId: null, suffix: SUF });
  assert.deepEqual(parseHtbPath(`/content-page/module/${MOD}/section/${SEC}/${SUF}`),
    { moduleId: MOD, sectionId: SEC, suffix: SUF });
  assert.deepEqual(parseHtbPath(`/content-page/module/${MOD}`),
    { moduleId: MOD, sectionId: null, suffix: null });
  assert.equal(parseHtbPath("/dashboard"), null);
});

test("matches only enterprise module pages", () => {
  const loc = (h, p) => ({ hostname: h, pathname: p });
  assert.ok(isHtbModulePage(loc("enterprise.hackthebox.com", `/content-page/module/${MOD}/${SUF}`)));
  assert.ok(!isHtbModulePage(loc("enterprise.hackthebox.com", "/dashboard")));
  assert.ok(!isHtbModulePage(loc("evil.com", `/content-page/module/${MOD}/${SUF}`)));
});

test("api paths carry the suffix only when present", () => {
  assert.equal(moduleApiPath(MOD, SUF), `/api/v1/content/module/${MOD}/${SUF}`);
  assert.equal(sectionApiPath(SEC, null), `/api/v1/content/section/${SEC}`);
});

test("section links follow page order", () => {
  const json = { data: { sections: [
    { content_id: "b", title: "Second  one", page: 2 },
    { content_id: "a", title: "First", page: 1 },
  ] } };
  assert.deepEqual(sectionLinks(json, ORIGIN, MOD, SUF), [
    { url: `${ORIGIN}/content-page/module/${MOD}/section/a/${SUF}`, title: "First" },
    { url: `${ORIGIN}/content-page/module/${MOD}/section/b/${SUF}`, title: "Second one" },
  ]);
  assert.deepEqual(sectionLinks({}, ORIGIN, MOD, SUF), []);
});

test("storage paths map to the CDN, other relatives to the origin", () => {
  assert.equal(resolveHtbUrl("/storage/modules/297/x.png", ORIGIN), `${HTB_CDN}/modules/297/x.png`);
  assert.equal(resolveHtbUrl("/foo", ORIGIN), `${ORIGIN}/foo`);
  assert.equal(resolveHtbUrl("https://a.b/c.png", ORIGIN), "https://a.b/c.png");
});

test("img tags become standalone markdown images", () => {
  const md = htbContentToMarkdown(
    'Intro\r\n<img class="website-screenshot" data-url="http://127.0.0.1:5000/" src="/storage/modules/1/a.png" alt="A &quot;q&quot; [x]">\r\nAfter',
    ORIGIN);
  assert.equal(md, `Intro\n\n![A "q" x](${HTB_CDN}/modules/1/a.png)\n\nAfter`);
});

test("cards become blockquotes with inline formatting", () => {
  const md = htbContentToMarkdown(
    '<div class="card bg-light">\n    <div class="card-body">\n        <p class="mb-0"><b>Note:</b> use <code>curl</code></p>\n    </div>\n</div>\n\n---\n## Next',
    ORIGIN);
  assert.equal(md, "> **Note:** use `curl`\n\n---\n## Next");
});

test("code fences are left untouched", () => {
  const src = "Text <img src=\"/storage/a.png\">\n```html\n<html><img src=\"/storage/b.png\"></html>\n```\n~~~\n![x](/y)\n~~~";
  const md = htbContentToMarkdown(src, ORIGIN);
  assert.ok(md.includes('<html><img src="/storage/b.png"></html>'));
  assert.ok(md.includes("![x](/y)"));
  assert.ok(md.includes(`![](${HTB_CDN}/a.png)`));
});

test("root-relative markdown links are absolutised", () => {
  assert.equal(htbContentToMarkdown("[m](/module/1) ![i](/storage/i.png) [p](//cdn/x)", ORIGIN),
    `[m](${ORIGIN}/module/1) ![i](${HTB_CDN}/i.png) [p](//cdn/x)`);
});

test("section json -> title and body with questions but no answers", () => {
  const out = sectionToMarkdown({ data: {
    title: "API title", content: "Body",
    questions: [
      { order: 2, question: "Second <b>q</b>", user_answer: "SECRET" },
      { order: 1, question: "First q", user_answer: "SECRET" },
    ],
  } }, ORIGIN, "Hint title");
  assert.equal(out.title, "Hint title");
  assert.equal(out.body, "Body\n\n### Questions\n\n1. First q\n2. Second q");
  assert.ok(!out.body.includes("SECRET"));
});
