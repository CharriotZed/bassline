// CSDN 流量券自动推广。手动路径:创作中心-内容管理-用券推广→券卡片"去使用"→选文章→确定。
//
// 页面结构(2026-08-27 实测):
//   页面 https://mp.csdn.net/mp_blog/manage/traffic (标题"流量券列表")
//   "去使用" = P.btn (每张可用券一个)
//   弹窗 = .traffic-dialog-blog  → 文章项 .traffic-dialog-item, 标题在 p.title span.text
//   选中 = 点列表项, class 追加 active (无 radio/checkbox)
//   确定 = P.success   取消 = P.fail
//
// ⚠️安全设计:列表项里**没有 articleId**(无 data 属性、无链接),只能按标题匹配。
//   而这些账号发过别的推广文,所以:
//   ①只认调用方给的标题白名单 ②**完全相等**匹配,不做模糊/包含 ③白名单一篇都没命中就点取消退出
//   ④一张券只投一篇,已投过的本轮不再投。用券不可逆,默认 dry-run,加 --live 才真点确定。
const fs = require('fs');
const os = require('os');
const path = require('path');
const z = require('./czgts');
const { CDP } = require('./cdp');

const TRAFFIC_URL = 'https://mp.csdn.net/mp_blog/manage/traffic';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 页面操作原子步骤 ──

async function gotoTraffic(c) {
  const cur = await c.eval('location.href').catch(() => '');
  if (!/manage\/traffic/.test(cur)) {
    await c.send('Page.navigate', { url: TRAFFIC_URL });
    await sleep(6000);
  }
  return await c.eval(`/流量券/.test(document.title) || !!document.querySelector('.traffic-box')`);
}

// 数当前可用券(可见的"去使用"按钮个数)
async function countCoupons(c) {
  return await c.eval(`(function(){
    const vis=e=>e&&e.offsetParent!==null;
    let n=0;
    for(const e of document.querySelectorAll('*')){
      if(!vis(e))continue;
      const own=[...e.childNodes].filter(x=>x.nodeType===3).map(x=>x.textContent).join('').trim();
      if(own==='去使用')n++;
    }
    return n;
  })()`);
}

// 点第 idx 个"去使用"(打开弹窗,可取消,可逆)
async function openCouponDialog(c, idx) {
  const clicked = await c.eval(`(function(){
    const vis=e=>e&&e.offsetParent!==null;
    let k=0;
    for(const e of document.querySelectorAll('*')){
      if(!vis(e))continue;
      const own=[...e.childNodes].filter(x=>x.nodeType===3).map(x=>x.textContent).join('').trim();
      if(own==='去使用'){ if(k===${idx}){ e.click(); return true; } k++; }
    }
    return false;
  })()`);
  if (!clicked) return { open: false, reason: 'no-use-button' };
  await sleep(4000);
  return await readDialog(c);
}

async function readDialog(c) {
  const raw = await c.eval(`(function(){
    const vis=e=>e&&e.offsetParent!==null;
    const d=[...document.querySelectorAll('.traffic-dialog-blog')].filter(vis)[0];
    if(!d)return JSON.stringify({open:false});
    const items=[...d.querySelectorAll('.traffic-dialog-item')].map((it,i)=>({
      idx:i,
      title:((it.querySelector('p.title span.text')||it.querySelector('p.title')||{}).innerText||'').trim(),
      active:/(^|\\s)active(\\s|$)/.test((it.className||'').toString())
    }));
    return JSON.stringify({open:true, items});
  })()`);
  return JSON.parse(raw || '{"open":false}');
}

async function closeDialog(c) {
  await c.eval(`(function(){
    const vis=e=>e&&e.offsetParent!==null;
    const d=[...document.querySelectorAll('.traffic-dialog-blog')].filter(vis)[0];
    if(!d)return 'no-dialog';
    const cancel=[...d.querySelectorAll('p')].find(p=>(p.innerText||'').trim()==='取消');
    if(cancel){cancel.click();return 'cancelled';}
    const x=d.querySelector('.el_mcm-dialog__headerbtn');
    if(x){x.click();return 'closed';}
    return 'no-close';
  })()`).catch(() => {});
  await sleep(1500);
}

