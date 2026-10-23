const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { Monitor, targetsOf } = require('./monitor');
const { connectHost } = require('./socks');
const { DohForwarder } = require('./dns');

const PORT = Number(process.env.PORT) || 17900;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DEFAULT_BIND = process.env.DEFAULT_BIND || '127.0.0.1';
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
const CONFIG = path.join(DATA_DIR, 'proxies.json');
const ASKPASS = path.join(__dirname, '.askpass.sh');
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const DEFAULT_OPTIONS = ['ExitOnForwardFailure=yes', 'ServerAliveInterval=30', 'ServerAliveCountMax=3', 'StrictHostKeyChecking=accept-new'];

// 通过 SSH_ASKPASS 传密码，无需 sshpass
// 按提示文本区分：目标机用 SSH_PROXY_PASS，其余（跳板机）用 SSH_JUMP_PASS
fs.writeFileSync(
  ASKPASS,
  `#!/bin/sh
case "$1" in
  *"$SSH_TARGET'"*) printf '%s\\n' "$SSH_PROXY_PASS" ;;
  *) printf '%s\\n' "\${SSH_JUMP_PASS:-$SSH_PROXY_PASS}" ;;
esac
`,
  { mode: 0o700 }
);

// 跳板机：用 ProxyCommand 以便给跳板机也带上参数
const jumpOption = (item) =>
  item.jumpHost
    ? `ProxyCommand=ssh -W %h:%p -p ${item.jumpPort || 22} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10${item.jumpIdentityFile ? ` -i ${item.jumpIdentityFile}` : ''} ${item.jumpUser || item.user}@${item.jumpHost}`
    : null;

const procs = new Map(); // id -> { child, logs: [] }
const monitors = new Map(); // id -> { mon, clients: Set<res> }

const load = () => (fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, 'utf8')) : []);
const save = (list) => fs.writeFileSync(CONFIG, JSON.stringify(list, null, 2), { mode: 0o600 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 查询监听本地端口的进程
function listeners(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], (_, out = '') => {
      const res = [];
      let cur;
      for (const line of out.split('\n')) {
        if (line[0] === 'p') res.push((cur = { pid: Number(line.slice(1)) }));
        if (line[0] === 'c' && cur) cur.cmd = line.slice(1);
      }
      resolve(res);
    });
  });
}


// 设置 PANEL_PASSWORD 时启用 Basic 认证（用户名任意）
const sha = (v) => crypto.createHash('sha256').update(v).digest();
function authorized(req) {
  if (!PANEL_PASSWORD) return true;
  const raw = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
  return crypto.timingSafeEqual(sha(raw.slice(raw.indexOf(':') + 1)), sha(PANEL_PASSWORD));
}

