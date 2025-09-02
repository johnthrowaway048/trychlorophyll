import { createBot } from 'mineflayer'
import { loader as autoEat } from 'mineflayer-auto-eat'
import minecraftData from 'minecraft-data'
import AutoAuth from 'mineflayer-auto-auth'
import fs from 'fs'
import { config } from 'dotenv'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

// ES module helpers
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

config()

// ----------------- WEB SERVER FOR RENDER -----------------
const app = express()
const PORT = process.env.PORT || 3000

// Global bot so endpoints can read it
let bot = null

// Health root
app.get('/', (req, res) => {
  const status = {
    status: bot ? 'online' : 'not initialized',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    bot: bot ? {
      username: bot.username,
      connected: !!bot.entity,
      health: bot.health || 0,
      food: bot.food || 0,
      position: bot.entity ? {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z
      } : null
    } : { status: 'not initialized' }
  }
  res.json(status)
})

// Additional health
app.get('/health', (req, res) => {
  res.json({
    status: bot ? 'healthy' : 'not initialized',
    timestamp: new Date().toISOString(),
    botConnected: !!(bot && bot.entity)
  })
})

// Status endpoint
app.get('/status', (req, res) => {
  if (!bot) return res.json({ error: 'Bot not initialized' })
  res.json({
    username: bot.username,
    connected: !!bot.entity,
    health: bot.health || 0,
    food: bot.food || 0,
    position: bot.entity ? {
      x: Math.floor(bot.entity.position.x),
      y: Math.floor(bot.entity.position.y),
      z: Math.floor(bot.entity.position.z)
    } : null,
    trustedPlayers: trustedPlayers.length,
    memoryEntries: memory.length
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log('[WEB] Web server running on port ' + PORT)
})

// ----------------- SETTINGS -----------------
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']
let trustedPlayers = [ownerName]
let ignoredPlayers = []

// Use /tmp for ephemeral storage on Render
const memoryFile = '/tmp/memory.json'
const trustedFile = '/tmp/trusted.json'
const ignoredFile = '/tmp/ignored.json'

// ----------------- NLP -----------------
let nlp = null
try {
  const compromiseImport = await import('compromise')
  nlp = compromiseImport.default
  console.log('[NLP] Compromise NLP loaded')
} catch (e) {
  console.error('[NLP] Failed to load Compromise NLP. Fallback active. Reason: ' + e.message)
  nlp = (text) => ({
    has: (word) => text.toLowerCase().includes(word.toLowerCase())
  })
}

// ----------------- MEMORY -----------------
let memory = []
try {
  memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : []
  console.log('[MEMORY] Loaded ' + memory.length + ' entries from ' + memoryFile)
} catch (e) {
  console.warn('[MEMORY] Failed to load memory. Reason: ' + e.message)
  memory = []
}

function saveMemory() {
  try {
    const trimmed = memory.slice(-50)
    fs.writeFileSync(memoryFile, JSON.stringify(trimmed, null, 2))
    console.log('[MEMORY] Saved ' + trimmed.length + ' entries to ' + memoryFile)
  } catch (e) {
    console.error('[MEMORY] Failed to save memory. Reason: ' + e.message)
  }
}

try {
  trustedPlayers = fs.existsSync(trustedFile) ? JSON.parse(fs.readFileSync(trustedFile, 'utf8')) : trustedPlayers
  console.log('[TRUST] Loaded trusted players: ' + JSON.stringify(trustedPlayers))
} catch (e) {
  console.warn('[TRUST] Failed to load trusted players. Reason: ' + e.message)
}

function saveTrusted() {
  try {
    fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2))
    console.log('[TRUST] Saved trusted players: ' + JSON.stringify(trustedPlayers))
  } catch (e) {
    console.error('[TRUST] Failed to save trusted players. Reason: ' + e.message)
  }
}

try {
  ignoredPlayers = fs.existsSync(ignoredFile) ? JSON.parse(fs.readFileSync(ignoredFile, 'utf8')) : []
  console.log('[IGNORE] Loaded ignored players: ' + JSON.stringify(ignoredPlayers))
} catch (e) {
  console.warn('[IGNORE] Failed to load ignored players. Reason: ' + e.message)
}

