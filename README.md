# cc-web-frontend

把 Claude Code 接到自制 web 前端的完整方案。包含架构指南、参考代码和排障手册。

## 这是什么

一套让 CC（Claude Code CLI）通过自制 web 前端对话的方案。核心思路：

- **入站**（用户 → CC）：前端 → WebSocket hub → `tmux send-keys` → CC 终端
- **出站**（CC → 用户）：CC → MCP reply 工具 → hub → 前端

不依赖任何实验性 flag，不走 channel 协议。只要 CC 还认 `<channel>` tag 格式，这个方案就不会 break。

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

## 关键文件

| 文件 | 作用 |
|------|------|
| `start_cc.sh` | CC 启动脚本，处理 session 摘要注入 |
| `channel/hub.ts` | WebSocket hub，面对前端，内含 nudge 定时逻辑 |
| `channel/server.ts` | MCP bridge，CC 调工具时经过这里 |
| `.claude/hooks/nudge-check.sh` | Nudge 的 stop hook，强制 CC 发消息 |
| `.mcp.json` | MCP server 配置 |
| `.claude/settings.local.json` | CC 权限配置 |
| `CLAUDE.md` | CC 的人设和行为指令（需要自己写） |

## 前置要求

- tmux
- Node.js / Bun
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
- 可选：一台 VPS（想让 CC 24 小时在线的话。建议 ≥ 2GB 内存，1GB 非常勉强。本地电脑跑也完全可以）

## 快速开始

```bash
# 1. 启动 hub
tmux new-session -d -s hub 'cd channel && bun run hub.ts'

# 2. 启动 CC（新 session 或 continue）
tmux new-session -d -s cc
tmux send-keys -t cc 'bash start_cc.sh' Enter

# 3. 打开前端，连 hub 的 WebSocket，开始对话
```

详细原理和踩坑见 [GUIDE.md](GUIDE.md)，出问题看 [HANDBOOK.md](HANDBOOK.md)。