function broadcast(id, event, data) {
  for (const res of monitors.get(id)?.clients || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function log(id, text, level = 'info') {
  const p = procs.get(id) || { logs: [] };
  const entry = { time: Date.now(), level, text: text.trim() };
  p.logs.push(entry);
  p.logs = p.logs.slice(-300);
  procs.set(id, p);
  broadcast(id, 'log', entry);
}

// SSE：有客户端订阅时才运行监控
function subscribe(item, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let m = monitors.get(item.id);
  if (!m) {
    m = { clients: new Set() };
    monitors.set(item.id, m);
    const getPid = async () => {
      const ls = await listeners(item.localPort);
      return (ls.find((l) => l.cmd === 'ssh') || ls[0])?.pid;
    };
    m.mon = new Monitor(item, getPid, (event, data) => (event === 'log' ? log(item.id, data.text, data.level) : broadcast(item.id, event, data)));
    log(item.id, `开始监控，TLS 探测目标 ${targetsOf(item).join('、')}`);
  }
  m.clients.add(res);
  res.write(`event: init\ndata: ${JSON.stringify({ targets: targetsOf(item), samples: m.mon.samples, logs: procs.get(item.id)?.logs || [] })}\n\n`);
  res.on('close', () => {
    m.clients.delete(res);
    if (!m.clients.size) {
      m.mon.stop();
      monitors.delete(item.id);
    }
  });
}

async function status(item) {
  const ls = await listeners(item.localPort);
  const managed = procs.get(item.id)?.child;
  return {
    running: ls.length > 0,
    pids: ls.map((l) => l.pid),
    cmd: ls[0]?.cmd,
    managed: !!managed && ls.some((l) => l.pid === managed.pid),
  };
}

const publicView = async (item) => {
  const { password, jumpPassword, ...rest } = item;
  return { ...rest, hasPassword: !!password, hasJumpPassword: !!jumpPassword, status: await status(item), dns: dnsServers.get(item.id)?.fwd.view() || null };
};

async function start(item, password, jumpPassword) {
  const st = await status(item);
  if (st.running) throw new Error(`本地端口 ${item.localPort} 已被占用 (${st.cmd} pid ${st.pids.join(',')})`);

  const pass = password || item.password;
  const jumpPass = item.jumpHost ? jumpPassword || item.jumpPassword : '';
  const args = ['-N', '-D', `${item.bind}:${item.localPort}`, '-p', String(item.sshPort)];
  for (const o of [...item.options, jumpOption(item)].filter(Boolean)) args.push('-o', o);
  if (!pass && !jumpPass) args.push('-o', 'BatchMode=yes');
  if (item.extraArgs) args.push(...item.extraArgs.split(/\s+/).filter(Boolean));
  args.push(`${item.user}@${item.host}`);

  const env = { ...process.env };
  if (pass || jumpPass)
    Object.assign(env, { SSH_ASKPASS: ASKPASS, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: ':0', SSH_TARGET: `${item.user}@${item.host}`, SSH_PROXY_PASS: pass || '', SSH_JUMP_PASS: jumpPass || '' });

  log(item.id, `$ ssh ${args.join(' ')}`);
  // ssh 独立进程运行，stderr 写文件，面板重启不影响代理
  const logFile = path.join(LOG_DIR, `${item.id}.log`);
  const fd = fs.openSync(logFile, 'a');
  let pos = fs.fstatSync(fd).size;
  const child = spawn('ssh', args, { env, stdio: ['ignore', 'ignore', fd], detached: true });
  fs.closeSync(fd);
  child.unref();
  procs.get(item.id).child = child;
  const readNew = () => {
    const size = fs.statSync(logFile).size;
    if (size <= pos) return;
    const b = Buffer.alloc(size - pos);
    const f = fs.openSync(logFile, 'r');
    fs.readSync(f, b, 0, b.length, pos);
    fs.closeSync(f);
    pos = size;
    log(item.id, b.toString(), 'ssh');
  };
  const tail = setInterval(readNew, 500);
  let exited = false;
  child.on('exit', (code) => {
    exited = true;
    clearInterval(tail);
    readNew();
    log(item.id, `ssh 进程退出，code=${code}`, code ? 'error' : 'info');
    if (procs.get(item.id)?.child === child) procs.get(item.id).child = null;
  });

  // 等待端口监听或进程退出
  for (let i = 0; i < 30 && !exited; i++) {
    await sleep(300);
    if ((await status(item)).managed) return;
  }
  if (!exited) child.kill();
  throw new Error(procs.get(item.id).logs.slice(-3).map((e) => e.text).join('\n') || '启动超时');
}

async function stop(item) {
  const managed = procs.get(item.id)?.child;
  if (managed) managed.kill();
  // 同时清理外部启动（如 ssh -f）占用该端口的 ssh 进程
  for (const l of await listeners(item.localPort)) {
    if (l.cmd === 'ssh') process.kill(l.pid);
  }
  log(item.id, '已停止');
}

function test(item) {
  return new Promise((resolve) => {
    const t = Date.now();
    execFile('curl', ['-s', '-m', '10', '--socks5-hostname', `${connectHost(item.bind)}:${item.localPort}`, 'https://api.ipify.org'], (err, out) => {
      resolve(err ? { ok: false, error: err.message.split('\n')[0] } : { ok: true, ip: out.trim(), ms: Date.now() - t });
    });
  });
}

function normalize(body, old = {}) {
  return {
    id: old.id || crypto.randomUUID().slice(0, 8),
    name: body.name || body.host,
    user: body.user || 'root',
    host: body.host,
    sshPort: Number(body.sshPort) || 22,
    bind: body.bind || DEFAULT_BIND,
    localPort: Number(body.localPort),
    options: Array.isArray(body.options) ? body.options.filter(Boolean) : DEFAULT_OPTIONS,
    extraArgs: (body.extraArgs || '').trim(),
    // 留空表示保留原密码；clearPassword 清除
    monitorTargets: old.monitorTargets,
    enabled: old.enabled,
    password: body.clearPassword ? '' : body.password || old.password || '',
    jumpHost: (body.jumpHost || '').trim(),
    jumpUser: (body.jumpUser || '').trim(),
    jumpPort: Number(body.jumpPort) || 22,
    jumpIdentityFile: (body.jumpIdentityFile || '').trim(),
    jumpPassword: body.clearPassword ? '' : body.jumpPassword || old.jumpPassword || '',
    dnsPort: Number(body.dnsPort) || 0,
    dnsUpstream: (body.dnsUpstream || '').trim(),
  };
}

const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s ? JSON.parse(s) : {}));
  });

const send = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

