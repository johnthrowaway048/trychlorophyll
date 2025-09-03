// /mnt/data/bot.js
import { createBot } from 'mineflayer'
import { loader as autoEat } from 'mineflayer-auto-eat'
import minecraftData from 'minecraft-data'
import AutoAuth from 'mineflayer-auto-auth'
import fs from 'fs'
import { config } from 'dotenv'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import { createProxyMiddleware } from 'http-proxy-middleware'
import net from 'net'

config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---------- Logging (ASCII-only sanitized) ----------
const LOG_PATH = process.env.BOT_LOG_FILE || '/tmp/bot-debug.log'
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' })

function sanitizeAscii(s) {
  try {
    return String(s).replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?')
  } catch (e) {
    return String(s)
  }
}

function safeWriteLog(prefix, args) {
  try {
    const msg = Array.from(args).map(a => {
      if (typeof a === 'string') return a
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
    const line = `${new Date().toISOString()} ${prefix} ${sanitizeAscii(msg)}\n`
    process.stdout.write(line)
    logStream.write(line)
  } catch (e) {
    // ignore logging errors
  }
}
console.log = (...args) => safeWriteLog('[INFO]', args)
console.warn = (...args) => safeWriteLog('[WARN]', args)
console.error = (...args) => safeWriteLog('[ERROR]', args)

// ---------- Express app and viewer proxy config ----------
const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)

const VIEWER_PORT_INTERNAL = parseInt(process.env.VIEWER_PORT || '3001', 10)
const VIEWER_HOST_INTERNAL = process.env.VIEWER_HOST || '127.0.0.1'
const VIEWER_TARGET = `http://${VIEWER_HOST_INTERNAL}:${VIEWER_PORT_INTERNAL}`

// ---------- Persistent state and files ----------
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']
let trustedPlayers = [ownerName]
let ignoredPlayers = []
const memoryFile = process.env.MEMORY_FILE || '/tmp/memory.json'
const trustedFile = process.env.TRUSTED_FILE || '/tmp/trusted.json'
const ignoredFile = process.env.IGNORED_FILE || '/tmp/ignored.json'

let memory = []
try {
  memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : []
  console.log('[MEMORY] Loaded entries count ' + memory.length)
} catch (e) { console.error('[MEMORY] Load failed', e.message); memory = [] }

try {
  trustedPlayers = fs.existsSync(trustedFile) ? JSON.parse(fs.readFileSync(trustedFile, 'utf8')) : trustedPlayers
  console.log('[TRUST] Loaded trusted players ' + JSON.stringify(trustedPlayers))
} catch (e) { console.warn('[TRUST] Load failed', e.message) }

try {
  ignoredPlayers = fs.existsSync(ignoredFile) ? JSON.parse(fs.readFileSync(ignoredFile, 'utf8')) : []
  console.log('[IGNORE] Loaded ignored players ' + JSON.stringify(ignoredPlayers))
} catch (e) { console.warn('[IGNORE] Load failed', e.message) }

function saveMemory() {
  try {
    fs.writeFileSync(memoryFile, JSON.stringify(memory.slice(-50), null, 2))
    console.log('[MEMORY] Saved ' + Math.min(memory.length, 50) + ' entries')
  } catch (e) { console.error('[MEMORY] Save failed', e.message) }
}
function saveTrusted() {
  try { fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2)); console.log('[TRUST] Saved trusted players') } catch (e) { console.error('[TRUST] Save failed', e.message) }
}
function saveIgnored() {
  try { fs.writeFileSync(ignoredFile, JSON.stringify(ignoredPlayers, null, 2)); console.log('[IGNORE] Saved ignored players') } catch (e) { console.error('[IGNORE] Save failed', e.message) }
}

// ---------- NLP loader ----------
let nlp = null
try {
  const compromiseImport = await import('compromise')
  nlp = compromiseImport.default || compromiseImport
  console.log('[NLP] Compromise loaded')
} catch (e) {
  console.warn('[NLP] Compromise load failed, fallback active', e.message)
  nlp = (text) => ({ has: (word) => ('' + text).toLowerCase().includes(('' + word).toLowerCase()) })
}

