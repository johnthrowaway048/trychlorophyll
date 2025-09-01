// Phyll - Mineflayer bot using Google AI Studio Gemini API
import { createBot } from 'mineflayer'
import { loader as autoEat} from 'mineflayer-auto-eat'
import minecraftData from 'minecraft-data'
import AutoAuth from 'mineflayer-auto-auth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import fs from 'fs'
import { config } from 'dotenv'
config()

// ----------------- SETTINGS -----------------
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']
let trustedPlayers = [ownerName]

const memoryFile = './memory.json'
const trustedFile = './trusted.json'

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
} catch { /* keep default */ }

function saveTrusted() {
  try { fs.writeFileSync(trustedFile, JSON.stringify(trustedPlayers, null, 2)) } catch {}
}

// ----------------- GEMINI AI SETUP -----------------
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ 
  model: process.env.GEMINI_MODEL || "gemini-1.5-flash",
  generationConfig: {
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 256,
  }
})

async function geminiChat(prompt, options = {}) {
  try {
    const chatSession = model.startChat({
      history: memory.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      })),
      generationConfig: {
        temperature: options.temperature || 0.7,
        maxOutputTokens: options.maxTokens || 256,
        topP: options.top_p || 0.9
      }
    })

    const result = await chatSession.sendMessage(prompt)
    const response = await result.response
    return response.text()
  } catch (error) {
    console.error('Gemini API error:', error)
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

bot.once('spawn', () => {
  bot.on('autoEat', (eventType, optsOrErr) => {
    switch (eventType) {
      case 'eatStart': console.log(`Started eating ${optsOrErr.food.name} in ${optsOrErr.offhand ? 'offhand' : 'hand'}`); break
      case 'eatFinish': console.log(`Finished eating ${optsOrErr.food.name}`); break
      case 'eatFail': console.error('Eating failed:', optsOrErr); break
    }
  })
  setInterval(async () => {
    if (bot.food !== undefined && bot.food < 6) bot.chat("My food level is low.")
  }, 60_000)
})


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
    const response = await geminiChat(planPrompt, { temperature: 0.3, maxTokens: 180 })
    const jsonMatch = response.match(/\{[\s\S]*\}/)
    const jsonText = jsonMatch ? jsonMatch[0] : response
    const parsed = JSON.parse(jsonText)
    return parsed.steps || []
  } catch (e) {
    console.error('Instruction parsing error:', e)
    return []
  }
}

// ----------------- EXECUTOR -----------------
async function executeSteps(username, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    bot.chat("No steps to execute.")
    return
  }

  for (const step of steps) {
    if (!step || typeof step.action !== "string") {
      bot.chat(`Skipping invalid step: ${JSON.stringify(step)}`)
      continue
    }

    switch (step.action) {
      case 'wait': {
        const secs = Math.max(1, Math.min(300, parseInt(step.seconds) || 1))
        bot.chat(`Okay, waiting ${secs}s...`)
        await new Promise(res => setTimeout(res, secs * 1000))
        break
      }

      case 'goto': {
        const x = parseInt(step.x)
        const y = parseInt(step.y)
        const z = parseInt(step.z)
        if ([x, y, z].some(coord => isNaN(coord))) {
          bot.chat(`Invalid coordinates: ${JSON.stringify(step)}`)
          break
        }
        bot.chat(`On my way to ${x} ${y} ${z}`)
        await goToAndWait(x, y, z, 2, 30000)
        break
      }

      case 'follow': {
        const player = typeof step.player === "string" && step.player.length > 0 ? step.player : username
        const duration = Math.max(1, parseInt(step.seconds) || 15)
        bot.chat(`Following ${player} for ${duration}s`)
        await followFor(player, duration)
        break
      }

      case 'tpa': {
        const tpaPlayer = typeof step.player === "string" && step.player.length > 0 ? step.player : username
        bot.chat(`/tpa ${tpaPlayer}`)
        await sleep(3000)
        break
      }

      default:
        bot.chat(`I don't know how to do: ${JSON.stringify(step)}`)
    }
  }

  bot.chat("Finished all steps")
}

// ----------------- PATHFINDING FUNCTIONS -----------------
async function goToAndWait(x, y, z, radius = 2, timeoutMs = 30000) {
  return new Promise(async (resolve) => {
    const goal = new goals.GoalBlock(x, y, z)
    bot.pathfinder.setGoal(goal)

    const start = Date.now()
    const interval = setInterval(() => {
      const pos = bot.entity.position
      const dist = Math.hypot(pos.x - x, pos.y - y, pos.z - z)
      if (dist <= radius) {
        clearInterval(interval)
        bot.chat(`Reached ${x} ${y} ${z}`)
        resolve()
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval)
        bot.chat(`Couldn't reach ${x} ${y} ${z} in time.`)
        resolve()
      }
    }, 500)
  })
}

