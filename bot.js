// index.mjs
import dotenv from 'dotenv';
dotenv.config();

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import express from 'express';
import { createBot } from 'mineflayer';
import { loader as autoEatLoader } from 'mineflayer-auto-eat';
import { mineflayer as prismarineViewer } from 'prismarine-viewer';

const AutoAuth = require('mineflayer-auto-auth');

const {
  SERVER_HOST = 'localhost',
  SERVER_PORT = '25565',
  MC_VERSION,
  BOT_USERNAME = 'Bot',
  BOT_PASSWORD = '',
  AUTO_AUTH = 'true',
  LOGIN_PASSWORD = '',
  AUTO_EAT = 'true',
  AUTO_EAT_THRESHOLD = '14',
  BANNED_FOOD = 'rotten_flesh,spider_eye,poisonous_potato',
  ENABLE_VIEWER = 'true',
  AUTO_RECONNECT = 'true',
  PORT = '3000',
  TRUSTED_PLAYERS = ''
} = process.env;

const serverHost = SERVER_HOST;
const serverPort = parseInt(SERVER_PORT, 10) || 25565;
const webPort = parseInt(PORT, 10) || 3000;

const autoAuthEnabled = AUTO_AUTH === 'true';
const autoEatEnabled = AUTO_EAT === 'true';
const viewerEnabled = ENABLE_VIEWER === 'true';
const autoReconnectEnabled = AUTO_RECONNECT === 'true';
const autoEatThreshold = Number(AUTO_EAT_THRESHOLD) || 14;
const bannedFoodArray = BANNED_FOOD.split(',').map(s => s.trim()).filter(Boolean);
const trustedPlayers = TRUSTED_PLAYERS.split(',').map(s => s.trim()).filter(Boolean);

// helper to choose auth mode
function getAuthMode() {
  if (BOT_PASSWORD && BOT_PASSWORD.length > 0) return 'microsoft';
  return 'offline';
}

let botInstance = null;
let restarting = false;

function startExpressHealth() {
  const app = express();

  app.get('/', (req, res) => {
    res.send(`<html><body><h3>Mineflayer bot running</h3>
<p>Bot name: ${BOT_USERNAME}</p>
<p>Viewer enabled: ${viewerEnabled}</p>
</body></html>`);
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.listen(webPort, () => {
    console.log(`Express health server listening on port ${webPort}`);
  });
}

async function createMineflayerBot() {
  const createOptions = {
    host: serverHost,
    port: serverPort,
    username: BOT_USERNAME,
    version: MC_VERSION || undefined,
  };

  if (BOT_PASSWORD && BOT_PASSWORD.length > 0) {
    createOptions.password = BOT_PASSWORD;
    createOptions.auth = getAuthMode();
  } else {
    createOptions.auth = getAuthMode();
  }

  if (autoAuthEnabled) {
    createOptions.plugins = [AutoAuth];
    createOptions.AutoAuth = {
      password: LOGIN_PASSWORD,
      logging: false,
      ignoreRepeat: true
    };
  }

  console.log('Creating bot with options');
  console.log({ host: createOptions.host, port: createOptions.port, username: createOptions.username, auth: createOptions.auth, version: createOptions.version });

  const bot = createBot(createOptions);

  bot.once('spawn', async () => {
    console.log('Bot spawned', BOT_USERNAME);

    if (autoAuthEnabled) {
      bot.on('serverAuth', () => {
        console.log('Server authentication completed');
      });
    }

    if (autoEatEnabled) {
      try {
        bot.loadPlugin(autoEatLoader);
        const minHunger = Math.max(0, Math.min(20, autoEatThreshold));
        bot.autoEat.setOpts({
          minHunger,
          minHealth: 14,
          bannedFood: bannedFoodArray
        });
        bot.autoEat.enableAuto();
        console.log(`Auto eat enabled with threshold ${minHunger} and banned food ${bannedFoodArray.join(', ')}`);
      } catch (err) {
        console.error('Failed to load auto eat plugin', err);
      }
    }

    if (viewerEnabled) {
      try {
        prismarineViewer(bot, { port: webPort, firstPerson: true });
        console.log(`Prismarine viewer started on port ${webPort}`);
      } catch (err) {
        console.error('Failed to start prismarine viewer', err);
      }
    }

    setupTeleportAutoAccept(bot);
  });

  bot.on('kicked', (reason, loggedIn) => {
    console.warn('Kicked from server', reason?.toString?.() || reason);
  });

  bot.on('error', (err) => {
    console.error('Bot error', err && err.message ? err.message : err);
  });

  bot.on('end', () => {
    console.log('Bot disconnected end event');
    if (autoReconnectEnabled) {
      scheduleReconnect();
    }
  });

  botInstance = bot;
  return bot;
}

function scheduleReconnect() {
  if (restarting) return;
  restarting = true;
  const delayMs = 5000;
  console.log(`Scheduling reconnect in ${delayMs} ms`);
  setTimeout(async () => {
    try {
      console.log('Recreating bot now');
      await createMineflayerBot();
    } catch (err) {
      console.error('Reconnect attempt failed', err);
      restarting = false;
      setTimeout(scheduleReconnect, 10000);
    } finally {
      restarting = false;
    }
  }, delayMs);
}

function tryAcceptCommands(bot, playerName) {
  const acceptCommands = [
    '/tpaccept',
    `/tpaccept ${playerName}`,
    '/tpaaccept',
    `/tpaaccept ${playerName}`,
    '/tpacceptall',
    '/tpyes',
    `/tpyes ${playerName}`,
    `/tp accept ${playerName}`,
    `/tpa accept ${playerName}`
  ];

  let i = 0;
  const runNext = () => {
    if (i >= acceptCommands.length) return;
    const cmd = acceptCommands[i++];
    try {
      bot.chat(cmd);
      console.log(`Sent accept command: ${cmd}`);
    } catch (err) {
      console.warn('Failed to send command', cmd, err && err.message ? err.m
