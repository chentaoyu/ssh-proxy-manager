const tls = require('tls');
const { socksConnect } = require('./socks');
const { spawn, execFile } = require('child_process');

const INTERVAL = 3000;
const MAX_SAMPLES = 200;
const DEFAULT_TARGETS = ['www.google.com:443', 'www.cloudflare.com:443', 'registry-1.docker.io:443'];
const targetsOf = (item) => (item.monitorTargets?.length ? item.monitorTargets : DEFAULT_TARGETS);

// 经 SOCKS5 建连并完成 TLS 握手，分别计时
async function probeTls(bind, port, target, timeout = 8000) {
  const [host, tport = 443] = target.split(':');
  const t0 = performance.now();
  let sock;
  try {
    sock = await socksConnect(bind, port, host, Number(tport), timeout);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const socksMs = performance.now() - t0;
  const { greetMs } = sock;
  return new Promise((resolve) => {
    const t1 = performance.now();
    const done = (r) => {
      clearTimeout(timer);
      ts.destroy();
      resolve({ socksMs, greetMs, ...r });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'TLS 握手超时' }), timeout);
    const ts = tls.connect({ socket: sock, servername: host }, () => done({ ok: true, tlsMs: performance.now() - t1, proto: ts.getProtocol() }));
    ts.on('error', (e) => done({ ok: false, error: `TLS: ${e.message}` }));
  });
}

// 读取 ssh 隧道 TCP 连接的内核统计（累计值）；走跳板机时连接在 ProxyCommand 子进程上
async function tunnelStats(pid, localPort) {
  if (!pid) return null;
  const kids = await new Promise((r) => execFile('pgrep', ['-P', String(pid)], (_, out = '') => r(out.split('\n').filter(Boolean))));
  const pids = [String(pid), ...kids];
  if (process.platform === 'linux') return ssRow(pids, localPort);
  for (const p of pids) {
    const row = await nettopRow(p);
    if (row) return row;
  }
  return null;
}

// Linux：ss -ti 输出每条连接两行，第一行地址与进程，第二行 TCP 内部统计
function ssRow(pids, localPort) {
  return new Promise((resolve) => {
    execFile('ss', ['-tinpH', 'state', 'established'], (err, out = '') => {
      const lines = out.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const head = lines[i];
        if (/^\s/.test(head)) continue;
        const [, , local, peer] = head.trim().split(/\s+/);
        const owned = [...head.matchAll(/pid=(\d+)/g)].some((m) => pids.includes(m[1]));
        if (!owned || !peer || /^(127\.|\[::1\]|\[::ffff:127\.)/.test(peer) || local.endsWith(`:${localPort}`)) continue;
        const info = lines[i + 1];
        const num = (k) => Number(info.match(new RegExp(`\\b${k}:(\\d+)`))?.[1] || 0);
        const rtt = info.match(/\brtt:([\d.]+)\/([\d.]+)/);
        return resolve({ conn: `${local}<->${peer}`, in: num('bytes_received'), out: num('bytes_sent'), dupe: 0, ooo: 0, retx: num('bytes_retrans'), rtt: rtt ? +rtt[1] : null, rttVar: rtt ? +rtt[2] : null });
      }
      resolve(null);
    });
  });
}

function nettopRow(pid) {
  return new Promise((resolve) => {
    const cols = 'bytes_in,bytes_out,rx_dupe,rx_ooo,re-tx,rtt_avg,rtt_var';
    execFile('nettop', ['-m', 'tcp', '-L', '1', '-n', '-x', '-p', String(pid), '-J', cols], (err, out = '') => {
      const row = out
        .split('\n')
        .map((l) => l.split(','))
        .find((c) => c[0].startsWith('tcp') && !/<->(127\.0\.0\.1|\*|::1)/.test(c[0]));
      if (err || !row) return resolve(null);
      const n = (v) => parseFloat(v) || 0;
      resolve({ conn: row[0], in: n(row[1]), out: n(row[2]), dupe: n(row[3]), ooo: n(row[4]), retx: n(row[5]), rtt: n(row[6]) || null, rttVar: n(row[7]) || null });
    });
  });
}

