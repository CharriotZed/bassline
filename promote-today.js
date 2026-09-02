// 给「今天发的文章」投流量券。默认 dry-run,--live 才真投(用券不可逆)。
//   node promote-today.js                  # 扫描各账号可推广列表
//   node promote-today.js --live           # 真投
//   node promote-today.js --date 2026-09-02 [--live]
//
// 标题**从 CSV 读**而不是手写:弹窗列表项里没有 articleId,只能按标题完全相等匹配,
// 手写转录一个字符不对就命中不了(而列表里混着大量历史技术文,模糊匹配必然误选)。
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./promote');
const { chipFor } = require('./accounts-map');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const di = args.indexOf('--date');
const d = di >= 0 ? new Date(args[di + 1]) : new Date();
const ISO = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  + '-' + String(d.getDate()).padStart(2, '0');

// CSV 字段带引号且标题含中文逗号 → 必须真正解析引号,不能 split(',')
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; }
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

function tsToIso(ts) {
  const m = ts.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : null;
}

const csv = process.env.CZGTS_CSV || path.join(os.homedir(), 'czgts-published.csv');
const byAcct = {};
for (const line of fs.readFileSync(csv, 'utf8').split(/\r?\n/).filter(Boolean).slice(1)) {
  const c = parseCsvLine(line);
  const [ts, account, title] = c;
  const aid = c[4];
  if (!ts || !account || !aid) continue;
  if (tsToIso(ts) !== ISO) continue;
  (byAcct[account] = byAcct[account] || []).push({ aid: aid.trim(), title: title.trim() });
}

const jobs = Object.entries(byAcct).map(([account, articles]) => ({
  account, chipLabel: chipFor(account), articles,
}));

const total = jobs.reduce((n, j) => n + j.articles.length, 0);
console.log(LIVE ? '*** LIVE — 会真投券,不可逆 ***' : '--- DRY RUN(只开弹窗后取消) ---');
console.log('日期', ISO, '|', total, '篇 /', jobs.length, '个账号\n');
if (!total) { console.log('该日期没有已发布记录'); process.exit(0); }
for (const j of jobs) {
  console.log('  ' + j.account);
  for (const a of j.articles) console.log('     ' + a.aid, a.title.slice(0, 46));
}

(async () => {
  const results = await P.promoteBatch(jobs, { live: LIVE });
  console.log('\n=== RESULTS ===');
  const tally = {};
  for (const r of results) {
    tally[r.status] = (tally[r.status] || 0) + 1;
    console.log('  ' + (r.status || '?').padEnd(12), r.account,
      '|', (r.title || '').slice(0, 40), r.coupon ? '| ' + r.coupon : '');
  }
  console.log('\n汇总:', JSON.stringify(tally));
  if (tally['not-in-list']) {
    console.log('⚠️ not-in-list = 该文不在可推广列表里(弹窗写明"审核中文章不可被推广")');
    console.log('   → 不是推广故障,去查那几篇的审核状态: node check-audit.js --today');
  }
  fs.writeFileSync(path.join(os.homedir(), 'promote-today-result.json'),
    JSON.stringify(results, null, 1));
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
