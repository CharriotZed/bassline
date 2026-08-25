// 极简 CDP over WebSocket 客户端，用于驱动 Electron webview target
const WebSocket = require('ws');

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        } else if (msg.method) {
          const hs = this.eventHandlers.get(msg.method) || [];
          hs.forEach(h => h(msg.params));
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 45000);
    });
  }
  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method).push(handler);
  }
  // 在页面里跑 JS，返回 JSON 值
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) throw new Error('页面JS异常: ' + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

const fs = require('fs');
const path = require('path');
// 调试端口写在客户端配置目录。默认取 %APPDATA%\创作罐头\DevToolsActivePort,
// 也可用环境变量 CZGTS_PORT_FILE 覆盖(不同客户端名/自定义安装位置时)。
const PORT_FILE = process.env.CZGTS_PORT_FILE
  || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), '创作罐头', 'DevToolsActivePort');
function readPort() {
  const p = fs.readFileSync(PORT_FILE, 'utf8');
  return p.split('\n')[0].trim();
}
async function listTargets() {
  const port = readPort();
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return await res.json();
}

module.exports = { CDP, readPort, listTargets };