// ---------- Graceful shutdown ----------
function shutdown(signal) {
  console.log('[SYSTEM] ' + signal + ' received, saving and exiting')
  saveMemory(); saveTrusted(); saveIgnored()
  try { if (bot) bot.quit('Server shutting down') } catch (e) { console.warn('[SYSTEM] quit failed', e.message) }
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ---------- Pathfinder and movement exports (safe resolution) ----------
let pathfinderLoaded = false
let Movements = null
let goals = null
let GoalBlock = null
let GoalFollow = null

async function ensurePathfinderLoaded() {
  if (pathfinderLoaded) return
  if (!bot) throw new Error('Bot not initialized when loading pathfinder')
  console.log('[PATH] Loading pathfinder package')
  try {
    const pathfinderPkgRaw = await import('mineflayer-pathfinder')
    const pf = pathfinderPkgRaw.default || pathfinderPkgRaw

    // resolve plugin and exports resiliently
    const pathfinderPlugin = pf.pathfinder || pf.default?.pathfinder || pf.pathfinder?.default || (pf)
    Movements = pf.Movements || pf.Movements || pf.default?.Movements
    goals = pf.goals || pf.goals || pf.default?.goals

    // Debug dump for troubleshooting if exports not found
    if (!goals || !Movements || !pathfinderPlugin) {
      console.error('[PATH] Could not resolve pathfinder exports. pf keys: ' + Object.keys(pf).join(', '))
      throw new Error('pathfinder exports missing')
    }

    // load plugin into bot
    bot.loadPlugin(pathfinderPlugin)
    GoalBlock = goals.GoalBlock || goals.GoalBlockGoal || goals.Goal || null
    GoalFollow = goals.GoalFollow || goals.GoalFollowGoal || null

    const mcData = minecraftData(bot.version)
    bot.pathfinder.setMovements(new Movements(bot, mcData))

    pathfinderLoaded = true
    console.log('[PATH] Pathfinder ready; GoalBlock present=' + !!GoalBlock + ' GoalFollow present=' + !!GoalFollow)
  } catch (e) {
    console.error('[PATH] ensurePathfinderLoaded failed', e && e.message)
    throw e
  }
}

// ---------- Utilities ----------
let bot = null

function whisper(player, message) {
  if (!bot) return
  console.log('[WHISPER] ->' + player + ' ' + message)
  try {
    if (bot.players && bot.players[player]) bot.chat('/msg ' + player + ' ' + message)
    else bot.chat(message)
  } catch (e) { console.error('[WHISPER] Send failed', e.message) }
}

// ---------- Raw message extraction ----------
function tryExtractUserFromRaw(raw) {
  if (!raw) return null
  const r = String(raw).trim()

  // vanilla <user> message
  let m = r.match(/^<(\w+)>[ ](.+)$/)
  if (m) return { username: m[1], message: m[2] }

  // Discord style from your logs
  m = r.match(/^\[Discord\][ ]*\|[ ]*([^»\s]+)\s*»\s*(.+)$/i)
  if (m) return { username: m[1], message: m[2] }

  // "[Discord] user: message"
  m = r.match(/^\[Discord\][ ]*(.+?):[ ](.+)$/i)
  if (m) return { username: m[1], message: m[2] }

  // "user: message"
  m = r.match(/^(\w+):[ ](.+)$/)
  if (m) return { username: m[1], message: m[2] }

  // join/leave lines
  m = r.match(/^(.+?) has joined the server!?$/i)
  if (m) return { username: m[1], message: `${m[1]} has joined` }
  m = r.match(/^(.+?) has left the server!?$/i)
  if (m) return { username: m[1], message: `${m[1]} left` }

  // try JSON text object
  try {
    const obj = JSON.parse(r)
    if (obj && typeof obj === 'object') {
      const textParts = []
      if (Array.isArray(obj.extra)) {
        for (const e of obj.extra) {
          if (typeof e === 'string') textParts.push(e)
          else if (e && typeof e.text === 'string') textParts.push(e.text)
        }
      }
      if (obj.with && Array.isArray(obj.with)) {
        for (const w of obj.with) {
          if (typeof w === 'string') textParts.push(w)
          else if (w && typeof w.text === 'string') textParts.push(w.text)
        }
      }
      const joined = textParts.join(' ').trim()
      if (joined) {
        let mm = joined.match(/^<(\w+)>[ ](.+)$/)
        if (mm) return { username: mm[1], message: mm[2] }
        mm = joined.match(/^(\w+):[ ](.+)$/)
        if (mm) return { username: mm[1], message: mm[2] }
        mm = joined.match(/^\[Discord\][ ]*\|[ ]*([^»\s]+)\s*»\s*(.+)$/i)
        if (mm) return { username: mm[1], message: mm[2] }
      }
    }
  } catch (e) { /* not JSON */ }

  // heuristic using online player list: if line starts with known player name
  try {
    if (bot && bot.players) {
      const players = Object.keys(bot.players)
      if (players && players.length > 0) {
        for (const p of players) {
          if (!p) continue
          const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const re = new RegExp('^' + esc + '[\\s:»,>\\-]+(.+)$', 'i')
          const hits = r.match(re)
          if (hits) return { username: p, message: hits[1].trim() }
        }
      }
    }
  } catch (e) { /* ignore */ }

  return null
}

// ---------- NLP instruction parsing (kept behavior) ----------
function extractPlayerName(message, defaultName, commandWords = []) {
  const words = message.toLowerCase().split(/\s+/)
  for (const cmdWord of commandWords) {
    const cmdIndex = words.findIndex(word => word.includes(cmdWord.toLowerCase()))
    if (cmdIndex !== -1 && cmdIndex + 1 < words.length) {
      const nextWord = words[cmdIndex + 1].replace(/[^a-zA-Z0-9_]/g, '')
      if (nextWord && nextWord.length > 0 && !['me', 'to', 'at', 'the'].includes(nextWord)) return nextWord
    }
  }
  if (message.toLowerCase().includes('follow me') || message.toLowerCase().includes('come to me')) return defaultName
  return defaultName
}

function parseInstructionsNLP(username, message) {
  const doc = nlp(message.toLowerCase())
  const steps = []
  if (doc.has('follow') || doc.has('come') || (doc.has('come') && doc.has('with'))) {
    const target = extractPlayerName(message, username, ['follow', 'come'])
    steps.push({ action: 'follow', player: target })
  }
  const coordMatch = message.match(/(?:go to|goto|move to)\s+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i)
  if (coordMatch) steps.push({ action: 'goto', x: parseInt(coordMatch[1], 10), y: parseInt(coordMatch[2], 10), z: parseInt(coordMatch[3], 10) })
  if ((doc.has('teleport') || message.toLowerCase().includes('/tpa') || message.toLowerCase().includes('tp to')) && !doc.has('request')) {
    const target = extractPlayerName(message, username, ['teleport', 'tp', 'tpa'])
    if (target !== username) steps.push({ action: 'tpa', player: target })
  }
  const waitMatch = message.match(/(?:wait|pause|stop)[ ]+(?:\w+[ ]+)?(\d+)[ ]+(?:seconds|secs|sec)/i)
  if (waitMatch) steps.push({ action: 'wait', seconds: parseInt(waitMatch[1], 10) })
  console.log('[NLP] parsed steps for ' + username + ': ' + JSON.stringify(steps))
  return steps
}

function generateResponse(message, username, isTrusted) {
  if (!nlp) return "I'm having trouble with language processing right now."
  const doc = nlp(message.toLowerCase())
  if (doc.has('hello') || doc.has('hi') || doc.has('hey')) return 'Hello ' + username + '! How can I help you?'
  if (doc.has('thank') || doc.has('thanks')) return "You're welcome!"
  if (doc.has('how are you') || doc.has('how do you feel')) return "I'm functioning properly and ready to help!"
  if (doc.has('where are you')) {
    if (!bot || !bot.entity) return "I'm not sure where I am right now."
    const pos = bot.entity.position
    return 'I am at ' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ', ' + Math.floor(pos.z)
  }
  if (doc.has('trust') && isTrusted) return 'I have updated the trusted players list.'
  if (isTrusted) return "I heard you, but I'm not sure what you want me to do. Try 'follow me', 'goto x y z', or 'tpa player'."
  return "I'm here! Let me know if you need anything."
}

function validCoords(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000) return false
  if (y < -64 || y > 320) return false
  return true
}

