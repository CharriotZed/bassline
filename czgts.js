// 创作罐头(Muse, Electron套壳, 内核www.czgts.cn) CDP自动发文引擎。
// 复用软件里已登录的CSDN账号会话，驱动 editor.csdn.net Markdown编辑器。
// 用法见同目录 SKILL.md。所有函数经真实发文验证。
const fs = require('fs');
const path = require('path');
const { CDP } = require('./cdp');

const { execFile } = require('child_process');
const os = require('os');
// 客户端配置目录下的调试端口文件。默认 %APPDATA%\创作罐头\...,可用 CZGTS_PORT_FILE 覆盖。
const PORT_FILE = process.env.CZGTS_PORT_FILE
  || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '创作罐头', 'DevToolsActivePort');
const MUSE_BASE = process.env.CZGTS_MUSE_BASE || 'C:\\Program Files (x86)\\Muse';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 动态定位主exe: Muse/<应用名>/<版本>/<应用名>.exe (basename==应用目录名)
function findMainExe() {
  const appDir = fs.readdirSync(MUSE_BASE)[0];
  const appPath = path.join(MUSE_BASE, appDir);
  const verDir = fs.readdirSync(appPath).find(d => /^\d+\.\d+/.test(d));
  const verPath = path.join(appPath, verDir);
  const exes = fs.readdirSync(verPath).filter(f => f.endsWith('.exe'));
  const main = exes.find(f => path.basename(f, '.exe') === appDir);
  return main ? path.join(verPath, main) : null;
}

// 调试端口每次重启会变，动态读第一行
function readPort() {
  return fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0].trim();
}

// 端口是否可达(软件是否在运行且开着调试端口)
async function portReachable(port) {
  port = port || (() => { try { return readPort(); } catch (e) { return null; } })();
  if (!port) return false;
  try {
    const ctrl = AbortSignal.timeout(3000);
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctrl });
    return r.ok;
  } catch (e) { return false; }
}

// 确保创作罐头在运行且调试端口可达。已在运行则直接返回端口。
// 关键:必须用 `explorer.exe <exe绝对路径>` 启动(等同双击, 走shell语义)才会开调试端口。
// 直接 spawn 主exe 会立即自杀(它是Electron stub, 拿不到shell上下文)——实测确认。
// 注意:不要用桌面快捷方式(可能不存在); 用 findMainExe() 动态定位exe。
// 返回 {running, port, launched}。超时未就绪返回 {running:false}。
async function ensureRunning({ waitMs = 90000 } = {}) {
  if (await portReachable()) return { running: true, port: readPort(), launched: false };
  const exe = findMainExe();
  if (!exe) return { running: false, launched: false, reason: '未找到主exe' };
  await new Promise((resolve) => {
    execFile('explorer.exe', [exe], () => resolve());  // explorer打开exe=双击语义
    setTimeout(resolve, 1500);
  });
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (await portReachable()) return { running: true, port: readPort(), launched: true };
  }
  return { running: false, launched: true };
}

// 浏览器级端点，用于 Target.getTargets（能看到 type=webview，Playwright看不到）
async function browserCDP(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const bc = new CDP(ver.webSocketDebuggerUrl);
  await bc.connect();
  return bc;
}

// 列出所有 CSDN webview 及其登录账号(读cookie UserName)。返回 [{targetId, url, title, account}]
async function listAccounts(port) {
  port = port || readPort();
  const bc = await browserCDP(port);
  const { targetInfos } = await bc.send('Target.getTargets');
  const csdn = targetInfos.filter(t => t.type === 'webview' && /csdn/.test(t.url));
  const out = [];
  for (const t of csdn) {
    const c = new CDP(`ws://127.0.0.1:${port}/devtools/page/${t.targetId}`);
    try {
      await c.connect();
      await c.send('Runtime.enable');
      const acct = await c.eval(`(function(){
        const u=(document.cookie.match(/UserName=([^;]+)/)||[])[1]||null;
        const n=decodeURIComponent((document.cookie.match(/UserNick=([^;]+)/)||[])[1]||'');
        return {user:u, nick:n};
      })()`).catch(() => ({ user: null, nick: null }));
      out.push({ targetId: t.targetId, url: t.url, title: t.title, account: acct.user, nick: acct.nick });
    } catch (e) {
      out.push({ targetId: t.targetId, url: t.url, title: t.title, account: '(读取失败)' });
    } finally { c.close(); }
  }
  bc.close();
  return out;
}

