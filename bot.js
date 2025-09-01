import { createBot } from 'mineflayer'
import { loader as autoEat } from 'mineflayer-auto-eat'
import minecraftData from 'minecraft-data'
import AutoAuth from 'mineflayer-auto-auth'
import fs from 'fs'
import { config } from 'dotenv'
config()

// ----------------- SETTINGS -----------------
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']
let trustedPlayers = [ownerName]
let ignoredPlayers = []

const memoryFile = './memory.json'
const trustedFile = './trusted.json'
const ignoredFile = './ignored.json'

// ----------------- MEMORY -----------------
let memory = []
try {
  memory = fs.existsSync(memoryFile) ? JSON.parse(fs.readFileSync(memoryFile, 'utf8')) : []
} catch (e) { 
  console.warn('Failed to load memory:', e.message)
  memory = [] 
}

function saveMemory() {
  try { 
    fs.writeFileSync(memoryFile, JSON.stringify(memory.slice(-50), null, 2)) 
  } catch (e) {
    console.error('Failed to save memory:', e.message)
  }
}

try {
  trustedPlayers = fs.existsSync(trustedFile) ? JSON.parse(fs.readFileSync(trustedFile, 'utf8')) : trustedPlayers
} catch (e) {
  console.warn('Failed to load trusted players:', e.message)
}

function saveTrusted() {
  try { 
    fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2)) 
  } catch (e) {
    console.error('Failed to save trusted players:', e.message)
  }
}

try {
  ignoredPlayers = fs.existsSync(ignoredFile) ? JSON.parse(fs.readFileSync(ignoredFile, 'utf8')) : []
} catch (e) {
  console.warn('Failed to load ignored players:', e.message)
}

function saveIgnored() {
  try { 
    fs.writeFileSync(ignoredFile, JSON.stringify(ignoredPlayers, null, 2)) 
  } catch (e) {
    console.error('Failed to save ignored players:', e.message)
  }
}

// ----------------- ARLI AI SETUP -----------------
async function arliChat(prompt, options = {}) {
  try {
    // Validate API key exists
    if (!process.env.ARLI_API_KEY) {
      console.error('ARLI_API_KEY not found in environment variables')
      return "My AI brain isn't configured properly."
    }

    const response = await fetch("https://arli.p.rapidapi.com/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-RapidAPI-Key": process.env.ARLI_API_KEY,
        "X-RapidAPI-Host": "arli.p.rapidapi.com"
      },
      body: JSON.stringify({
        query: prompt,
        conversation: memory.slice(-20).map(msg => ({ role: msg.role, content: msg.content })), // Limit conversation history
        stream: false
      })
    })

    if (!response.ok) {
      console.error(`Arli API HTTP error: ${response.status} ${response.statusText}`)
      return "I'm having trouble thinking right now."
    }

    const data = await response.json()
    return data?.result?.response || "I'm having trouble thinking right now."
  } catch (error) {
    console.error('Arli API error:', error.message)
    return "I'm having trouble thinking right now. Please try again later."
  }
}

// ----------------- BOT INIT -----------------
const bot = createBot({
  host: process.env.BOT_HOST || 'localhost',
  port: parseInt(process.env.BOT_PORT || '25565', 10),
  username: process.env.BOT_USERNAME || 'phyll',
  auth: process.env.BOT_AUTH || 'offline',
  plugins: [AutoAuth],
  AutoAuth: {
    password: process.env.BOT_PASSWORD,
    logging: true,
    ignoreRepeat: true,
  },
})

let pathfinderLoaded = false
let pathfinderPkg, Movements, goals

// Add error handling for bot connection
bot.on('error', (err) => {
  console.error('Bot error:', err.message)
})

bot.on('kicked', (reason) => {
  console.log('Bot was kicked:', reason)
})

bot.on('end', () => {
  console.log('Bot disconnected')
})

bot.once('spawn', async () => {
  console.log(`Bot spawned as ${bot.username} at ${bot.entity.position}`)
  const mcData = minecraftData(bot.version)

  try { 
    bot.loadPlugin(autoEat) 
    console.log('AutoEat plugin loaded successfully')
  } catch (e) { 
    console.error("AutoEat plugin failed to load:", e.message) 
  }
  
  try { 
    bot.loadPlugin(AutoAuth) 
    console.log('AutoAuth plugin loaded successfully')
  } catch (e) { 
    console.error("AutoAuth plugin failed to load:", e.message) 
  }
})

async function ensurePathfinderLoaded() {
  if (!pathfinderLoaded) {
    try {
      pathfinderPkg = await import('mineflayer-pathfinder')
      bot.loadPlugin(pathfinderPkg.pathfinder)
      Movements = pathfinderPkg.Movements
      goals = pathfinderPkg.goals
      const mcDataModule = await import('minecraft-data')
      const mcData = mcDataModule.default(bot.version)
      bot.pathfinder.setMovements(new Movements(bot, mcData))
      pathfinderLoaded = true
      console.log('Pathfinder loaded successfully')
    } catch (e) {
      console.error('Failed to load pathfinder:', e.message)
      throw e
    }
  }
}

