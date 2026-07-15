# MD2EPUB — Bind the Web into Books 把网页装订成书

**MD2EPUB** is a Chrome extension that converts Markdown-born webpages (docs
sites, tech blogs) into clean **Markdown** or **EPUB** ebooks — and
batch-binds a whole article series into a single book with a full table of
contents and embedded images, ready for Kindle.

MD2EPUB 是一款 Chrome 插件：把源自 Markdown 的网页（技术博客、文档站）一键转成
干净的 Markdown 或 EPUB 电子书，还能把整个专题的几十篇文章装订成一本带完整目录、
内嵌插图的书，直接送进 Kindle。

🌐 **Website / 官网**: https://chloegu214.github.io/md2epub/

## Features 功能

- **Single-page conversion 单页转换** — any webpage → clean Markdown / EPUB, tables and code blocks preserved
- **Series binding 专题装订** — scan a series index page, sort by chapter, merge dozens of articles into one book
- **Real table of contents 完整目录** — standard EPUB TOC, jump to any article on Kindle
- **Offline images 图片离线** — optionally embed every illustration into the book
- **Background binding 后台装订** — jobs survive tab switches; live progress on the icon; auto-download when done
- **Save to Drive 存入 Drive** — optionally upload the finished book to Google Drive (great for Kindle Scribe)
- **Local & private 本地转换** — everything converts on your machine; your content never touches a server
- **Bilingual UI** — English / 简体中文 / 繁體中文

## Send to Kindle 送进 Kindle

The finished EPUB is a standard file: send it via **Send to Kindle** (web,
email, or app) and Amazon converts and delivers it automatically; Kindle
Scribe owners can also import straight from Google Drive.

## Repository layout 仓库结构

```
docs/       Official website (static, bilingual) — served by GitHub Pages
md2epub/    Extension source — see md2epub/README.md for build & architecture
```

## Build 构建

```bash
cd md2epub
npm install
npm run build    # -> dist/md2epub.zip
```

For local development, load `md2epub/ext/` as an unpacked extension at
`chrome://extensions` (Developer mode → Load unpacked) after a build.

## License

Proprietary — © Limitless Ladies Minds Inc.

---

*MD2EPUB is an independent tool — not affiliated with or endorsed by Amazon.
Kindle is a trademark of Amazon.com, Inc.*