class Monitor {
  constructor(item, getPid, emit) {
    Object.assign(this, { item, getPid, emit });
    this.samples = [];
    this.prev = null;
    this.icmp = { sent: 0, lost: 0, rtts: [] };
    this.startPing();
    this.tick();
    this.timer = setInterval(() => this.tick(), INTERVAL);
  }

  startPing() {
    // Linux (iputils) 用 -O 输出丢包行
    const flags = process.platform === 'linux' ? ['-O', '-i', '1'] : ['-i', '1'];
    this.ping = spawn('ping', [...flags, this.item.jumpHost || this.item.host]);
    let rest = '';
    this.ping.stdout.on('data', (d) => {
      const lines = (rest + d).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        const m = l.match(/icmp_seq=\d+.*time=([\d.]+)/);
        if (m) this.icmp.sent++, this.icmp.rtts.push(Number(m[1]));
        else if (/Request timeout|no answer yet/.test(l)) {
          this.icmp.sent++, this.icmp.lost++;
          this.emit('log', { level: 'warn', text: `ICMP 丢包：${l.trim()}` });
        }
      }
    });
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.sample();
    } finally {
      this.busy = false;
    }
  }

  async sample() {
    const { item } = this;
    const pid = await this.getPid();
    const targets = targetsOf(item);
    const [probes, tun] = await Promise.all([
      Promise.all(targets.map(async (target) => ({ target, ...(pid ? await probeTls(item.bind, item.localPort, target) : { ok: false, error: '代理未运行' }) }))),
      tunnelStats(pid, item.localPort),
    ]);

    const failed = probes.filter((p) => !p.ok);
    const s = { t: Date.now(), probes, tlsOk: !failed.length, error: failed.map((p) => `${p.target} ${p.error}`).join('；') };

    // 隧道：累计值求差
    if (tun) {
      const p = this.prev?.conn === tun.conn ? this.prev : null;
      Object.assign(s, { rtt: tun.rtt, rttVar: tun.rttVar });
      if (p) {
        const dt = (s.t - p.t) / 1000;
        Object.assign(s, {
          inBps: (tun.in - p.in) / dt,
          outBps: (tun.out - p.out) / dt,
          dOut: tun.out - p.out,
          dRetx: tun.retx - p.retx,
          dOoo: tun.ooo - p.ooo + (tun.dupe - p.dupe),
        });
        s.retxPct = s.dOut > 1024 ? (s.dRetx / s.dOut) * 100 : null;
      } else if (this.prev) {
        this.emit('log', { level: 'warn', text: `隧道 TCP 连接已变化：${tun.conn}` });
      }
      this.prev = { ...tun, t: s.t };
    }

    // ICMP：本周期内的发包/丢包
    const ic = this.icmp;
    Object.assign(s, {
      icmpSent: ic.sent,
      icmpLost: ic.lost,
      icmpRtt: ic.rtts.length ? ic.rtts.reduce((a, b) => a + b) / ic.rtts.length : null,
    });
    this.icmp = { sent: 0, lost: 0, rtts: [] };

    for (const p of failed) this.emit('log', { level: 'error', text: `TLS 探测失败 ${p.target}：${p.error}` });
    if (s.dRetx > 0) this.emit('log', { level: 'warn', text: `TCP 重传 ${s.dRetx} 字节（${s.retxPct?.toFixed(2) ?? '-'}%）` });
    for (const p of probes) {
      if (!p.ok) continue;
      const recent = this.samples.slice(-20).map((x) => x.probes?.find((q) => q.target === p.target)?.tlsMs).filter(Boolean).sort((a, b) => a - b);
      const median = recent[recent.length >> 1];
      if (median && p.tlsMs > median * 2.5 && p.tlsMs > 300)
        this.emit('log', { level: 'warn', text: `TLS 握手突增 ${p.target} ${p.tlsMs.toFixed(0)}ms（中位数 ${median.toFixed(0)}ms）` });
    }

    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    this.emit('sample', s);
  }

  stop() {
    clearInterval(this.timer);
    this.ping.kill();
  }
}

module.exports = { Monitor, targetsOf };
