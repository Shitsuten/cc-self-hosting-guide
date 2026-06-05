# 自制前端连接 Claude Code：从原理到踩坑

> 这不是教程，是一份参考。记录了我们在把 CC 接到自制 web 前端过程中搞清楚的所有东西。适合想自己动手但不知道从哪下手的人。

---

## 目录

- [零、进化路线概览](#零进化路线概览)
- [一、两个概念：MCP 和 Channel](#一两个概念mcp-和-channel)
- [二、官方 Telegram 插件是怎么工作的](#二官方-telegram-插件是怎么工作的)
- [三、我们最初的方案：自己写一个带 channel 能力的 MCP server](#三我们最初的方案自己写一个带-channel-能力的-mcp-server)
- [四、版本更新后翻车](#四版本更新后翻车)
- [五、最终方案：tmux 注入](#五最终方案tmux-注入)
- [六、自动化脚本](#六自动化脚本)
  - [1. Nudge（定时主动行为）](#1-nudge定时主动行为)
  - [2. Watchdog → 开机自启动](#2-watchdog--开机自启动2026-05-15-移除)
  - [3. Session 轮换](#3-session-轮换)
- [七、关于维护](#七关于维护)
- [八、关键经验总结](#八关键经验总结踩了才知道的)
- [九、文件清单](#九文件清单)
- [附录：排障手册](#附录排障手册handbook模板)

---

## 零、进化路线概览

先给一个全貌，后面每一步都会展开。

```
阶段1  screen + Telegram plugin
       ↓  screen 的 pty 有问题，MCP 通信断断续续
阶段2  tmux + Telegram plugin
       ↓  想要自制前端，不想被 Telegram 限制
阶段3  tmux + 自制 MCP server（走 channel notification 入站）
       ↓  CC 版本更新，--dangerously-load-development-channels crash
阶段4  tmux + tmux send-keys 入站 + MCP 工具出站（当前方案）
```

越走越野，但越走越稳。每次迁移都是被逼的——screen 不行换 tmux，Telegram 不够用换自制前端，channel flag 炸了换 tmux 注入。

**本文亮点：** 如果你已经有了基本的前端 + CC 架构，可以直接跳到感兴趣的部分——
- **Session 轮换**（第六节）：通过前端远程完成 CC 的停止、重启和上下文衔接，不需要 SSH。这是我们摸索出来的解决 CC 长期运行后 context 膨胀问题的方案。
- **排障手册的思路**（第七节）：VPS 上的 CC 不应该自己修自己。单独维护一份排障手册，让别的 agent 或者你自己照着修，比让 CC 分心 debug 自己靠谱得多。

---

## 一、两个概念：MCP 和 Channel

在讲具体方案之前，先把两个概念分清楚，因为它们经常被混着说。

### MCP（Model Context Protocol）

MCP 是一个通用协议，让 CC 能调用外部工具。比如读 vault、发 Discord 消息、操作文件系统——这些都是通过 MCP 工具实现的。

MCP 的基本模型是**单向的**：CC 调用工具，工具返回结果。CC 是主动方，工具是被动方。

### Channel

Channel 是 CC 在 MCP 之上加的一层**实验性扩展**。

普通的 MCP server 只能等 CC 来调用它。但如果一个 MCP server 声明了 channel 能力，它就可以**反过来给 CC 推送消息**。这就是 channel 做的事——打开了一条"外部世界 → CC"的入站通道。

技术上，channel 用的是 MCP 协议自带的 notification 机制（`notifications/claude/channel`）。所以 channel 不是独立于 MCP 的另一套东西，而是 MCP 的一个扩展用法。

### 合在一起看

一个"带 channel 能力的 MCP server"同时扮演两个角色：
- **作为 MCP 工具**：提供 `reply` 等工具让 CC 调用（出站，CC → 外部）
- **作为 Channel**：往 CC 推送消息通知（入站，外部 → CC）

官方的 Telegram 插件就是这样一个东西。

---

## 二、官方 Telegram 插件是怎么工作的

```
Telegram Bot API（轮询消息）
      ↓
CC Telegram Plugin（带 channel 能力的 MCP server，Bun 跑的 TypeScript）
      ↓ stdio（双向）
Claude Code（主进程）
```

具体来说：
1. 你启动 CC 时加 `--channels plugin:telegram@claude-plugins-official`
2. CC 会从插件市场下载 telegram 插件，拉起来作为一个 MCP server 子进程
3. 这个 MCP server 通过 stdio 跟 CC 通信
4. **入站**：插件用 Telegram Bot API 的 long polling 接收消息 → 通过 channel notification 推给 CC
5. **出站**：CC 处理完后，调用插件提供的 MCP 工具（`reply`）→ 插件调 Telegram Bot API 发送回复

---

## 三、我们最初的方案：自己写一个带 channel 能力的 MCP server

既然 Telegram 插件只是一个带 channel 能力的 MCP server，那我们自己写一个不就行了？

### 架构（v1）

```
Web 前端（浏览器）
    ↕ WebSocket
Hub（独立 Node/Bun 进程，常驻）
    ↕ WebSocket（内部桥接）
Server.ts（MCP server，被 CC 拉起）
    ↕ stdio
Claude Code
```

三个角色：
- **Hub**（hub.ts）：WebSocket 服务器，直接面对前端。即使 CC 挂了，hub 还活着，前端不会断连，只是看到"CC offline"。
- **Server.ts**（MCP bridge）：CC 启动时通过 `.mcp.json` 加载的 MCP server。它连到 hub，负责在 CC 和 hub 之间转发消息。出站时 CC 调 `reply` 工具 → server.ts → hub → 前端。入站时 hub → server.ts → MCP channel notification → CC。
- **前端**：普通网页，连 hub 的 WebSocket。

### 入站细节（用户消息怎么到达 CC）

前面说了，channel 是 MCP 的实验性扩展。MCP server 在声明 capabilities 时加上 channel 能力：

```typescript
capabilities: {
  tools: {},
  experimental: { 'claude/channel': {} },
}
```

然后就可以用 `notifications/claude/channel` 往 CC 推送消息。CC 收到后当作用户输入处理。

这需要 CC 启动时加两个 flag：
```bash
claude --channels server:<your-mcp-server-name> --dangerously-load-development-channels
```

- `--channels server:<name>` 告诉 CC 从哪个 MCP server 监听 channel 消息
- `--dangerously-load-development-channels` 允许加载非官方 channel 插件
- MCP server 需要在 `.mcp.json` 里配置好，`server:` 前缀匹配 `.mcp.json` 里的 key

### 出站细节（CC 的回复怎么送回前端）

CC 调 server.ts 提供的 `reply` MCP 工具 → server.ts 通过 WebSocket 转发给 hub → hub 广播给所有前端客户端。

出站走的是标准的 MCP tool call，不需要任何特殊 flag，完全稳定。

---

## 四、版本更新后翻车

**`--dangerously-load-development-channels` 在新版 CC（2.1.118+）会导致 crash。**

表现：CC 启动后直接报 `--print` 模式错误然后退出。疑似这个 flag 的解析跟其他 flag 冲突了。

我们试了：
- CC 2.1.141、2.1.118、2.0.77 三个版本
- settings.json 里加 `skipDangerousDevelopmentChannelWarning: true`（只跳过警告，不替代 flag）
- 只用 `--channels` 不用 `--dangerously-load-development-channels`（CC 报错说 server 不在 approved allowlist）

**结论：入站通过 MCP channel notification 这条路走不通了。**

出站（CC 调 MCP 工具回复）完全没问题，不受影响。

---

## 五、最终方案：tmux 注入

既然 MCP channel notification 走不通，我们绕过它——直接往 CC 的终端注入文字。

### 新架构

```
入站（用户 → CC）：
前端 → hub → tmux send-keys → CC 终端

出站（CC → 用户）：
CC → MCP reply 工具 → server.ts bridge → hub → 前端
```

入站改成了终端注入，出站还是走 MCP 工具，没动。

**注意：这个方案里 channel 协议实际上完全没有用到了。** 入站不走 channel notification，出站是普通的 MCP tool call。唯一跟 channel 沾边的是消息的 `<channel>` tag 格式（见下文），但那只是一个格式约定，让 CC 知道该调哪个 MCP server 的 reply 工具来回复，不是真的在走 channel 协议。

### tmux 注入的原理

CC 跑在一个 tmux session 里。tmux 有一个命令叫 `send-keys`，可以往 session 里"打字"——就像有人在键盘上敲了这些字然后按了回车。

```bash
tmux send-keys -t <session-name> "要发送的内容" Enter
```

CC 收到这段文字后，就当作用户在终端里打的字来处理。

**tmux 的原理**：tmux 在你的程序和真正的终端之间插了一层虚拟终端。它完全控制了这个虚拟终端——能记录屏幕内容、能模拟键盘输入、能断开真终端但程序继续跑。send-keys 做的事情就是往虚拟终端的输入流里塞字节，对于里面跑的程序来说，跟真人用键盘打进来的完全一样。

### 消息格式

为了让 CC 知道这是从前端来的消息（而不是随便一段文字），我们把消息格式化成 CC 认识的 channel tag：

```
<channel source="my-frontend" chat_id="xxx" message_id="xxx" user="username" ts="2026-05-15T03:00:00.000Z">
消息内容
</channel>
```

CC 看到这个 tag 就知道该调对应 MCP server 的 `reply` 工具来回复，而不是把回复打印到终端。这里复用了 CC 内部解析 channel tag 的逻辑，但我们并没有走 channel 协议的 notification 通道——文字是 tmux 硬塞进去的，CC 只是认出了格式。

### hub.ts 里的关键代码

```typescript
import { execFileSync } from 'child_process'

function forwardToCC(text: string, chatId: string, messageId: string, user: string) {
  const ts = new Date().toISOString()
  const tag = `<channel source="my-frontend" chat_id="${chatId}" message_id="${messageId}" user="${user}" ts="${ts}">\n${text}\n</channel>`
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, '-l', tag])
  execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'Enter'])
}
```

**重要：用 `execFileSync` 不要用 `execSync`。** `execSync` 会经过 shell，消息里的 `$`、`` ` ``、`"` 等字符会被 shell 解释，消息内容会被破坏。`execFileSync` 直接调用 tmux 二进制，不经过 shell，什么特殊字符都不怕。

**重要：注入前必须 strip 换行符。** `tmux send-keys -l` 遇到内容中的 `\n` 会当成按了 Enter，导致消息被从中间截断提交。如果消息是 XML tag 格式，截断后 CC 收到的是畸形 XML，会卡住不处理。修复方法是在 `forwardToCC` 里把 `content.replace(/\n/g, ' ')` 再注入。

### 为什么这个方案可行

1. tmux send-keys 是 tmux 的标准功能，不依赖 CC 的任何实验性 flag
2. CC 对 channel tag 格式的解析是内置的，不需要 `--channels` flag 也认（这是 CC 处理所有 channel 插件消息的通用逻辑）
3. 出站走的是普通 MCP tool call，一直是稳定的
4. **整个方案不依赖 channel 协议**——不需要 `--channels`、不需要 `--dangerously-load-development-channels`、不需要 MCP notification。只要 CC 还认 `<channel>` tag 格式（官方 Discord 和 Telegram 插件都依赖这个），这个方案就不会 break

### 离线消息投递：Whisper 自动兜底

如果 CC 调 MCP reply 工具时前端没有客户端在线（WebSocket 无连接），消息不会丢——channel server 会自动 fallback 到 whisper 推送：存消息 + 推手机通知。用户下次打开前端就能看到。

**注意：不要手动调 whisper push API 发消息。** channel reply 失败时已经自动兜底了，手动再发一次 = 用户收到两条一样的。只有在完全绕过 channel 的极少数场景下才需要手动 whisper。

### 局限

- tmux 注入是"模拟打字"，如果 CC 正在处理别的事情（比如正在输出回复），注入的文字会跟 CC 的输出混在一起。实际使用中问题不大，因为 hub 会在 CC busy 的时候告诉前端"正在思考"。
- 没有送达确认。tmux send-keys 执行成功只代表字节塞进去了，不代表 CC 真的收到并处理了。如果 CC 当时卡死了，这条消息就丢了。
- 没有背压机制。如果前端疯狂发消息，全部会挤进终端。但正常使用不会遇到这个问题。
- **内容换行符会被当成 Enter。** `send-keys -l` 的 `-l`（literal）只阻止特殊键名解析（如 `Enter`、`Escape`），不阻止实际的 `\n` 字符被当成换行发送。必须在注入前把 `\n` 替换掉。

### 终端视图（bonus：tmux 的第三个能力）

tmux 除了 send-keys（往里塞字节）和 detach（断开但不杀进程），还有一个能力：`capture-pane`——把虚拟终端的屏幕内容读出来。

我们用这个做了前端的终端视图，可以实时看到 CC 在终端里干什么（在 thinking、在调工具、在写回复……）。

**实现方式：**
1. 前端打开终端视图时，通过 WebSocket 发 `terminal_subscribe` 给 hub
2. hub 每 2 秒跑一次 `tmux capture-pane -t <session> -p -S -60`，读最近 60 行终端内容
3. 跟上一次的结果对比，有变化就推给所有订阅的前端
4. 前端关掉终端视图就 `terminal_unsubscribe`，hub 不再推送

不是真正的实时流，是 2 秒轮询差异。但对人眼来说足够了。

capture-pane 跟 send-keys 一样，对 CC 完全透明——CC 不知道有人在看它的屏幕。

**终端视图还支持远程操控：**
- 前端可以通过 `terminal_input` 消息往 CC 的终端注入命令（走 tmux send-keys）
- 支持发送 Ctrl+C 信号（`terminal_signal` 消息，走 `tmux send-keys -t <session> C-c`）用于中断卡死的进程
- 前端提供预制指令栏（start CC、claude --continue、tmux ls 等），点击填入输入框

**所以 tmux 在整个方案里其实承担了四个角色：**
- **detach**：让 CC 脱离 SSH 在后台跑
- **send-keys**：入站，模拟键盘输入（消息注入 + 终端操控）
- **send-keys 信号**：发送 Ctrl+C 等控制信号
- **capture-pane**：终端视图，读屏幕内容

这些能力组合起来，tmux 就变成了 CC 和外部世界之间的一个完整的双向通道（加一个观察窗口和控制面板）。

---

## 六、自动化脚本

### 1. Nudge（定时主动行为）

CC 跑在 VPS 上 24 小时在线，但没人找它的时候它就干等着。nudge 解决这个问题——定时检查空闲时间，往终端注入一条系统指令，让 CC 主动做点什么。

**原理：** hub.ts 里跑一个 `setInterval`（每 5 分钟 tick），检查用户最后一条消息距今多久。超过阈值就用 `tmux send-keys` 往终端注入一条 `[nudge]` 消息。CC 收到后自行决定做什么——查 heartbeat、读记忆库、发消息、写 moment、或者任何它觉得合适的事。

核心就一句话：**往终端注入一条系统指令来触发 CC 的主动行为，上下文完全连续。** CC 的 session 一直在，它记得之前聊了什么，所以它做出的反应是基于完整上下文的，不是无脑定时推送。

**关键设计：**
- 首次阈值 10 分钟，之后 15-45 分钟随机间隔（`rollThreshold()`），深夜（UTC+8 0:00-7:30）拉长到 2 小时一次
- CC busy 的时候不发（正在回复别的消息）
- CC 进程不在的时候不发
- 白天 nudge 内容：要求 CC 先查 heartbeat，再看最近的 moments，然后结合数据决定发什么
- 夜间 nudge 内容：给一份具体的任务菜单（写日记、检查服务、整理记忆、读资讯、发 moment），要求做了什么早上汇报
- 阈值基于用户最后发消息的时间（从 WebSocket 消息历史里取），不是 CC 最后回复的时间
- **Nudge 可以附带结构化数据。** 比如我们在 nudge 里注入 ledger（待办事项列表）的未完成 items，CC 就能在主动行为时提醒用户今天该做什么、什么 deadline 快到了。hub 在组装 nudge 消息时从 ledger API 拉数据拼进去就行

**保证执行的 stop hook（电击项圈）：**

光有 nudge 不够——CC 可能收到 nudge 后选择"不发消息"，然后默默结束回合。所以配了一个 stop hook（`nudge-check.sh`），在 CC 每次要结束回合时检查：

1. 读 CC 的 transcript JSONL，找最后一条真实用户消息（跳过 `tool_result`）
2. 检查这条消息是不是 nudge（内容包含 `[nudge]`）
3. 如果是 nudge，检查 CC 在这之后有没有调用过 satyricon 的 reply 工具
4. 如果没有 → block，返回提示强制 CC 发消息

这个 hook 确保 CC 不能"收到 nudge 但不发消息"。效果：CC 被 nudge 后必定会通过前端发一条消息给用户。

**早期方案（已废弃）：** 最初 nudge 是一个独立的 Python 脚本通过 cron 跑的，但后来发现 hub.ts 已经掌握了用户最后消息时间等关键信息，把 nudge 逻辑合并进 hub 更简洁。cron 依赖外部状态文件，hub 内置计时器不需要。

### 2. ~~Watchdog~~ → 开机自启动（2026-05-15 移除）

Watchdog 经历了 v1-v5 五个版本的迭代，每个版本都有不同的 bug（自杀循环、hub 误杀、Telegram 依赖）。最终决定完全移除，改用 rc.local 开机自启动 + 手动运维。

**`/etc/rc.local`：**
```bash
#!/bin/bash
su - myuser -c "tmux new-session -d -s hub 'cd /opt/cc-project/channel-hub && exec bun run hub.ts 2>&1'"
su - myuser -c "tmux new-session -d -s cc"
exit 0
```

Hub 开机自动拉起，CC 的 tmux session 创建但不自动启动（需要手动 `bash start_cc.sh`，因为可能需要交互）。

**历史踩坑记录（留作参考）：**
- **v1 自杀循环：** pgrep 匹配规则太宽，误判正常进程为重复，导致 CC 在"启动→被杀→启动→被杀"无限循环
- **v2-v5 hub 误杀：** bun 进程名不带完整命令行，pgrep 匹配不到，watchdog 以为 hub 死了反复重启
- **所有版本的 Telegram 依赖：** 通知通过 Telegram 发送，Telegram 移除后 watchdog 无法通知

**教训：不要写 watchdog。** 在 1GB VPS 上跑的服务，自动重启的判断逻辑永远比你预期的脆弱。手动 SSH 重启更可靠。

### 3. Session 轮换

CC 的 context window 有上限。CC 有内置的自动压缩机制，大多数时候不需要手动干预。但如果 CC 被 OOM 杀掉或异常退出，就需要手动重启一个新 session。

**启动脚本做了什么：**

启动脚本（`start_cc.sh`）不只是 `claude` 一行命令，它还负责 session 之间的上下文衔接：

1. 检查有没有上一个 session 留下的摘要文件（如 `session_summaries/pending_*.md`）
2. 如果有，把摘要内容写到一个临时文件，用 `--append-system-prompt-file` 注入新 session 的系统提示
3. 同时从旧 session 的 JSONL 里提取最后 20 条对话原文，一起附上，让新 CC 能看到最近在聊什么
4. 启动 CC 后，延时注入一条消息（通过 `tmux send-keys`），提醒 CC 主动给用户打招呼

所以轮换前要做的是：在旧 session 还活着的时候，让 CC 把摘要写好存到约定路径。

**前端预制按钮的设计：**

前端的终端视图里有一排预制按钮（preset bar），点击即可向 tmux session 发送预设命令，省去手动打字：

- **⌃C 按钮**：向 tmux 发送 Ctrl+C 信号。因为这个操作会中断 CC 进程，所以需要 PIN 确认。输入 PIN 后有 10 秒宽限期，期间再次点击不需要重新输入——这是因为退出 CC 需要连按两次 Ctrl+C（第一次中断当前任务，第二次退出 CC 本身）
- **start CC**：执行 `bash start_cc.sh`，一键重启
- **claude --continue**：恢复上一个 session 而不开新的，适合 CC 意外退出但 session 文件还完好的情况

有了这些，轮换 session 不需要 SSH 进服务器，在手机或网页上就能完成。

**CC 的 auto-memory 系统：**

除了 session summary，CC 还有内置的持久化记忆系统（`~/.claude/projects/<project>/memory/`）。这是一个文件目录，CC 可以自己读写 markdown 文件来记住跨 session 的信息——用户偏好、反馈、项目状态、外部资源引用等。

跟 session summary 的区别：session summary 是一次性的，用来衔接两个相邻 session；auto-memory 是长期的，所有 session 都能读到。配合使用效果最好——summary 传递"刚才在干嘛"，memory 传递"一直以来要注意什么"。

建议让 CC 在换 session 前把本轮学到的新东西存进 memory，这样即使 summary 压缩丢了细节，关键信息还是能跨 session 保留。

**局限：**
- 新 session 有摘要但记忆深度不如原始对话——这是压缩的固有代价
- 摘要质量取决于你让 CC 写了什么。建议包含：当前话题、重要上下文、用户近期状态

---

## 七、关于维护

VPS 上跑 CC 的本质目的是让 CC 专注在那台 VPS 上运行——陪聊、主动行为、调工具，所有 token 和 context 都花在这件事上。

所以当 VPS 上的 CC 出问题时，**不要用那个 CC 自己来修自己。** debug 和运维应该交给别的东西——另一台机器上的 AI agent、别的 AI 服务、或者你自己手动 SSH 进去。

建议整理一份详尽的排障手册（handbook），覆盖所有常见故障的症状、排查步骤和修复命令。这样不管是让别的 AI 照着手册修，还是自己半夜被叫起来 SSH 进去，都能快速定位问题，而不是让 VPS 上的 CC 分心去 debug 自己的运行环境。

附录里附了一份我们自用的 handbook 作为参考。

---

## 八、关键经验总结（踩了才知道的）

1. **出站走 MCP 工具，入站走 tmux 注入。** 不要依赖 `--channels` 和 `--dangerously-load-development-channels`，这两个 flag 不稳定。
2. **Hub 和 CC 分离。** Hub 常驻，CC 可以挂可以重启，前端不受影响。
3. **用 `execFileSync` 不要用 `execSync`。** Shell 转义会吃掉特殊字符。
4. **注入前 strip 换行符。** `tmux send-keys -l` 遇到 `\n` 会当成 Enter，截断消息。
5. **screen 不能用，只能用 tmux。** MCP stdio 在 screen detached 模式下不工作。
6. **1GB 内存跑 CC 非常勉强。** CC 虚拟内存会到 73GB，OOM killer 随时可能动手。建议至少 2GB。
7. **CC 读图片可能炸 session。** 某些图片导致 API 400，但图片数据已经在 context 里了，之后每轮都重发都 400，session 不可恢复。
8. **不要写 watchdog。** 在资源受限的 VPS 上，自动重启的判断逻辑永远比预期脆弱。rc.local 开机自启 + 手动运维更可靠。
9. **不要用 pkill -f 杀进程。** 匹配范围太广会连带杀死 MCP bridge，导致 CC 一起挂。用精确 PID 或 tmux send-keys C-c。
10. **tmux session 命名要语义化。** 历史遗留的 "telegram" session 名曾导致多次混淆。改为 `cc` 和 `hub`。
11. **不要让 VPS 上的 CC debug 自己。** 它的 token 和 context 应该花在正事上，运维交给外部。
12. **SSE 长连接需要 keepalive。** 如果你的前端或 legacy 客户端用 SSE（Server-Sent Events）连接 hub，中间经过 nginx/CDN/云服务商的反代时，空闲连接会被静默断开（通常 60 秒超时）。解决方法是服务端每 25 秒发一条 SSE 注释 `:ping\n\n`，保持连接活跃。不加的话客户端会频繁重连，hub 侧也会累积 stale 连接。
13. **多机部署时注意文件权限。** 如果你有多台机器通过 MCP 工具操作同一个 VPS 上的文件（比如一台跑 CC，另一台跑管理 agent），注意写入文件的 owner 可能不一致。我们遇到过一台机器以 root 写入了数据文件，另一台以普通用户运行的服务读不了，导致 EACCES 崩溃循环。建议统一运行用户，或对共享数据目录设置 `setgid` + 宽松的 group 权限。
14. **多 VPS 部署模式。** 服务不一定要全跑在一台机器上。我们的方案是 CC 和 channel hub 跑在本机，其他服务（站点、API、工具）跑在另一台 VPS 上，CC 通过 MCP 工具（exec_vps）远程操作。好处是 CC 的 OOM 不会连带杀死其他服务，坏处是多了网络延迟和一层 SSH 跳板。

---

## 九、文件清单

VPS 上的关键文件（路径根据你自己的部署调整）：

| 文件 | 作用 |
|------|------|
| `start_cc.sh` | CC 启动脚本，处理 session 摘要注入 |
| `watchdog.sh` | ~~保活脚本~~ 已移除，改用 rc.local 开机自启 |
| `channel/hub.ts` | WebSocket hub，面对前端，内含 nudge 定时逻辑 |
| `channel/server.ts` | MCP bridge，CC 调工具时经过这里 |
| `.claude/hooks/nudge-check.sh` | Nudge 的 stop hook，强制 CC 发消息 |
| `.mcp.json` | MCP server 配置 |
| `.claude/settings.local.json` | CC 权限配置 |
| `CLAUDE.md` | CC 的人设和行为指令 |

---

## 附录：排障手册（Handbook）模板

> 以下是我们自用的排障手册，脱敏后的版本。建议根据自己的部署情况整理一份类似的。给 AI agent 和自己看的，修之前先读完相关 section。

### 排障原则

1. **先看再动**。`tmux ls` 看 session 在不在，`pgrep -af claude` 看进程在不在，`dmesg | tail -30` 看有没有 OOM。
2. **不要随便改 nginx 配置**。改完 sites-available 要同步到 sites-enabled（有些服务器不是 symlink 是独立拷贝）。
3. **不要碰 `.mcp.json` 和 `CLAUDE.md`** 除非你完全知道自己在做什么。
4. **root 用户不能用 `--dangerously-skip-permissions`**。CC 硬性禁止。
5. **不要跑多个 CC 实例**。OAuth token 和 tmux session 会打架。

### CC 进程挂了 / 没响应

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

### SSH 连不上

可能是防火墙规则被改了。通过 VPS 面板的 VNC 登入：
```bash
ufw allow 22/tcp
systemctl restart ssh
```

### screen vs tmux

**永远用 tmux，不要用 screen。** CC 的 MCP 插件在 screen detached 模式下收不到消息。原因是 screen 的 pty 分配方式导致 stdio 通信异常。

### 权限格式

CC 的 MCP 工具权限通配符格式是 `mcp__<服务名>__*`，服务名要完整写。

常见错误：
```
mcp__*(*)     ← 不行，不能带括号
Plugin:*      ← 不行，大写不对
mcp__*        ← 不行，不匹配 plugin 工具
```

### --channels flag 不能用

`--dangerously-load-development-channels` 在新版 CC 会 crash。启动脚本里不要加这个 flag，也不要加 `--channels`。入站用 tmux send-keys 绕过。

### 启动脚本注意事项

- 用 `--append-system-prompt-file` 传系统提示，不要直接在命令行传中文（编码乱码）
- 不要加 `--channels` 和 `--dangerously-load-development-channels`
- 如果以前用过 telegram plugin，确保已禁用（避免跟自制前端抢消息）

### watchdog 注意事项（已废弃，留作参考）

- watchdog 已移除，改用 rc.local 开机自启
- 如果你仍然想做保活：**只通知，不自动重启 CC。** CC 重启后 context 是空的，需要人工处理
- **不要做"重复进程检测"。** 只检查"有没有在跑"。重复检测的 pgrep 逻辑极容易误判导致无限杀→重启循环
- **不要用 pkill -f 杀进程。** 匹配范围太广，会连带杀死 MCP bridge 等子进程导致 CC 一起挂。用精确 PID 或 tmux send-keys C-c

### nginx 踩坑

- sites-enabled 可能不是 symlink 而是独立拷贝，改完 sites-available 要手动同步
- 检查有没有 `.bak` 文件残留在 sites-enabled 里跟主配置打架
- 改完配置：`nginx -t && systemctl reload nginx`

### 图片炸 session

CC 的 Read 工具读某些 png 会导致 API 400。图片数据进入 context 后每轮重发，session 不可恢复。**预防**：不要让 CC 直接 Read 图片文件。**已发生**：只能新开 session。

### 数据文件权限错误（EACCES 崩溃循环）

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

### SSE 连接频繁断开重连

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

### OAuth 过期

CC 的 OAuth token 会过期。重启 CC 时可能需要重新登录。`claude setup-token` 可以生成长期 token。

### CC 版本更新

CC 会自动更新。更新过程中启动可能报 `native binary not installed`。等更新完再启动，或手动 `npm install -g @anthropic-ai/claude-code`。

### 快速恢复 cheatsheet

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
