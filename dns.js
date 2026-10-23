const dgram = require('dgram');
const http2 = require('http2');
const tls = require('tls');
const { once } = require('events');
const { socksConnect } = require('./socks');

const DEFAULT_UPSTREAM = 'https://cloudflare-dns.com/dns-query';
const CACHE_TTL = 60000;

// 本地 UDP DNS → 经 SOCKS 隧道 → DoH（HTTP/2 长连接复用）
class DohForwarder {
  constructor(item, log) {
    this.item = item;
    this.log = log;
    this.url = new URL(item.dnsUpstream || DEFAULT_UPSTREAM);
    this.cache = new Map();
    this.stats = { queries: 0, cached: 0, failed: 0, resolved: 0, totalMs: 0 };
    this.udp = dgram.createSocket(item.bind.includes(':') ? 'udp6' : 'udp4');
    this.udp.on('message', (msg, rinfo) => this.handle(msg, rinfo));
    this.udp.on('error', (e) => this.log(`加密 DNS 监听失败：${e.message}`, 'error'));
    this.udp.bind(item.dnsPort, item.bind, () => this.log(`加密 DNS 已启动 udp://${item.bind}:${item.dnsPort} → ${this.url.href}`));
  }

  session() {
    if (this.s && !this.s.closed && !this.s.destroyed) return this.s;
    this.pending ??= (async () => {
      const { hostname, port, origin } = this.url;
      const sock = await socksConnect(this.item.bind, this.item.localPort, hostname, Number(port) || 443);
      const s = http2.connect(origin, { createConnection: () => tls.connect({ socket: sock, servername: hostname, ALPNProtocols: ['h2'] }) });
      s.on('error', () => {});
      s.setTimeout(120000, () => s.close());
      await once(s, 'connect');
      return (this.s = s);
    })().finally(() => (this.pending = null));
    return this.pending;
  }

  async query(body) {
    const s = await this.session();
    return new Promise((resolve, reject) => {
      const req = s.request({ ':method': 'POST', ':path': this.url.pathname + this.url.search, 'content-type': 'application/dns-message', accept: 'application/dns-message', 'content-length': body.length });
      const chunks = [];
      let status;
      req.setTimeout(5000, () => {
        req.close();
        reject(new Error('DoH 超时'));
      });
      req.on('response', (h) => (status = h[':status']));
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => (status === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`DoH HTTP ${status}`))));
      req.on('error', reject);
      req.end(body);
    });
  }

  async handle(msg, rinfo) {
    if (msg.length < 12) return;
    const id = msg.readUInt16BE(0);
    const key = msg.subarray(2).toString('base64');
    this.stats.queries++;
    let resp;
    const hit = this.cache.get(key);
    if (hit && hit.exp > Date.now()) {
      resp = Buffer.from(hit.data);
      this.stats.cached++;
    } else {
      const q = Buffer.from(msg);
      q.writeUInt16BE(0, 0); // DoH 建议 ID 置 0
      const t = performance.now();
      try {
        // 长连接可能已被对端关闭，失败时重建一次
        const data = await this.query(q).catch(() => {
          this.s?.destroy();
          this.s = null;
          return this.query(q);
        });
        this.stats.resolved++;
        this.stats.totalMs += performance.now() - t;
        if (this.cache.size > 2000) this.cache.clear();
        this.cache.set(key, { data, exp: Date.now() + CACHE_TTL });
        resp = Buffer.from(data);
      } catch (e) {
        this.stats.failed++;
        if (Date.now() - (this.lastErr || 0) > 10000) {
          this.lastErr = Date.now();
          this.log(`加密 DNS 查询失败：${e.message}`, 'error');
        }
        // 返回 SERVFAIL
        resp = Buffer.from(msg);
        resp[2] |= 0x80;
        resp[3] = 0x80 | 2;
      }
    }
    resp.writeUInt16BE(id, 0);
    this.udp.send(resp, rinfo.port, rinfo.address);
  }

  view() {
    const { resolved, totalMs, ...rest } = this.stats;
    return { ...rest, avgMs: resolved ? Math.round(totalMs / resolved) : null };
  }

  stop() {
    this.udp.close();
    this.s?.close();
  }
}

module.exports = { DohForwarder, DEFAULT_UPSTREAM };