function saveIgnored() {
  try {
    fs.writeFileSync(ignoredFile, JSON.stringify(ignoredPlayers, null, 2))
    console.log('[IGNORE] Saved ignored players: ' + JSON.stringify(ignoredPlayers))
  } catch (e) {
    console.error('[IGNORE] Failed to save ignored players. Reason: ' + e.message)
  }
}

// ----------------- GRACEFUL SHUTDOWN -----------------
function shutdown(signal) {
  console.log('[SYSTEM] ' + signal + ' received. Saving state and shutting down.')
  saveMemory()
  saveTrusted()
  saveIgnored()
  if (bot) bot.quit('Server shutting down')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// ----------------- PATHFINDER -----------------
let pathfinderLoaded = false
let Movements, goals, GoalBlock, GoalFollow

async function ensurePathfinderLoaded() {
  if (!pathfinderLoaded && bot) {
    console.log('[PATHFINDER] Loading pathfinder plugin and movements')
    const pathfinderPkg = await import('mineflayer-pathfinder')
    bot.loadPlugin(pathfinderPkg.pathfinder)
    Movements = pathfinderPkg.Movements
    goals = pathfinderPkg.goals
    GoalBlock = goals.GoalBlock
    GoalFollow = goals.GoalFollow
    const mcData = minecraftData(bot.version)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
    pathfinderLoaded = true
    console.log('[PATHFINDER] Loaded successfully with version ' + bot.version)
  }
}

// ----------------- CHAT UTILS -----------------
function whisper(player, message) {
  if (!bot) return
  const out = '[BOT->' + player + '] ' + message
  console.log(out)
  if (bot.players[player]) {
    bot.chat('/msg ' + player + ' ' + message)
  } else {
    bot.chat(message)
  }
}

function tryExtractUserFromPluginMessage(raw) {
  // Try formats and return { username, message } or null
  // Format 1: <user> message
  let m = raw.match(/^<(\w+)>[ ](.+)$/)
  if (m) return { username: m[1], message: m[2] }

  // Format 2: [Discord] user: message
  m = raw.match(/^\[Discord\][ ](.+?):[ ](.+)$/i)
  if (m) return { username: m[1], message: m[2] }

  // Format 3: username: message
  m = raw.match(/^(\w+):[ ](.+)$/)
  if (m) return { username: m[1], message: m[2] }

  // Unknown format
  return null
}

// ----------------- NLP COMMAND PARSER -----------------
function parseInstructionsNLP(username, message) {
  const doc = nlp(message.toLowerCase())
  const steps = []

  // Follow
  if (doc.has('follow') || doc.has('come') || (doc.has('come') && doc.has('with'))) {
    steps.push({ action: 'follow', player: username })
  }

  // Goto x y z
  const coordMatch = message.match(/(?:go to|goto|move to)[ ]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i)
  if (coordMatch) {
    steps.push({
      action: 'goto',
      x: parseInt(coordMatch[1], 10),
      y: parseInt(coordMatch[2], 10),
      z: parseInt(coordMatch[3], 10)
    })
  }

  // Teleport intent
  if ((doc.has('teleport') || message.toLowerCase().includes('/tpa') || message.toLowerCase().includes('tp to')) && !doc.has('request')) {
    if (username) steps.push({ action: 'tpa', player: username })
  }

  // Wait n seconds
  const waitMatch = message.match(/(?:wait|pause|stop)[ ]+(?:\w+[ ]+)?(\d+)[ ]+(?:seconds|secs|sec)/i)
  if (waitMatch) {
    steps.push({ action: 'wait', seconds: parseInt(waitMatch[1], 10) })
  }

  console.log('[NLP] Parsed steps for ' + username + ': ' + JSON.stringify(steps))
  return steps
}

function generateResponse(message, username, isTrusted) {
  const doc = nlp(message.toLowerCase())

  if (doc.has('hello') || doc.has('hi') || doc.has('hey')) {
    return 'Hello ' + username + '! How can I help you?'
  }

  if (doc.has('thank') || doc.has('thanks')) {
    return "You are welcome!"
  }

  if (doc.has('how are you') || doc.has('how do you feel')) {
    return 'I am functioning properly and ready to help.'
  }

  if (doc.has('where are you')) {
    if (!bot || !bot.entity) return 'I am not sure where I am right now.'
    const p = bot.entity.position
    return 'I am at ' + Math.floor(p.x) + ', ' + Math.floor(p.y) + ', ' + Math.floor(p.z)
  }

  if (doc.has('trust') && isTrusted) {
    return 'I have updated the trusted players list.'
  }

  if (isTrusted) {
    return "I heard you, but I am not sure what you want me to do. Try 'follow me', 'goto x y z', or 'tpa player'."
  }

  return 'I am here. Let me know if you need anything.'
}

// ----------------- STEP EXECUTION -----------------
async function ensureValidCoordinates(x, y, z) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000) return false
  if (y < -64 || y > 320) return false
  return true
}

