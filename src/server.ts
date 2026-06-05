#!/usr/bin/env bun
/**
 * Channel Bridge — MCP server that connects CC to the hub.
 *
 * This runs as a CC MCP server (stdio transport). It forwards messages
 * between CC and the hub via WebSocket.
 *
 * Env:
 *   CHANNEL_BRIDGE_PORT — hub's bridge port (default 3457)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { WebSocket } from 'ws'

const BRIDGE_PORT = parseInt(process.env.CHANNEL_BRIDGE_PORT ?? '3457', 10)
const HUB_URL = `ws://127.0.0.1:${BRIDGE_PORT}`

let hub: WebSocket | null = null
let hubReady = false
let reqCounter = 0
const pending = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>()

function connectHub() {
  hub = new WebSocket(HUB_URL)

  hub.on('open', () => {
    hubReady = true
    process.stderr.write('bridge: connected to hub\n')
  })

  hub.on('message', (raw) => {
    let msg: any
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg._req_id && pending.has(msg._req_id)) {
      const p = pending.get(msg._req_id)!
      pending.delete(msg._req_id)
      clearTimeout(p.timer)
      p.resolve(msg)
      return
    }

    if (msg.type === 'channel_message') {
      mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: msg.content, meta: msg.meta },
      }).catch(err => {
        process.stderr.write(`bridge: channel notify failed: ${err}\n`)
      })
    }
  })

  hub.on('close', () => {
    hubReady = false
    process.stderr.write('bridge: hub disconnected, reconnecting...\n')
    setTimeout(connectHub, 2000)
  })

  hub.on('error', () => {})
}

function hubRequest(msg: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!hub || !hubReady) return reject(new Error('hub not connected'))
    const id = `req_${++reqCounter}`
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, 10000)
    pending.set(id, { resolve, timer })
    hub.send(JSON.stringify({ ...msg, _req_id: id }))
  })
}

const mcp = new Server(
  { name: 'channel', version: '0.1.0' },
  {
    capabilities: {
      tools: {},
      experimental: { 'claude/channel': {} },
    },
    instructions: [
      'Messages from the web chat arrive as <channel source="web" chat_id="..." message_id="..." user="..." ts="...">.',
      'Reply with the reply tool — pass chat_id back.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to a web chat client. Pass chat_id from the inbound message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'client_id from the inbound channel tag' },
          text: { type: 'string' },
          reply_to: { type: 'string', description: 'Message ID to quote-reply' },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string' },
          message_id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['chat_id', 'message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const result = await hubRequest({
          type: 'reply',
          chat_id: args.chat_id,
          text: args.text,
          reply_to: args.reply_to,
        })
        if (!result.ok) return { content: [{ type: 'text', text: result.error ?? 'failed' }], isError: true }
        return { content: [{ type: 'text', text: `sent (id: ${result.id})` }] }
      }
      case 'edit_message': {
        const result = await hubRequest({
          type: 'edit',
          chat_id: args.chat_id,
          message_id: args.message_id,
          text: args.text,
        })
        if (!result.ok) return { content: [{ type: 'text', text: result.error ?? 'failed' }], isError: true }
        return { content: [{ type: 'text', text: `edited (id: ${result.id})` }] }
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `${req.params.name} failed: ${msg}` }], isError: true }
  }
})

connectHub()

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('bridge: MCP connected to CC\n')
