const mineflayer = require('mineflayer');

const bot = mineflayer.createBot({
  host: 'pibblesmp.serv.cx', // The cracked server address
  port: 25566,               // Default port; change if needed
  username: 'TryChlorophyll', // Any name you want (must not be taken by another player)
  auth: 'offline'           // Important: disables online (Microsoft) auth
});

bot.on('spawn', () => {
  console.log('Bot connected');
  bot.chat('TESTING');
});

bot.on('error', err => console.error('Error:', err));
bot.on('end', () => console.log('Bot disconnected'));