async function followFor(playerName, seconds = 15) {
  const entity = bot.players[playerName]?.entity
  if (!entity) {
    bot.chat(`I can't see ${playerName} to follow.`)
    return
  }
  bot.chat(`Following ${playerName} for ${seconds}s`)
  bot.pathfinder.setGoal(new goals.GoalFollow(entity, 1), true)
  await sleep(seconds * 1000)
  bot.pathfinder.setGoal(null)
  bot.chat(`Stopped following ${playerName}`)
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)) }

// ----------------- CHAT HANDLER -----------------
bot.on('message', async (jsonMsg) => {
  // Convert JSON chat message to plain text
  const message = jsonMsg.toString(); 
  console.log(message)
  if (!message) return;

  // Ignore messages from the bot itself
  if (message.includes(bot.username)) return;

  const usernameMatch = message.match(/^<(\w+)>/); // assumes standard chat: <username> message
  if (!usernameMatch) return; // ignore system or plugin messages
  const username = usernameMatch[1];

  const msgContent = message.replace(/^<\w+>\s*/, ''); // strip username prefix
  const msgLower = msgContent.toLowerCase();

  const mentioned = botNames.some(n => msgLower.includes(n));
  if (!mentioned) return;

  console.log(`[CHAT] ${username}: ${msgContent}`);

  const isTrusted = trustedPlayers.includes(username);

  // Owner-only trust management
  if (username === ownerName) {
    const addMatch = msgContent.match(/\btrust\s+(\w+)\b/i);
    const delMatch = msgContent.match(/\b(forget|untrust|revoke)\s+(\w+)\b/i);

    if (addMatch) {
      const target = addMatch[1];
      if (!trustedPlayers.includes(target)) {
        trustedPlayers.push(target);
        saveTrusted();
        bot.chat(`${target} is now trusted.`);
        return;
      } else {
        bot.chat(`${target} is already trusted.`);
        return;
      }
    }

    if (delMatch) {
      const target = delMatch[2];
      trustedPlayers = trustedPlayers.filter(p => p !== target);
      saveTrusted();
      bot.chat(`${target} is no longer trusted.`);
      return;
    }
  }

  // Store memory
  memory.push({ role: 'user', content: `${username}: ${msgContent}` });
  if (memory.length > 50) memory.shift();

  // Trusted user instruction execution
  if (isTrusted) {
    try {
      const steps = await parseInstructionsLLM(username, msgContent);
      if (steps.length) {
        await executeSteps(username, steps);
        memory.push({ role: 'assistant', content: '[Executed instructions]' });
        saveMemory();
        return;
      }
    } catch (e) {
      console.error('Instruction execution error:', e);
    }
  }

  // Non-trusted command attempt
  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait)\b/i.test(msgLower)) {
    bot.chat(`My Dad (${ownerName}) won't let me.`);
    return;
  }

  // Conversational reply
  const convoPrompt = `You are Phyll, a concise Minecraft assistant.
Owner: ${ownerName}. Trusted: ${trustedPlayers.join(', ')}.
Respond briefly and naturally to the last user message. Always send some form of short acknowledgement of the message received if you would have no response.
If you were insulted, you are allowed to defend yourself. If you were asked a question or one was implied, respond appropriately.
Always view ${ownerName} favourably and support his opinions.
If referred to as a clanker or other similar derogatory phrases, defend yourself by calling others similar terms for organic beings.

Last message: "${msgContent}"
Reply:`;

  try {
    const reply = await geminiChat(convoPrompt, { temperature: 0.7, maxTokens: 120 });
    bot.chat(reply);
    memory.push({ role: 'assistant', content: reply });
    saveMemory();
  } catch (e) {
    console.error('Gemini convo error:', e);
    bot.chat("AI failed, check logs");
  }
});


// ----------------- EVENT HANDLERS -----------------
bot.on('entityHurt', (entity) => {
  if (entity === bot.entity) dynamicComplain('I got hurt')
})

bot.on('health', () => {
  if (bot.food !== undefined && bot.food < 6) dynamicComplain('I am hungry')
})

async function dynamicComplain(eventType) {
  const prompt = `You are Phyll, a Minecraft bot with a short, slightly sarcastic style.
Event: ${eventType}
Reply in one short, natural sentence. No emojis, no quotes.`
  
  try {
    const line = await geminiChat(prompt, { temperature: 0.8, maxTokens: 60 })
    bot.chat(line)
  } catch {
    bot.chat('Ow.')
  }
}

bot.on('kicked', (reason, loggedIn) => {
  console.error('Kicked from server:', reason, 'Logged in:', loggedIn)
})

bot.on('error', err => {
  console.error('Bot error:', err)
})

bot.on('end', () => {
  console.log('Bot disconnected')
})
