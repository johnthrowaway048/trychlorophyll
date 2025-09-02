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

// ----------------- WEB SERVER FOR RENDER -----------------
const app = express()
const PORT = process.env.PORT || 3000

// Health check endpoint
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

// Additional health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    botConnected: !!(bot && bot.entity)
  })
})

// Status endpoint for monitoring
app.get('/status', (req, res) => {
  if (!bot) {
    return res.json({ error: 'Bot not initialized' })
  }
  
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

// Start web server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server running on port ${PORT}`)
})

// ----------------- SETTINGS -----------------
const ownerName = process.env.OWNER_NAME || 'TryChloroform'
const botNames = process.env.BOT_NAMES ? process.env.BOT_NAMES.split(',') : ['trychlorophyll', 'phyll']
let trustedPlayers = [ownerName]
let ignoredPlayers = []

// Use /tmp for file storage on Render (ephemeral but works)
const memoryFile = '/tmp/memory.json'
const trustedFile = '/tmp/trusted.json'
const ignoredFile = '/tmp/ignored.json'

// ----------------- COMPROMISE NLP -----------------
let nlp = null;
try {
  const compromiseImport = await import('compromise');
  nlp = compromiseImport.default;
  console.log('Compromise NLP loaded successfully');
} catch (e) {
  console.error('Failed to load Compromise NLP:', e.message);
  // Fallback to simple pattern matching
  nlp = {
    process: (text) => {
      return {
        match: (pattern) => {
          const regex = new RegExp(pattern, 'i');
          return regex.test(text);
        },
        has: (word) => text.toLowerCase().includes(word.toLowerCase())
      };
    }
  };
}

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

// ----------------- GRACEFUL SHUTDOWN -----------------
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...')
  saveMemory()
  saveTrusted()
  saveIgnored()
  if (bot) {
    bot.quit('Server shutting down')
  }
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...')
  saveMemory()
  saveTrusted() 
  saveIgnored()
  if (bot) {
    bot.quit('Server shutting down')
  }
  process.exit(0)
})

// Global bot variable (declared here so web endpoints can access it)
let bot = null

// ----------------- WHISPER FUNCTION -----------------
function whisper(player, message) {
  if (bot && bot.players[player]) {
    bot.chat(`/msg ${player} ${message}`);
  } else if (bot) {
    // Fallback to regular chat if player not found
    bot.chat(message);
  }
}

// ----------------- LOCAL NLP PROCESSING -----------------
function parseInstructionsNLP(username, message) {
  const doc = nlp(message.toLowerCase());
  const steps = [];
  
  // Follow commands
  if (doc.has('follow') || doc.has('come') || (doc.has('come') && doc.has('with'))) {
    const target = extractPlayerName(message, username, ['follow', 'come']);
    steps.push({ action: "follow", player: target });
  }
  
  // Goto coordinates - be more specific about coordinate patterns
  const coordMatch = message.match(/(?:go to|goto|move to)\s+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i);
  if (coordMatch) {
    steps.push({ 
      action: "goto", 
      x: parseInt(coordMatch[1]), 
      y: parseInt(coordMatch[2]), 
      z: parseInt(coordMatch[3]) 
    });
  }
  
  // Teleport requests - be more specific to avoid false matches
  if ((doc.has('teleport') || message.toLowerCase().includes('/tpa') || message.toLowerCase().includes('tp to')) && !doc.has('request')) {
    const target = extractPlayerName(message, username, ['teleport', 'tp', 'tpa']);
    if (target !== username) { // Don't tp to self
      steps.push({ action: "tpa", player: target });
    }
  }
  
  // Wait commands
  const waitMatch = message.match(/(?:wait|pause|stop) (?:\w+ )?(\d+) (?:seconds|secs|sec)/i);
  if (waitMatch) {
    steps.push({ action: "wait", seconds: parseInt(waitMatch[1]) });
  }
  
  return steps;
}