// ---------- Execution of parsed steps with defensive checks ----------
async function executeSteps(username, steps) {
  if (!bot) return
  console.log('[EXEC] Executing ' + steps.length + ' steps for ' + username)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    console.log('[EXEC] step ' + (i + 1) + '/' + steps.length + ': ' + JSON.stringify(step))
    try {
      switch (step.action) {
        case 'follow': {
          try {
            await ensurePathfinderLoaded()
          } catch (e) {
            console.error('[EXEC] cannot load pathfinder for follow', e && e.message)
            whisper(username, 'Pathfinder could not be loaded; follow not possible.')
            break
          }
          if (!GoalFollow) {
            console.error('[EXEC] GoalFollow is undefined after loading pathfinder.')
            whisper(username, 'Internal error: pathfinding follow goal class missing.')
            break
          }
          const target = bot.players[step.player]?.entity
          if (!target) { whisper(username, "I can't see " + step.player + " right now."); break }
          bot.pathfinder.setGoal(null)
          const goal = new GoalFollow(target, 1)
          bot.pathfinder.setGoal(goal, true)
          whisper(username, 'Following ' + step.player)
          setTimeout(() => {
            try {
              if (bot && bot.pathfinder && bot.pathfinder.goal && bot.pathfinder.goal instanceof GoalFollow) {
                bot.pathfinder.setGoal(null)
                whisper(username, 'Stopped following ' + step.player)
              }
            } catch (e) { console.error('[EXEC] follow timeout error', e.message) }
          }, 60000)
          break
        }
        case 'goto': {
          try {
            await ensurePathfinderLoaded()
          } catch (e) {
            console.error('[EXEC] cannot load pathfinder for goto', e && e.message)
            whisper(username, 'Pathfinder could not be loaded; goto not possible.')
            break
          }
          if (!GoalBlock) {
            console.error('[EXEC] GoalBlock is undefined after loading pathfinder.')
            whisper(username, 'Internal error: pathfinding goto goal class missing.')
            break
          }
          if (!validCoords(step.x, step.y, step.z)) { whisper(username, 'Those coordinates are invalid or too far.'); break }
          bot.pathfinder.setGoal(null)
          const g = new GoalBlock(step.x, step.y, step.z)
          bot.pathfinder.setGoal(g)
          whisper(username, 'Going to ' + step.x + ', ' + step.y + ', ' + step.z)
          break
        }
        case 'tpa': {
          if (!step.player) { whisper(username, 'I need to know who to teleport to.'); break }
          console.log('[TPA] sending /tpa ' + step.player)
          try { bot.chat('/tpa ' + step.player) } catch (e) { console.error('[TPA] send failed', e.message) }
          whisper(username, 'Sent teleport request to ' + step.player)
          break
        }
        case 'wait': {
          const seconds = Math.max(1, Math.min(30, parseInt(step.seconds, 10) || 1))
          whisper(username, 'Waiting ' + seconds + ' seconds...')
          await new Promise(r => setTimeout(r, seconds * 1000))
          whisper(username, 'Done waiting')
          break
        }
        default:
          console.warn('[EXEC] Unknown action ' + step.action)
          whisper(username, "I don't know how to do: " + step.action)
      }
      if (i < steps.length - 1) await new Promise(r => setTimeout(r, 500))
    } catch (err) {
      console.error('[EXEC] Error executing step ' + JSON.stringify(step) + ' ' + (err && err.message))
      whisper(username, 'Something went wrong with: ' + step.action)
    }
  }
}