// 按标题**完全相等**选中一项
async function selectByTitle(c, title) {
  const r = await c.eval(`(function(){
    const vis=e=>e&&e.offsetParent!==null;
    const d=[...document.querySelectorAll('.traffic-dialog-blog')].filter(vis)[0];
    if(!d)return 'no-dialog';
    const target=${JSON.stringify(title)};
    const it=[...d.querySelectorAll('.traffic-dialog-item')].find(x=>
      ((x.querySelector('p.title span.text')||x.querySelector('p.title')||{}).innerText||'').trim()===target);
    if(!it)return 'not-found';
    it.click();
    return 'clicked';
  })()`);
  if (r !== 'clicked') return { ok: false, reason: r };
  await sleep(1200);
  // 校验:该项确实成了 active,且只有它 active
  const d = await readDialog(c);
  const actives = (d.items || []).filter(i => i.active);
  if (actives.length !== 1 || actives[0].title !== title) {
    return { ok: false, reason: `active校验失败(${actives.length}项active)`, actives: actives.map(a => a.title) };
  }
  return { ok: true };
}

// 点确定——**不可逆**,消耗一张券
async function confirm(c) {
  const r = await c.eval(`(function(){
    const vis=e=>e&&e.offsetParent!==null;
    const d=[...document.querySelectorAll('.traffic-dialog-blog')].filter(vis)[0];
    if(!d)return 'no-dialog';
    const ok=[...d.querySelectorAll('p')].find(p=>(p.innerText||'').trim()==='确定');
    if(!ok)return 'no-confirm-btn';
    ok.click();
    return 'clicked';
  })()`);
  if (r !== 'clicked') return { ok: false, reason: r };
  await sleep(4000);
  // 判据:弹窗关闭即视为提交(再叠加券数减少做二次确认)
  const stillOpen = (await readDialog(c)).open;
  return { ok: !stillOpen, reason: stillOpen ? '弹窗未关闭,可能未提交' : 'dialog-closed' };
}

// ── 记录 ──

function recordPromotion({ account, title, articleId, coupon }, csvPath) {
  csvPath = csvPath || process.env.CZGTS_PROMO_CSV || path.join(os.homedir(), 'czgts-promoted.csv');
  const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = '推广时间,账号,标题,文章ID,券信息';
  let existing = '';
  try { existing = fs.readFileSync(csvPath, 'utf8'); } catch (e) {}
  // 幂等:同账号+同articleId 不重复记
  if (existing && new RegExp(`,"${articleId}","`).test(existing)) {
    return { written: false, reason: 'already-recorded' };
  }
  const row = [new Date().toLocaleString('zh-CN', { hour12: false }), account, title, articleId, coupon].map(esc).join(',');
  if (!existing) fs.writeFileSync(csvPath, '﻿' + header + '\r\n' + row + '\r\n', 'utf8');
  else fs.appendFileSync(csvPath, row + '\r\n', 'utf8');
  return { written: true, csvPath };
}

// ── 主流程 ──

/**
 * 给指定账号的目标文章用券推广。
 * @param jobs [{account, chipLabel, articles:[{aid,title}]}]
 * @param opts {live=false 真点确定, logPath}
 * 返回 [{account, title, aid, status, reason?}]
 *   status: PROMOTED / dry-run / not-in-list / no-coupon / no-dialog / select-fail / confirm-fail / error
 */