function extractPlayerName(message, defaultName, commandWords = []) {
  const words = message.toLowerCase().split(/\s+/);
  
  // Look for player names after command words
  for (const cmdWord of commandWords) {
    const cmdIndex = words.findIndex(word => word.includes(cmdWord.toLowerCase()));
    if (cmdIndex !== -1 && cmdIndex + 1 < words.length) {
      const nextWord = words[cmdIndex + 1].replace(/[^a-zA-Z0-9_]/g, '');
      // Don't return empty strings or common words
      if (nextWord && nextWord.length > 0 && !['me', 'to', 'at', 'the'].includes(nextWord)) {
        return nextWord;
      }
    }
  }
  
  // Look for "me" patterns
  if (message.toLowerCase().includes('follow me') || message.toLowerCase().includes('come to me')) {
    return defaultName;
  }
  
  return defaultName;
}

function generateResponse(message, username, isTrusted) {
  if (!nlp) return "I'm having trouble with language processing right now.";
  
  const doc = nlp(message.toLowerCase());
  
  // Greetings
  if (doc.has('hello') || doc.has('hi') || doc.has('hey')) {
    return `Hello ${username}! How can I help you?`;
  }
  
  // Thanks
  if (doc.has('thank') || doc.has('thanks')) {
    return "You're welcome!";
  }
  
  // Questions about status
  if (doc.has('how are you') || doc.has('how do you feel')) {
    return "I'm functioning properly and ready to help!";
  }
  
  // Location questions
  if (doc.has('where are you')) {
    if (!bot || !bot.entity) return "I'm not sure where I am right now.";
    const pos = bot.entity.position;
    return `I'm at ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`;
  }
  
  // Trust management responses
  if (doc.has('trust') && isTrusted) {
    return "I've updated the trusted players list.";
  }
  
  // Default response for unknown queries
  if (isTrusted) {
    return "I heard you, but I'm not sure what you want me to do. Try 'follow me', 'goto x y z', or 'tpa player'.";
  }
  
  return "I'm here! Let me know if you need anything.";
}