// ---------- Chat handling routed from message extraction ----------
async function handleChat(username, message) {
  if (!bot) return
  if (!username || username === bot.username) return
  if (ignoredPlayers.includes(username)) { console.log('[CHAT] Ignoring ' + username); return }
  console.log('[CHAT] <' + username + '> ' + message)
  const msgLower = message.toLowerCase()
  const mentioned = botNames.some(n => msgLower.includes(n.toLowerCase()))
  if (!mentioned) return
  const isTrusted = trustedPlayers.includes(username)
  console.log('[AUTH] mentioned by ' + username + ' trusted=' + isTrusted)
  if (username === ownerName) {
    const addMatch = message.match(/\btrust\s+(\w+)\b/i)
    const delMatch = message.match(/\b(forget|untrust|revoke)\s+(\w+)\b/i)
    const ignoreAdd = message.match(/\bignore\s+(\w+)\b/i)
    const ignoreDel = message.match(/\b(unignore|forgive)\s+(\w+)\b/i)
    if (addMatch) { const target = addMatch[1]; if (!trustedPlayers.includes(target)) { trustedPlayers.push(target); saveTrusted(); whisper(username, target + ' is now trusted') } else whisper(username, target + ' is already trusted'); return }
    if (delMatch) { const target = delMatch[2]; const was = trustedPlayers.includes(target); trustedPlayers = trustedPlayers.filter(p => p !== target); saveTrusted(); whisper(username, was ? target + ' is no longer trusted' : target + ' was not trusted'); return }
    if (ignoreAdd) { const target = ignoreAdd[1]; if (!ignoredPlayers.includes(target)) { ignoredPlayers.push(target); saveIgnored(); whisper(username, target + ' is now ignored') } else whisper(username, target + ' is already ignored'); return }
    if (ignoreDel) { const target = ignoreDel[1]; const was = ignoredPlayers.includes(target); ignoredPlayers = ignoredPlayers.filter(p => p !== target); saveIgnored(); whisper(username, was ? target + ' is no longer ignored' : target + ' was not ignored'); return }
  }

  memory.push({ role: 'user', content: username + ': ' + message })
  while (memory.length > 50) memory.shift()

  if (isTrusted) {
    try {
      const steps = parseInstructionsNLP(username, message)
      if (steps && steps.length > 0) {
        console.log('[CHAT] Executing parsed steps', JSON.stringify(steps))
        await executeSteps(username, steps)
        memory.push({ role: 'assistant', content: '[Executed ' + steps.length + ' instructions for ' + username + ']' })
        saveMemory()
        return
      }
    } catch (e) {
      console.error('[CHAT] instruction execution error', e.message)
      whisper(username, 'Something went wrong executing that command.')
      return
    }
  }

  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait|mine|build|attack)\b/i.test(msgLower)) {
    whisper(username, 'Sorry, only trusted players can give me commands. Ask ' + ownerName + '!')
    return
  }

  try {
    const reply = generateResponse(message, username, isTrusted)
    whisper(username, reply)
    memory.push({ role: 'assistant', content: reply })
    saveMemory()
  } catch (e) {
    console.error('[CHAT] response generation error', e.message)
    whisper(username, "I'm having trouble understanding that.")
  }
}