// 连到指定 targetId 的页面，返回激活好的 CDP 客户端
async function connectPage(port, targetId, { activate = true } = {}) {
  const bc = await browserCDP(port);
  if (activate) await bc.send('Target.activateTarget', { targetId }).catch(() => {});
  const c = new CDP(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await c.connect();
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  await c.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  c._browser = bc;       // 保留引用便于统一关闭
  c._targetId = targetId; // openNewDraft 重试时用它重新 activateTarget 唤醒冻结的webview
  return c;
}

function closePage(c) { try { c.close(); } catch (e) {} try { c._browser && c._browser.close(); } catch (e) {} }

// 在指定webview里打开新建草稿页，等cledit进入托管态(ce=true)。返回 {ok, len, hasTemplate, tries}
// 注意:新建页常自带CSDN默认模板("欢迎使用Markdown编辑器"~4900字), 属正常; fillArticle会先清空。
// 就绪判据是"托管态"而非"空", 因为cledit只在托管态下才认execCommand清空。
// ⚠️就绪判据只看 hasEd && hasTitle && len>=1，绝不要求 ce==='true'。
// 血泪教训(2026-08-23): cledit 在 navigate 后长期停在 ce=false,fillArticle 内部会自己强制
// ce=true 再 paste——填充根本不依赖 ce。之前 gate 在 ce==='true' 上死等一个永不到来的状态,
// 把每次 navigate 都误报成"draft-frozen/webview冻结",折腾了整整一轮才发现 navigate 一直是好的。
// (自己 Page.navigate 编辑器 webview 完全可行, 不需要靠应用打开。)
async function openNewDraft(c, { attempts = 2 } = {}) {
  for (let a = 0; a < attempts; a++) {
    await c.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    if (c._browser && c._targetId) await c._browser.send('Target.activateTarget', { targetId: c._targetId }).catch(() => {});
    await c.send('Page.navigate', { url: 'https://editor.csdn.net/md/?not_checkout=1' });
    for (let i = 0; i < 40; i++) {
      const st = await c.eval(`(function(){
        const e=document.querySelector('.editor__inner');
        const ti=document.querySelector('input[placeholder*="标题"]');
        const txt=e?(e.innerText||''):'';
        return {hasEd:!!e, ce:e?e.getAttribute('contenteditable'):null, len:txt.length, hasTitle:!!ti, hasTemplate:/欢迎使用Markdown|@\\[TOC\\]/.test(txt)};
      })()`).catch(() => ({ hasEd: false }));
      // 放宽判据:编辑器DOM + 标题框都在, 内容非空(模板或空白页都行)。不看 ce。
      if (st.hasEd && st.hasTitle && st.len >= 1) return { ok: true, len: st.len, ce: st.ce, hasTemplate: st.hasTemplate, tries: a + 1 };
      await sleep(500);
    }
  }
  return { ok: false, tries: attempts };
}

// 核心：填标题 + paste整篇markdown(保留空行)。title为字符串，body为markdown字符串。
// **发布前硬门禁**: 用 clean-article 扫描AI脚手架残留(建议/备选标题列表、前置答案块/TL;DR标签、H2:前缀),
// 命中即抛错拒填——这些字段发出去会被判AI垃圾内容, 有封号风险(实测抖音篇曾泄漏"备选标题/前置答案块")。
// 调用方应先用 cleanArticle() 清洗再传入; 本门禁是最后一道保险。
// 返回严格校验结果 {ok, len, nn, sec, srcLen, srcNn, head, tail}
async function fillArticle(c, title, body) {
  body = body.replace(/\r\n/g, '\n');
  const { assertClean } = require('./clean-article');
  const gate = assertClean(body);
  if (!gate.clean) throw new Error('拒绝填充:正文含AI脚手架残留(封号风险)→ ' + JSON.stringify(gate.hits) + ' 。请先过 cleanArticle() 清洗。');
  const srcNn = (body.match(/\n\n/g) || []).length;

  // 填标题（原生setter绕React受控）
  await c.eval(`(function(){
    const el=document.querySelector('input[placeholder*="标题"]');
    const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    s.call(el, ${JSON.stringify(title)});
    el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);

  // 先清空已有内容(默认模板 或 webview残留的上一篇)。
  // ⚠️血泪(2026-08-26): 必须先强制 ce=true 再 delete——cledit 在 navigate 后停在 ce=false,
  // 非托管态下 execCommand('delete') 静默无效,啥也没删,紧接着 paste 就把新正文追加在残留内容后面,
  // 叠成"两篇合一"(实测 076 残留上一篇→7997字, 幸被 fillArticle 长度校验拦下未发)。
  // 所以: 每轮先 ce=true 再全选删除, 删完验证是否清空, 没清干净就重试(最多3轮)。
  let cleared = false;
  for (let k = 0; k < 3; k++) {
    const remain = await c.eval(`(function(){
      const ed=document.querySelector('.editor__inner');
      ed.setAttribute('contenteditable','true'); ed.focus();
      const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(ed);
      sel.removeAllRanges(); sel.addRange(r);
      document.execCommand('delete',false,null);
      return (ed.innerText||'').trim().length;
    })()`);
    if (remain <= 2) { cleared = true; break; }
    await sleep(400);
  }
  if (!cleared) return { ok: false, reason: 'clear-failed', ...(await c.eval(`(function(){const e=document.querySelector('.editor__inner');return {len:(e.innerText||'').length};})()`)) };
  await sleep(300);

  // paste整篇：cledit的粘贴处理会原样保留空行。绝不用execCommand insertText(会折叠空行毁排版)
  await c.eval(`(function(){
    const ed=document.querySelector('.editor__inner');
    ed.setAttribute('contenteditable','true'); ed.focus();
    const sel=window.getSelection(); const r=document.createRange(); r.selectNodeContents(ed); r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    const dt=new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(body)});
    const ev=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:dt});
    ed.dispatchEvent(ev);
  })()`);
  await sleep(2500);

  const chk = await c.eval(`(function(){
    const ed=document.querySelector('.editor__inner');
    const secs=[...ed.querySelectorAll('.cledit-section')];
    const src=secs.map(s=>s.textContent).join('');
    return {nn:(src.match(/\\n\\n/g)||[]).length, sec:secs.length, len:src.length, head:src.slice(0,50), tail:src.slice(-50)};
  })()`);
  const lenOK = Math.abs(chk.len - body.length) < 300;
  const nnOK = chk.nn >= srcNn * 0.9;
  return { ok: lenOK && nnOK, ...chk, srcLen: body.length, srcNn };
}

// 触发保存草稿(Ctrl+S)，轮询save-message与articleId。返回 {saved, articleId, saveMsg}
// 关键:webview非OS焦点时单次Ctrl+S常收不到——所以在轮询里每隔几轮重发一次(而非只发一次),
// 直到articleId出现。这是"填充成功却卡住存不进"的根因(实测CSDN虽有自动保存兜底,但不能依赖它的时机)。
async function saveDraft(c) {
  const sendCtrlS = async () => {
    await c.eval(`(function(){const ed=document.querySelector('.editor__inner');ed.focus();
      const sel=window.getSelection();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);
      sel.removeAllRanges();sel.addRange(r);})()`).catch(() => {});
    await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, windowsVirtualKeyCode: 83, code: 'KeyS', key: 's' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, windowsVirtualKeyCode: 83, code: 'KeyS', key: 's' });
  };
  await sendCtrlS();
  // 判据: articleId 落到 URL 本身就是服务端已建草稿的铁证, 以它为准。
  // 别要求 "已保存"文字 + articleId 同时命中——两者出现有时间差(实测articleId比提示晚),
  // 强求同时会在窗口内误报失败。轮询到 aid 即成功; 延长到 ~50s 更稳。
  let saveMsg = '', aid = null;
  for (let i = 0; i < 25; i++) {
    await sleep(2000);
    const st = await c.eval(`(function(){return {save:document.querySelector('.save-message')?.textContent?.trim()||'', url:location.href};})()`);
    saveMsg = st.save; aid = (st.url.match(/articleId=(\d+)/) || [])[1];
    if (aid) break;   // articleId 一出现即落库成功
    if (i % 4 === 3) await sendCtrlS();   // 每~8s重发一次Ctrl+S,防单次键事件丢失
  }
  return { saved: !!aid, articleId: aid, saveMsg };
}

// 从服务器重载草稿读回验证(硬验证持久化)。返回 {ok, title, len, nn, head}
async function verifyDraft(c, articleId, expect = {}) {
  await c.send('Page.navigate', { url: `https://editor.csdn.net/md/?articleId=${articleId}` });
  let len = 0;
  for (let i = 0; i < 60; i++) {
    len = await c.eval(`(function(){const e=document.querySelector('.editor__inner');return e?(e.innerText||'').length:-1;})()`).catch(() => -1);
    if (len > 500) break;
    await sleep(500);
  }
  const r = await c.eval(`(function(){
    const ed=document.querySelector('.editor__inner');
    const secs=[...ed.querySelectorAll('.cledit-section')];
    const src=secs.map(s=>s.textContent).join('');
    return {title:document.querySelector('input[placeholder*="标题"]')?.value||'', nn:(src.match(/\\n\\n/g)||[]).length, len:src.length, head:src.slice(0,50)};
  })()`);
  const ok = r.len > (expect.minLen || 100) && (!expect.head || r.head.startsWith(expect.head));
  return { ok, ...r };
}