// ----------------- BOT INITIALIZATION WITH RETRY -----------------
async function initializeBot() {
  const maxRetries = 5;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      console.log(`Initializing bot (attempt ${retryCount + 1}/${maxRetries})...`);
      
      bot = createBot({
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
        connectTimeout: 30000, // 30 second timeout
        checkTimeoutInterval: 10000,
        version: process.env.MC_VERSION || false // Auto-detect version
      });
      
      setupBotEventHandlers();
      break;
      
    } catch (error) {
      console.error(`Bot initialization failed (attempt ${retryCount + 1}):`, error.message);
      retryCount++;
      
      if (retryCount < maxRetries) {
        console.log(`Retrying in ${5 * retryCount} seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000 * retryCount));
      } else {
        console.error('Max retries reached. Bot initialization failed.');
      }
    }
  }
}

let pathfinderLoaded = false;
let pathfinderPkg, Movements, goals;

function setupBotEventHandlers() {
  // Add error handling for bot connection
  bot.on('error', (err) => {
    console.error('Bot error:', err.message);
    // Auto-reconnect on error after delay
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      initializeBot();
    }, 10000);
  });

  bot.on('kicked', (reason) => {
    console.log('Bot was kicked:', reason);
    // Auto-reconnect after being kicked
    setTimeout(() => {
      console.log('Attempting to reconnect after kick...');
      initializeBot();
    }, 15000);
  });

  bot.on('end', () => {
    console.log('Bot disconnected');
    // Auto-reconnect after disconnect
    setTimeout(() => {
      console.log('Attempting to reconnect after disconnect...');
      initializeBot();
    }, 10000);
  });

  bot.once('spawn', async () => {
    console.log(`Bot spawned as ${bot.username} at ${bot.entity.position}`);
    const mcData = minecraftData(bot.version);

    try { 
      bot.loadPlugin(autoEat); 
      console.log('AutoEat plugin loaded successfully');
    } catch (e) { 
      console.error("AutoEat plugin failed to load:", e.message); 
    }
    
    try { 
      bot.loadPlugin(AutoAuth); 
      console.log('AutoAuth plugin loaded successfully');
    } catch (e) { 
      console.error("AutoAuth plugin failed to load:", e.message); 
    }
  });

  // Chat handlers
  bot.on('chat', handleChat);
  bot.on('chat', handleOwnerCommands);
}

async function ensurePathfinderLoaded() {
  if (!pathfinderLoaded && bot) {
    try {
      pathfinderPkg = await import('mineflayer-pathfinder');
      bot.loadPlugin(pathfinderPkg.pathfinder);
      Movements = pathfinderPkg.Movements;
      goals = pathfinderPkg.goals;
      const mcDataModule = await import('minecraft-data');
      const mcData = mcDataModule.default(bot.version);
      bot.pathfinder.setMovements(new Movements(bot, mcData));
      pathfinderLoaded = true;
      console.log('Pathfinder loaded successfully');
    } catch (e) {
      console.error('Failed to load pathfinder:', e.message);
      throw e;
    }
  }
}

// ----------------- EXECUTE STEPS -----------------
async function executeSteps(username, steps) {
  if (!bot) return;
  
  console.log(`Executing ${steps.length} steps for ${username}`);
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`Executing step ${i + 1}/${steps.length}:`, step);
    
    try {
      switch (step.action) {
        case "follow": {
          await ensurePathfinderLoaded();
          const target = bot.players[step.player]?.entity;
          if (!target) {
            whisper(username, `I can't see ${step.player} right now.`);
            continue;
          }
          
          bot.pathfinder.setGoal(null);
          const goal = new goals.GoalFollow(target, 1);
          bot.pathfinder.setGoal(goal, true);
          whisper(username, `Following ${step.player}!`);

          setTimeout(() => {
            if (bot.pathfinder.goal instanceof goals.GoalFollow) {
              bot.pathfinder.setGoal(null);
              whisper(username, `Stopped following ${step.player}.`);
            }
          }, 60000);
          break;
        }

        case "goto": {
          await ensurePathfinderLoaded();
          const { x, y, z } = step;
          
          if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
            whisper(username, "Those coordinates don't look right.");
            continue;
          }
          
          if (Math.abs(x) > 30000000 || Math.abs(z) > 30000000 || y < -64 || y > 320) {
            whisper(username, "Those coordinates are too far or invalid.");
            continue;
          }
          
          bot.pathfinder.setGoal(null);
          const goal = new goals.GoalBlock(x, y, z);
          bot.pathfinder.setGoal(goal);
          whisper(username, `Going to ${x}, ${y}, ${z}!`);
          break;
        }

        case "tpa": {
          if (!step.player) {
            whisper(username, "I need to know who to teleport to.");
            continue;
          }
          bot.chat(`/tpa ${step.player}`);
          whisper(username, `Sent teleport request to ${step.player}!`);
          break;
        }

        case "wait": {
          const seconds = Math.max(1, Math.min(30, parseInt(step.seconds, 10) || 1));
          whisper(username, `Waiting ${seconds} seconds...`);
          await new Promise(resolve => setTimeout(resolve, seconds * 1000));
          whisper(username, `Done waiting!`);
          break;
        }

        default:
          console.warn("Unknown action:", step.action);
          whisper(username, `I don't know how to do: ${step.action}`);
      }
      
      if (i < steps.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
    } catch (err) {
      console.error("Error executing step:", step, err.message);
      whisper(username, `Something went wrong with: ${step.action}`);
    }
  }
}