async function executeSteps(username, steps) {
  if (!bot) return
  console.log('[EXEC] Executing ' + steps.length + ' steps for ' + username)

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    console.log('[EXEC] Step ' + (i + 1) + '/' + steps.length + ': ' + JSON.stringify(step))
    try {
      switch (step.action) {
        case 'follow': {
          await ensurePathfinderLoaded()
          const target = bot.players[step.player]?.entity
          if (!target) {
            whisper(username, 'I cannot see ' + step.player + ' right now.')
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
            } catch (e) {
              console.error('[EXEC] Follow stop timer error: ' + e.message)
            }
          }, 60000)
          break
        }

        case 'goto': {
          await ensurePathfinderLoaded()
          if (!(await ensureValidCoordinates(step.x, step.y, step.z))) {
            whisper(username, 'Those coordinates look invalid or too far.')
            break
          }
          bot.pathfinder.setGoal(null)
          const goal = new GoalBlock(step.x, step.y, step.z)
          bot.pathfinder.setGoal(goal)
          whisper(username, 'Going to ' + step.x + ', ' + step.y + ', ' + step.z)
          break
        }

        case 'tpa': {
          if (!step.player) {
            whisper(username, 'I need to know who to teleport to.')
            break
          }
          console.log('[TPA] Sending /tpa to ' + step.player)
          bot.chat('/tpa ' + step.player)
          whisper(username, 'Sent teleport request to ' + step.player)
          break
        }

        case 'wait': {
          const seconds = Math.max(1, Math.min(30, parseInt(step.seconds, 10) || 1))
          whisper(username, 'Waiting ' + seconds + ' seconds')
          await new Promise(r => setTimeout(r, seconds * 1000))
          whisper(username, 'Done waiting')
          break
        }

        default:
          console.warn('[EXEC] Unknown action: ' + step.action)
          whisper(username, 'I do not know how to do: ' + step.action)
      }

      if (i < steps.length - 1) {
        await new Promise(r => setTimeout(r, 500))
      }
    } catch (err) {
      console.error('[EXEC] Error during step ' + JSON.stringify(step) + ' Reason: ' + err.message)
      whisper(username, 'Something went wrong with: ' + step.action)
    }
  }
}