// ---------- Bot event handlers and message listener ----------
function setupBotEventHandlers() {
  bot.on('error', (err) => {
    console.error('[BOT] Error', err && err.message)
    try {
      const m = err && err.message && err.message.toString()
      if (m && (m.includes('PartialReadError') || m.includes('Unexpected buffer end') || m.includes('Read error'))) {
        console.error('[BOT] Protocol parse error. If you see this, set MC_VERSION to your server version or set FALLBACK_MC_VERSION to let the bot retry with a pinned version.')
      }
    } catch (e) { /* ignore */ }

    setTimeout(() => {
      console.log('[BOT] reconnecting after error')
      initializeBot().catch(e2 => console.error('[BOT] reconnect failed', e2 && e2.message))
    }, 10000)
  })

  bot.on('kicked', (reason) => {
    console.log('[BOT] Kicked reason ' + reason)
    setTimeout(() => { console.log('[BOT] reconnecting after kick'); initializeBot().catch(e => console.error('[BOT] reconnect failed', e && e.message)) }, 15000)
  })

  bot.on('end', () => {
    console.log('[BOT] Disconnected')
    setTimeout(() => { console.log('[BOT] reconnecting after end'); initializeBot().catch(e => console.error('[BOT] reconnect failed', e && e.message)) }, 10000)
  })

  bot.once('spawn', async () => {
    console.log('[SPAWN] Bot spawned as ' + bot.username + ' at ' + JSON.stringify(bot.entity ? bot.entity.position : null))
    try { bot.loadPlugin(autoEat); console.log('[SPAWN] AutoEat loaded') } catch (e) { console.error('[SPAWN] AutoEat failed', e.message) }
    try { bot.loadPlugin(AutoAuth); console.log('[SPAWN] AutoAuth loaded') } catch (e) { console.error('[SPAWN] AutoAuth failed', e.message) }

    // Start prismarine viewer on internal port
    try {
      const { mineflayer: startViewer } = await import('prismarine-viewer')
      startViewer(bot, { port: VIEWER_PORT_INTERNAL, firstPerson: (process.env.VIEWER_FIRST_PERSON === 'true') })
      console.log('[VIEWER] Prismarine viewer started on ' + VIEWER_HOST_INTERNAL + ':' + VIEWER_PORT_INTERNAL)
    } catch (e) {
      console.error('[VIEWER] start failed', e && e.message)
    }
  })

  // Prefer message event (works for plugin forwarded lines) and fallback to chat behavior
  bot.on('message', (jsonMsg) => {
    const raw = jsonMsg.toString()
    console.log('[MESSAGE-RAW] ' + raw)

    const lower = raw.toLowerCase()
    if (lower.includes('has requested to teleport to you') && (lower.includes('tpaccept') || lower.includes('/tpaccept'))) {
      console.log('[TPA] auto-accept detected, sending /tpaccept')
      try { bot.chat('/tpaccept') } catch (e) { console.error('[TPA] tpaccept failed', e.message) }
    }

    const parsed = tryExtractUserFromRaw(raw)
    if (parsed) {
      if (parsed.username === bot.username) return
      handleChat(parsed.username, parsed.message)
    } else {
      // fallback heuristic: first token equals an online player name
      try {
        const players = bot && bot.players ? Object.keys(bot.players) : []
        if (players && players.length > 0) {
          const parts = raw.trim().split(/\s+/)
          const first = parts[0]
          if (first && players.includes(first)) {
            const rest = parts.slice(1).join(' ').trim()
            handleChat(first, rest || '')
            return
          }
        }
      } catch (e) { /* ignore */ }

      console.log('[MESSAGE-RAW] Could not extract username from raw line. Please paste this raw line to help adjust regex: ' + raw)
    }
  })
}

