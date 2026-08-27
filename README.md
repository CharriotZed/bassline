# czgts-publish

> ⚠️ 本仓库名为 `bassline`，但 skill 名是 `czgts-publish`（[SKILL.md](SKILL.md) 的 frontmatter `name` 字段）。
> 作为 Claude Code skill 安装时，**目录名必须与 skill 名一致**，所以 clone 时要显式指定目录：
> ```bash
> git clone https://github.com/CharriotZed/bassline.git czgts-publish
> ```
> 直接 `git clone` 会落地成 `bassline/`，目录名与 frontmatter 不匹配。

通过 CDP（Chrome DevTools Protocol）驱动「创作罐头」(Muse) 桌面客户端，复用其中已登录的账号会话，自动化地向 CSDN 等自媒体平台发文——不碰登录、不模拟鼠标点像素。

创作罐头是 Electron 套壳应用，运行时开着 Chrome DevTools 调试端口。每个登录的平台账号是一个 `type=webview` target，用原始 WebSocket 直连其 `webSocketDebuggerUrl` 即可驱动（Playwright 的 `connectOverCDP` 看不到 webview）。

## 依赖

```bash
npm install
```

只依赖 `ws`。需要 Node.js 18+（用到内置 `fetch`）。

## 组成

| 文件 | 作用 |
|------|------|
| `czgts.js` | 引擎：启动检测、列账号、开草稿、填正文(paste 保排版)、发布、核实、记录 |
| `clean-article.js` | 发布前清洗 AI 生成脚手架(建议标题/答案块标签等) + 硬门禁 |
| `cdp.js` | 极简 CDP over WebSocket 封装 |
| `SKILL.md` | 完整用法、工作流、踩坑记录 |

## 快速开始

```js
const z = require('./czgts');
const { cleanArticle, assertClean } = require('./clean-article');

const run = await z.ensureRunning();          // 软件没开会自动拉起
const accts = await z.listAccounts(run.port); // 先列账号,别发错号
const c = await z.connectPage(run.port, accts[0].targetId);

const body = cleanArticle(rawMarkdown, title); // 清洗脚手架
if (!assertClean(body).clean) throw new Error('脚手架残留,拒发');

await z.openNewDraft(c);
await z.fillArticle(c, title, body);
// 发布是公开不可逆动作,确认授权后再调
await z.openPublishPanel(c);
await z.publish(c, run.port);
```

详细流程、判据、踩坑见 [SKILL.md](SKILL.md)。

## 配置

引擎中的本地路径（客户端配置目录、输出 CSV 路径）目前为硬编码，按自己环境调整 `czgts.js` / `cdp.js` 顶部的常量。

## 免责声明

仅用于驱动**使用者自己拥有、已授权**的账号，发布使用者自己的内容。请遵守目标平台的服务条款与发文规则（含每日发文配额、内容审核规范）。使用者对发布行为及后果自负。