// ----------------- CHAT HANDLERS -----------------
async function handleChat(username, message) {
  if (!bot) return

  // Normalize for plugin forwarded lines
  if (!username || username === bot.username) {
    const parsed = tryExtractUserFromPluginMessage(message)
    if (parsed) {
      username = parsed.username
      message = parsed.message
      console.log('[CHAT ROUTE] Parsed plugin message as <' + username + '> ' + message)
    } else {
      // If still unknown, ignore but log
      if (!username) {
        console.log('[CHAT ROUTE] Unknown sender format. Raw: ' + message)
        return
      }
    }
  }

  if (username === bot.username) return
  if (ignoredPlayers.includes(username)) {
    console.log('[CHAT ROUTE] Ignoring user ' + username)
    return
  }

  console.log('[CHAT] <' + username + '> ' + message)

  const msgLower = message.toLowerCase()
  const mentioned = botNames.some(n => msgLower.includes(n.toLowerCase()))
  if (!mentioned) return

  const isTrusted = trustedPlayers.includes(username)
  console.log('[AUTH] Mentioned by ' + username + ' trusted=' + isTrusted)

  // Owner moderation
  if (username === ownerName) {
    const addMatch = message.match(/\btrust[ ]+(\w+)\b/i)
    const delMatch = message.match(/\b(?:forget|untrust|revoke)[ ]+(\w+)\b/i)
    const ignoreAdd = message.match(/\bignore[ ]+(\w+)\b/i)
    const ignoreDel = message.match(/\b(?:unignore|forgive)[ ]+(\w+)\b/i)

    if (addMatch) {
      const target = addMatch[1]
      if (!trustedPlayers.includes(target)) {
        trustedPlayers.push(target)
        saveTrusted()
        whisper(username, target + ' is now trusted')
      } else {
        whisper(username, target + ' is already trusted')
      }
      return
    }

    if (delMatch) {
      const target = delMatch[1]
      const existed = trustedPlayers.includes(target)
      trustedPlayers = trustedPlayers.filter(p => p !== target)
      saveTrusted()
      whisper(username, existed ? (target + ' is no longer trusted') : (target + ' was not trusted'))
      return
    }

    if (ignoreAdd) {
      const target = ignoreAdd[1]
      if (!ignoredPlayers.includes(target)) {
        ignoredPlayers.push(target)
        saveIgnored()
        whisper(username, target + ' is now ignored')
      } else {
        whisper(username, target + ' is already ignored')
      }
      return
    }

    if (ignoreDel) {
      const target = ignoreDel[1]
      const existed = ignoredPlayers.includes(target)
      ignoredPlayers = ignoredPlayers.filter(p => p !== target)
      saveIgnored()
      whisper(username, existed ? (target + ' is no longer ignored') : (target + ' was not ignored'))
      return
    }
  }

  // Memory log
  memory.push({ role: 'user', content: username + ': ' + message })
  while (memory.length > 50) memory.shift()

  // Trusted commands first
  if (isTrusted) {
    try {
      const steps = parseInstructionsNLP(username, message)
      if (steps && steps.length > 0) {
        await executeSteps(username, steps)
        memory.push({ role: 'assistant', content: '[Executed ' + steps.length + ' steps for ' + username + ']' })
        saveMemory()
        return
      }
    } catch (e) {
      console.error('[CMD] Instruction execution error: ' + e.message)
      whisper(username, 'Something went wrong executing that command.')
      return
    }
  }

  // Block untrusted action verbs
  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait|mine|build|attack)\b/i.test(msgLower)) {
    whisper(username, 'Sorry, only trusted players can give me commands. Ask ' + ownerName)
    return
  }

  // General response
  try {
    const reply = generateResponse(message, username, isTrusted)
    whisper(username, reply)
    memory.push({ role: 'assistant', content: reply })
    saveMemory()
  } catch (e) {
    console.error('[RESP] Response generation error: ' + e.message)
    whisper(username, 'I am having trouble understanding that.')
  }
}