// ----------------- INSTRUCTION PARSER -----------------
async function parseInstructionsLLM(username, message) {
  const basePrompt = (msg, strict = false) => `
You are a planner for a Minecraft bot named TryChlorophyll/Phyll.
Given an instruction, output a JSON plan of steps.

Valid actions:
- {"action":"follow","player":"<player>"}
- {"action":"goto","x":<int>,"y":<int>,"z":<int>}
- {"action":"tpa","player":"<player>"}
- {"action":"wait","seconds":<int>}

Rules:
- Output ONLY valid JSON, no extra text.
- Always wrap output in {"steps":[ ... ]}
- Use integers for numbers.
- If the player to follow/teleport isn't specified, use "${username}".
- If nothing actionable, return {"steps": []}.
${strict ? "STRICT: Do not include any explanations, only JSON." : ""}

Instruction: "${msg}"
JSON:`.trim()

  async function askArli(prompt) {
    try {
      const response = await arliChat(prompt, { temperature: 0.3 })
      if (!response || response.includes("trouble thinking")) {
        return null
      }
      
      const jsonMatch = response.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null
      
      const parsed = JSON.parse(jsonMatch[0])
      return parsed
    } catch (e) {
      console.error('JSON parsing error:', e.message)
      return null
    }
  }

  try {
    // First attempt
    let parsed = await askArli(basePrompt(message))
    if (parsed && Array.isArray(parsed.steps)) {
      console.log('Parsed instructions:', parsed.steps)
      return parsed.steps
    }

    // Retry with stricter instructions
    console.warn("Retrying instruction parsing with stricter prompt...")
    parsed = await askArli(basePrompt(message, true))
    if (parsed && Array.isArray(parsed.steps)) {
      console.log('Parsed instructions (retry):', parsed.steps)
      return parsed.steps
    }

    // Final fallback
    console.error("Failed to parse valid JSON after retries.")
    return []
  } catch (e) {
    console.error("Instruction parsing error:", e.message)
    return []
  }
}

// ----------------- EXECUTE STEPS -----------------
async function executeSteps(username, steps) {
  console.log(`Executing ${steps.length} steps for ${username}`)
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    console.log(`Executing step ${i + 1}/${steps.length}:`, step)
    
    try {
      switch (step.action) {
        case "follow": {
          await ensurePathfinderLoaded()
          const target = bot.players[step.player]?.entity
          if (!target) {
            bot.chat(`I can't see ${step.player} right now.`)
            continue
          }
          
          // Clear any existing goal first
          bot.pathfinder.setGoal(null)
          
          const goal = new goals.GoalFollow(target, 1)
          bot.pathfinder.setGoal(goal, true)
          bot.chat(`Following ${step.player}!`)

          // Cancel follow after 60s
          setTimeout(() => {
            if (bot.pathfinder.goal instanceof goals.GoalFollow) {
              bot.pathfinder.setGoal(null)
              bot.chat(`Stopped following ${step.player}.`)
            }
          }, 60000)
          break
        }

        case "goto": {
          await ensurePathfinderLoaded()
          const { x, y, z } = step
          
          // Validate coordinates
          if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
            bot.chat("Those coordinates don't look right.")
            continue
          }
          
          if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 320) {
            bot.chat("Those coordinates are too far or invalid.")
            continue
          }
          
          // Clear any existing goal first
          bot.pathfinder.setGoal(null)
          
          const goal = new goals.GoalBlock(x, y, z)
          bot.pathfinder.setGoal(goal)
          bot.chat(`Going to ${x}, ${y}, ${z}!`)
          break
        }

        case "tpa": {
          if (!step.player) {
            bot.chat("I need to know who to teleport to.")
            continue
          }
          bot.chat(`/tpa ${step.player}`)
          bot.chat(`Sent teleport request to ${step.player}!`)
          break
        }

        case "wait": {
          const seconds = Math.max(1, Math.min(30, parseInt(step.seconds, 10) || 1)) // Cap at 30 seconds
          bot.chat(`Waiting ${seconds} seconds...`)
          await new Promise(resolve => setTimeout(resolve, seconds * 1000))
          bot.chat(`Done waiting!`)
          break
        }

        default:
          console.warn("Unknown action:", step.action)
          bot.chat(`I don't know how to do: ${step.action}`)
      }
      
      // Small delay between steps to prevent spam
      if (i < steps.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
      
    } catch (err) {
      console.error("Error executing step:", step, err.message)
      bot.chat(`Something went wrong with: ${step.action}`)
    }
  }
}