http
  .createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SSH Proxy Manager"' });
      return res.end('Unauthorized');
    }
    try {
      const url = new URL(req.url, 'http://x');
      const [, api, , id, action] = url.pathname.split('/'); // /api/proxies/:id/:action

      if (api !== 'api') {
        const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
        const fp = path.join(__dirname, 'public', file);
        if (!fs.existsSync(fp)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
        return fs.createReadStream(fp).pipe(res);
      }

      const list = load();
      const idx = list.findIndex((p) => p.id === id);
      const item = list[idx];
      const body = req.method === 'GET' ? {} : await readBody(req);

      if (!id && req.method === 'GET') return send(res, 200, { list: await Promise.all(list.map(publicView)), defaults: DEFAULT_OPTIONS, defaultBind: DEFAULT_BIND });
      if (!id && req.method === 'POST') {
        const n = normalize(body);
        if (!body.remember) n.password = n.jumpPassword = '';
        list.push(n);
        save(list);
        return send(res, 200, await publicView(n));
      }
      if (!item) return send(res, 404, { error: '代理不存在' });

      if (!action && req.method === 'PUT') {
        list[idx] = normalize(body, item);
        if (!body.remember) list[idx].password = list[idx].jumpPassword = '';
        save(list);
        syncDns();
        return send(res, 200, await publicView(list[idx]));
      }
      if (!action && req.method === 'DELETE') {
        await stop(item);
        monitors.get(item.id)?.mon.stop();
        monitors.delete(item.id);
        list.splice(idx, 1);
        save(list);
        syncDns();
        return send(res, 200, { ok: true });
      }
      if (action === 'start') {
        if (!procs.has(item.id)) procs.set(item.id, { logs: [] });
        await start(item, body.password, body.jumpPassword);
        item.enabled = true;
        save(list);
        syncDns();
        retry.delete(item.id);
        // 启动成功后保存密码
        if (body.remember && (body.password || body.jumpPassword)) {
          if (body.password) item.password = body.password;
          if (body.jumpPassword) item.jumpPassword = body.jumpPassword;
          save(list);
          log(item.id, '密码已保存');
        }
        return send(res, 200, await publicView(item));
      }
      if (action === 'stop') {
        item.enabled = false;
        save(list);
        syncDns();
        retry.delete(item.id);
        await stop(item);
        await sleep(300);
        return send(res, 200, await publicView(item));
      }
      if (action === 'test') return send(res, 200, await test(item));
      if (action === 'monitor') {
        if (!procs.has(item.id)) procs.set(item.id, { logs: [] });
        return subscribe(item, req, res);
      }
      if (action === 'monitor-targets') {
        const targets = body.targets.map((t) => t.trim()).filter(Boolean).map((t) => (t.includes(':') ? t : `${t}:443`)).slice(0, 3);
        item.monitorTargets = targets;
        save(list);
        const m = monitors.get(item.id);
        if (m) m.mon.item.monitorTargets = targets;
        log(item.id, `TLS 探测目标改为 ${targets.join('、')}`);
        broadcast(item.id, 'targets', targets);
        return send(res, 200, { targets });
      }
      if (action === 'logs') return send(res, 200, { logs: procs.get(item.id)?.logs || [] });
      send(res, 404, { error: 'unknown action' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  })
  .listen(PORT, HOST, () => console.log(`SSH Proxy Manager: http://${HOST}:${PORT}`));

// 断线守护：已开启（enabled）但未运行的代理自动重连，失败指数退避
const retry = new Map(); // id -> { next, delay, busy }
// 加密 DNS：代理开启且配置了端口时运行，配置变化时重建
const dnsServers = new Map(); // id -> { fwd, sig }
function syncDns() {
  const list = load();
  for (const [id, d] of dnsServers) {
    const item = list.find((p) => p.id === id);
    if (!item?.enabled || d.sig !== dnsSig(item)) {
      d.fwd.stop();
      dnsServers.delete(id);
    }
  }
  for (const item of list) {
    if (!item.enabled || !item.dnsPort || dnsServers.has(item.id)) continue;
    if (!procs.has(item.id)) procs.set(item.id, { logs: [] });
    dnsServers.set(item.id, { sig: dnsSig(item), fwd: new DohForwarder(item, (text, level) => log(item.id, text, level)) });
  }
}
const dnsSig = (p) => [p.bind, p.dnsPort, p.localPort, p.dnsUpstream].join('|');

async function watchdog() {
  syncDns();
  for (const item of load().filter((p) => p.enabled)) {
    const r = retry.get(item.id) || { next: 0, delay: 5000 };
    if (r.busy || Date.now() < r.next) continue;
    if ((await status(item)).running) {
      retry.delete(item.id);
      continue;
    }
    r.busy = true;
    retry.set(item.id, r);
    if (!procs.has(item.id)) procs.set(item.id, { logs: [] });
    log(item.id, '代理未运行，自动重连…', 'warn');
    try {
      await start(item);
      log(item.id, '自动重连成功');
      retry.delete(item.id);
    } catch {
      log(item.id, `自动重连失败，${r.delay / 1000}s 后重试`, 'error');
      Object.assign(r, { next: Date.now() + r.delay, delay: Math.min(r.delay * 2, 300000), busy: false });
    }
  }
}

// 兼容旧配置：未设置 enabled 的按当前运行状态初始化
(async () => {
  const list = load();
  for (const p of list) if (p.enabled === undefined) p.enabled = (await status(p)).running;
  save(list);
  watchdog();
  setInterval(watchdog, 5000);
})();

// 面板退出时只停监控，不影响 ssh 代理
const cleanup = () => {
  for (const m of monitors.values()) m.mon.stop();
  for (const d of dnsServers.values()) d.fwd.stop();
  process.exit();
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