function setupBotEventHandlers() {
  // Core lifecycle
  bot.on('error', (err) => {
    console.error('[LIFECYCLE] Bot error: ' + err.message)
    setTimeout(() => {
      console.log('[LIFECYCLE] Attempting reconnect after error')
      initializeBot().catch(err2 => console.error('[LIFECYCLE] Reconnect failed: ' + err2.message))
    }, 10000)
  })

  bot.on('kicked', (reason) => {
    console.log('[LIFECYCLE] Bot kicked. Reason: ' + reason)
    setTimeout(() => {
      console.log('[LIFECYCLE] Attempting reconnect after kick')
      initializeBot().catch(err2 => console.error('[LIFECYCLE] Reconnect failed: ' + err2.message))
    }, 15000)
  })

  bot.on('end', () => {
    console.log('[LIFECYCLE] Bot disconnected')
    setTimeout(() => {
      console.log('[LIFECYCLE] Attempting reconnect after disconnect')
      initializeBot().catch(err2 => console.error('[LIFECYCLE] Reconnect failed: ' + err2.message))
    }, 10000)
  })

  bot.once('spawn', async () => {
    console.log('[SPAWN] Bot spawned as ' + bot.username + ' at ' + JSON.stringify(bot.entity.position))
    try {
      bot.loadPlugin(autoEat)
      console.log('[SPAWN] AutoEat loaded')
    } catch (e) {
      console.error('[SPAWN] AutoEat failed: ' + e.message)
    }

    try {
      bot.loadPlugin(AutoAuth)
      console.log('[SPAWN] AutoAuth loaded')
    } catch (e) {
      console.error('[SPAWN] AutoAuth failed: ' + e.message)
    }
  })

  // Vanilla chat
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    console.log('[CHAT VANILLA] <' + username + '> ' + message)
    handleChat(username, message)
  })

  // Plugin or system messages including Discord bridge
  bot.on('message', (jsonMsg) => {
    const raw = jsonMsg.toString()
    console.log('[CHAT MESSAGE] ' + raw)

    // Auto accept TPA prompts from Essentials style messages
    const lower = raw.toLowerCase()
    if (lower.includes('has requested to teleport to you') && (lower.includes('tpaccept') || lower.includes('/tpaccept'))) {
      console.log('[TPA] Auto accepting incoming TPA')
      bot.chat('/tpaccept')
    }

    // Try to route plugin line into handleChat
    const parsed = tryExtractUserFromPluginMessage(raw)
    if (parsed) {
      handleChat(parsed.username, parsed.message)
    }
  })

  // Owner commands routed through standard chat handler already
}

// ----------------- OWNER COMMANDS -----------------
async function handleOwnerCommands(username, message) {
  if (!bot || username !== ownerName) return

  const msgLower = message.toLowerCase()

  if (msgLower.includes('status') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    const pos = bot.entity?.position
    if (pos) {
      whisper(username, 'Health: ' + (bot.health?.toFixed(1) || 0) + '/20, Food: ' + (bot.food || 0) + '/20, Position: ' + Math.floor(pos.x) + ', ' + Math.floor(pos.y) + ', ' + Math.floor(pos.z))
    } else {
      whisper(username, 'I am not connected to the server right now.')
    }
  }

  if (msgLower.includes('trusted list') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    whisper(username, 'Trusted players: ' + trustedPlayers.join(', '))
  }

  if (msgLower.includes('stop') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    if (pathfinderLoaded && bot.pathfinder) {
      bot.pathfinder.setGoal(null)
      whisper(username, 'Stopped all movement')
    }
  }
}

// ----------------- BOT INITIALIZATION WITH RETRIES -----------------
async function initializeBot() {
  const maxRetries = 5
  let retry = 0

  while (retry < maxRetries) {
    try {
      console.log('[INIT] Creating bot. Attempt ' + (retry + 1) + ' of ' + maxRetries)
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
    } catch (err) {
      console.error('[INIT] Bot creation failed on attempt ' + (retry + 1) + '. Reason: ' + err.message)
      retry++
      if (retry < maxRetries) {
        const delay = 5000 * retry
        console.log('[INIT] Retrying in ' + Math.floor(delay / 1000) + ' seconds')
        await new Promise(r => setTimeout(r, delay))
      } else {
        console.error('[INIT] Max retries reached. Initialization failed.')
      }
    }
  }
}

// ----------------- PERIODIC TASKS -----------------
setInterval(() => {
  console.log('[HEARTBEAT] Bot status: ' + (bot ? (bot.entity ? 'connected' : 'disconnected') : 'not initialized'))
}, 5 * 60 * 1000)

setInterval(() => {
  saveMemory()
  saveTrusted()
  saveIgnored()
}, 10 * 60 * 1000)

// ----------------- START -----------------
console.log('[SYSTEM] Starting Minecraft bot for Render web service')
console.log('[ENV] BOT_HOST: ' + (process.env.BOT_HOST || 'localhost'))
console.log('[ENV] BOT_PORT: ' + (process.env.BOT_PORT || '25565'))
console.log('[ENV] BOT_USERNAME: ' + (process.env.BOT_USERNAME || 'TryChlorophyll'))
console.log('[ENV] OWNER_NAME: ' + (process.env.OWNER_NAME || 'TryChloroform'))

initializeBot().catch((e) => console.error('[START] initializeBot threw: ' + e.message))
