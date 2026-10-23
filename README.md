# SSH Proxy Manager

在本机用 `ssh -D` 管理多条 SOCKS5 代理的 Web 面板，带实时监控。

- 多条代理独立配置：SSH 参数、跳板机、密码或私钥登录
- 断线自动重连，容器重启后自动恢复已开启的代理
- 实时监控：TLS 探测（Google / Cloudflare / Docker Hub）、隧道 TCP 重传率与 RTT、ICMP 丢包、吞吐
- 请求链路动画：SOCKS5 → SSH 隧道 → TCP → TLS 逐层展示
- 加密 DNS：本地 UDP DNS 经隧道转发到 DoH（Cloudflare / Google / Quad9）
- 深色 / 浅色主题

## 使用

```bash
docker compose up -d
```

打开 http://127.0.0.1:17910 新增代理。

- 面板和代理端口只映射到 `127.0.0.1`，仅本机可访问
- 代理的本地 SOCKS 端口和 DNS 端口需在 `17870-17879` 内（见 `docker-compose.yml`）
- 配置与日志保存在 `./data`，**其中包含已保存的 SSH 密码，不要提交到仓库**
- 私钥登录时取消 `docker-compose.yml` 中 `./ssh:/root/.ssh` 的注释，把私钥放进 `./ssh`

国内网络构建时可换镜像源：

```bash
docker compose build --build-arg BASE=docker.m.daocloud.io/library/node:22-bookworm-slim --build-arg APT_MIRROR=mirrors.ustc.edu.cn
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `17900` | 面板端口（容器内） |
| `PANEL_PASSWORD` | 空 | 面板访问密码，留空无需登录 |
| `DEFAULT_BIND` | `0.0.0.0` | 新建代理的监听地址 |
| `DATA_DIR` | `/data` | 配置与日志目录 |

## 不用 Docker 运行

需要 Node.js 22+ 和 OpenSSH 8.4+，无其他依赖：

```bash
node server.js
```

默认在 http://127.0.0.1:17900，配置保存在项目目录下的 `proxies.json`。
