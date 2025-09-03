const mineflayer = require('mineflayer');
const { mineflayer: mineflayerViewer } = require('prismarine-viewer');

// Load environment variables
require('dotenv').config();

const bot = mineflayer.createBot({
  host: process.env.SERVER_HOST || 'localhost',
  port: parseInt(process.env.SERVER_PORT) || 25565,
  username: process.env.BOT_USERNAME || 'MinecraftBot',
  password: process.env.BOT_PASSWORD, // Leave undefined for offline mode
  auth: process.env.BOT_PASSWORD ? 'microsoft' : 'offline',
  version: process.env.MC_VERSION || '1.21.7'
});

// Auto-auth plugin
let autoAuthEnabled = process.env.AUTO_AUTH === 'true';
let loginPassword = process.env.LOGIN_PASSWORD;

// Auto-eat settings
let autoEatEnabled = process.env.AUTO_EAT === 'true';
const HUNGER_THRESHOLD = 16; // Eat when hunger is below this level
const HEALTH_THRESHOLD = 15; // Eat when health is below this level

// Web viewer settings
const viewerPort = process.env.PORT || 3000; // Use PORT for Render deployment

bot.once('spawn', () => {
  console.log('Bot spawned successfully!');
  
  // Initialize web viewer
  if (process.env.ENABLE_VIEWER === 'true') {
    try {
      mineflayerViewer(bot, { 
        port: viewerPort,
        firstPerson: false
      });
      console.log(`Web viewer started on port ${viewerPort}`);
      console.log(`View at: http://localhost:${viewerPort} (or your Render URL)`);
    } catch (error) {
      console.error('Failed to start viewer:', error);
    }
  }
  
  console.log(`Logged in as ${bot.entity.username}`);
  console.log(`Bot position: ${bot.entity.position}`);
});

// Auto-auth functionality
bot.on('message', (message) => {
  const msg = message.toString().toLowerCase();
  
  if (autoAuthEnabled && loginPassword) {
    // Common login/register patterns
    if (msg.includes('/login') || msg.includes('login') || 
        msg.includes('/register') || msg.includes('register') ||
        msg.includes('password') || msg.includes('authenticate')) {
      
      setTimeout(() => {
        bot.chat(`/login ${loginPassword}`);
        console.log('Auto-auth: Attempted login');
      }, 1000);
      
      // Also try register in case it's a new account
      setTimeout(() => {
        bot.chat(`/register ${loginPassword} ${loginPassword}`);
        console.log('Auto-auth: Attempted register');
      }, 2000);
    }
  }
  
  console.log(`Chat: ${message}`);
});

// Auto-eat functionality
function autoEat() {
  if (!autoEatEnabled) return;
  
  const food = bot.inventory.items().find(item => {
    return item && item.name && (
      item.name.includes('bread') ||
      item.name.includes('apple') ||
      item.name.includes('carrot') ||
      item.name.includes('potato') ||
      item.name.includes('beef') ||
      item.name.includes('pork') ||
      item.name.includes('chicken') ||
      item.name.includes('mutton') ||
      item.name.includes('fish') ||
      item.name.includes('cookie') ||
      item.name.includes('melon') ||
      item.name.includes('berry')
    );
  });
  
  const needsFood = bot.food < HUNGER_THRESHOLD || bot.health < HEALTH_THRESHOLD;
  
  if (food && needsFood && !bot.pathfinder?.isMoving()) {
    bot.equip(food, 'hand').then(() => {
      bot.consume().then(() => {
        console.log(`Auto-eat: Consumed ${food.name}`);
      }).catch(err => {
        console.log('Auto-eat: Failed to consume food:', err.message);
      });
    }).catch(err => {
      console.log('Auto-eat: Failed to equip food:', err.message);
    });
  }
}

// Check for food every 5 seconds
setInterval(autoEat, 5000);

// Health and hunger monitoring
bot.on('health', () => {
  console.log(`Health: ${bot.health}/20, Food: ${bot.food}/20`);
  if (bot.health < 10) {
    console.log('Warning: Low health!');
  }
  if (bot.food < 10) {
    console.log('Warning: Low hunger!');
  }
});

// Error handling
bot.on('error', (err) => {
  console.error('Bot error:', err);
});

bot.on('end', () => {
  console.log('Bot disconnected');
  // Auto-reconnect after 5 seconds
  if (process.env.AUTO_RECONNECT === 'true') {
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      // You would need to recreate the bot here
    }, 5000);
  }
});

bot.on('kicked', (reason) => {
  console.log('Bot was kicked:', reason);
});

bot.on('death', () => {
  console.log('Bot died');
  bot.chat('I died! Respawning...');
});

// Simple commands
bot.on('chat', (username, message) => {
  if (username === bot.username) return;
  
  // Basic commands (you can expand this)
  if (message.startsWith('!pos')) {
    const pos = bot.entity.position;
    bot.chat(`I am at ${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}`);
  }
  
  if (message.startsWith('!health')) {
    bot.chat(`Health: ${bot.health}/20, Food: ${bot.food}/20`);
  }
  
  if (message.startsWith('!time')) {
    bot.chat(`Time of day: ${bot.time.timeOfDay} ticks`);
  }
});

// Keep the process alive for web services
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  bot.quit('Server shutting down');
  process.exit(0);
});

console.log('Starting Mineflayer bot...');
console.log(`Connecting to: ${process.env.SERVER_HOST || 'localhost'}:${process.env.SERVER_PORT || 25565}`);
console.log(`Username: ${process.env.BOT_USERNAME || 'MinecraftBot'}`);
console.log(`Auth type: ${process.env.BOT_PASSWORD ? 'Microsoft' : 'Offline/Cracked'}`);
console.log(`Auto-auth: ${process.env.AUTO_AUTH === 'true' ? 'enabled' : 'disabled'}`);
console.log(`Auto-eat: ${process.env.AUTO_EAT === 'true' ? 'enabled' : 'disabled'}`);
console.log(`Web viewer: ${process.env.ENABLE_VIEWER === 'true' ? 'enabled' : 'disabled'}`);