// ----------------- CHAT HANDLERS -----------------
async function handleChat(username, message) {
  if (!bot) return;
  
  if (!username) { 
    const match = message.match(/^<?(\w+)>?\s*(.*)/);
    if (match) { 
      username = match[1];
      message = match[2];
    } else { 
      return;
    }
  }
  
  if (!username || username === bot.username) return;
  if (ignoredPlayers.includes(username)) return;

  console.log(`[CHAT] ${username}: ${message}`);

  const msgLower = message.toLowerCase();
  const mentioned = botNames.some(n => msgLower.includes(n.toLowerCase()));
  if (!mentioned) return;

  const isTrusted = trustedPlayers.includes(username);
  console.log(`Mentioned by ${username} (trusted: ${isTrusted})`);

  // Owner-only trust/ignore management
  if (username === ownerName) {
    const addMatch = message.match(/\btrust\s+(\w+)\b/i);
    const delMatch = message.match(/\b(forget|untrust|revoke)\s+(\w+)\b/i);
    const ignoreAdd = message.match(/\bignore\s+(\w+)\b/i);
    const ignoreDel = message.match(/\b(unignore|forgive)\s+(\w+)\b/i);

    if (addMatch) {
      const target = addMatch[1];
      if (!trustedPlayers.includes(target)) {
        trustedPlayers.push(target);
        saveTrusted();
        whisper(username, `${target} is now trusted!`);
        return;
      } else {
        whisper(username, `${target} is already trusted.`);
        return;
      }
    }

    if (delMatch) {
      const target = delMatch[2];
      const wasRemoved = trustedPlayers.includes(target);
      trustedPlayers = trustedPlayers.filter(p => p !== target);
      saveTrusted();
      whisper(username, wasRemoved ? `${target} is no longer trusted.` : `${target} wasn't trusted anyway.`);
      return;
    }

    if (ignoreAdd) {
      const target = ignoreAdd[1];
      if (!ignoredPlayers.includes(target)) {
        ignoredPlayers.push(target);
        saveIgnored();
        whisper(username, `${target} is now ignored.`);
        return;
      } else {
        whisper(username, `${target} is already ignored.`);
        return;
      }
    }

    if (ignoreDel) {
      const target = ignoreDel[1];
      const wasRemoved = ignoredPlayers.includes(target);
      ignoredPlayers = ignoredPlayers.filter(p => p !== target);
      saveIgnored();
      whisper(username, wasRemoved ? `${target} is no longer ignored.` : `${target} wasn't ignored anyway.`);
      return;
    }
  }

  // Add message to memory
  memory.push({ role: 'user', content: `${username}: ${message}` });
  while (memory.length > 50) {
    memory.shift();
  }

  // Handle trusted player instructions
  if (isTrusted) {
    try {
      const steps = parseInstructionsNLP(username, message);
      if (steps && steps.length > 0) {
        console.log(`Executing ${steps.length} instruction steps:`, steps);
        await executeSteps(username, steps);
        memory.push({ role: 'assistant', content: `[Executed ${steps.length} instructions for ${username}]` });
        saveMemory();
        return;
      }
    } catch (e) { 
      console.error('Instruction execution error:', e.message); 
      whisper(username, "Something went wrong executing that command.");
      return;
    }
  }

  // Block untrusted players from using action commands
  if (!isTrusted && /\b(follow|goto|come|hold|drop|tp|tpa|wait|mine|build|attack)\b/i.test(msgLower)) {
    whisper(username, `Sorry, only trusted players can give me commands. Ask ${ownerName}!`);
    return;
  }

  // Generate response using local NLP
  try {
    const reply = generateResponse(message, username, isTrusted);
    whisper(username, reply);
    memory.push({ role: 'assistant', content: reply });
    saveMemory();
  } catch (e) {
    console.error('Response generation error:', e.message);
    whisper(username, "I'm having trouble understanding that.");
  }
}

async function handleOwnerCommands(username, message) {
  if (!bot || username !== ownerName) return;
  
  const msgLower = message.toLowerCase();
  
  if (msgLower.includes('status') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    const pos = bot.entity?.position;
    if (pos) {
      whisper(username, `Health: ${bot.health?.toFixed(1) || 0}/20, Food: ${bot.food || 0}/20, Position: ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`);
    } else {
      whisper(username, "I'm not connected to the server right now.");
    }
  }
  
  if (msgLower.includes('trusted list') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    whisper(username, `Trusted players: ${trustedPlayers.join(', ')}`);
  }
  
  if (msgLower.includes('stop') && botNames.some(n => msgLower.includes(n.toLowerCase()))) {
    if (pathfinderLoaded && bot.pathfinder) {
      bot.pathfinder.setGoal(null);
      whisper(username, "Stopped all movement.");
    }
  }
}

// ----------------- START THE BOT -----------------
console.log('Starting Minecraft bot for Render web service...');
console.log('Environment variables loaded:');
console.log(`- BOT_HOST: ${process.env.BOT_HOST || 'localhost'}`);
console.log(`- BOT_PORT: ${process.env.BOT_PORT || '25565'}`);
console.log(`- BOT_USERNAME: ${process.env.BOT_USERNAME || 'TryChlorophyll'}`);
console.log(`- OWNER_NAME: ${process.env.OWNER_NAME || 'TryChloroform'}`);

// Initialize bot
initializeBot().catch(console.error);

// Keep alive interval to prevent Render from sleeping
setInterval(() => {
  console.log(`Bot status: ${bot ? (bot.entity ? 'connected' : 'disconnected') : 'not initialized'}`);
}, 5 * 60 * 1000); // Every 5 minutes

// Periodic memory save
setInterval(() => {
  saveMemory();
  saveTrusted();
  saveIgnored();
}, 10 * 60 * 1000); // Every 10 minutes