import mineflayer from 'mineflayer';
import { mineflayer as mineflayerViewer } from 'prismarine-viewer';
import autoeat from 'mineflayer-auto-eat';
import autoAuth from 'mineflayer-auto-auth';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const bot = mineflayer.createBot({
  host: process.env.SERVER_HOST || 'localhost',
  port: parseInt(process.env.SERVER_PORT) || 25565,
  username: process.env.BOT_USERNAME || 'MinecraftBot',
  password: process.env.BOT_PASSWORD, // Leave undefined for offline mode
  auth: process.env.BOT_PASSWORD ? 'microsoft' : 'offline',
  version: process.env.MC_VERSION || '1.20.1'
});

// Auto-auth plugin
if (process.env.AUTO_AUTH === 'true' && process.env.LOGIN_PASSWORD) {
  bot.loadPlugin(autoAuth);
  bot.once('spawn', () => {
    console.log('Auto-auth plugin initialized');
  });
}

// Auto-eat plugin
if (process.env.AUTO_EAT === 'true') {
  bot.loadPlugin(autoeat);
  bot.once('spawn', () => {
    bot.autoEat.options = {
      priority: 'foodPoints',
      startAt: 16,
      bannedFood: []
    };
    console.log('Auto-eat plugin initialized');
  });
}

// Web viewer settings
const viewerPort = process.env.PORT || 3000; // Use PORT for Render deployment

bot.once('spawn', () => {
  console.log('Bot spawned successfully!');

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