// ----------------- CHAT HANDLER -----------------
bot.on('chat', async (username, message) => {
  // Handle system messages that might not have a username
  if (!username) { 
    const match = message.match(/^<?(\w+)>?\s*(.*)/)
    if (match) { 
      username = match[1]
      message = match[2]
    } else { 
      return // Skip system messages we can't parse
    }
  }
  
  // Skip bot's own messages
  if (!username || username === bot.username) return
  
  // Skip ignored players
  if (ignoredPlayers.includes(username)) return

  console.log(`[CHAT] ${username}: ${message}`)

  // Check if bot was mentioned
  const msgLower = message.toLowerCase()
  const mentioned = botNames.some(n => msgLower.includes(n.toLowerCase()))
  if (!mentioned) return

  const isTrusted = trustedPlayers.includes(username)
  
  console.log(`Mentioned by ${username} (trusted: ${isTrusted})`)

  // Owner-only trust/ignore management
  if (username === ownerName) {
    const addMatch = message.match(/\btrust\s+(\w+)\b/i)
    const delMatch = message.match(/\b(forget|untrust|revoke)\s+(\w+)\b/i)
    const ignoreAdd = message.match(/\bignore\s+(\w+)\b/i)
    const ignoreDel = message.match(/\b(unignore|forgive)\s+(\w+)\b/i)

    if (addMatch) {
      const target = addMatch[1]
      if (!trustedPlayers.includes(target)) {
        trustedPlayers.push(target)
        saveTrusted()
        bot.chat(`${target} is now trusted!`)
        return
      } else {
        bot.chat(`${target} is already trusted.`)
        return
      }
    }

    if (delMatch) {
      const target = delMatch[2]
      const wasRemoved = trustedPlayers.includes(target)
      trustedPlayers = trustedPlayers.filter(p => p !== target)
      saveTrusted()
      if (wasRemoved) {
        bot.chat(`${target} is no longer trusted.`)
      } else {
        bot.chat(`${target} wasn't trusted anyway.`)
      }
      return
    }

    if (ignoreAdd) {
      const target = ignoreAdd[1]
      if (!ignoredPlayers.includes(target)) {
        ignoredPlayers.push(target)
        saveIgnored()
        bot.chat(`${target} is now ignored.`)
        return
      } else {
        bot.chat(`${target} is already ignored.`)
        return
      }
    }

    if (ignoreDel) {
      const target = ignoreDel[1]
      const wasRemoved = ignoredPlayers.includes(target)
      ignoredPlayers = ignoredPlayers.filter(p => p !== target)
      saveIgnored()
      if (wasRemoved) {
        bot.chat(`${target} is no longer ignored.`)
      } else {
        bot.chat(`${target} wasn't ignored anyway.`)
      }
      return
    }
  }

  // Add message to memory (with length limit)
  memory.push({ role: 'user', content: `${username}: ${message}` })
  while (memory.length > 50) {
    memory.shift()
  }

  // Handle trusted player instructions
  if (isTrusted) {
    try {
      const steps = await parseInstructionsLLM(username, message)
      if (steps && steps.length > 0) {
        console.log(`Executing ${steps.length} instruction steps`)
        await executeSteps(username, steps)
        memory.push({ role: 'assistant', content: `[Executed ${steps.length} instructions for ${username}]` })
        saveMemory()
        return
      }
    } catch (e) { 
      console.error('Instruction execution error:', e.message) 
      bot.chat("Something went wrong executing that command.")
      return
    }
  }

  // Block untrusted players from using action commands
  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait|mine|build|attack)\b/i.test(msgLower)) {
    bot.chat(`Sorry, only trusted players can give me commands. Ask ${ownerName}!`)
    return
  }

  // Generate conversational response
  const convoPrompt = `You are Phyll, a helpful Minecraft bot assistant.
Owner: ${ownerName}. Currently trusted: ${trustedPlayers.join(', ')}.
You are loyal to your owner and helpful to trusted players.
Respond briefly and naturally (1-2 sentences max) to: "${message}"
Be friendly but don't be overly chatty. If someone is rude, snap back.`

  try {
    const reply = await arliChat(convoPrompt)
    if (reply && !reply.includes("trouble thinking")) {
      // Ensure response isn't too long for Minecraft chat
      const truncatedReply = reply.length > 100 ? reply.substring(0, 97) + "..." : reply
      bot.chat(truncatedReply)
      memory.push({ role: 'assistant', content: truncatedReply })
      saveMemory()
    } else {
      bot.chat("*thinking...*")
    }
  } catch (e) {
    console.error('Conversation error:', e.message)
    bot.chat("My brain is a bit fuzzy right now.")
  }
})

// Add some helpful status commands
bot.on('chat', async (username, message) => {
  if (username !== ownerName) return
  
  const msgLower = message.toLowerCase()
  
  if (msgLower.includes('status') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    const pos = bot.entity.position
    bot.chat(`Health: ${bot.health?.toFixed(1)}/20, Food: ${bot.food}/20, Position: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`)
  }
  
  if (msgLower.includes('trusted list') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    bot.chat(`Trusted players: ${trustedPlayers.join(', ')}`)
  }
  
  if (msgLower.includes('stop') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    if (pathfinderLoaded && bot.pathfinder) {
      bot.pathfinder.setGoal(null)
      bot.chat("Stopped all movement.")
    }
  }
})