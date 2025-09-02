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

config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Logging to console and file
const LOG_PATH = process.env.BOT_LOG_FILE || '/tmp/bot-debug.log'
const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' })
function safeWriteLog(prefix, args) {
  try {
    const msg = Array.from(args).map(a => {
      if (typeof a === 'string') return a
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(' ')
    const line = `${new Date().toISOString()} ${prefix} ${msg}\n`
    process.stdout.write(line)
    logStream.write(line)
  } catch (e) {
    // no-op
  }
}
console.log = (...args) => safeWriteLog('[INFO]', args)
console.warn = (...args) => safeWriteLog('[WARN]', args)
console.error = (...args) => safeWriteLog('[ERROR]', args)

// Express app
const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)

let bot = null

app.get('/', (req, res) => {
  res.json({
    status: bot ? 'online' : 'not initialized',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    bot: bot ? {
      username: bot.username,
      connected: !!bot.entity,
      health: bot.health || 0,
      food: bot.food || 0,
      position: bot.entity ? bot.entity.position : null
    } : null
  })
})

app.get('/health', (req, res) => {
  res.json({
    status: bot ? 'healthy' : 'not initialized',
    timestamp: new Date().toISOString(),
    botConnected: !!(bot && bot.entity)
  })
})

// Settings and storage
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']
let trustedPlayers = [ownerName]
let ignoredPlayers = []
const memoryFile = process.env.MEMORY_FILE || '/tmp/memory.json'
const trustedFile = process.env.TRUSTED_FILE || '/tmp/trusted.json'
const ignoredFile = process.env.IGNORED_FILE || '/tmp/ignored.json'

// Load memory and lists
let memory = []
try {
  memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : []
  console.log('[MEMORY] Loaded entries count ' + memory.length)
} catch (e) {
  console.error('[MEMORY] Load failed', e.message)
  memory = []
}
try {
  trustedPlayers = fs.existsSync(trustedFile) ? JSON.parse(fs.readFileSync(trustedFile, 'utf8')) : trustedPlayers
  console.log('[TRUST] Loaded trusted players ' + JSON.stringify(trustedPlayers))
} catch (e) {
  console.warn('[TRUST] Load failed', e.message)
}
try {
  ignoredPlayers = fs.existsSync(ignoredFile) ? JSON.parse(fs.readFileSync(ignoredFile, 'utf8')) : []
  console.log('[IGNORE] Loaded ignored players ' + JSON.stringify(ignoredPlayers))
} catch (e) {
  console.warn('[IGNORE] Load failed', e.message)
}
function saveMemory() {
  try {
    fs.writeFileSync(memoryFile, JSON.stringify(memory.slice(-50), null, 2))
    console.log('[MEMORY] Saved ' + Math.min(memory.length, 50) + ' entries')
  } catch (e) {
    console.error('[MEMORY] Save failed', e.message)
  }
}
function saveTrusted() {
  try {
    fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2))
    console.log('[TRUST] Saved trusted players')
  } catch (e) { console.error('[TRUST] Save failed', e.message) }
}
function saveIgnored() {
  try {
    fs.writeFileSync(ignoredFile, JSON.stringify(ignoredPlayers, null, 2))
    console.log('[IGNORE] Saved ignored players')
  } catch (e) { console.error('[IGNORE] Save failed', e.message) }
}

// NLP loader
let nlp = null
try {
  const compromiseImport = await import('compromise')
  nlp = compromiseImport.default
  console.log('[NLP] Compromise loaded')
} catch (e) {
  console.warn('[NLP] Compromise load failed, fallback active', e.message)
  nlp = (text) => ({
    has: (word) => ('' + text).toLowerCase().includes(('' + word).toLowerCase())
  })
}

