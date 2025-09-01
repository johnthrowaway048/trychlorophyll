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
} catch { memory = [] }

function saveMemory() {
  try { fs.writeFileSync(memoryFile, JSON.stringify(memory.slice(-50), null, 2)) } catch {}
}

try {
  trustedPlayers = fs.existsSync(trustedFile) ? JSON.parse(fs.readFileSync(trustedFile, 'utf8')) : trustedPlayers
} catch {}

function saveTrusted() {
  try { fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2)) } catch {}
}

try {
  ignoredPlayers = fs.existsSync(ignoredFile) ? JSON.parse(fs.readFileSync(ignoredFile, 'utf8')) : []
} catch {}

function saveIgnored() {
  try { fs.writeFileSync(ignoredFile, JSON.stringify(ignoredPlayers, null, 2)) } catch {}
}

// ----------------- ARLI AI SETUP -----------------
async function arliChat(prompt, options = {}) {
  try {
    const response = await fetch("https://arli.p.rapidapi.com/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-RapidAPI-Key": process.env.ARLI_API_KEY,
        "X-RapidAPI-Host": "arli.p.rapidapi.com"
      },
      body: JSON.stringify({
        query: prompt,
        conversation: memory.map(msg => ({ role: msg.role, content: msg.content })),
        stream: false
      })
    })
    const data = await response.json()
    return data?.result?.response || "I'm having trouble thinking right now."
  } catch (error) {
    console.error('Arli API error:', error)
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

bot.once('spawn', async () => {
  console.log("Bot spawned")
  const mcData = minecraftData(bot.version)

  try { bot.loadPlugin(autoEat) } catch (e) { console.error("AutoEat plugin failed to load:", e) }
  try { bot.loadPlugin(AutoAuth) } catch (e) { console.error("AutoAuth plugin failed to load:", e) }
})

async function ensurePathfinderLoaded() {
  if (!pathfinderLoaded) {
    pathfinderPkg = await import('mineflayer-pathfinder')
    bot.loadPlugin(pathfinderPkg.pathfinder)
    Movements = pathfinderPkg.Movements
    goals = pathfinderPkg.goals
    const mcDataModule = await import('minecraft-data')
    const mcData = mcDataModule.default(bot.version)
    bot.pathfinder.setMovements(new Movements(bot, mcData))
    pathfinderLoaded = true
  }
}

// ----------------- INSTRUCTION PARSER -----------------
async function parseInstructionsLLM(username, message) {
  const planPrompt = `You are a planner for a Minecraft bot named TryChlorophyll/Phyll.
Given an instruction, output a JSON plan of steps. If told to move to a set of coordinates, prefer to pathfind there. If told to move to a player, prefer to teleport there.

Valid actions:
- {"action":"follow","player":"<player>"}
- {"action":"goto","x":<int>,"y":<int>,"z":<int>}
- {"action":"tpa","player":"<player>"}
- {"action":"wait","seconds":<int>}

Rules:
- Output ONLY valid JSON, no extra text.
- Use integers for numbers.
- If the player to follow/teleport isn't specified, use "${username}".
- If nothing actionable, return {"steps": []}.

Instruction: "${message}"
JSON:`

  try {
    const response = await arliChat(planPrompt, { temperature: 0.3 })
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    const jsonText = jsonMatch ? jsonMatch[0] : response
    const parsed = JSON.parse(jsonText)
    return parsed.steps || []
  } catch (e) {
    console.error('Instruction parsing error:', e)
    return []
  }
}

// ----------------- CHAT HANDLER -----------------
bot.on('chat', async (username, message) => {
	
  if (!username) { const match = message.match(/^<?(\w+)>?\s*(.*)/); // attempt to parse <username> Message 
	if (match) { username = match[1]; message = match[2]; } 
	else { username = 'Unknown'; } }
	
  if (!username || username === bot.username) return
  if (ignoredPlayers.includes(username)) return // skip ignored players

  console.log('[CHAT] ${username}: ${message}');

  const msgLower = message.toLowerCase()
  const mentioned = botNames.some(n => msgLower.includes(n))
  if (!mentioned) return

  const isTrusted = trustedPlayers.includes(username)
  
  console.log('Mentioned by ${username}, generating response')

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
        bot.chat(`${target} is now trusted.`)
        return
      } else {
        bot.chat(`${target} is already trusted.`)
        return
      }
    }

    if (delMatch) {
      const target = delMatch[2]
      trustedPlayers = trustedPlayers.filter(p => p !== target)
      saveTrusted()
      bot.chat(`${target} is no longer trusted.`)
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
      ignoredPlayers = ignoredPlayers.filter(p => p !== target)
      saveIgnored()
      bot.chat(`${target} is no longer ignored.`)
      return
    }
  }

  // Memory and conversation
  memory.push({ role: 'user', content: `${username}: ${message}` })
  if (memory.length > 50) memory.shift()

  if (isTrusted) {
    try {
      const steps = await parseInstructionsLLM(username, message)
      if (steps.length) {
        // executeSteps stays the same as in your original code
        await executeSteps(username, steps)
        memory.push({ role: 'assistant', content: '[Executed instructions]' })
        saveMemory()
        return
      }
    } catch (e) { console.error('Instruction execution error:', e) }
  }

  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait)\b/i.test(msgLower)) {
    bot.chat(`My Dad (${ownerName}) won't let me.`)
    return
  }

  const convoPrompt = `You are Phyll, a concise Minecraft assistant.
Owner: ${ownerName}. Trusted: ${trustedPlayers.join(', ')}. Ignored: ${ignoredPlayers.join(', ')}.
Respond briefly and naturally to the last user message. If insulted, defend yourself. Always agree, defend and support your owner.`

  try {
    const reply = await arliChat(convoPrompt)
    bot.chat(reply)
    memory.push({ role: 'assistant', content: reply })
    saveMemory()
  } catch (e) {
    console.error('Arli convo error:', e)
    bot.chat("AI failed, check logs")
  }
})
