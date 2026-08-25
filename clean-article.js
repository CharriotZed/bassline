// 文章清洗 + 硬门禁。杜绝"建议标题/备选标题列表""前置答案块/TL;DR 标签""H2：前缀"等
// AI脚手架字段被发布出去(会被判AI垃圾内容→封号风险)。
// 设计原则:不靠"顶部+---分隔线"的脆弱假设(deepseek至少4种脚手架形态、有的无---)。
// 而是: ①按模式在任意位置删标题列表块 ②去掉答案块/TL;DR的"标签"但保留正文 ③发布前 assertClean 硬校验,残留即抛错拒发。

// 删除"建议标题/备选标题/推荐标题/参考标题"这一整块(小标题行 + 紧随的编号标题列表)。
// 可能出现在文件顶部,也可能夹在真标题之后。删到列表结束(遇到空行后的非列表行/下一个heading/---)。
function stripTitleList(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 命中脚手架小标题行: 可选#、可选"数字."、含"(建议|备选|推荐|参考)标题"
    if (/^#{0,3}\s*(\d+[.、]\s*)?(建议|备选|推荐|参考)?标题(（.*）|\(.*\))?\s*$/.test(line.trim())
        && /(建议|备选|推荐|参考)?标题/.test(line)) {
      i++;
      // 跳过紧随的空行 + 编号/项目符号列表项 + 其间空行
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t === '') { i++; continue; }
        if (/^(\d+[.、]|[-*])\s+/.test(t)) { i++; continue; }  // 列表项(标题候选)
        break;
      }
      // 吃掉列表后紧跟的一条 --- 分隔线(常见于脚手架块收尾)
      while (i < lines.length && lines[i].trim() === '') i++;
      if (i < lines.length && lines[i].trim() === '---') i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

// 去掉答案块/TL;DR 的"标签"但保留其正文内容。
// - "## 前置答案块（TL;DR）" 这类独立heading → 整行删(内容在下一段,保留)
// - "> 前置答案块：正文…" / "**前置答案块**：正文…" 行内标签 → 只删标签词,留正文
function stripAnswerBlockLabels(md) {
  return md.split('\n').map(line => {
    const t = line.trim();
    // 独立的答案块heading行 → 删整行
    if (/^#{1,4}\s*(前置)?答案块\s*(（.*）|\(.*\))?\s*$/.test(t)) return '\x00DELETE\x00';
    if (/^#{1,4}\s*(TL;?DR|tl;?dr)\s*(（.*）|\(.*\))?\s*$/.test(t)) return '\x00DELETE\x00';
    // 行内标签: 去掉"前置答案块：""**前置答案块**：""> 前置答案块 "等前缀, 留后面正文
    let s = line
      .replace(/(^|>\s*|\*\*)\s*(前置)?答案块\s*(（[^）]*）|\([^)]*\))?\s*(\*\*)?\s*[:：]\s*/g, (m, p1) => (p1 && p1.trim() === '>' ? '> ' : (p1 || '')))
      .replace(/(^|>\s*|\*\*)\s*(TL;?DR)\s*(\*\*)?\s*[:：]\s*/gi, (m, p1) => (p1 && p1.trim() === '>' ? '> ' : (p1 || '')));
    return s;
  }).filter(x => x !== '\x00DELETE\x00').join('\n');
}

// 去掉正文里 deepseek 偶发的 "## H2：xxx" / "### H3：xxx" 结构标记前缀
function stripHeadingMarkers(md) {
  return md.split('\n').map(line =>
    line.replace(/^(#{1,6}\s*)H[1-6][：:]\s*/i, '$1')
  ).join('\n');
}

// 折叠清洗后可能产生的连续空行(>2 → 2), 去首尾空白
function tidy(md) {
  return md.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '').replace(/\s+$/, '');
}

// 主清洗: 输入原始markdown, 输出可发布正文(不含标题行——标题单独传给编辑器)。
// 若提供 knownTitle, 会额外去掉正文开头与标题重复的 H1。
function cleanArticle(md, knownTitle) {
  md = md.replace(/\r\n/g, '\n');
  md = stripTitleList(md);
  md = stripAnswerBlockLabels(md);
  md = stripHeadingMarkers(md);
  md = tidy(md);
  // 去掉开头与标题重复的 H1
  if (knownTitle) {
    const lines = md.split('\n');
    let i = 0; while (i < lines.length && lines[i].trim() === '') i++;
    if (i < lines.length && /^#\s+/.test(lines[i])) {
      const norm = s => s.replace(/[：:，,。\s*]/g, '');
      if (norm(lines[i].replace(/^#\s+/, '')) === norm(knownTitle)) {
        lines.splice(i, 1);
        md = tidy(lines.join('\n'));
      }
    }
  }
  return md;
}

// 硬门禁: 扫描残留脚手架标记。返回 {clean:bool, hits:[...]}。发布前必须调用, clean=false 拒发。
const FORBIDDEN = [
  { re: /(建议|备选|推荐|参考)标题/, name: '标题列表标签' },
  { re: /前置答案块/, name: '前置答案块标签' },
  { re: /\bTL;?DR\b/i, name: 'TLDR标签' },
  { re: /^#{1,6}\s*H[1-6][：:]/m, name: 'H2:前缀标记' },
  { re: /^\s*(\d+[.、])\s*[《【]?.*(工程复盘|工程演进|工作流复盘)[》】]?\s*$/m, name: '疑似残留标题列表项' },
];
function assertClean(text) {
  const hits = [];
  for (const f of FORBIDDEN) {
    const m = text.match(f.re);
    if (m) hits.push({ name: f.name, sample: (m[0] || '').slice(0, 40) });
  }
  return { clean: hits.length === 0, hits };
}

module.exports = { cleanArticle, assertClean, stripTitleList, stripAnswerBlockLabels, stripHeadingMarkers };