// Graceful shutdown
function shutdown(signal) {
  console.log('[SYSTEM] ' + signal + ' received, saving and exiting')
  saveMemory()
  saveTrusted()
  saveIgnored()
  if (bot) bot.quit('Server shutting down')
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Pathfinder variables
let pathfinderLoaded = false
let Movements = null
let goals = null
let GoalBlock = null
let GoalFollow = null

async function ensurePathfinderLoaded() {
  if (!pathfinderLoaded && bot) {
    console.log('[PATH] Loading pathfinder')
    const pathfinderPkg = await import('mineflayer-pathfinder')
    bot.loadPlugin(pathfinderPkg.pathfinder)
    Movements = pathfinderPkg.Movements
    goals = pathfinderPkg.goals
    GoalBlock = goals.GoalBlock
    GoalFollow = goals.GoalFollow
    const mcData = minecraftData(bot.version)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
    pathfinderLoaded = true
    console.log('[PATH] Pathfinder ready for version ' + bot.version)
  }
}

// Utility whisper
function whisper(player, message) {
  if (!bot) return
  console.log('[WHISPER] ->' + player + ' ' + message)
  try {
    if (bot.players[player]) bot.chat('/msg ' + player + ' ' + message)
    else bot.chat(message)
  } catch (e) {
    console.error('[WHISPER] Send failed', e.message)
  }
}

// Parse plugin and vanilla message lines
function tryExtractUserFromRaw(raw) {
  if (!raw) return null
  const r = String(raw)
  // Format: <user> message
  let m = r.match(/^<(\w+)>[ ](.+)/)
  if (m) return { username: m[1], message: m[2] }
  // Format: [Discord] user: message
  m = r.match(/^\[Discord\][ ](.+?):[ ](.+)/i)
  if (m) return { username: m[1], message: m[2] }
  // Format: user: message
  m = r.match(/^(\w+):[ ](.+)/)
  if (m) return { username: m[1], message: m[2] }
  return null
}

// NLP parsing for commands
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
  if (coordMatch) {
    steps.push({ action: 'goto', x: parseInt(coordMatch[1], 10), y: parseInt(coordMatch[2], 10), z: parseInt(coordMatch[3], 10) })
  }
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

// Validate coords
function validCoords(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000) return false
  if (y < -64 || y > 320) return false
  return true
}

