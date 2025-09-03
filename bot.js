import dotenv from 'dotenv';
dotenv.config();

import mineflayer from 'mineflayer';
import { loader as autoeat} from 'mineflayer-auto-eat';
import autoauth from 'mineflayer-auto-auth';
import { mineflayer as prismarineViewer } from 'prismarine-viewer';

const bot = mineflayer.createBot({
  host: process.env.MINECRAFT_HOST,
  port: parseInt(process.env.MINECRAFT_PORT) || 25565,
  username: process.env.MINECRAFT_USERNAME,
  version: process.env.MINECRAFT_VERSION || false,
  auth: process.env.MINECRAFT_AUTH || 'mojang' // optional, defaults to mojang
});

// Auto-auth config
bot.loadPlugin(autoeat);
bot.loadPlugin(autoauth);

bot.once('spawn', () => {
  console.log('Bot spawned!');

  // Auto-auth (usually for online-mode servers with plugins like AuthMe)
  if (process.env.MINECRAFT_PASSWORD) {
    bot.authWithPassword(process.env.MINECRAFT_PASSWORD);
  }

  // Auto-eat setup
  bot.autoEat.options = {
    priority: 'saturation',  // or 'foodPoints'
    startAt: 14,             // start eating below this food level
    bannedFood: []           // array of food names to not eat
  };
  bot.autoEat.enable();

  prismarineViewer(bot, { port: 3007, firstPerson: true });
  console.log('Viewer running on http://localhost:3007');
});

bot.on('error', err => console.log('Error:', err));
bot.on('end', () => console.log('Bot disconnected'));