// ---------- Viewer proxy that supports websockets ----------
// Viewer readiness probe
function checkTcp(host, port, timeout = 300) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket()
    let done = false
    socket.setTimeout(timeout)
    socket.once('error', (err) => { if (!done) { done = true; socket.destroy(); reject(err) } })
    socket.once('timeout', () => { if (!done) { done = true; socket.destroy(); reject(new Error('timeout')) } })
    socket.connect(port, host, () => { if (!done) { done = true; socket.end(); resolve() } })
  })
}

// Friendly middleware: only proxy if viewer reachable
app.use('/viewer', async (req, res, next) => {
  try {
    await checkTcp(VIEWER_HOST_INTERNAL, VIEWER_PORT_INTERNAL, 300)
    return next()
  } catch (err) {
    console.log('[PROXY] Viewer not reachable; returning 503 to client. host=' + VIEWER_HOST_INTERNAL + ' port=' + VIEWER_PORT_INTERNAL + ' err=' + (err && err.message))
    res.status(503).send('Viewer not ready. Try again in a few seconds.')
  }
})

// Proxy with websocket support and onError handler
app.use('/viewer', createProxyMiddleware({
  target: VIEWER_TARGET,
  changeOrigin: true,
  ws: true,
  pathRewrite: { '^/viewer': '/' },
  logLevel: 'warn',
  onError: (err, req, res) => {
    try {
      console.error('[PROXY] error while proxying to viewer', err && err.message)
      if (!res.headersSent) {
        res.status(502).send('Viewer proxy error. See server logs for details.')
      } else {
        // if headers already sent, close connection
        res.end()
      }
    } catch (e) {
      console.error('[PROXY] onError handler failed', e && e.message)
    }
  }
}))