// 打开发布面板(点btn-publish)。返回是否成功打开(面板红色确认按钮出现)。
async function openPublishPanel(c) {
  await c.eval(`(function(){
    const b=[...document.querySelectorAll('button')].find(x=>x.classList.contains('btn-publish')&&x.offsetParent!==null&&/发布文章/.test(x.textContent||''));
    if(b) b.click();
  })()`);
  await sleep(2500);
  return await c.eval(`!!document.querySelector('button.btn-b-red')`);
}

// 设封面：把本地图片喂给发布面板的 input.el-upload__input。
// 实测直接喂文件即可,不触发裁剪弹窗。**前提:发布面板已打开**(先调openPublishPanel)。
// coverPath需绝对路径(反斜杠)。返回 {ok, reason}。注意:不回读图片base64(会撑爆输出)。
async function setCover(c, coverPath) {
  await c.send('DOM.enable');
  const doc = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input.el-upload__input' });
  if (!nodeIds.length) return { ok: false, reason: 'no-cover-input(发布面板可能没开)' };
  await c.send('DOM.setFileInputFiles', { nodeId: nodeIds[0], files: [coverPath] });
  await sleep(3500);
  // 若意外弹出裁剪框,点其中的确认(防御性,实测通常不弹)
  await c.eval(`(function(){
    const crop=document.querySelector('.vue-image-crop-upload');
    if(crop && crop.offsetParent!==null){
      const ok=[...crop.querySelectorAll('button')].find(b=>/确定|确认|完成|上传/.test(b.textContent||'')&&b.offsetParent!==null);
      if(ok) ok.click();
    }
  })()`);
  await sleep(1000);
  // 校验:封面预览img的src是否变成了图片数据(只看前缀/有无,不回读全部base64)
  const ok = await c.eval(`(function(){
    const img=[...document.querySelectorAll('.container-coverimage-box img, [class*="cover"] img')].find(i=>i.src && !i.src.includes('not_checkout') && (i.src.startsWith('data:image')||/csdnimg|blob:/.test(i.src)));
    return !!img;
  })()`);
  return { ok, reason: ok ? 'cover-set' : '未检测到封面预览,可能未设上' };
}

