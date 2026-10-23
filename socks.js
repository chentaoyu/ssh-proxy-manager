const net = require('net');

const connectHost = (bind) => (bind === '0.0.0.0' || bind === '::' ? '127.0.0.1' : bind);

// 经 SOCKS5（无认证）连接目标，返回已建立隧道的 socket
function socksConnect(bind, port, host, tport, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const sock = net.connect(Number(port), connectHost(bind));
    const fail = (msg) => {
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail('SOCKS 建连超时'), timeout);
    sock.on('error', (e) => fail(e.message));
    // OpenSSH 远端建连失败（如禁止转发）时不回错误码，直接关闭连接
    sock.on('close', () => fail(stage === 1 ? 'SOCKS CONNECT 失败：代理关闭了连接' : 'SOCKS 连接被关闭'));
    sock.on('connect', () => sock.write(Buffer.from([5, 1, 0])));

    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[1] !== 0) return fail('SOCKS 认证被拒');
        buf = buf.subarray(2);
        stage = 1;
        sock.greetMs = performance.now() - t0; // 本地 SOCKS 握手耗时
        const h = Buffer.from(host);
        sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([tport >> 8, tport & 255])]));
      }
      if (stage === 1 && buf.length >= 10) {
        if (buf[1] !== 0) return fail(`SOCKS CONNECT 失败 code=${buf[1]}`);
        clearTimeout(timer);
        sock.removeListener('data', onData);
        sock.removeAllListeners('error');
        sock.removeAllListeners('close');
        sock.on('error', () => {}); // 错误交给上层 TLS 连接处理
        resolve(sock);
      }
    };
    sock.on('data', onData);
  });
}

module.exports = { socksConnect, connectHost };