// Create http server so upgrade events are handled
const server = http.createServer(app)
server.on('upgrade', (req, socket, head) => { /* middleware handles upgrades */ })
server.listen(PORT, '0.0.0.0', () => {
  console.log('[WEB] Express listening on 0.0.0.0:' + PORT + ' proxy viewer at /viewer')
  initializeBot().catch(e => console.error('[START] initializeBot threw', e && e.message))
})

// ---------- Bot initialization with retry and optional fallback version ----------
async function initializeBot() {
  const maxRetries = 5
  let attempt = 0
  const baseVersion = process.env.MC_VERSION ? process.env.MC_VERSION : false
  const fallbackVersionEnv = process.env.FALLBACK_MC_VERSION || null

  while (attempt < maxRetries) {
    attempt++
    try {
      console.log('[INIT] Creating bot attempt ' + attempt + ' version=' + (baseVersion || 'auto'))
      bot = createBot({
        host: process.env.BOT_HOST || 'localhost',
        port: parseInt(process.env.BOT_PORT || '25565', 10),
        username: process.env.BOT_USERNAME || 'phyll',
        auth: process.env.BOT_AUTH || 'offline',
        plugins: [AutoAuth],
        AutoAuth: {
          password: process.env.BOT_PASSWORD,
          logging: true,
          ignoreRepeat: true
        },
        connectTimeout: 30000,
        checkTimeoutInterval: 10000,
        version: baseVersion
      })
      setupBotEventHandlers()
      break
    } catch (e) {
      console.error('[INIT] createBot failed', e && e.message)
      const msg = e && e.message ? String(e.message) : ''
      if (fallbackVersionEnv && msg && (msg.includes('PartialReadError') || msg.includes('Unexpected buffer end') || msg.includes('Read error'))) {
        try {
          console.log('[INIT] Retrying with FALLBACK_MC_VERSION=' + fallbackVersionEnv)
          bot = createBot({
            host: process.env.BOT_HOST || 'localhost',
            port: parseInt(process.env.BOT_PORT || '25565', 10),
            username: process.env.BOT_USERNAME || 'phyll',
            auth: process.env.BOT_AUTH || 'offline',
            plugins: [AutoAuth],
            AutoAuth: {
              password: process.env.BOT_PASSWORD,
              logging: true,
              ignoreRepeat: true
            },
            connectTimeout: 30000,
            checkTimeoutInterval: 10000,
            version: fallbackVersionEnv
          })
          setupBotEventHandlers()
          break
        } catch (e2) {
          console.error('[INIT] fallback createBot failed', e2 && e2.message)
        }
      }
      if (attempt < maxRetries) {
        const delay = 5000 * attempt
        console.log('[INIT] retrying in ' + Math.floor(delay / 1000) + 's')
        await new Promise(r => setTimeout(r, delay))
      } else {
        console.error('[INIT] max retries reached. If you see PartialReadError set MC_VERSION or FALLBACK_MC_VERSION to your server version.')
      }
    }
  }
}

// periodic tasks
setInterval(() => { saveMemory(); saveTrusted(); saveIgnored() }, 10 * 60 * 1000)
setInterval(() => console.log('[HEARTBEAT] status ' + (bot ? (bot.entity ? 'connected' : 'disconnected') : 'not initialized')), 5 * 60 * 1000)
