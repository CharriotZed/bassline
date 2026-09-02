// 列出各账号草稿箱内容(只读,不删)。删除前先用它看清目标。
//   node list-drafts.js              # 所有已登录账号
//   node list-drafts.js 2601_123456  # 只看指定账号
// 账号动态发现(读 webview cookie),不硬编码——账号名/手机号属 PII,不入库。
// ⚠️写成独立文件而非 node -e:bash+node 双层转义会毁掉 eval 里的 '\n' 等转义序列。
// ⚠️eval 里不写正则(模板转义会毁掉它,实测 "Invalid regular expression: missing /")。
const { CDP } = require('./cdp');
const z = require('./czgts');
const { chipFor } = require('./accounts-map');

const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));

// "草稿箱" tab 是文本节点,按自有文本扫全部元素(该站点多处不是 <button>,按标签名过滤会漏)
const CLICK_DRAFT_TAB = `(function(){
  var els=[].slice.call(document.querySelectorAll('*'));
  for(var i=0;i<els.length;i++){
    var e=els[i];
    var own=[].slice.call(e.childNodes).filter(function(n){return n.nodeType===3;})
             .map(function(n){return n.textContent;}).join('');
    if(own.indexOf('草稿箱')>=0 && e.offsetParent!==null){ e.click(); return own.trim(); }
  }
  return 'tab-not-found';
})()`;

const LIST_JS = `(function(){
  var items=[].slice.call(document.querySelectorAll('.article-list-item-mp'));
  var rows=items.map(function(x){
    var link=x.querySelector('a[href]');
    var lines=(x.innerText||'').split(String.fromCharCode(10))
      .map(function(s){return s.trim();}).filter(Boolean);
    var href=link?link.href:'';
    var aid='';
    var k=href.indexOf('articleId=');
    if(k>=0) aid=href.slice(k+10);
    return {title: lines[0]||'', meta: lines.slice(1).join(' / ').slice(0,70), aid: aid};
  });
  var body=(document.body?document.body.innerText:'');
  var i=body.indexOf('全部(');
  return {
    tabs: i>=0 ? body.slice(i,i+70).split(String.fromCharCode(10)).join(' ') : '?',
    rows: rows
  };
})()`;

(async () => {
  const run = await z.ensureRunning();
  if (!run.running) throw new Error('创作罐头未就绪');
  const port = run.port;

  const accts = (await z.listAccounts(port))
    .filter(a => a.account)
    .filter(a => !ONLY.length || ONLY.includes(a.account));
  console.log('已登录账号:', accts.length,
    ONLY.length ? '(过滤: ' + ONLY.join(',') + ')' : '');

  const found = [];
  for (const a of accts) {
    await z.switchAccount(port, chipFor(a.account));
    await z.sleep(2200);
    const w = await z.findWebviewByAccount(port, a.account);
    if (!w) { console.log(a.account, 'no-webview'); continue; }
    const c = new CDP(w.webSocketDebuggerUrl);
    try {
      await c.connect(); await c.send('Runtime.enable'); await c.send('Page.enable');
      await c.send('Page.navigate', { url: 'https://mp.csdn.net/mp_blog/manage/article' });
      await z.sleep(8000);
      await c.eval(CLICK_DRAFT_TAB);
      await z.sleep(4000);
      const r = await c.eval(LIST_JS);
      console.log('\n=== ' + a.account);
      console.log('   tabs:', r.tabs);
      console.log('   草稿数:', r.rows.length);
      r.rows.forEach((x, i) => {
        console.log('     [' + i + '] aid=' + x.aid, '|', x.title.slice(0, 56));
        console.log('          ', x.meta);
        found.push({ account: a.account, aid: x.aid, title: x.title });
      });
    } catch (e) {
      console.log(a.account, 'ERR', e.message);
    } finally { c.close(); }
  }
  console.log('\n合计草稿:', found.length);
  if (found.length) {
    console.log('删除用: node delete-drafts.js <账号> <aid> [--live]');
  }
})().catch(e => console.error('FATAL', e.message));
