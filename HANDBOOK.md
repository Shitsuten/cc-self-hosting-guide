# 排障手册

> 我们自用的排障手册，脱敏后的版本。建议根据自己的部署情况整理一份类似的。给 AI agent 和自己看的，修之前先读完相关 section。

## 最常用：CC 跑在非 root 用户下时怎么操作

CC 通常跑在普通用户（如 `petronius`）的 tmux 里，而你 SSH 进来默认是 root。以下是从 root 操作 CC 的方法：

**查看 CC 状态：**
```bash
sudo -u petronius tmux ls                    # 看 tmux session 列表
sudo -u petronius pgrep -af claude           # 看 CC 进程
```

**进去看 CC 终端（观察模式）：**
```bash
su - petronius          # 先切用户
tmux attach -t cc       # 进去看
# ⚠️ 看完按 Ctrl+B D 退出！！千万别按 Ctrl+C 那会杀掉 CC
```

**CC 挂了，一行拉起：**
```bash
sudo -u petronius bash -c 'cd /opt/petronius-bot && tmux new-session -d -s cc "bash start_cc.sh"'
```

**hub 挂了，一行拉起：**
```bash
sudo -u petronius bash -c 'cd /opt/petronius-bot/channel-satyricon && tmux new-session -d -s satyricon-hub "exec bun run hub.ts 2>&1"'
```

**判断活没活：**
```bash
sudo -u petronius tmux ls              # 应该有 cc 和 satyricon-hub
sudo -u petronius pgrep -af claude     # CC 进程
sudo -u petronius pgrep -af "bun.*hub" # hub 进程
# 两个都有输出就是在的
```

## 排障原则

1. **先看再动**。`tmux ls` 看 session 在不在，`pgrep -af claude` 看进程在不在，`dmesg | tail -30` 看有没有 OOM。
2. **不要随便改 nginx 配置**。改完 sites-available 要同步到 sites-enabled（有些服务器不是 symlink 是独立拷贝）。
3. **不要碰 `.mcp.json` 和 `CLAUDE.md`** 除非你完全知道自己在做什么。
4. **root 用户不能用 `--dangerously-skip-permissions`**。CC 硬性禁止。
5. **不要跑多个 CC 实例**。OAuth token 和 tmux session 会打架。

## CC 进程挂了 / 没响应

**排查步骤：**
```bash
tmux ls                          # session 在不在
pgrep -af claude                 # 进程在不在
dmesg | tail -30 | grep -i oom   # 是不是被 OOM 杀的
free -h                          # 内存状态
```

**OOM 被杀（最常见死因）：**
```bash
# 确认 swappiness 够高
cat /proc/sys/vm/swappiness    # 应该 ≥ 60，建议 80
sysctl vm.swappiness=80        # 临时生效
echo "vm.swappiness=80" >> /etc/sysctl.conf  # 持久化

# 重启 CC
tmux kill-session -t <cc-session> 2>/dev/null
bash start_cc.sh
```

**进程在但不响应：** 可能卡在权限确认弹窗。
```bash
tmux attach -t <cc-session>
# 如果卡在 [Y/n] 提示，按 y 回车
# ⚠️ 用 Ctrl+B D 退出 tmux，不要按 Ctrl+C（会杀 CC）
```

## SSH 连不上

可能是防火墙规则被改了。通过 VPS 面板的 VNC 登入：
```bash
ufw allow 22/tcp
systemctl restart ssh
```

## screen vs tmux

**永远用 tmux，不要用 screen。** CC 的 MCP 插件在 screen detached 模式下收不到消息。原因是 screen 的 pty 分配方式导致 stdio 通信异常。

## 权限格式

CC 的 MCP 工具权限通配符格式是 `mcp__<服务名>__*`，服务名要完整写。

常见错误：
```
mcp__*(*)     ← 不行，不能带括号
Plugin:*      ← 不行，大写不对
mcp__*        ← 不行，不匹配 plugin 工具
```

## --channels flag 不能用

