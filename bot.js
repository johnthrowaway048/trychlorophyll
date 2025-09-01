// Phyll - Mineflayer bot using ArliAI API
import { createBot } from 'mineflayer'
import { loader as autoEat} from 'mineflayer-auto-eat'
import minecraftData from 'minecraft-data'
import AutoAuth from 'mineflayer-auto-auth'
import fs from 'fs'
import fetch from 'node-fetch'
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

// ----------------- TRUSTED & IGNORED -----------------
try { trustedPlayers = fs.existsSync(trustedFile) ? JSON.parse(fs.readFileSync(trustedFile, 'utf8')) : trustedPlayers } catch {}
try { ignoredPlayers = fs.existsSync(ignoredFile) ? JSON.parse(fs.readFileSync(ignoredFile, 'utf8')) : [] } catch {}

function saveTrusted() { try { fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2)) } catch {} }
function saveIgnored() { try { fs.writeFileSync(ignoredFile, JSON.stringify(ignoredPlayers, null, 2)) } catch {} }

// ----------------- ARLI AI SETUP -----------------
const ARLI_API_KEY = process.env.ARLI_API_KEY
const ARLI_ENDPOINT = 'https://api.arli.ai/v1/complete'

async function arliChat(prompt, options = {}) {
  try {
    const res = await fetch(ARLI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ARLI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt,
        max_tokens: options.maxTokens || 256,
        temperature: options.temperature || 0.7,
      })
    })
    const data = await res.json()
    return data.output?.[0]?.content?.[0]?.text || "I couldn't think of a response."
  } catch (err) {
    console.error('Arli API error:', err)
    return "AI is unavailable right now."
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

// ----------------- CHAT HANDLER -----------------
bot.on('chat', async (username, message) => {
  if (!username) { const match = message.match(/^<?(\w+)>?\s*(.*)/); // attempt to parse <username> Message 
	if (match) { username = match[1]; message = match[2]; } 
	else { username = 'Unknown'; } } 

  if (username === bot.username) return; // ignore bot itself console.log([CHAT] ${username}: ${message});

  if (ignoredPlayers.includes(username)) return // ignore ignored players
  if (username === bot.username) return

  const msgLower = message.toLowerCase()
  const mentioned = botNames.some(n => msgLower.includes(n))
  if (!mentioned) return

  const isTrusted = trustedPlayers.includes(username)

  // Owner-only trust/ignore management
  if (username === ownerName) {
    const addMatch = message.match(/\btrust\s+(\w+)\b/i)
    const delMatch = message.match(/\b(forget|untrust|revoke)\s+(\w+)\b/i)
    const ignoreMatch = message.match(/\bignore\s+(\w+)\b/i)
    const unignoreMatch = message.match(/\bunignore\s+(\w+)\b/i)

    if (addMatch) { const target = addMatch[1]; if (!trustedPlayers.includes(target)) { trustedPlayers.push(target); saveTrusted(); bot.chat(`${target} is now trusted.`); return } }
    if (delMatch) { const target = delMatch[2]; trustedPlayers = trustedPlayers.filter(p => p !== target); saveTrusted(); bot.chat(`${target} is no longer trusted.`); return }
    if (ignoreMatch) { const target = ignoreMatch[1]; if (!ignoredPlayers.includes(target)) { ignoredPlayers.push(target); saveIgnored(); bot.chat(`${target} is now ignored.`); return } }
    if (unignoreMatch) { const target = unignoreMatch[1]; ignoredPlayers = ignoredPlayers.filter(p => p !== target); saveIgnored(); bot.chat(`${target} is no longer ignored.`); return }
  }

  // Store memory
  memory.push({ role: 'user', content: `${username}: ${message}` })
  if (memory.length > 50) memory.shift()

  // Trusted user instruction (optional step execution logic can stay the same)
  if (isTrusted) {
    try {
      bot.chat(`Executing instructions from trusted user ${username}...`)
      // integrate parseInstructionsLLM & executeSteps if needed
      return
    } catch (e) { console.error('Execution error:', e) }
  }

  // Non-trusted command attempt
  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait)\b/i.test(msgLower)) {
    bot.chat(`My Dad (${ownerName}) won't let me.`)
    return
  }

  // Conversational reply
  const convoPrompt = `You are Phyll, a concise Minecraft assistant.
Owner: ${ownerName}. Trusted: ${trustedPlayers.join(', ')}. Ignored: ${ignoredPlayers.join(', ')}.
Respond briefly and naturally to the last user message. Last message: "${message}"
Reply:`

  try {
    const reply = await arliChat(convoPrompt, { temperature: 0.7, maxTokens: 120 })
    bot.chat(reply)
    memory.push({ role: 'assistant', content: reply })
    saveMemory()
  } catch (e) {
    console.error('Arli convo error:', e)
    bot.chat("AI failed, check logs")
  }
})
