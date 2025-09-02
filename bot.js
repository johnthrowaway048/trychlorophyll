import { createBot } from 'mineflayer'
import { loader as autoEat } from 'mineflayer-auto-eat'
import minecraftData from 'minecraft-data'
import AutoAuth from 'mineflayer-auto-auth'
import fs from 'fs'
import { config } from 'dotenv'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

// ES6 module compatibility
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

config()

// ----------------- WEB SERVER -----------------
const app = express()
const PORT = process.env.PORT || 3000

let bot = null
let trustedPlayers = []
let ignoredPlayers = []
let memory = []

app.get('/', (req, res) => {
  const status = {
    status: 'online',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    bot: bot ? {
      username: bot.username,
      connected: !!bot.entity,
      health: bot.health || 0,
      food: bot.food || 0,
      position: bot.entity ? bot.entity.position : null
    } : { status: 'not initialized' }
  }
  res.json(status)
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[INFO] Web server running on port ${PORT}`)
})

// ----------------- SETTINGS -----------------
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']

// ----------------- NLP -----------------
let nlp = null
try {
  const compromiseImport = await import('compromise')
  nlp = compromiseImport.default
  console.log('[INFO] Compromise NLP loaded successfully')
} catch (e) {
  console.log('[WARN] Failed to load Compromise NLP, fallback mode')
  nlp = (text) => ({
    has: (word) => text.toLowerCase().includes(word.toLowerCase())
  })
}

// ----------------- PATHFINDER -----------------
let pathfinderLoaded = false
let pathfinderPkg, Movements, goals

async function ensurePathfinderLoaded() {
  if (!pathfinderLoaded && bot) {
    pathfinderPkg = await import('mineflayer-pathfinder')
    bot.loadPlugin(pathfinderPkg.pathfinder)
    Movements = pathfinderPkg.Movements
    goals = pathfinderPkg.goals
    const mcDataModule = await import('minecraft-data')
    const mcData = mcDataModule.default(bot.version)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
    pathfinderLoaded = true
    console.log('[INFO] Pathfinder loaded successfully')
  }
}

// ----------------- BOT -----------------
async function initializeBot() {
  try {
    console.log('[INFO] Initializing bot...')

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
      version: process.env.MC_VERSION || false
    })

    setupBotEventHandlers()
  } catch (err) {
    console.log('[ERROR] Bot initialization failed:', err.message)
  }
}

function setupBotEventHandlers() {
  bot.on('login', () => {
    console.log(`[INFO] Logged in as ${bot.username}`)
  })

  bot.once('spawn', () => {
    console.log(`[INFO] Bot spawned at ${bot.entity.position}`)
    try {
      bot.loadPlugin(autoEat)
      console.log('[INFO] AutoEat plugin loaded')
    } catch (e) {
      console.log('[WARN] Failed to load AutoEat:', e.message)
    }
  })

  bot.on('error', (err) => {
    console.log('[ERROR] Bot error:', err.message)
  })

  bot.on('end', () => {
    console.log('[WARN] Bot disconnected, attempting reconnect in 10s')
    setTimeout(initializeBot, 10000)
  })

  // Normal in-game chat
  bot.on('chat', (username, message) => {
    console.log(`[CHAT] ${username}: ${message}`)
    handleChat(username, message)
  })

  // Plugin or Discord bridge messages
  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString()
    console.log(`[MESSAGE EVENT] ${msg}`)
    // Parse <username> message
    const match = msg.match(/^<(\w+)> (.*)$/)
    if (match) {
      const username = match[1]
      const message = match[2]
      handleChat(username, message)
    }
    // Parse [Discord] User: message
    const discMatch = msg.match(/^\[Discord\]\s+(.+?):\s+(.*)$/)
    if (discMatch) {
      const username = discMatch[1]
      const message = discMatch[2]
      handleChat(username, message)
    }
  })

  // Teleport auto-accept for EssentialsX style
  bot.on('message', (jsonMsg) => {
    const msg = jsonMsg.toString().toLowerCase()
    if (msg.includes('has requested to teleport to you')) {
      console.log('[INFO] Auto-accepting teleport request')
      bot.chat('/tpaccept')
    }
  })
}

// ----------------- ACTIONS -----------------
async function executeSteps(username, steps) {
  if (!bot) return

  console.log(`[INFO] Executing ${steps.length} steps for ${username}`)

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    console.log(`[INFO] Step ${i + 1}:`, step)

    try {
      switch (step.action) {
        case 'goto': {
          await ensurePathfinderLoaded()
          const { GoalBlock } = goals
          const { x, y, z } = step
          const goal = new GoalBlock(x, y, z)
          bot.pathfinder.setGoal(goal)
          console.log(`[INFO] Moving to ${x} ${y} ${z}`)
          break
        }
        case 'follow': {
          await ensurePathfinderLoaded()
          const { GoalFollow } = goals
          const target = bot.players[step.player]?.entity
          if (!target) {
            console.log(`[WARN] Target ${step.player} not found`)
            continue
          }
          const goal = new GoalFollow(target, 1)
          bot.pathfinder.setGoal(goal, true)
          console.log(`[INFO] Following ${step.player}`)
          break
        }
        case 'tpa': {
          if (!step.player) {
            console.log('[WARN] No player specified for TPA')
            continue
          }
          bot.chat(`/tpa ${step.player}`)
          console.log(`[INFO] Sent /tpa to ${step.player}`)
          break
        }
        default:
          console.log(`[WARN] Unknown action ${step.action}`)
      }
    } catch (err) {
      console.log('[ERROR] Failed step:', step, err.message)
    }
  }
}

// ----------------- CHAT HANDLER -----------------
async function handleChat(username, message) {
  if (!username || username === bot.username) return
  console.log(`[DEBUG] handleChat: user=${username}, message=${message}`)

  // Example: parse simple goto
  const coordMatch = message.match(/(?:go to|goto|move to)\s+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i)
  if (coordMatch) {
    const x = parseInt(coordMatch[1])
    const y = parseInt(coordMatch[2])
    const z = parseInt(coordMatch[3])
    await executeSteps(username, [{ action: 'goto', x, y, z }])
    return
  }

  // Example: parse teleport
  if (message.toLowerCase().includes('tpa')) {
    await executeSteps(username, [{ action: 'tpa', player: username }])
    return
  }

  // Example: greetings
  if (/(hello|hi|hey)/i.test(message)) {
    bot.chat(`Hello ${username}!`)
  }
}

// ----------------- START -----------------
console.log('[INFO] Starting Minecraft bot...')
initializeBot()