// 发布：开面板→确认标签→点红色btn-b-red→查success URL。
// 返回 {published, successUrl, articleId, tag}。发布是公开不可逆动作，调用方须已获用户明确授权。
// 若外部已用openPublishPanel开好面板(比如为了先设封面),本函数会复用不重开。
// articleId 可选:传了就用它精确匹配 creation/success/{articleId}。
// **不传也安全**——本函数在点击前快照已有的 success 页集合,只认"点击后新出现"的那条,
// 因此不会误抓上一篇残留的成功页(那些webview不会自动关)。articleId 从成功页URL回读并返回。
async function publish(c, port, articleId) {
  // 面板没开才开(兼容外部已开好+设过封面的情况)
  const panelOpen = await c.eval(`!!document.querySelector('button.btn-b-red')`);
  if (!panelOpen) await openPublishPanel(c);
  await sleep(500);
  // 确认标签已选中(chip带删除叉)
  const tag = await c.eval(`(function(){
    const t=[...document.querySelectorAll('.el-tag')].find(x=>x.offsetParent!==null&&(x.textContent||'').trim());
    return t?{text:(t.textContent||'').trim(),hasClose:!!t.querySelector('[class*="close"]')}:null;
  })()`);
  if (!tag || !tag.text) return { published: false, reason: 'no-tag', tag };
  // 点击前快照已有 success 页——无论调用方传不传 articleId 都能只认新增,不误抓残留成功页
  const before = new Set((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
    .filter(t => /mp_blog\/creation\/success\//.test(t.url)).map(t => t.url));
  // 点红色最终确认
  await c.eval(`(function(){
    const pub=[...document.querySelectorAll('button.btn-b-red')].find(b=>/发布文章/.test(b.textContent||'')&&b.offsetParent!==null);
    if(pub) pub.click();
  })()`);
  // 结果判据：出现 creation/success/ 的新 webview（别看editor页toast，那是反馈表单干扰）。
  // 传了articleId用严格匹配; 没传就认"点击后新出现"的success页(before-diff)。
  const strictRe = articleId ? new RegExp('mp_blog/creation/success/' + articleId + '\\b') : null;
  let successUrl = null;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const s = list.find(t => {
      if (!/mp_blog\/creation\/success\//.test(t.url)) return false;
      return strictRe ? strictRe.test(t.url) : !before.has(t.url);
    });
    if (s) { successUrl = s.url; break; }
  }
  const aid = articleId || (successUrl && (successUrl.match(/success\/(\d+)/) || [])[1]) || null;
  return { published: !!successUrl, successUrl, articleId: aid, tag: tag.text };
}

// 拼公开浏览链接
function publicUrl(account, articleId) {
  return `https://blog.csdn.net/${account}/article/details/${articleId}`;
}

// 弹Windows气泡通知(浮在所有窗口最上层, 非阻塞)。解决"创作罐头置顶时看不到终端、不知道
// 脚本卡住还是在等间隔"的问题——每步进度都推一条, 用户始终看得到当前在干什么。
// title/msg为字符串; 失败静默(通知只是辅助, 不该影响主流程)。
function notify(title, msg) {
  try {
    const ps = `
$ErrorActionPreference='SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
$n=New-Object System.Windows.Forms.NotifyIcon
$n.Icon=[System.Drawing.SystemIcons]::Information
$n.Visible=$true
$n.ShowBalloonTip(4000, ${JSON.stringify(title)}, ${JSON.stringify(msg)}, [System.Windows.Forms.ToolTipIcon]::Info)
Start-Sleep -Milliseconds 4200
$n.Dispose()`.trim();
    // detached, 不阻塞主流程
    require('child_process').spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {}
}

// 检查文章是否已过审公开。判据:在登录webview里fetch公开链接, 200+含标题+无审核提示=已过审。
// c=已连接的该账号webview; 返回 {passed, status, reason, url}
async function checkAudit(c, account, articleId, titleSnippet) {
  const url = publicUrl(account, articleId);
  const snip = (titleSnippet || '').slice(0, 12);
  const r = await c.eval(`(async function(){
    try{
      const resp = await fetch(${JSON.stringify(url)}, {credentials:'include'});
      const html = await resp.text();
      return {
        status: resp.status,
        hasTitle: ${JSON.stringify(snip)} ? html.includes(${JSON.stringify(snip)}) : true,
        auditHint: /审核中|待审核|正在审核/.test(html.slice(0,4000)),
        gone: /文章不存在|已删除|页面不存在|404/.test(html.slice(0,4000))
      };
    }catch(e){ return {err:e.message}; }
  })()`).catch(e => ({ err: e.message }));
  if (r.err) return { passed: false, reason: 'fetch失败:' + r.err, url };
  if (r.status === 200 && r.hasTitle && !r.auditHint && !r.gone) return { passed: true, status: 200, url };
  let reason = r.gone ? '文章不存在/已删除' : r.auditHint ? '审核中' : `status=${r.status} hasTitle=${r.hasTitle}`;
  return { passed: false, status: r.status, reason, url };
}

// 默认CSV路径(和recordArticle一致)
function defaultCsvPath() {
  return process.env.CZGTS_CSV || path.join(os.homedir(), 'czgts-published.csv');
}

// 统计某账号"今天"已发布篇数——用于发布前配额预检(CSDN每账号每天2篇上限)。
// 数据源=本地CSV(recordArticle写的发布流水),100%可靠、无需抓管理页DOM。
// ⚠️盲区:只统计"本流水线发过的",不含你手动在别处发的。若同一天也手动发过,以管理后台"已发布"tab为权威。
// 返回今天该账号的行数。CSV时间列由 toLocaleString('zh-CN') 写入,今天前缀=toLocaleDateString('zh-CN')(如 2026/8/26)。
function countPublishedToday(account, csvPath) {
  csvPath = csvPath || defaultCsvPath();
  let text = '';
  try { text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, ''); } catch (e) { return 0; }
  const today = new Date().toLocaleDateString('zh-CN'); // 无补零,与写入格式一致
  const lines = text.trim().split(/\r?\n/).slice(1); // 跳表头
  let n = 0;
  for (const line of lines) {
    // 字段可能带引号(新行)或不带(旧行);逐字段去引号解析前两列足够
    const fields = line.split(',').map(f => f.replace(/^"|"$/g, ''));
    const timeCol = fields[0] || '', acctCol = fields[1] || '';
    if (acctCol === account && timeCol.startsWith(today)) n++;
  }
  return n;
}

// 记录过审文章到本地CSV(Excel可直接打开)。字段:时间,账号,标题,公开链接,articleId
// 默认写 用户主目录\czgts-published.csv(可用 CZGTS_CSV 环境变量或第2参数覆盖), 幂等去重(同articleId不重复写)
function recordArticle({ account, title, articleId, url }, csvPath) {
  csvPath = csvPath || process.env.CZGTS_CSV || path.join(os.homedir(), 'czgts-published.csv');
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = '发布时间,发布账号,标题,公开浏览链接,文章ID';
  let existing = '';
  try { existing = fs.readFileSync(csvPath, 'utf8'); } catch (e) {}
  // 去重:articleId字段(带引号,行末最后一列)已存在则跳过。
  // 注意用 ,"id" 精确匹配字段, 不能用裸 ,id —— URL列里也含id(/details/id)会误判。
  if (existing && new RegExp(`,"${articleId}"(\r|\n|$)`).test(existing)) {
    return { written: false, reason: 'already-recorded', csvPath };
  }
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const row = [now, account, title, url || publicUrl(account, articleId), articleId].map(esc).join(',');
  if (!existing) {
    // 新文件加 UTF-8 BOM, 否则Excel打开中文乱码
    fs.writeFileSync(csvPath, '\uFEFF' + header + '\r\n' + row + '\r\n', 'utf8');
  } else {
    fs.appendFileSync(csvPath, row + '\r\n', 'utf8');
  }
  return { written: true, csvPath };
}

// ── 批量编排(以前散在各 publish-*.js 里重写N遍,现收口进引擎) ──

// 点主界面(czgts.cn外壳)的账号标签(手机号chip)切号——客户端一次只有前台一个活跃webview,
// CDP的activateTarget唤不醒,必须点应用外壳的账号标签。返回 'clicked'/'clicked-el'/'not-found'。
async function switchAccount(port, phone) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const main = list.find(t => t.type === 'page' && /czgts\.cn/.test(t.url));
  if (!main) return 'no-shell';
  const c = new CDP(main.webSocketDebuggerUrl);
  try {
    await c.connect(); await c.send('Runtime.enable');
    return await c.eval(`(function(){
      const el=[...document.querySelectorAll('*')].find(e=>{const own=[...e.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('');return own.includes('${phone}');});
      if(!el)return 'not-found';
      let n=el;for(let i=0;i<6;i++){if(/AccountName|account|item|card/i.test((n.className||'').toString())){n.click();return 'clicked';}n=n.parentElement;if(!n)break;}
      el.click();return 'clicked-el';
    })()`);
  } finally { c.close(); }
}

// 遍历所有CSDN webview,读cookie UserName匹配目标账号,返回该target(未找到返回null)。
async function findWebviewByAccount(port, account) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  for (const w of list.filter(t => t.type === 'webview')) {
    const c = new CDP(w.webSocketDebuggerUrl);
    try {
      await c.connect(); await c.send('Runtime.enable');
      const u = await c.eval(`(document.cookie.match(/UserName=([^;]+)/)||[])[1]`).catch(() => '?');
      if (u === account) { c.close(); return w; }
    } catch (e) {} finally { c.close(); }
  }
  return null;
}

// 确保发布面板里有已选标签:没有就点"添加文章标签"→找标签input→输入+回车。返回当前标签数组。
// **前提:发布面板已打开**(先 openPublishPanel)。
async function ensureTag(c, tag) {
  let tags = await c.eval(`[...document.querySelectorAll('.el-tag')].filter(x=>x.offsetParent!==null).map(x=>(x.textContent||'').trim())`).catch(() => []);
  if (tags.length) return tags;
  await c.eval(`(function(){const b=[...document.querySelectorAll('.tag__btn-tag,button,a,span')].find(e=>/添加文章标签/.test((e.textContent||'').trim())&&e.offsetParent!==null);if(b)b.click();})()`);
  await sleep(1000);
  await c.send('DOM.enable');
  const doc = await c.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await c.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input' });
  for (const nid of nodeIds) {
    const d = await c.send('DOM.describeNode', { nodeId: nid });
    if (/标签/.test((d.node.attributes || []).join(' '))) {
      await c.send('DOM.focus', { nodeId: nid });
      await c.send('Input.insertText', { text: tag });
      await sleep(500);
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter' });
      break;
    }
  }
  await sleep(1200);
  return await c.eval(`[...document.querySelectorAll('.el-tag')].filter(x=>x.offsetParent!==null).map(x=>(x.textContent||'').trim())`).catch(() => []);
}

// 批量串行发布。jobs=[{account, phone, title, body, tag}](body为原始markdown,内部会cleanArticle清洗)。
// 每篇: 配额预检(<2) → 切号 → 定位webview → 开草稿 → 校验账号防发错 → 清洗+填充 → 开面板+标签 → publish → 记录。
// 客户端架构决定必须串行(一次只一个活跃webview),无法并发。发布是公开不可逆动作,调用方须已获授权。
// opts: {gap=[25000,15000] 间隔基数+抖动ms, dailyCap=2 每账号每日上限, logPath}。
// 返回 [{account, title, status, reason?, url?, aid?, ms}]; 同时把结果+汇总写入 batch-log(JSONL)。
async function publishBatch(jobs, opts = {}) {
  const { cleanArticle } = require('./clean-article');
  const run = await ensureRunning();
  if (!run.running) throw new Error('创作罐头未就绪: ' + JSON.stringify(run));
  const port = run.port;
  const gapBase = (opts.gap && opts.gap[0]) ?? 25000;
  const gapJit = (opts.gap && opts.gap[1]) ?? 15000;
  const cap = opts.dailyCap ?? 2;
  const logPath = opts.logPath || process.env.CZGTS_BATCH_LOG || path.join(os.homedir(), 'czgts-batch-log.jsonl');
  const results = [];

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const t0 = Date.now();
    const rec = (status, extra = {}) => {
      const r = { ts: new Date().toISOString(), account: job.account, title: job.title, status, ms: Date.now() - t0, ...extra };
      results.push(r);
      try { fs.appendFileSync(logPath, JSON.stringify(r) + '\n', 'utf8'); } catch (e) {}
      return r;
    };
    let c = null;
    try {
      // #1 配额预检——不白跑生成/填充(数本地CSV今天该号已发数)
      const already = countPublishedToday(job.account);
      if (already >= cap) { rec('quota', { reason: `今日已发${already}/${cap}篇` }); continue; }

      const body = cleanArticle(job.body, job.title);
      if (!require('./clean-article').assertClean(body).clean) { rec('dirty', { reason: '脚手架残留' }); continue; }

      await switchAccount(port, job.phone);
      await sleep(3000);
      const wv = await findWebviewByAccount(port, job.account);
      if (!wv) { rec('no-webview'); continue; }
      c = new CDP(wv.webSocketDebuggerUrl);
      await c.connect(); await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('DOM.enable');
      c._targetId = wv.id;

      const nd = await openNewDraft(c);
      if (!nd.ok) { rec('draft', { reason: nd.reason || 'editor-not-ready' }); c.close(); c = null; continue; }
      // 校验账号防发错号
      const chk = await c.eval(`(document.cookie.match(/UserName=([^;]+)/)||[])[1]`);
      if (chk !== job.account) { rec('acct-mismatch', { reason: `${chk}≠${job.account}` }); c.close(); c = null; continue; }

      const fill = await fillArticle(c, job.title, body);
      if (!fill.ok) { rec('fill', { reason: JSON.stringify({ len: fill.len, nn: fill.nn }) }); c.close(); c = null; continue; }

      await openPublishPanel(c); await sleep(1000);
      const tags = await ensureTag(c, job.tag);
      if (!tags.length) { rec('no-tag'); c.close(); c = null; continue; }

      const p = await publish(c, port);  // 自包含before-diff,无需传articleId
      if (p.published) {
        const url = publicUrl(job.account, p.articleId);
        recordArticle({ account: job.account, title: job.title, articleId: p.articleId, url });
        rec('PUBLISHED', { url, aid: p.articleId, tag: p.tag });
      } else {
        // publish失败:再查配额区分"配额耗尽" vs "真技术故障"(消歧,别再误判成按钮没点到)
        const nowCount = countPublishedToday(job.account);
        rec(nowCount >= cap ? 'quota-hit' : 'no-success', { reason: p.reason || '无新success页' });
      }
      c.close(); c = null;
    } catch (e) {
      rec('error', { reason: e.message });
      try { c && c.close(); } catch (_) {}
      c = null;
    }
    if (i < jobs.length - 1) await sleep(gapBase + Math.random() * gapJit);
  }

  const summary = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  try { fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), summary }) + '\n', 'utf8'); } catch (e) {}
  return results;
}

module.exports = {
  readPort, portReachable, ensureRunning, listAccounts, connectPage, closePage,
  openNewDraft, fillArticle, saveDraft, verifyDraft, openPublishPanel, setCover, publish, sleep,
  publicUrl, checkAudit, recordArticle, notify,
  countPublishedToday, switchAccount, findWebviewByAccount, ensureTag, publishBatch
};