`--dangerously-load-development-channels` 在新版 CC 会 crash。启动脚本里不要加这个 flag，也不要加 `--channels`。入站用 tmux send-keys 绕过。

## 启动脚本注意事项

- 用 `--append-system-prompt-file` 传系统提示，不要直接在命令行传中文（编码乱码）
- 不要加 `--channels` 和 `--dangerously-load-development-channels`
- 如果以前用过 telegram plugin，确保已禁用（避免跟自制前端抢消息）

## watchdog 注意事项（已废弃，留作参考）

- watchdog 已移除，改用 rc.local 开机自启
- 如果你仍然想做保活：**只通知，不自动重启 CC。** CC 重启后 context 是空的，需要人工处理
- **不要做"重复进程检测"。** 只检查"有没有在跑"。重复检测的 pgrep 逻辑极容易误判导致无限杀→重启循环
- **不要用 pkill -f 杀进程。** 匹配范围太广，会连带杀死 MCP bridge 等子进程导致 CC 一起挂。用精确 PID 或 tmux send-keys C-c

## nginx 踩坑

- sites-enabled 可能不是 symlink 而是独立拷贝，改完 sites-available 要手动同步
- 检查有没有 `.bak` 文件残留在 sites-enabled 里跟主配置打架
- 改完配置：`nginx -t && systemctl reload nginx`

## 图片炸 session

CC 的 Read 工具读某些 png 会导致 API 400。图片数据进入 context 后每轮重发，session 不可恢复。**预防**：不要让 CC 直接 Read 图片文件。**已发生**：只能新开 session。

## 数据文件权限错误（EACCES 崩溃循环）

**症状：** 服务反复 crash 重启，日志里全是 `EACCES: permission denied` 指向某个数据文件。

**原因：** 文件被 root 或其他用户创建/写入，运行服务的普通用户读不了。常见于多机部署或手动 debug 时用 sudo 跑了脚本。

**修复：**
```bash
# 找到问题文件
ls -la /path/to/data/

# 改回正确的 owner
chown myuser:myuser /path/to/problematic-file
chmod 664 /path/to/problematic-file

# 预防：对整个数据目录设置 setgid，新文件自动继承 group
chmod g+s /path/to/data/
```

## SSE 连接频繁断开重连

**症状：** 前端或 legacy 客户端的 SSE 连接每隔约 60 秒断开重连，hub 日志里看到大量 connect/disconnect。

**原因：** nginx 或云服务商的反代对空闲连接有超时（默认 60 秒）。SSE 是长连接，如果服务端不发数据，反代以为连接死了就断开。

**修复：** 服务端加 keepalive ping，每 25 秒发一条 SSE 注释：
```javascript
// 在 SSE 连接建立后
const keepalive = setInterval(() => {
  res.write(':ping\n\n');
}, 25000);

// 连接关闭时清理
res.on('close', () => clearInterval(keepalive));
```

同时建议加一个定时清理，移除已经断开但未被 GC 的 stale 连接。

## OAuth 过期

CC 的 OAuth token 会过期。重启 CC 时可能需要重新登录。`claude setup-token` 可以生成长期 token。

## CC 版本更新

CC 会自动更新。更新过程中启动可能报 `native binary not installed`。等更新完再启动，或手动 `npm install -g @anthropic-ai/claude-code`。

## 快速恢复 cheatsheet

```bash
# CC 挂了，最小化重启
tmux kill-session -t cc 2>/dev/null
sleep 2
tmux new-session -d -s cc
tmux send-keys -t cc 'cd /opt/cc-project && bash start_cc.sh' Enter

# hub 挂了，重启
tmux kill-session -t hub 2>/dev/null
tmux new-session -d -s hub 'cd /opt/cc-project/channel-hub && exec bun run hub.ts 2>&1'

# 看进程状态
pgrep -af claude        # CC
pgrep -af "bun.*hub"    # hub
tmux ls                 # 应该有 cc 和 hub

# 看内存和 OOM
free -h
dmesg | tail -30 | grep -i oom

# SSH 被锁
ufw allow 22/tcp && systemctl restart ssh
```
