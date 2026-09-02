// 核实文章的真实审核状态 —— 权威判据 = 管理后台该行的状态文字。
//   node check-audit.js --today                 # 核实本地CSV里今天发的全部文章
//   node check-audit.js --date 2026-09-01       # 核实指定日期
//   node check-audit.js <账号> <aid>[,<aid>...]  # 核实指定文章
//
// 为什么不用别的判据(都踩过):
//   - publishBatch 报 PUBLISHED 只代表"提交成功",平台之后的判定它看不到
//   - 登录态 fetch 自己的文章:草稿和被判违规的都返 200,分不清死活
//   - 匿名 fetch:能证明"已公开",但刚发布的文章未过审也是 404,分不清"审核中 vs 未通过"
// 只有后台行文字能区分 已发布 / 审核中 / 审核未通过。
//
// ⚠️eval 里不写正则、不写 '\n' 字面量(用 String.fromCharCode(10));写成独立文件避免 bash 双层转义。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CDP } = require('./cdp');
const z = require('./czgts');
const { chipFor } = require('./accounts-map');

const args = process.argv.slice(2);

// CSV 的字段是**带引号**的(`"2026/9/2 14:07:24","2601_x",...`),且标题里含中文逗号。
// 直接 split(',') 会把引号留在值里 → new Date('"2026/9/2 14:07"') 是 Invalid Date,
// 于是"今天发的文章"一篇都匹配不上(2026-09-02 实测踩到)。要真正解析引号。
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur); cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// "2026/9/2 14:07:24" → "2026-09-02"。不用 new Date():日期形如 2026/9/2,
// 各平台/时区解析行为不一致,直接按字面拆更稳。
function tsToIso(ts) {
  const m = ts.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return null;
  return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
}

function fromCsv(dateStr) {
  const csv = process.env.CZGTS_CSV || path.join(os.homedir(), 'czgts-published.csv');
  const lines = fs.readFileSync(csv, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
  const byAcct = {};
  for (const line of lines) {
    const cols = parseCsvLine(line);
    const [ts, account, title] = cols;
    const aid = cols[4];
    if (!ts || !account || !aid) continue;
    if (tsToIso(ts) !== dateStr) continue;
    (byAcct[account] = byAcct[account] || []).push({ aid: aid.trim(), title: (title || '').trim() });
  }
  return byAcct;
}

let TARGETS = {};
if (args[0] === '--today' || args[0] === '--date') {
  const d = args[0] === '--today' ? new Date() : new Date(args[1]);
  const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    + '-' + String(d.getDate()).padStart(2, '0');
  console.log('核实日期:', iso);
  TARGETS = fromCsv(iso);
} else if (args.length >= 2) {
  TARGETS[args[0]] = args[1].split(',').map(s => ({ aid: s.trim(), title: '' }));
} else {
  console.error('用法: node check-audit.js --today | --date YYYY-MM-DD | <账号> <aid>[,<aid>...]');
  process.exit(1);
}

const total = Object.values(TARGETS).reduce((n, a) => n + a.length, 0);
if (!total) { console.log('没有要核实的文章'); process.exit(0); }
console.log('待核实:', total, '篇,涉及', Object.keys(TARGETS).length, '个账号\n');

// 后台列表一页约20行;取足够多行再按 aid 匹配
const ROW_JS = `(function(){
  var items=[].slice.call(document.querySelectorAll('.article-list-item-mp'));
  var rows=items.map(function(x){
    var link=x.querySelector('a[href]');
    var it=(x.innerText||'');
    var lines=it.split(String.fromCharCode(10))
      .map(function(s){return s.trim();}).filter(Boolean);
    return {
      title: lines[0]||'',
      href: link? link.href : '',
      rejected: it.indexOf('审核未通过')>=0,
      reviewing: it.indexOf('审核中')>=0
    };
  });
  var body=(document.body?document.body.innerText:'');
  var i=body.indexOf('全部(');
  return {
    tabs: i>=0? body.slice(i,i+64).split(String.fromCharCode(10)).join(' ') : '?',
    rows: rows
  };
})()`;

(async () => {
  const run = await z.ensureRunning();
  if (!run.running) throw new Error('创作罐头未就绪');
  const port = run.port;
  const verdicts = [];

  for (const [account, items] of Object.entries(TARGETS)) {
    await z.switchAccount(port, chipFor(account));
    await z.sleep(2500);
    const w = await z.findWebviewByAccount(port, account);
    if (!w) {
      console.log('=== ' + account + '  no-webview(未登录/账号异常)');
      for (const it of items) verdicts.push({ account, ...it, status: 'no-webview' });
      continue;
    }
    const c = new CDP(w.webSocketDebuggerUrl);
    try {
      await c.connect(); await c.send('Runtime.enable'); await c.send('Page.enable');
      await c.send('Page.navigate', { url: 'https://mp.csdn.net/mp_blog/manage/article' });
      await z.sleep(9000);
      const r = await c.eval(ROW_JS);
      console.log('=== ' + account);
      console.log('    tabs:', r.tabs);
      for (const it of items) {
        const row = r.rows.find(x => x.href.indexOf(it.aid) >= 0);
        const status = !row ? 'not-listed'
          : row.rejected ? '审核未通过'
            : row.reviewing ? '审核中' : '已发布';
        console.log('    ' + it.aid, '→ [' + status + ']',
          (row ? row.title : it.title).slice(0, 44));
        verdicts.push({ account, aid: it.aid, title: (row ? row.title : it.title), status });
      }
    } catch (e) {
      console.log('=== ' + account + '  ERR', e.message);
    } finally { c.close(); }
  }

  const by = s => verdicts.filter(v => v.status === s);
  console.log('\n===== SUMMARY =====');
  console.log('  已发布', by('已发布').length,
    '| 审核中', by('审核中').length,
    '| 审核未通过', by('审核未通过').length,
    '| 未列出', by('not-listed').length);
  for (const v of by('审核未通过')) console.log('   ✗', v.account, v.aid, v.title.slice(0, 42));
  for (const v of by('not-listed')) console.log('   ?未列出(可能翻页外)', v.account, v.aid);
  fs.writeFileSync(path.join(os.homedir(), 'czgts-audit-verdict.json'),
    JSON.stringify(verdicts, null, 1));
  console.log('  明细已写 ~/czgts-audit-verdict.json');
})().catch(e => console.error('FATAL', e.message));
