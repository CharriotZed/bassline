// 删除指定草稿。默认 dry-run(点开确认框后取消),--live 才真删。
//   node list-drafts.js                                  # 先看清目标
//   node delete-drafts.js <账号> <aid>[,<aid>...]        # dry-run
//   node delete-drafts.js <账号> <aid>[,<aid>...] --live  # 真删
//
// 安全设计(删除不可逆,平台弹窗写明"删除后无法恢复"):
//   - 只删命令行显式给出的 aid,按 aid 定位行,绝不按位置/模糊匹配
//   - 点开确认框后先回读该行标题打印出来,让调用方能核对删的是不是想删的
//   - 默认 dry-run,点"取消"退出
// ⚠️eval 里不写正则、不写 '\n' 字面量(用 String.fromCharCode(10));写成独立文件避免 bash 双层转义。
const { CDP } = require('./cdp');
const z = require('./czgts');
const { chipFor } = require('./accounts-map');

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const [account, aidArg] = args.filter(a => !a.startsWith('--'));

if (!account || !aidArg) {
  console.error('用法: node delete-drafts.js <账号> <aid>[,<aid>...] [--live]');
  console.error('先跑 node list-drafts.js 看清各账号草稿箱里有什么');
  process.exit(1);
}
const AIDS = aidArg.split(',').map(s => s.trim()).filter(Boolean);

const CLICK_DRAFT_TAB = `(function(){
  var els=[].slice.call(document.querySelectorAll('*'));
  for(var i=0;i<els.length;i++){
    var e=els[i];
    var own=[].slice.call(e.childNodes).filter(function(n){return n.nodeType===3;})
             .map(function(n){return n.textContent;}).join('');
    if(own.indexOf('草稿箱')>=0 && e.offsetParent!==null){ e.click(); return true; }
  }
  return false;
})()`;

// 按 aid 定位行 → 行内点"删除"。回读行标题供调用方核对。
function clickDeleteJs(aid) {
  return `(function(){
    var items=[].slice.call(document.querySelectorAll('.article-list-item-mp'));
    for(var i=0;i<items.length;i++){
      var row=items[i];
      var link=row.querySelector('a[href]');
      if(!link || link.href.indexOf(${JSON.stringify(aid)})<0) continue;
      var lines=(row.innerText||'').split(String.fromCharCode(10))
        .map(function(s){return s.trim();}).filter(Boolean);
      var els=[].slice.call(row.querySelectorAll('*'));
      for(var k=0;k<els.length;k++){
        var e=els[k];
        var own=[].slice.call(e.childNodes).filter(function(n){return n.nodeType===3;})
                 .map(function(n){return n.textContent;}).join('').trim();
        if(own==='删除' && e.offsetParent!==null){
          e.click();
          return {ok:true, rowTitle:lines[0]||''};
        }
      }
      return {ok:false, reason:'row-found-but-no-delete-control', rowTitle:lines[0]||''};
    }
    return {ok:false, reason:'row-not-found'};
  })()`;
}

// 确认框里的按钮同样不是 <button>(是 SPAN),按自有文本扫全部元素
function clickByText(text) {
  return `(function(){
    var els=[].slice.call(document.querySelectorAll('*'));
    for(var i=0;i<els.length;i++){
      var e=els[i];
      if(e.offsetParent===null) continue;
      var own=[].slice.call(e.childNodes).filter(function(n){return n.nodeType===3;})
               .map(function(n){return n.textContent;}).join('').trim();
      if(own===${JSON.stringify(text)}){ e.click(); return true; }
    }
    return false;
  })()`;
}

const COUNT_DRAFTS = `(function(){
  var body=(document.body?document.body.innerText:'');
  var i=body.indexOf('草稿箱(');
  return {
    tab: i>=0 ? body.slice(i,i+12).split(String.fromCharCode(10)).join(' ') : '?',
    rows: [].slice.call(document.querySelectorAll('.article-list-item-mp')).length
  };
})()`;

(async () => {
  console.log(LIVE ? '*** LIVE — 会真删,不可恢复 ***' : '--- DRY RUN(开确认框后取消) ---');
  console.log('账号:', account, '| 目标 aid:', AIDS.join(', '), '\n');

  const run = await z.ensureRunning();
  if (!run.running) throw new Error('创作罐头未就绪');
  const port = run.port;

  await z.switchAccount(port, chipFor(account));
  await z.sleep(2500);
  const w = await z.findWebviewByAccount(port, account);
  if (!w) throw new Error('找不到该账号的 webview(未登录?): ' + account);

  const c = new CDP(w.webSocketDebuggerUrl);
  try {
    await c.connect(); await c.send('Runtime.enable'); await c.send('Page.enable');
    for (const aid of AIDS) {
      await c.send('Page.navigate', { url: 'https://mp.csdn.net/mp_blog/manage/article' });
      await z.sleep(8000);
      await c.eval(CLICK_DRAFT_TAB);
      await z.sleep(4000);
      console.log('aid ' + aid);
      console.log('   before:', JSON.stringify(await c.eval(COUNT_DRAFTS)));

      const hit = await c.eval(clickDeleteJs(aid));
      if (!hit.ok) { console.log('   跳过:', hit.reason); continue; }
      console.log('   该行标题:', hit.rowTitle.slice(0, 56));
      await z.sleep(2000);

      if (LIVE) {
        console.log('   点确定 →', await c.eval(clickByText('确定')));
        await z.sleep(3500);
        console.log('   after:', JSON.stringify(await c.eval(COUNT_DRAFTS)));
      } else {
        await c.eval(clickByText('取消'));
        console.log('   已取消(dry-run,未删)');
      }
    }
  } finally { c.close(); }
})().catch(e => console.error('FATAL', e.message));
