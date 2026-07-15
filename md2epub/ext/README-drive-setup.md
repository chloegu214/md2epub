# Webpage to Markdown — Google Drive 配置说明

「保存到 Google Drive」功能通过 OAuth 授权实现（上架商店后将使用统一的官方 Client ID，用户一键授权即可）。开发阶段自行配置步骤：

## 1. 获取扩展 ID
1. 打开 `chrome://extensions`，开启开发者模式，加载本文件夹
2. 复制卡片上显示的 **ID**（32 位小写字母），例如 `abcdefghijklmnopabcdefghijklmnop`

> 注意：未打包扩展的 ID 与文件夹路径有关，换路径/换电脑会变。
> 想固定 ID，可在 manifest.json 里加 `"key"` 字段（打包一次后从
> `chrome://extensions` 详情页获取公钥），或保持文件夹路径不变。

## 2. 创建 Google Cloud 项目
1. 打开 https://console.cloud.google.com/ → 新建项目（名字随意）
2. 「API 和服务」→「库」→ 搜索 **Google Drive API** → 启用
3. 「API 和服务」→「OAuth 同意屏幕」→ 类型选 External →
   填应用名称和你的邮箱 → 在「测试用户」里添加你自己的 Google 账号
4. 「凭据」→「创建凭据」→「OAuth 客户端 ID」→
   应用类型选 **Chrome 扩展程序** → 粘贴第 1 步复制的扩展 ID → 创建
5. 复制生成的 Client ID（形如 `123456-xxxx.apps.googleusercontent.com`）

## 3. 填入 manifest.json
把 `manifest.json` 中的

```json
"client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com"
```

替换成你的 Client ID，然后在 `chrome://extensions` 里刷新扩展。

## 4. 使用
点击「保存到 Google Drive」→ 首次会弹出 Google 授权窗口 →
同意后文件会上传到 Drive 根目录，状态栏会给出「在 Drive 中打开」链接。

权限说明：使用的是 `drive.file` 最小权限范围——扩展只能访问
**它自己创建的文件**，看不到你 Drive 里的其他任何内容。

---
