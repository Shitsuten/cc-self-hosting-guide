# cc-web-frontend

把 Claude Code 接到自制 web 前端的完整方案。包含架构指南、参考代码和排障手册。

## 这是什么

一套让 CC（Claude Code CLI）通过自制 web 前端对话的方案。核心思路：

- **入站**（用户 → CC）：前端 → WebSocket hub → `tmux send-keys` → CC 终端
- **出站**（CC → 用户）：CC → MCP reply 工具 → hub → 前端

不依赖任何实验性 flag，不走 channel 协议。只要 CC 还认 `<channel>` tag 格式，这个方案就不会 break。

亮点：

- **离线自动推送**：hub 检测到没有活跃的 WebSocket 客户端时，自动通过 Web Push 把 CC 的回复推到手机通知栏。不需要第三方推送服务，不需要额外后端
- **零摩擦通知授权**：PWA 的通知权限请求挂在发送按钮上——用户第一次按发送时弹出授权，既满足浏览器的 user gesture 要求，又不需要单独放一个"允许通知"按钮
- **CC 存活分离**：hub 独立于 CC 运行。CC 崩了、重启了、换 session 了，前端不断线，只是状态灯变灰。CC 回来自动重连
- **Chrome 侧边栏**：一键提取当前网页内容（标题、URL、选中文本、正文），预览确认后发送给 CC。浏览网页时随时把看到的东西喂给 CC，不用来回复制粘贴

```
Web 前端（浏览器）
    ↕ WebSocket
Hub（常驻进程，负责转发 + nudge + 终端视图）
    ├─ tmux send-keys → CC 终端（入站）
    └─ ← MCP reply 工具 ← CC（出站）
```

## 文档

| 文件 | 内容 |
|------|------|
| [GUIDE.md](GUIDE.md) | 完整架构指南：进化路线、原理、自动化脚本、经验总结 |
| [HANDBOOK.md](HANDBOOK.md) | 排障手册：常见故障的症状、排查步骤和修复命令 |

## 参考代码（`src/`）

可以直接跑的最小实现。暗色主题、PWA、Web Push 推送、终端视图、图片发送、PIN 认证。

| 文件 | 作用 |
|------|------|
| [`src/hub.ts`](src/hub.ts) | WebSocket hub：消息转发、tmux 注入、history、nudge、Web Push |
| [`src/server.ts`](src/server.ts) | MCP bridge：CC 调 reply/edit 工具经过这里到 hub |
| [`src/index.html`](src/index.html) | 前端：聊天 UI + 终端视图 + PWA + Push |
| [`src/sw.js`](src/sw.js) | Service worker：接收 push 弹系统通知 |
| [`src/manifest.json`](src/manifest.json) | PWA manifest |
| [`src/package.json`](src/package.json) | 依赖声明 |
| [`src/chrome-extension/`](src/chrome-extension/) | Chrome 侧边栏插件：提取网页内容发送给 CC |

```bash
# 跑起来
cd src && bun install
npm run setup-vapid          # 生成 VAPID 密钥（push 用，可选）
CHANNEL_PIN=1234 bun run hub.ts  # 启动 hub（PIN 可选，不设就无认证）
# 然后配 CC 的 .mcp.json 指向 server.ts
```

## 关键文件（你自己项目里的）

| 文件 | 作用 |
|------|------|
| `start_cc.sh` | CC 启动脚本，处理 session 摘要注入 |
| `.claude/hooks/nudge-check.sh` | Nudge 的 stop hook，强制 CC 发消息 |
| `.mcp.json` | MCP server 配置 |
| `.claude/settings.local.json` | CC 权限配置 |
| `CLAUDE.md` | CC 的人设和行为指令（需要自己写） |

## 前置要求

- tmux
- Node.js / Bun
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
- 可选：一台 VPS（想让 CC 24 小时在线的话。建议 ≥ 2GB 内存，1GB 非常勉强。本地电脑跑也完全可以）

## 快速开始（本地）

在自己电脑上跑，不需要域名、不需要 VPS、不需要 HTTPS。

```bash
# 1. 安装依赖
cd src && bun install

# 2. 生成 VAPID 密钥（PWA push 通知用，可选）
npm run setup-vapid

# 3. 启动 hub
tmux new-session -d -s hub 'bun run hub.ts'

# 4. 配置 CC 的 MCP（在你的项目 .mcp.json 里加）
# { "mcpServers": { "channel": { "command": "bun", "args": ["run", "/path/to/src/server.ts"] } } }

# 5. 启动 CC
tmux new-session -d -s cc
tmux send-keys -t cc 'claude' Enter

# 6. 打开前端
# 浏览器访问 http://localhost:3456
```

## 进阶：远程访问（VPS + 域名）

想从手机或其他设备访问 CC，需要：

1. **一台 VPS**（建议 ≥ 2GB 内存）— 让 CC 24 小时在线
2. **域名**（可选但推荐）— 不想每次输 IP 的话
3. **HTTPS** — 浏览器对非 localhost 的 WebSocket 连接要求 `wss://`，必须配证书
4. **nginx 反代** — 把 hub 的 WebSocket 端口代理到 443

```nginx
# nginx 配置示例（hub 同时提供 HTTP 和 WebSocket）
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
```

`proxy_read_timeout 86400` 很重要——默认 60 秒会断 WebSocket。Hub 同时提供 HTML 页面和 WebSocket，全走同一个端口。

证书推荐用 Let's Encrypt（免费）：
```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

## CC 冷知识（热知识）

- **Session 本地保存**：所有对话都存在本地 JSONL 文件里。即使 context 被压缩，原文不会消失
- **Session 文件保留 30 天**：默认只保留 30 天，可以在设置里改 `~/.claude/settings.json` → `"sessionTTLDays"`
- **`/resume`**：回到任意历史 session 继续对话，会列出最近的 session 让你选
- **`/continue`**：直接接上最后一个 session，不用选
- **不要用 root 跑 CC**：`--dangerously-skip-permissions` 在 root 下会拒绝执行。建议新建一个普通用户跑 CC

## 可选升级

- **终端视图**：参考代码用 `tmux capture-pane` 轮询文本，延迟高且没有颜色。可以换成 xterm.js + node-pty 或 SwiftTerm 做真实终端流，通过 WebSocket 双向传输 PTY 数据
- **前端框架**：参考代码是单文件 vanilla HTML。复杂场景可以拆成 React/Vue 项目

详细原理和踩坑见 [GUIDE.md](GUIDE.md)，出问题看 [HANDBOOK.md](HANDBOOK.md)。
