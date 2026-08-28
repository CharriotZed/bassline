---
name: czgts-publish
description: Use when the user wants to auto-post, batch-publish, or draft articles to CSDN (or other self-media accounts) through the 创作罐头 / Muse (czgts) desktop app — driving its logged-in webview accounts via CDP instead of clicking the GUI. Triggers include 创作罐头, czgts, 批量发文, 自动发文, 多账号发布, CSDN 发文.
---

# 创作罐头 (czgts) 自动发文

## Overview
「创作罐头」(Muse 出品, `C:\Program Files (x86)\Muse\创作罐头\`, 内核域名 `www.czgts.cn`) 是 Electron 套壳应用, 运行时开着 Chrome DevTools 调试端口。可用 CDP 脚本连上**正在运行的实例**, 复用它里面已登录的 CSDN 账号会话直接发文 —— 不碰登录、不模拟鼠标点像素。

核心洞察: 每个登录的 CSDN 账号是一个 `type=webview` target。**Playwright 的 `connectOverCDP` 看不到 webview**(只暴露 `type=page`), 必须用原始 WebSocket 直连 target 的 `webSocketDebuggerUrl`。

## When to Use
- 用户想通过创作罐头批量/自动发文章到 CSDN
- 用户要多账号群发或各账号发不同内容
- 用户说"替我发""帮我发到 CSDN""批量发"并提到这个软件

**前提**: 创作罐头需运行且调试端口可达。**软件没开不用让用户手动开** —— 先调 `ensureRunning()` 自动拉起(见下方"自动启动")。软件关着直接连会 `fetch failed`。

## The Critical Pitfall (排版会糊掉)

CSDN Markdown 编辑器是 **cledit** (`PRE.editor__inner[contenteditable]` + `DIV.cledit-section` 子节点)。

**绝不能用 `document.execCommand('insertText')` 写正文** —— contenteditable 会把段落间空行 `\n\n` 全部折叠掉(实测 53 个空行→0 个), 整篇 Markdown 糊成一坨, 标题/代码块/表格全失效。

**唯一正确写法: 合成 paste 事件** (`ClipboardEvent` + `DataTransfer` 设 `text/plain`, dispatch 给 `.editor__inner`)。cledit 的粘贴处理会原样保留空行。且 cledit **无视程序构造的 DOM 选区和 execCommand**(全选/清空/Ctrl+A 都不生效, paste 只会在它自己光标处追加导致内容累加变脏)—— 所以**永远在干净的新建页 `/md/?not_checkout=1` 上一次性 paste**, 不要试图清空旧草稿重填。

`czgts.js` 的 `fillArticle()` 已封装正确写法, 直接用。

## The Critical Pitfall #2 (脚手架泄漏 = 封号风险)

SoloChorus 等生成器的原文常带 **AI 脚手架字段**:开头的"建议标题/备选标题（3个备选）"标题列表、"前置答案块/TL;DR"这类标签行、正文里的 `## H2：xxx` 前缀。**这些字段一旦随正文发出去,会被 CSDN 判定为 AI 垃圾内容,有封号风险**(2026-08-23 抖音篇实测泄漏"备选标题""前置答案块（TL;DR）"公开可见)。

脆弱写法(已废弃):按"文件顶部 + `---` 分隔线"切割 —— deepseek 至少 4 种脚手架形态(`# 建议标题`/`## 备选标题`/`## 1.建议标题`/**真标题在前、备选标题埋在后、全篇无 `---`**),位置假设一破就整块泄漏。

**唯一正确写法: 发布前必过 `clean-article.js`**:
- `cleanArticle(rawMd, title)` —— 按**模式**在任意位置删标题列表块、剥答案块/TL;DR 标签(保留正文)、去 `H2：` 前缀,返回可发布正文。
- `assertClean(body)` —— 硬门禁,扫残留脚手架,命中即 `{clean:false, hits}`,**拒发**。已焊进 `fillArticle()`(带脚手架的正文无法进编辑器,会抛错)。

## Workflow

引擎在 `czgts.js`(依赖同目录 `cdp.js` + `ws`, 已 npm install)。所有函数经真实发文验证。

```js
const z = require('./czgts');

// 0. 确保软件在运行(没开会自动拉起)。返回后 port 一定可用
const run = await z.ensureRunning();             // {running, port, launched}
if (!run.running) throw new Error('创作罐头启动失败');
const port = run.port;                           // 别用 readPort(),端口每次重启会变

// 1. 列出账号 —— 务必先做! webview顺序≠你以为的账号顺序, 别发错号
const accts = await z.listAccounts(port);
// [{targetId, url, title, account:'2601_xxxx', nick}]

// 2. 连到目标账号的 webview
const c = await z.connectPage(port, accts[0].targetId);

// 2.5 清洗脚手架(必做,防封号) —— 见 "Critical Pitfall #2"
const { cleanArticle, assertClean } = require('./clean-article');
const body = cleanArticle(rawMarkdown, title);   // 删标题列表/答案块标签/H2:前缀
if (!assertClean(body).clean) throw new Error('脚手架残留,拒发');

// 3. 开新建草稿页 → 填标题+正文(paste保排版)。openNewDraft 用 Page.navigate 完全可行(见下)
await z.openNewDraft(c);
const r = await z.fillArticle(c, title, body);   // fillArticle 内置 assertClean 二次保险
if (!r.ok) throw new Error('排版校验未过: ' + JSON.stringify(r));

// 4. 发布(仅在用户明确授权后!)。**跳过 saveDraft,直接 publish**——见下方"存草稿键盘失效"。
//    带封面时:openPublishPanel → setCover → publish(复用已开面板)
await z.openPublishPanel(c);
// await z.setCover(c, coverAbsPath);            // 可选封面
const p = await z.publish(c, port);              // 自包含:点击前快照success页,只认新增,不传articleId也安全
// p = {published, successUrl, articleId, tag}   // articleId 已从新success页回读

// 5. 记录到本地CSV(用管理后台"已发布"tab 核实, 别只信 success URL/HTTP200)
if (p.published) z.recordArticle({ account, title, articleId: p.articleId, url: z.publicUrl(account, p.articleId) });

z.closePage(c);
```

**发布前务必校验当前 webview 账号**(`cookie UserName === 目标账号`),webview 顺序会变,不校验会发错号。

### 批量发布首选 `publishBatch()`(别再手写 publish-*.js)
以前每个批量脚本都把「切号→定位webview→开草稿→校验账号→清洗→填充→标签→发布→记录」重写一遍,易漂移出 bug。现已收口进引擎:
```js
const results = await z.publishBatch([
  { account: '2601_xxx', phone: '188xxxx', title, body: rawMarkdown, tag: '游戏' },
  // ...每个号一篇
]);
// 内部逐篇: 配额预检(今日<2跳过) → 切号 → 开草稿 → 校验账号防发错 → cleanArticle+填充
//          → 标签 → publish(自包含) → recordArticle。串行(客户端一次只一个活跃webview,无法并发)。
// results: [{account,title,status,reason?,url?,aid?,ms}]; 同时写 ~/czgts-batch-log.jsonl(含失败原因,可复盘)
// status: PUBLISHED / quota(预检超限) / quota-hit(发布失败且已达上限) / dirty / no-webview
//         / draft / acct-mismatch / fill / no-tag / no-success / error
```
配套函数:`countPublishedToday(account)`(数本地CSV今日该号已发数)、`switchAccount(port,chipLabel)`(第2参数是**主界面 chip 上实际显示的文本**——老号是手机号、新号是账号名,按文本匹配;`jobs[].phone` 字段同理,填 chip 文本即可)、`findWebviewByAccount(port,account)`、`ensureTag(c,tag)`。

### 自动启动 (#1)
`ensureRunning()` 已封装,端口不可达时自动拉起软件。**正确启动方式 = `explorer.exe <主exe绝对路径>`**(走 shell 语义 = 等同双击),实测端口约 2 秒就绪。两个踩过的坑:
- **直接 spawn/Start-Process 主 exe 会立即自杀** —— `创作罐头.exe` 是 Electron stub,裸启动拿不到 shell 上下文就退出,不开调试端口。必须走 explorer。
- **别依赖桌面快捷方式** —— 桌面上可能根本没有那个 lnk。用 `findMainExe()` 动态定位:`Muse/<应用名>/<版本>/<应用名>.exe`(basename==应用目录名,排除 updater/crash 等辅助 exe)。
- 定位路径用 Node 的 fs(UTF-8 可靠);**别在 `node -e` 里写中文/反斜杠路径**,bash+node 双层转义会毁掉它,写成独立 .js 文件。

### 封面 (AI 自动生成)
生图复用现成脚本 `video-workflow-builder/scripts/generate_cover.py`(走 B站网关 gpt-image-2, key 在该 skill 的 .env):
```bash
python scripts/generate_cover.py --platform baijiahao --prompt "文章主题的画面描述,极简科技风,无文字" --output cover.png
```
`baijiahao`=1024x768 横版,最接近 CSDN 封面比例。生成后用 `setCover()` 喂给发布面板。

### 过审/存活核实 + 记录 (#3 #4)
判断一篇文章"是否真正公开存活",有三个已踩过的判据陷阱,和一个验证有效的正确姿势:

**❌ 三个陷阱(别用):**
1. **登录态 fetch 全是假 200** —— 在软件的登录 webview 里 fetch 自己文章(旧 `checkAudit`),作者 session 连**草稿**和**被判违规**的文章都能返 200+标题。分不清死活。
2. **只看 HTTP 状态不够** —— 要看渲染后的正文,不是状态码。
3. **裸 fetch 高频 → CSDN 返 521**(Cloudflare 限流),**521 ≠ 文章死**,只是被挡了。实测第一次过、之后全 521;误判成死亡就是又一次"假阴性"。

**✅ 正确姿势(`czgts-auto/verify-anon2.js` 实测有效):**
- **匿名访客视角**:直接用 **Node `fetch`**(天然不带 CSDN cookie = 真实访客),**不要**用登录 webview。
- **加完整浏览器头**:`User-Agent` + `Accept-Language` + `Referer:https://www.csdn.net/` + `sec-ch-ua`,否则易被反爬。
- **每篇间隔 6-15 秒**:CSDN 文章页是 SSR,正文 `#content_views` 直接在 HTML 里。慢速请求避 521。
- **判活判据**:`HTTP 200 && HTML 含 id="content_views" && 正文纯文本 > 200 字 && 无"审核中/审核未通过"字样`。**判死**:`404` 或含"文章不存在/审核未通过"(实测被判违规的文章会变 404 下架)。
- 遇 521 别当死亡 → 拉大间隔(15s)重测那几篇。

- `recordArticle()` 默认写 `%USERPROFILE%\czgts-published.csv`(可用 `CZGTS_CSV` 环境变量覆盖;字段=时间/账号/标题/公开链接/文章ID,按 articleId 幂等去重)。CSV 是"发布流水"≠"存活清单",核实后应补一列真实状态(正常公开/已下架)。
- 定期核实: 用 `CronCreate` 跑 `verify-anon2.js` 全量匿名核对。

**⚠️ `publishBatch` 报 PUBLISHED ≠ 文章存活。** 2026-08-28 实测:20 篇全部 PUBLISHED,其中 **2 篇随后被判"审核未通过"**、匿名访问返 404、从未公开。publish 只能确认"提交成功",平台之后的判定它看不到。**每批发完必须核实**,别把 PUBLISHED 数当成存活数上报。

**最省事的核实方式 = 流量券推广探针**(见下节):未过审的文章不在可推广列表里,`promoteBatch` 直接返回 `not-in-list`。发完就跑一次推广,哪篇 `not-in-list` 就是哪篇没过审——比单独查后台更早也更省事。

**要读确切状态就读管理后台**(权威):导航 `mp.csdn.net/mp_blog/manage/article`,tab 计数形如 `全部(4)/已发布(3)/审核中·未通过(1)/草稿箱(0)`,目标文章所在行的文字直接写"**审核未通过**"。定位方式:找 `a[href]` 含 articleId 的链接,再往上取父元素直到 `innerText` 长度 >60 即该行。
⚠️**别在 eval 字符串里写正则**——模板字面量转义会毁掉它(实测 `Invalid regular expression: missing /`),用 `indexOf`/字符串比较替代。

### 流量券推广 (`promote.js`)
文章发布后 CSDN 会发**流量券**(每日任务券, 如 +1500 曝光), 用在文章上可加曝光。手动路径: 创作中心-内容管理-用券推广 → 券卡片"去使用" → 弹出可选文章列表 → 选文章 → 确定。

```js
const P = require('./promote');
const results = await P.promoteBatch([
  { account: '2601_xxx', chipLabel: '2601_xxx', articles: [{ aid: '164117343', title: '完整标题' }] },
], { live: true });     // 默认 dry-run(只开弹窗+取消); live:true 才真点确定
// status: PROMOTED / dry-run / not-in-list / no-coupon / no-dialog / select-fail / confirm-fail
// 成功写 ~/czgts-promoted.csv(时间/账号/标题/文章ID/券信息, 按articleId幂等), 全过程写 ~/czgts-promote-log.jsonl
```

**⚠️ 弹窗列表项里没有 articleId**(无 data 属性、无链接, 只有标题文本), 所以只能**按标题匹配**。而账号里往往混着大量历史文章, 因此 `promoteBatch` 的安全设计必须保留:
- 只认调用方传入的标题白名单, **完全相等**匹配(绝不模糊/包含/按位置选)
- 每张券投出前打印列表里**不在白名单**的项, 便于事后核对没误选
- 白名单一篇都没命中 → 点取消退出, 不将就选别的
- 选中后校验"有且仅有目标项 class 含 active", 不符就取消
- 一张券只投一篇, 目标投完即停(**剩余券留着**, 不拿已投文章重复投、不投历史文)
- 用券**不可逆** → 默认 dry-run, 真投前先扫一遍看清各账号列表

**先 dry-run 扫描再真投**。2026-08-27 实测 10 个账号: 券共 54 张、今日 20 篇标题 20/20 命中, 但可选列表里合计 **61 篇历史技术文**(Tomcat/MySQL/SpringBoot 等), 其中一个号占 19 篇 —— 按位置或模糊匹配必然误选。

**`not-in-list` 是过审探针,不是故障。** 弹窗顶部写着"审核中文章不可被推广",所以**未过审的文章不会出现在可推广列表里**。2026-08-28 实测:20 篇里 18 篇 PROMOTED、2 篇 `not-in-list`,查管理后台确认这 2 篇正是"审核未通过"的那两篇。**用法**:每批发完直接跑一次 `promoteBatch`,返回 `not-in-list` 的就是没过审的——顺手推广、顺手体检,比事后逐篇查后台省事得多。看到 `not-in-list` 别去重试推广,去查那篇文章的审核状态。

## Quick Reference

| 元素 | 选择器 / 判据 |
|------|--------------|
| 启动软件 | `ensureRunning()` → `explorer.exe <主exe路径>`(非 spawn) |
| 主 exe 定位 | `Muse/<应用名>/<版本>/<应用名>.exe`, basename==目录名 |
| 调试端口 | `%AppData%\创作罐头\DevToolsActivePort` 第一行, 动态读 |
| CSDN 账号 target | `type=webview`, url 含 `csdn` |
| 当前账号 | cookie `UserName` / `UserNick` |
| 标题框 | `input[placeholder*="标题"]`, 原生 setter 填 |
| 正文编辑器 | `.editor__inner`, **paste 写入** |
| 新建空草稿 | 导航 `editor.csdn.net/md/?not_checkout=1` |
| 存草稿(慎用) | Ctrl+S 靠键盘事件, webview 非焦点时收不到→常失败。**优先跳过, 填完直接 publish** |
| 开新草稿判据 | `hasEd && hasTitle && len>=1`, **绝不看 ce**(cledit 长期 ce=false, fill 会自己置 true) |
| 脚手架清洗 | 发布前必过 `cleanArticle()`+`assertClean()`, 防"建议/备选标题、前置答案块、TL;DR"泄漏→封号 |
| 发布面板 | 点 `button.btn-publish` |
| 发布确认 | 面板内红色 `button.btn-b-red` (文字"发布文章") |
| **发布成功判据(权威)** | 读管理后台 `mp_blog/manage/article`, 文章进"已发布"tab。**别只信 success URL/HTTP 200** |
| 文章标签 | 必填; **只有带删除叉的 chip 才是已选中**——面板里那排无叉的 `.el-tag`(kubernetes/容器/云原生/mysql/android)是**待点击候选**,点了才算选上 |
| 加标签三条路径 | ①候选里有目标标签→直接 `click()` ②输入框手输+回车(placeholder=`请输入文字搜索，Enter键入可添加自定义标签`) ③兜底点第一个候选 |
| **每日发文上限(平台配额)** | CSDN=每账号每天 2 篇, 发满后发布被静默拒绝。这是**平台规则非工具限制**——其他平台(抖音/B站/百家号等)各有配额, 发前按平台查 |
| **配额在"提交"时扣, 不看审核结果** | 审核未通过的文章**照样占掉当天那个位置**, 不返还。所以一次被拒是**双倍损失**: 位置没了 + 什么都没发出去, 重写最早只能等次日配额。这决定了策略重心必须放在**发之前**(选题避开商业意图簇、正文守规则), 而不是"发出去再看, 不行就重写" |
| 账号切前台 | 点主界面(czgts.cn)账号 chip, 非 CDP activateTarget |
| chip 显示什么 | **不统一**:老号显示手机号(<手机号>),新号显示账号名(<账号名>)。`switchAccount` 按文本节点 includes 匹配,所以传谁取决于 chip 实际文本,两者都能点中 |
| 可用账号数 | **别按 accounts.json 推断**(它只维护了部分 phone→account 映射,照它算会漏掉只显示账号名的号)。发前 dump 一次 chip 实际文本:遍历 DOM 找自有文本匹配 `^1\d{10}$` 或 `^2601_\d+$` |
| 流量券页 | `mp.csdn.net/mp_blog/manage/traffic`(标题"流量券列表")。**别猜 `/manage/coupon` 或 `/manage/promotion`**——都 404 |
| "去使用"按钮 | `P.btn`(每张可用券一个; **是 `<p>` 不是 `<button>`**) |
| 用券弹窗 | `.traffic-dialog-blog` |
| 可推广文章项 | `.traffic-dialog-item`, 标题在 `p.title span.text`。**项里没有 articleId**(无 data 属性/无链接)→ 只能按标题匹配 |
| 文章选中态 | 点列表项后 class 追加 `active`(**无 radio/checkbox**) |
| 用券确定/取消 | `P.success` / `P.fail`(同样是 `<p>` 不是 `<button>`) |

## Common Mistakes

- **用 execCommand insertText 写正文** → 空行折叠, 排版全毁。永远用 paste。
- **在旧草稿上清空重填** → cledit 无视程序选区, 内容会累加变脏。永远开新建页。
- **发错账号** → webview 顺序不等于账号顺序。发前必须 `listAccounts` 确认。
- **靠 editor 页 toast 判断成败** → `"反馈已提交""请至少输入10个字"` 都是页面反馈表单的干扰元素, 会误判。存草稿看 `.save-message` 时间戳; 发布看 `/json/list` 的 success URL。
- **端口写死** → 每次重启变。用 `ensureRunning()` 返回的 port,或 `readPort()`。
- **软件没开就直连** → `fetch failed`。开头先调 `ensureRunning()`,别让用户手动开。
- **spawn 主 exe 启动** → stub 立即自杀,不开端口。必须 `explorer.exe <exe路径>`。
- **喂错封面 input** → 面板有 3 个 file input,只有 `.el-upload__input` 是封面,`.cfw-file-input` 是反馈表单。
- **⚠️ 平台每日发文配额(CSDN=每账号每天 2 篇)** → 这是**发布平台的规则,不是创作罐头工具的限制**;创作罐头是多平台管理器,接入的其他平台(抖音/B站/百家号/小红书等)各有各的配额,发前按目标平台查清。CSDN 发满 2 篇后:草稿能存、标签能加、发布按钮也点得到,但平台**静默拒绝发布**(publish 返回 false、文章仍在草稿箱、管理后台"已发布"不增加)。**别把它误判成"按钮没点到/webview 冻结/saveDraft 假阴性"反复重试**——发前先数该账号当天已发数,到上限就等次日配额刷新。(2026-08-21 实测踩坑:三个 CSDN 号各发满 2 篇后,新三篇怎么发都失败,折腾多轮才发现是配额。)
- **checkAudit(HTTP 200)不能证明"已发布/已过审"** → 作者登录态访问自己**草稿**的公开链接也返 200+标题;被判**广告营销**的文章照样返 200。唯一权威判据 = 读管理后台 `mp.csdn.net/mp_blog/manage/article` 的 tab 计数(文章进"已发布"、不在"草稿箱/审核中·未通过")。
- **⚠️ "新草稿未就绪/webview 冻结"多半是误报,真凶是 `openNewDraft` 卡在 `ce==='true'`** → 血泪教训(2026-08-23):cledit 在 `Page.navigate` 后**长期停在 `contenteditable=false`**,而 `fillArticle()` 内部自己会强制 ce=true 再 paste,填充**根本不依赖 ce**。旧就绪判据死等 ce==='true' 这个永不到来的状态,把每次导航都误报成"冻结",折腾整整一轮。**结论:自己 `Page.navigate` 编辑器 webview 完全可行,不用靠应用打开;openNewDraft 判据只看 `hasEd && hasTitle && len>=1`,绝不看 ce**(已在引擎修好)。多账号串行只需切账号(点主界面 czgts.cn 的手机号 chip)+ 逐个导航,不会真冻结。
- **⚠️ `saveDraft`(Ctrl+S)靠键盘事件,webview 非 OS 焦点时收不到 → articleId 永不出现、误判失败** → 别卡在存草稿上反复重试。**填充成功后直接 `publish()`**——publish 是 DOM 点击(`element.click()`),不依赖键盘焦点,节流下照常工作(标签也这么加)。"手动点发布能成"正是此理。publish 本身就持久化文章,不需要先存草稿;aid 从新出现的 `creation/success/{aid}` 页提取。
- **⚠️ `publish` 返 `no-success` 而配额没满 → 先查标签是不是"从来没真加上"** → 血泪教训(2026-08-27,20篇批量里1篇卡死,查了三轮):CSDN 发布面板会渲染一排**待点击候选标签**(kubernetes/容器/云原生/mysql/android),它们同样是可见 `.el-tag`,**但没有删除叉**——点了才算选上。引擎当时有三处把候选误当已选中: ①`ensureTag` 开头只看 `.el-tag` 数量非空就 return,直接跳过加标签 ②它的 return 同样不过滤,加标签失败时仍报告"有5个标签",把失败一路掩盖到 publish 才暴露 ③`publish` 前置检查读了 `hasClose` 却没让它参与判断,拿到 `kubernetes` 文本非空就放行。结果:标签必填未满足→平台**静默拒绝发布**,表现和"配额耗尽/按钮没点到"一模一样。**判据:只认带删除叉的 chip**(引擎已加 `SELECTED_TAGS_JS` 统一此判据,三处共用)。这 bug 平时被 CSDN 自动带标签掩盖,只在候选没命中目标标签时才暴露。
- **⚠️ `ensureTag` 无条件点"添加文章标签"会把已开的面板 toggle 关掉** → 关掉后 `DOM.focus`+`insertText` 打在**不可见**输入框上静默落空,标签永远加不上。必须先判 `.mark_add_tag` 是否可见,没开才点。手输路径也要确认输入框可见(`DOM.getBoxModel` 拿不到就跳过)。
- **⚠️ 流量券推广:按位置/模糊匹配选文章 = 必然误选到历史文章** → 弹窗列表项**没有 articleId**(无 data 属性、无链接,只有标题文本),所以只能按标题匹配,而列表里混着账号本周期内的所有文章。2026-08-27 实测 10 个账号:今日 20 篇全部命中,但可选列表里合计 **61 篇历史技术文**(Tomcat/MySQL/SpringBoot 等),其中一个号占 19 篇。**必须传标题白名单 + 完全相等匹配 + 没命中就取消退出**;选中后再校验"有且仅有目标项 class 含 active"。用券不可逆,真投前先 dry-run 扫一遍各账号列表。
- **⚠️ 流量券页面路径别猜,去导航菜单里读** → 猜的 `/mp_blog/manage/coupon`、`/mp_blog/manage/promotion` 都 404。真实路径 `/mp_blog/manage/traffic`,而且它在侧边菜单里是**折叠隐藏**的(`a[href]` 存在但 `offsetParent===null`),扫"可见链接"扫不到 —— 要扫全部 `a[href]` 并按 `/推广|券/` 文本或 `promot|coupon|traffic` href 过滤。
- **⚠️ 用券弹窗的按钮都是 `<p>` 不是 `<button>`** → "去使用"=`P.btn`、确定=`P.success`、取消=`P.fail`。用 `querySelectorAll('button')` 找一个都找不到(实测第一轮探查就因此判定"未找到去使用按钮",而页面文本里明明有)。选中机制也没有 radio/checkbox,靠点列表项后 class 追加 `active`。**这个站点多处如此(标签 chip 同理),扫按钮时别按标签名过滤,按自有文本扫全部元素。**
- **⚠️ 把 `publishBatch` 的 PUBLISHED 数当成"存活数"上报** → 2026-08-28 实测 20 篇全 PUBLISHED,2 篇随后被判**审核未通过**、匿名访问 404、从未公开。publish 只确认"提交成功"。**每批发完必核实**(最省事:跑一次 `promoteBatch`,`not-in-list` 的就是没过审的)。
- **⚠️ "符合全部生成规则"不保证过审, 而被拒的代价是不可回收的** → 164144198 是纯知识意图、品牌仅 4 次(全批最低)、答案块只一句带过还紧跟自我贬抑、有诚实局限段、开源占主体——按现有规则最安全的一篇,依然被拒。而同批两篇带"工具横评"的却过了。**生成侧规则只降低概率,不决定结果**。
  **关键: 配额在提交时就扣, 审核未通过不返还**(见 Quick Reference)。所以"发出去再看, 不行就重写"这个思路是错的——被拒等于白扔一个当天位置, 重写最早等次日。**正确姿势是把成本花在发之前**: ①选簇避开商业意图(见下条) ②每批发布**先挑 1-2 篇试投**、确认过审再铺开剩下的, 别 20 篇一次性梭 ③标题主框架用行为词("怎么做/制作方法")而非选型词("工具横评/怎么选")。样本积累在 `czgts-badcases.md`。
- **被判广告营销的诱因是"商业意图簇"**,不是品牌次数 → 命中"XX 软件/下载/哪个好"这类找付费软件的搜索意图,文章天然像软件推广被判违规(163953064 实测)。选簇优先"怎么写/怎么做/原理/教程"知识意图;答案块里品牌只作"一个可选方案"一句带过,别连列产品功能;标题别含"软件/下载"。建议本地维护一份 badcase 清单积累被判违规的特征。

## Safety

- **默认只到"存草稿"为止**。存草稿不公开、可逆。
- **发布是公开且不易撤回的动作** —— 只有在用户**明确说"发布"**后才调 `publish()`。一次授权不覆盖下一篇。
- 批量发文在每篇之间留随机间隔(建议数分钟), CSDN 对短时间高频发文有风控。
- 这是用户自己的软件/账号/内容, 授权明确。