async function promoteBatch(jobs, opts = {}) {
  const live = !!opts.live;
  const logPath = opts.logPath || process.env.CZGTS_PROMO_LOG || path.join(os.homedir(), 'czgts-promote-log.jsonl');
  const run = await z.ensureRunning();
  if (!run.running) throw new Error('创作罐头未就绪: ' + JSON.stringify(run));
  const port = run.port;
  const results = [];

  const rec = (o) => {
    results.push(o);
    try { fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), live, ...o }) + '\n', 'utf8'); } catch (e) {}
  };

  for (const job of jobs) {
    let c = null;
    console.log(`\n=== ${job.account} (${job.articles.length} 篇待推广) ===`);
    try {
      await z.switchAccount(port, job.chipLabel);
      await sleep(3000);
      const wv = await z.findWebviewByAccount(port, job.account);
      if (!wv) { rec({ account: job.account, status: 'no-webview' }); continue; }

      c = new CDP(wv.webSocketDebuggerUrl);
      await c.connect();
      await c.send('Runtime.enable');
      await c.send('Page.enable');

      if (!await gotoTraffic(c)) {
        rec({ account: job.account, status: 'no-traffic-page' });
        c.close(); c = null; continue;
      }

      const coupons = await countCoupons(c);
      console.log(`  可用券: ${coupons} 张`);
      if (!coupons) {
        for (const a of job.articles) rec({ account: job.account, title: a.title, aid: a.aid, status: 'no-coupon' });
        c.close(); c = null; continue;
      }

      const whitelist = new Set(job.articles.map(a => a.title));
      const done = new Set();

      for (let k = 0; k < coupons; k++) {
        const remaining = job.articles.filter(a => !done.has(a.title));
        if (!remaining.length) { console.log('  本账号目标文章已投完,剩余券留着'); break; }

        // 每轮都点"第0个"去使用:用掉一张后按钮会减少,索引会移位
        const dlg = await openCouponDialog(c, 0);
        if (!dlg.open) {
          console.log(`  券${k + 1}: 弹窗未打开 (${dlg.reason || '?'})`);
          rec({ account: job.account, status: 'no-dialog', reason: dlg.reason });
          break;
        }

        const listTitles = (dlg.items || []).map(i => i.title);
        console.log(`  券${k + 1}: 可选 ${listTitles.length} 篇`);
        // 关键安全检查:列出不在白名单里的项(它们可能是历史推广文,绝不选)
        const outsiders = listTitles.filter(t => !whitelist.has(t));
        if (outsiders.length) {
          console.log(`     ⚠️ 非今日文章 ${outsiders.length} 篇(跳过不选):`);
          outsiders.forEach(t => console.log(`        - ${t.slice(0, 46)}`));
        }

        const target = remaining.find(a => listTitles.includes(a.title));
        if (!target) {
          console.log('     白名单文章都不在可选列表里 → 取消退出');
          await closeDialog(c);
          for (const a of remaining) rec({ account: job.account, title: a.title, aid: a.aid, status: 'not-in-list' });
          break;
        }

        console.log(`     选中: ${target.title.slice(0, 46)}`);
        const sel = await selectByTitle(c, target.title);
        if (!sel.ok) {
          console.log(`     选中失败: ${sel.reason}`);
          await closeDialog(c);
          rec({ account: job.account, title: target.title, aid: target.aid, status: 'select-fail', reason: sel.reason });
          break;
        }

        if (!live) {
          console.log('     [dry-run] 不点确定,取消退出');
          await closeDialog(c);
          rec({ account: job.account, title: target.title, aid: target.aid, status: 'dry-run' });
          done.add(target.title);
          break;   // dry-run 每账号只验一张券
        }

        const cf = await confirm(c);
        if (cf.ok) {
          console.log('     ✓ 已推广');
          recordPromotion({ account: job.account, title: target.title, aid: target.aid, articleId: target.aid, coupon: '每日任务流量券' });
          rec({ account: job.account, title: target.title, aid: target.aid, status: 'PROMOTED' });
          done.add(target.title);
        } else {
          console.log(`     ✗ 确定失败: ${cf.reason}`);
          await closeDialog(c);
          rec({ account: job.account, title: target.title, aid: target.aid, status: 'confirm-fail', reason: cf.reason });
          break;
        }
        await sleep(2500);
      }

      c.close(); c = null;
    } catch (e) {
      console.log(`  ERR ${e.message}`);
      rec({ account: job.account, status: 'error', reason: e.message });
      try { c && c.close(); } catch (_) {}
      c = null;
    }
    await sleep(3000);
  }

  const summary = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(summary));
  try { fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), live, summary }) + '\n', 'utf8'); } catch (e) {}
  return results;
}

module.exports = {
  promoteBatch, recordPromotion,
  gotoTraffic, countCoupons, openCouponDialog, readDialog, closeDialog, selectByTitle, confirm,
  TRAFFIC_URL,
};
