// 账号 → 主界面 chip 文本的解析。
// chip 文本不统一:老号显示手机号、新号显示账号名(见 SKILL.md 的 Quick Reference),
// 而 switchAccount 是按 chip 文本匹配的,所以要传对。
// ⚠️手机号只从本地 accounts.json 读——该文件含真实 PII,已在 .gitignore 里,绝不入库。
// 查不到映射就用账号名本身当 chip 文本(新号即如此)。
const fs = require('fs');
const path = require('path');

let cache = null;

function load() {
  if (cache) return cache;
  cache = {};
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'accounts.json'), 'utf8'));
    for (const a of j.accounts || []) {
      if (a.account && a.phone) cache[a.account] = a.phone;
    }
  } catch (e) {
    // accounts.json 不存在或损坏:全部退化为"用账号名当 chip"
  }
  return cache;
}

function chipFor(account) {
  return load()[account] || account;
}

module.exports = { chipFor };
