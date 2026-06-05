#!/usr/bin/env bun
/**
 * Channel Hub — standalone WebSocket server.
 *
 * Runs independently of CC. The MCP bridge (server.ts) connects here
 * when CC is alive. If CC dies, the hub stays up and clients see
 * "CC offline" instead of losing connection entirely.
 *
 * Env:
 *   CHANNEL_PORT         — client-facing port (default 3456)
 *   CHANNEL_BRIDGE_PORT  — internal bridge port (default 3457)
 *   CHANNEL_PIN          — optional PIN for client auth. If not set, no auth required
 *   CHANNEL_TMUX         — tmux session name (default: cc)
 *   CHANNEL_USER         — display name for the user (default: user)
 *   CHANNEL_ASSISTANT    — display name for CC (default: claude)
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execSync, execFileSync } from 'child_process'
import webpush from 'web-push'

const PORT = parseInt(process.env.CHANNEL_PORT ?? '3456', 10)
const BRIDGE_PORT = parseInt(process.env.CHANNEL_BRIDGE_PORT ?? '3457', 10)
const PIN = process.env.CHANNEL_PIN ?? ''
const TMUX_SESSION = process.env.CHANNEL_TMUX ?? 'cc'
const USER_NAME = process.env.CHANNEL_USER ?? 'user'
const ASSISTANT_NAME = process.env.CHANNEL_ASSISTANT ?? 'claude'
const SCRIPT_DIR = import.meta.dir
const HISTORY_DIR = join(SCRIPT_DIR, 'history')
const HISTORY_FILE = join(HISTORY_DIR, 'current.jsonl')
const MAX_HISTORY = 500
mkdirSync(HISTORY_DIR, { recursive: true })
mkdirSync(join(SCRIPT_DIR, 'uploads'), { recursive: true })

// --- Logging ---
function log(msg: string) {
  process.stderr.write(`hub: ${msg}\n`)
}

// --- History ---
type StoredMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  ts: string
  reply_to?: string
  image?: string
  unread?: boolean
}

let history: StoredMessage[] = []
let _maxCounter = 0

function loadHistory() {
  if (existsSync(HISTORY_FILE)) {
    try {
      const lines = readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(l => l.trim())
      history = lines.map(l => JSON.parse(l))
      return
    } catch {}
  }
  history = []
}
loadHistory()

for (const m of history) {
  const match = m.id.match(/[us]_(\d+)/)
  if (match) _maxCounter = Math.max(_maxCounter, parseInt(match[1]))
}
log(`loaded ${history.length} history messages, counter at ${_maxCounter}`)

function appendMessage(msg: StoredMessage) {
  try { appendFileSync(HISTORY_FILE, JSON.stringify(msg) + '\n') }
  catch (err) { log(`append failed: ${err}`) }
}

function trimHistory() {
  const trimCount = 50
  const trimmed = history.slice(0, trimCount)
  history = history.slice(trimCount)
  try {
    const ds = new Date().toISOString().slice(0, 10)
    const archivePath = join(HISTORY_DIR, `archive_${ds}.jsonl`)
    appendFileSync(archivePath, trimmed.map(m => JSON.stringify(m)).join('\n') + '\n')
    writeFileSync(HISTORY_FILE, history.map(m => JSON.stringify(m)).join('\n') + '\n')
  } catch (err) { log(`trim failed: ${err}`) }
}

function addToHistory(msg: StoredMessage) {
  history.push(msg)
  appendMessage(msg)
  if (history.length >= MAX_HISTORY) trimHistory()
}

function updateInHistory(id: string, content: string) {
  const existing = history.find(m => m.id === id)
  if (existing) {
    existing.content = content
    try { writeFileSync(HISTORY_FILE, history.map(m => JSON.stringify(m)).join('\n') + '\n') }
    catch {}
  }
}

// --- Web Push ---
const VAPID_FILE = join(SCRIPT_DIR, 'vapid-keys.json')
const PUSH_SUBS_FILE = join(SCRIPT_DIR, 'push-subscriptions.json')
let vapidKeys = { publicKey: '', privateKey: '' }
try { vapidKeys = JSON.parse(readFileSync(VAPID_FILE, 'utf8')) } catch {}
if (vapidKeys.publicKey && vapidKeys.privateKey) {
  webpush.setVapidDetails('mailto:noreply@example.com', vapidKeys.publicKey, vapidKeys.privateKey)
  log('VAPID keys loaded')
} else {
  log('WARNING — no VAPID keys, run: npx web-push generate-vapid-keys > vapid-keys.json')
}

type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } }
let pushSubscriptions: PushSub[] = []
try { pushSubscriptions = JSON.parse(readFileSync(PUSH_SUBS_FILE, 'utf8')) } catch {}
log(`loaded ${pushSubscriptions.length} push subscriptions`)

function savePushSubscriptions() {
  try { writeFileSync(PUSH_SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2)) } catch {}
}

async function sendPushNotification(title: string, body: string) {
  if (!vapidKeys.publicKey || pushSubscriptions.length === 0) return
  const payload = JSON.stringify({ title, body })
  const stale: number[] = []
  for (let i = 0; i < pushSubscriptions.length; i++) {
    try {
      await webpush.sendNotification(pushSubscriptions[i], payload)
    } catch (err: any) {
      if (err?.statusCode === 410 || err?.statusCode === 404) stale.push(i)
      log(`push failed for sub ${i}: ${err}`)
    }
  }
  if (stale.length) {
    pushSubscriptions = pushSubscriptions.filter((_, i) => !stale.includes(i))
    savePushSubscriptions()
    log(`removed ${stale.length} stale push subscriptions`)
  }
}

// --- Client management ---
const clients = new Map<string, WebSocket>()
const clientLastPong = new Map<string, number>()
const clientLastActive = new Map<string, number>()
const ACTIVE_TIMEOUT = 90000
let clientCounter = 0
let messageCounter = _maxCounter
let ccAlive = false
let ccBusy = false
let busyTimer: ReturnType<typeof setTimeout> | null = null

function setBusy(busy: boolean) {
  ccBusy = busy
  if (busyTimer) clearTimeout(busyTimer)
  if (busy) busyTimer = setTimeout(() => setBusy(false), 120000)
  broadcast(JSON.stringify({ type: 'cc_busy', busy }))
}

function broadcast(data: string, exclude?: string) {
  for (const [id, ws] of clients) {
    if (id !== exclude && ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

function broadcastStatus() {
  broadcast(JSON.stringify({ type: 'cc_status', alive: ccAlive }))
}

// --- Bridge (CC's MCP bridge connects here) ---
let bridge: WebSocket | null = null

function handleBridgeMessage(raw: string) {
  let msg: any
  try { msg = JSON.parse(raw) } catch { return }

  if (msg._req_id && msg.type === undefined) return

  switch (msg.type) {
    case 'reply': {
      setBusy(false)
      const msgId = `s_${++messageCounter}`
      const ts = new Date().toISOString()
      let anyActive = false
      const now = Date.now()
      for (const [id, c] of clients) {
        if (c.readyState === WebSocket.OPEN && (now - (clientLastActive.get(id) ?? 0)) < ACTIVE_TIMEOUT) anyActive = true
      }
      const unread = !anyActive
      addToHistory({ id: msgId, role: 'assistant', content: msg.text, ts, reply_to: msg.reply_to, unread: unread || undefined })
      const payload = JSON.stringify({
        type: 'message', id: msgId, role: 'assistant',
        content: msg.text, reply_to: msg.reply_to, ts, unread
      })
      for (const [, c] of clients) {
        if (c.readyState === WebSocket.OPEN) c.send(payload)
      }
      if (!anyActive) {
        const preview = (msg.text || '').slice(0, 80)
        sendPushNotification(ASSISTANT_NAME, preview)
          .catch(e => log('web push failed: ' + e))
      }
      bridge?.send(JSON.stringify({
        _req_id: msg._req_id,
        ok: anyActive, id: msgId, error: anyActive ? undefined : 'no active clients'
      }))
      break
    }
    case 'edit': {
      updateInHistory(msg.message_id, msg.text)
      const ts = new Date().toISOString()
      broadcast(JSON.stringify({ type: 'edit', id: msg.message_id, content: msg.text, ts }))
      bridge?.send(JSON.stringify({ _req_id: msg._req_id, ok: true, id: msg.message_id }))
      break
    }
  }
}

const bridgeHttpServer = createServer()
const bridgeWss = new WebSocketServer({ server: bridgeHttpServer })

bridgeWss.on('connection', (ws) => {
  if (bridge && bridge.readyState === WebSocket.OPEN) {
    bridge.close(1000, 'replaced by new bridge')
  }
  bridge = ws
  ccAlive = true
  broadcastStatus()
  log('bridge connected, CC is alive')

  ws.on('message', (raw) => handleBridgeMessage(raw.toString()))
  ws.on('close', () => {
    if (bridge === ws) {
      bridge = null
      ccAlive = false
      setBusy(false)
      broadcastStatus()
      log('bridge disconnected, CC is offline')
    }
  })
  ws.on('error', (err) => log(`bridge error: ${err}`))
})

bridgeHttpServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  log(`bridge port ${BRIDGE_PORT}`)
})

// --- Tmux injection (sends user messages to CC) ---
function forwardToCC(content: string, meta: Record<string, unknown>): boolean {
  if (!ccAlive) return false
  const safe = content.replace(/\n/g, ' ')
  const attrs = ['chat_id', 'message_id', 'user', 'user_id', 'ts']
    .filter(k => meta[k] != null)
    .map(k => `${k}="${meta[k]}"`)
    .join(' ')
  const text = `<channel source="web" ${attrs}>${safe}</channel>`
  try {
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION + ':0', '-l', text], { timeout: 3000 })
    execFileSync('tmux', ['send-keys', '-t', TMUX_SESSION + ':0', 'Enter'], { timeout: 3000 })
    return true
  } catch (err) {
    log(`tmux inject failed: ${err}`)
    return false
  }
}

// --- Terminal capture ---
const terminalSubs = new Set<string>()
let lastCapture = ''

function captureTerminal(): string {
  try {
    return execSync(`tmux capture-pane -t ${TMUX_SESSION}:0 -e -p -S -60 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
  } catch { return '' }
}

function sendTerminalCapture(clientId?: string) {
  const output = captureTerminal()
  if (!output) return
  const payload = JSON.stringify({ type: 'terminal', content: output })
  if (clientId) {
    const ws = clients.get(clientId)
    if (ws?.readyState === WebSocket.OPEN) ws.send(payload)
  } else {
    for (const id of terminalSubs) {
      const ws = clients.get(id)
      if (ws?.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }
  lastCapture = output
}

setInterval(() => {
  if (terminalSubs.size === 0) return
  const output = captureTerminal()
  if (output && output !== lastCapture) {
    lastCapture = output
    const payload = JSON.stringify({ type: 'terminal', content: output })
    for (const id of terminalSubs) {
      const ws = clients.get(id)
      if (ws?.readyState === WebSocket.OPEN) ws.send(payload)
    }
  }
}, 2000)

// --- Nudge system ---
// Nudges CC when the user has been silent for a while.
// Customize thresholds and content to your needs.
const NUDGE_FIRST_THRESHOLD = 10
const NUDGE_MIN_INTERVAL = 15
const NUDGE_MAX_INTERVAL = 45

function findLastUserMessageTime(): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return new Date(history[i].ts).getTime()
  }
  return Date.now()
}

let lastUserMessageTime = findLastUserMessageTime()
let lastNudgeTime = 0
let nudgeThreshold = NUDGE_FIRST_THRESHOLD

function rollThreshold(): number {
  return NUDGE_MIN_INTERVAL + Math.random() * (NUDGE_MAX_INTERVAL - NUDGE_MIN_INTERVAL)
}

function tryNudge() {
  const now = Date.now()
  const idleMin = (now - lastUserMessageTime) / 60000
  const sinceLast = (now - lastNudgeTime) / 60000
  if (idleMin < nudgeThreshold) return
  if (sinceLast < nudgeThreshold) return
  if (!ccAlive || ccBusy) return

  const ts = new Date().toISOString()
  const msgId = `nudge_${++messageCounter}`
  const content = `[nudge] ${USER_NAME} has been silent for ${Math.floor(idleMin)} minutes.`
  const sent = forwardToCC(content, {
    chat_id: 'nudge', message_id: msgId,
    user: 'system', user_id: 'nudge', ts
  })
  if (sent) {
    lastNudgeTime = now
    nudgeThreshold = rollThreshold()
    log(`nudge sent (idle ${Math.floor(idleMin)}min, next threshold ${Math.floor(nudgeThreshold)}min)`)
  }
}

setInterval(() => { try { tryNudge() } catch (e) { log(`nudge error: ${e}`) } }, 5 * 60 * 1000)

// --- HTTP server ---
const httpServer = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]

  if (path === '/' || path === '/index.html') {
    try {
      const html = readFileSync(join(SCRIPT_DIR, 'index.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' })
      res.end(html)
    } catch { res.writeHead(500); res.end('error') }
    return
  }

  // PWA static files
  if (path === '/icon-192.png' || path === '/icon-512.png') {
    try {
      const data = readFileSync(join(SCRIPT_DIR, path.slice(1)))
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000' })
      res.end(data)
    } catch { res.writeHead(404); res.end('Not found') }
    return
  }
  if (path === '/manifest.json') {
    try {
      const data = readFileSync(join(SCRIPT_DIR, 'manifest.json'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' })
      res.end(data)
    } catch { res.writeHead(404); res.end('Not found') }
    return
  }
  if (path === '/sw.js') {
    try {
      const data = readFileSync(join(SCRIPT_DIR, 'sw.js'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/', 'Cache-Control': 'no-cache, no-store, must-revalidate' })
      res.end(data)
    } catch { res.writeHead(404); res.end('Not found') }
    return
  }

  // Push subscription API
  if (path === '/api/vapid-public-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ publicKey: vapidKeys.publicKey }))
    return
  }
  if (path === '/api/push/subscribe' && req.method === 'POST') {
    let body = ''
    req.on('data', (c: Buffer) => { body += c.toString() })
    req.on('end', () => {
      try {
        const sub = JSON.parse(body) as PushSub
        if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
          res.writeHead(400); res.end('invalid subscription'); return
        }
        if (!pushSubscriptions.some(s => s.endpoint === sub.endpoint)) {
          pushSubscriptions.push(sub)
          savePushSubscriptions()
          log(`new push subscription (total: ${pushSubscriptions.length})`)
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch { res.writeHead(400); res.end('invalid json') }
    })
    return
  }

  // Image upload
  if (path === '/api/upload' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk: any) => { body += chunk.toString() })
    req.on('end', () => {
      try {
        const { data, mime } = JSON.parse(body)
        if (!data || !mime) throw new Error('missing data or mime')
        const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'jpg'
        const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
        const buffer = Buffer.from(data, 'base64')
        if (buffer.length > 10 * 1024 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'File too large (max 10MB)' }))
          return
        }
        writeFileSync(join(SCRIPT_DIR, 'uploads', filename), buffer)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ url: '/uploads/' + filename }))
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Upload failed' }))
      }
    })
    return
  }

  // Static uploads
  if (path.startsWith('/uploads/')) {
    const filename = path.slice('/uploads/'.length).replace(/[^a-zA-Z0-9._-]/g, '')
    const filepath = join(SCRIPT_DIR, 'uploads', filename)
    try {
      const data = readFileSync(filepath)
      const ext = filename.split('.').pop()?.toLowerCase() ?? ''
      const mimeMap: Record<string, string> = {
        'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
        'gif': 'image/gif', 'webp': 'image/webp',
      }
      res.writeHead(200, { 'Content-Type': mimeMap[ext] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000' })
      res.end(data)
    } catch { res.writeHead(404); res.end('Not found') }
    return
  }

  // Health check
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', clients: clients.size, cc_alive: ccAlive, history_count: history.length }))
    return
  }

  // Nudge trigger (for external cron/scripts)
  if (path === '/api/nudge' && req.method === 'POST') {
    if (!ccAlive) {
      res.writeHead(503, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'CC offline' }))
      return
    }
    const idleMin = Math.floor((Date.now() - lastUserMessageTime) / 60000)
    const ts = new Date().toISOString()
    const msgId = `nudge_${++messageCounter}`
    const content = `[nudge] ${USER_NAME} has been silent for ${idleMin} minutes.`
    const sent = forwardToCC(content, {
      chat_id: 'nudge', message_id: msgId,
      user: 'system', user_id: 'nudge', ts
    })
    lastNudgeTime = Date.now()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: sent, idle_minutes: idleMin }))
    return
  }

  res.writeHead(404); res.end('Not found')
})

// --- WebSocket server ---
const wss = new WebSocketServer({ server: httpServer })

wss.on('connection', (ws) => {
  const clientId = `c_${++clientCounter}`
  let authenticated = !PIN

  ws.on('message', (raw) => {
    let msg: any
    try { msg = JSON.parse(raw.toString()) } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }))
      return
    }

    if (msg.type === 'auth') {
      if (!authenticated) {
        if (!PIN || msg.pin === PIN) {
          authenticated = true
        } else {
          ws.send(JSON.stringify({ type: 'auth_fail', message: 'wrong PIN' }))
          return
        }
      }
      clients.set(clientId, ws)
      clientLastPong.set(clientId, Date.now())
      clientLastActive.set(clientId, Date.now())
      ws.send(JSON.stringify({ type: 'auth_ok', client_id: clientId, cc_alive: ccAlive }))
      ws.send(JSON.stringify({ type: 'history', messages: history }))
      return
    }

    if (!authenticated) {
      ws.send(JSON.stringify({ type: 'error', message: 'not authenticated' }))
      return
    }

    if (msg.type === 'message') {
      lastUserMessageTime = Date.now()
      clientLastActive.set(clientId, Date.now())
      nudgeThreshold = NUDGE_FIRST_THRESHOLD
      const inboundId = `u_${++messageCounter}`
      const ts = new Date().toISOString()
      const image = msg.image ?? undefined
      addToHistory({ id: inboundId, role: 'user', content: msg.content ?? '', ts, image })
      broadcast(JSON.stringify({ type: 'message', id: inboundId, role: 'user', content: msg.content ?? '', ts, image }), clientId)
      setBusy(true)
      const imageNote = image ? `\n[image: ${image}]` : ''
      const forwarded = forwardToCC((msg.content ?? '') + imageNote, {
        chat_id: clientId, message_id: inboundId,
        user: USER_NAME, user_id: clientId, ts, image
      })
      if (!forwarded) {
        setBusy(false)
        ws.send(JSON.stringify({ type: 'error', message: 'CC is offline' }))
      }
      ws.send(JSON.stringify({ type: 'ack', id: inboundId }))
      return
    }

    if (msg.type === 'terminal_subscribe') { terminalSubs.add(clientId); sendTerminalCapture(clientId); return }
    if (msg.type === 'terminal_unsubscribe') { terminalSubs.delete(clientId); return }
    if (msg.type === 'terminal_signal') {
      if (msg.signal === 'C-c') {
        try {
          execSync(`tmux send-keys -t ${TMUX_SESSION}:0 C-c`, { timeout: 3000 })
          setTimeout(() => sendTerminalCapture(), 300)
        } catch (err) { log(`terminal_signal failed: ${err}`) }
      }
      return
    }
    if (msg.type === 'terminal_input') {
      const text = (msg.text ?? '').toString()
      if (!text) return
      try {
        execSync(`tmux send-keys -t ${TMUX_SESSION}:0 -l ${JSON.stringify(text)}`, { timeout: 3000 })
        if (msg.enter !== false) execSync(`tmux send-keys -t ${TMUX_SESSION}:0 Enter`, { timeout: 3000 })
        setTimeout(() => sendTerminalCapture(), 300)
      } catch (err) { log(`terminal_input failed: ${err}`) }
      return
    }
    if (msg.type === 'visibility') {
      if (msg.visible) clientLastActive.set(clientId, Date.now())
      return
    }
    if (msg.type === 'mark_read') {
      const m = history.find(h => h.id === msg.id)
      if (m?.unread) {
        m.unread = undefined
        try { writeFileSync(HISTORY_FILE, history.map(h => JSON.stringify(h)).join('\n') + '\n') } catch {}
        broadcast(JSON.stringify({ type: 'mark_read', id: msg.id }))
      }
      return
    }
  })

  ws.on('pong', () => { clientLastPong.set(clientId, Date.now()) })
  ws.on('close', () => { clients.delete(clientId); clientLastPong.delete(clientId); clientLastActive.delete(clientId); terminalSubs.delete(clientId) })
  ws.on('error', () => { clients.delete(clientId); clientLastPong.delete(clientId); clientLastActive.delete(clientId) })

  if (authenticated) {
    clients.set(clientId, ws)
    clientLastPong.set(clientId, Date.now())
    clientLastActive.set(clientId, Date.now())
    ws.send(JSON.stringify({ type: 'auth_ok', client_id: clientId, cc_alive: ccAlive }))
    ws.send(JSON.stringify({ type: 'history', messages: history }))
  } else {
    ws.send(JSON.stringify({ type: 'auth_required' }))
  }
})

// Ping/pong heartbeat
setInterval(() => {
  for (const [id, ws] of clients) {
    const lastPong = clientLastPong.get(id) ?? 0
    if (lastPong > 0 && Date.now() - lastPong > 40000) {
      log(`client ${id} stale (no pong), terminating`)
      ws.terminate()
      clients.delete(id); clientLastPong.delete(id); clientLastActive.delete(id); terminalSubs.delete(id)
      continue
    }
    if (ws.readyState === WebSocket.OPEN) ws.ping()
  }
}, 30000)

httpServer.listen(PORT, '0.0.0.0', () => log(`client port ${PORT}`))

let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  for (const [, ws] of clients) ws.close(1001, 'server shutting down')
  bridge?.close(1001, 'server shutting down')
  httpServer.close()
  bridgeHttpServer.close()
  setTimeout(() => process.exit(0), 2000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