// Execute steps
async function executeSteps(username, steps) {
  if (!bot) return
  console.log('[EXEC] Executing ' + steps.length + ' steps for ' + username)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    console.log('[EXEC] step ' + (i + 1) + '/' + steps.length + ': ' + JSON.stringify(step))
    try {
      switch (step.action) {
        case 'follow': {
          await ensurePathfinderLoaded()
          const target = bot.players[step.player]?.entity
          if (!target) {
            whisper(username, "I can't see " + step.player + " right now.")
            break
          }
          bot.pathfinder.setGoal(null)
          const goal = new GoalFollow(target, 1)
          bot.pathfinder.setGoal(goal, true)
          whisper(username, 'Following ' + step.player)
          setTimeout(() => {
            try {
              if (bot && bot.pathfinder && bot.pathfinder.goal instanceof GoalFollow) {
                bot.pathfinder.setGoal(null)
                whisper(username, 'Stopped following ' + step.player)
              }
            } catch (e) { console.error('[EXEC] follow timeout error', e.message) }
          }, 60000)
          break
        }
        case 'goto': {
          await ensurePathfinderLoaded()
          if (!validCoords(step.x, step.y, step.z)) {
            whisper(username, 'Those coordinates are invalid or too far.')
            break
          }
          bot.pathfinder.setGoal(null)
          const goal = new GoalBlock(step.x, step.y, step.z)
          bot.pathfinder.setGoal(goal)
          whisper(username, 'Going to ' + step.x + ', ' + step.y + ', ' + step.z)
          break
        }
        case 'tpa': {
          if (!step.player) { whisper(username, 'I need to know who to teleport to.'); break }
          console.log('[TPA] sending /tpa ' + step.player)
          bot.chat('/tpa ' + step.player)
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

// Main chat handler via message event only
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
    if (addMatch) {
      const target = addMatch[1]
      if (!trustedPlayers.includes(target)) { trustedPlayers.push(target); saveTrusted(); whisper(username, target + ' is now trusted') } else whisper(username, target + ' is already trusted')
      return
    }
    if (delMatch) {
      const target = delMatch[2]
      const was = trustedPlayers.includes(target)
      trustedPlayers = trustedPlayers.filter(p => p !== target)
      saveTrusted()
      whisper(username, was ? target + ' is no longer trusted' : target + ' was not trusted')
      return
    }
    if (ignoreAdd) {
      const target = ignoreAdd[1]
      if (!ignoredPlayers.includes(target)) { ignoredPlayers.push(target); saveIgnored(); whisper(username, target + ' is now ignored') } else whisper(username, target + ' is already ignored')
      return
    }
    if (ignoreDel) {
      const target = ignoreDel[1]
      const was = ignoredPlayers.includes(target)
      ignoredPlayers = ignoredPlayers.filter(p => p !== target)
      saveIgnored()
      whisper(username, was ? target + ' is no longer ignored' : target + ' was not ignored')
      return
    }
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

// Setup event handlers for a created bot instance
function setupBotEventHandlers() {
  bot.on('error', (err) => {
    console.error('[BOT] Error', err && err.message)
    setTimeout(() => { console.log('[BOT] reconnecting after error'); initializeBot().catch(e => console.error('[BOT] reconnect failed', e.message)) }, 10000)
  })

  bot.on('kicked', (reason) => {
    console.log('[BOT] Kicked reason ' + reason)
    setTimeout(() => { console.log('[BOT] reconnecting after kick'); initializeBot().catch(e => console.error('[BOT] reconnect failed', e.message)) }, 15000)
  })

  bot.on('end', () => {
    console.log('[BOT] Disconnected')
    setTimeout(() => { console.log('[BOT] reconnecting after end'); initializeBot().catch(e => console.error('[BOT] reconnect failed', e.message)) }, 10000)
  })

  bot.once('spawn', async () => {
    console.log('[SPAWN] Bot spawned as ' + bot.username + ' at ' + JSON.stringify(bot.entity ? bot.entity.position : null))
    try { bot.loadPlugin(autoEat); console.log('[SPAWN] AutoEat loaded') } catch (e) { console.error('[SPAWN] AutoEat failed', e.message) }
    try { bot.loadPlugin(AutoAuth); console.log('[SPAWN] AutoAuth loaded') } catch (e) { console.error('[SPAWN] AutoAuth failed', e.message) }

    // Start prismarine viewer on internal port and proxy via Express
    const viewerPort = parseInt(process.env.VIEWER_PORT || '3001', 10)
    const viewerHost = process.env.VIEWER_HOST || '127.0.0.1'
    try {
      const { mineflayer: startViewer } = await import('prismarine-viewer')
      startViewer(bot, { port: viewerPort, firstPerson: (process.env.VIEWER_FIRST_PERSON === 'true') })
      console.log('[VIEWER] Prismarine viewer started on ' + viewerHost + ':' + viewerPort + ' proxy path /viewer')
    } catch (e) {
      console.error('[VIEWER] start failed', e.message)
    }
  })

  // Use message event as primary chat input because many plugins and bridges deliver there
  bot.on('message', (jsonMsg) => {
    const raw = jsonMsg.toString()
    console.log('[MESSAGE-RAW] ' + raw)

    // Auto accept typical Essentials style tpa prompts
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
      // Fallback attempt: some servers put username in json structure, attempt to inspect
      try {
        const obj = JSON.parse(raw)
        if (obj && obj.extra && Array.isArray(obj.extra) && obj.extra.length > 0) {
          const text = obj.extra.map(x => x.text || '').join(' ')
          const alt = tryExtractUserFromRaw(text)
          if (alt) { handleChat(alt.username, alt.message); return }
        }
      } catch (e) {
        // Not JSON, ignore
      }
      console.log('[MESSAGE-RAW] Could not extract username from raw line. Please paste this line to help adjust regex: ' + raw)
    }
  })
}

// Proxy viewer through Express so only PORT needs to be open
const VIEWER_PORT_INTERNAL = parseInt(process.env.VIEWER_PORT || '3001', 10)
const VIEWER_HOST_INTERNAL = process.env.VIEWER_HOST || '127.0.0.1'
app.use('/viewer', (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/viewer/, '') || '/'
  const options = {
    hostname: VIEWER_HOST_INTERNAL,
    port: VIEWER_PORT_INTERNAL,
    path: targetPath,
    method: req.method,
    headers: req.headers
  }
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers)
    proxyRes.pipe(res, { end: true })
  })
  proxyReq.on('error', (err) => {
    console.error('[PROXY] viewer proxy error', err.message)
    res.statusCode = 502
    res.end('viewer proxy error')
  })
  req.pipe(proxyReq, { end: true })
})

// Initialize bot with retries
async function initializeBot() {
  const maxRetries = 5
  let attempt = 0
  while (attempt < maxRetries) {
    attempt++
    try {
      console.log('[INIT] Creating bot attempt ' + attempt)
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
        version: process.env.MC_VERSION || false
      })
      setupBotEventHandlers()
      break
    } catch (e) {
      console.error('[INIT] createBot failed', e.message)
      if (attempt < maxRetries) {
        const delay = 5000 * attempt
        console.log('[INIT] retrying in ' + Math.floor(delay / 1000) + 's')
        await new Promise(r => setTimeout(r, delay))
      } else {
        console.error('[INIT] max retries reached')
      }
    }
  }
}

// Periodic saves and heartbeat
setInterval(() => { saveMemory(); saveTrusted(); saveIgnored() }, 10 * 60 * 1000)
setInterval(() => console.log('[HEARTBEAT] status ' + (bot ? (bot.entity ? 'connected' : 'disconnected') : 'not initialized')), 5 * 60 * 1000)

// Start express and bot
app.listen(PORT, '0.0.0.0', () => {
  console.log('[WEB] Express listening on 0.0.0.0:' + PORT + ' proxy viewer at /viewer')
  initializeBot().catch(e => console.error('[START] initializeBot threw', e.message))
})
