// lib/silvaConnect.js
import pkg from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import pino from "pino";
import chalk from "chalk";
import { loadPlugins, handleMessage } from "./handler.js";

const {
  makeWASocket,
  useMultiFileAuthState,
  downloadContentFromMessage,
  fetchLatestBaileysVersion
} = pkg;

const __dirname = path.resolve();

export const globalContextInfo = {
  forwardingScore: 999,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: "120363200367779016@newsletter",
    newsletterName: "◢◤ Silva Tech Nexus ◢◤",
    serverMessageId: 144
  }
};

const STATUS_SAVER_ENABLED = false;
const LOG_RATE_LIMIT_MS = 2500;
const MAX_CACHE = 800;
const MESSAGE_PROCESS_DELAY_MS = 75;
const MEMORY_WARN_THRESHOLD_MB = 400;
const MEMORY_CRITICAL_MB = 512;
const MAX_RECONNECTS = 8;

const lastLogAt = new Map();
function logMessage(type, msg) {
  const now = Date.now();
  const last = lastLogAt.get(type) || 0;
  if (now - last < LOG_RATE_LIMIT_MS) return;
  lastLogAt.set(type, now);

  const colors = {
    INFO: chalk.cyan,
    ERROR: chalk.red,
    SUCCESS: chalk.green,
    EVENT: chalk.yellow,
    DEBUG: chalk.gray,
    WARN: chalk.yellow
  };
  const fn = colors[type] || ((t) => t);
  console.log(fn(`[${type}]`), msg);
}

function safeGetUserJid(sock) {
  try {
    const id = sock?.user?.id || sock?.user?.wa || sock?.user;
    if (!id) return null;
    return id.includes(":") ? `${id.split(":")[0]}@s.whatsapp.net` : id;
  } catch {
    return null;
  }
}

async function tryDownloadSessionFromMega() {
  const sessionsDir = path.join(__dirname, "sessions");
  const sessionPath = path.join(sessionsDir, "creds.json");
  if (fs.existsSync(sessionPath)) {
    logMessage("INFO", "Session exists locally — skip download.");
    return true;
  }

  const sess = process.env.SESSION_ID;
  if (!sess || !sess.startsWith("Silva~")) {
    logMessage("DEBUG", "SESSION_ID invalid or missing — QR auth required.");
    return false;
  }

  const code = sess.replace("Silva~", "");
  logMessage("INFO", "⬇ Downloading session from Silva servers...");

  try {
    const megaMod = await import("megajs").catch(() => null);
    const mega = megaMod?.default || megaMod;
    if (!mega?.File) {
      logMessage("ERROR", "megajs unavailable — skipping session download.");
      return false;
    }

    const file = mega.File.fromURL(`https://mega.nz/file/${code}`);
    const data = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Mega timeout")), 25000);
      file.download((err, data) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(data);
      });
    });

    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(sessionPath, data);
    logMessage("SUCCESS", "✅ Session downloaded successfully.");
    return true;
  } catch (err) {
    logMessage("ERROR", `Session download failed: ${err.message}`);
    return false;
  }
}

export async function silvaConnect() {
  try {
    await tryDownloadSessionFromMega();
  } catch (e) {
    logMessage("WARN", `Session download attempt failed: ${e.message}`);
  }

  const sessionsDir = path.join(__dirname, "sessions");
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    version,
    browser: ["Silva MD Pro", "Chrome", "4.0.0"],
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 30_000
  });

  const messageCache = new Map();

  try {
    await loadPlugins();
  } catch (err) {
    logMessage("ERROR", `Plugin load failed: ${err.message}`);
  }

  let reconnectCount = 0;
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      reconnectCount = 0;
      logMessage("SUCCESS", "🟢 Connected to WhatsApp!");
      const jid = safeGetUserJid(sock);
      if (jid) {
        sock.sendMessage(jid, {
          text: `✅ *Silva MD Pro is connected*\nAnti-delete active. Plugins loaded.`,
          contextInfo: globalContextInfo
        }).catch(() => {});
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      logMessage("WARN", `Connection closed (${code || "unknown"})`);
      if (code === 401) {
        logMessage("ERROR", "Invalid session. Clearing credentials...");
        try {
          fs.rmSync(path.join(__dirname, "sessions"), { recursive: true, force: true });
        } catch {}
        process.exit(1);
      }

      reconnectCount++;
      if (reconnectCount > MAX_RECONNECTS) {
        logMessage("ERROR", "Max reconnects reached. Stopping process.");
        process.exit(1);
      }

      const delay = Math.min(5000 * (1.5 ** (reconnectCount - 1)), 60000);
      setTimeout(() => {
        silvaConnect().catch(err => logMessage("ERROR", `Reconnect failed: ${err.message}`));
      }, delay);
    }

    if (qr && !sock.authState?.creds?.registered)
      logMessage("INFO", "QR generated — scan to connect.");
  });

  sock.ev.on("creds.update", saveCreds);

  const messageQueue = [];
  let processing = false;

  async function processQueue() {
    if (processing) return;
    processing = true;

    while (messageQueue.length) {
      const msg = messageQueue.shift();
      try {
        if (msg.key?.remoteJid === "status@broadcast") continue;
        if (msg.message) await handleMessage(sock, msg);
      } catch (err) {
        logMessage("ERROR", `processQueue error: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, MESSAGE_PROCESS_DELAY_MS));
    }

    processing = false;
  }

  sock.ev.on("messages.upsert", ({ messages }) => {
    if (!Array.isArray(messages) || !messages.length) return;
    for (const m of messages) {
      if (!m?.key) continue;
      if (m.message) {
        const cacheKey = `${m.key.remoteJid}-${m.key.id}`;
        messageCache.set(cacheKey, m);
        if (messageCache.size > MAX_CACHE) {
          const toRemove = Math.floor(MAX_CACHE * 0.2);
          for (let i = 0; i < toRemove; i++) messageCache.delete(messageCache.keys().next().value);
        }
      }
      messageQueue.push(m);
    }
    processQueue().catch(e => logMessage("ERROR", `Queue error: ${e.message}`));
  });

  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      if (key.remoteJid === "status@broadcast") continue;
      if (update?.message === null && !key.fromMe) {
        const cacheKey = `${key.remoteJid}-${key.id}`;
        const original = messageCache.get(cacheKey);
        const owner = safeGetUserJid(sock);

        if (!original?.message || !owner) continue;
        sock.sendMessage(owner, {
          text: `🚨 *Anti-Delete* — Message recovered from ${key.participant || key.remoteJid}`,
          contextInfo: globalContextInfo
        }).catch(() => {});

        const msgObj = original.message;
        const mType = Object.keys(msgObj)[0];

        try {
          if (["conversation", "extendedTextMessage"].includes(mType)) {
            const text = msgObj.conversation || msgObj.extendedTextMessage?.text;
            await sock.sendMessage(owner, { text, contextInfo: globalContextInfo });
          } else if (["imageMessage", "videoMessage", "audioMessage", "stickerMessage", "documentMessage"].includes(mType)) {
            const stream = await downloadContentFromMessage(msgObj[mType], mType.replace("Message", ""));
            let buffer = Buffer.from([]);
            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
            const field = mType.replace("Message", "");
            const payload = { [field]: buffer, contextInfo: globalContextInfo };
            if (msgObj[mType]?.caption) payload.caption = msgObj[mType].caption;
            await sock.sendMessage(owner, payload);
          }
        } catch (err) {
          logMessage("DEBUG", `Recovery failed: ${err.message}`);
        }
      }
    }
  });

  setInterval(() => {
    const usedMB = process.memoryUsage().rss / 1024 / 1024;
    if (usedMB > MEMORY_WARN_THRESHOLD_MB) {
      logMessage("WARN", `Memory high: ${Math.round(usedMB)} MB — trimming cache.`);
      const keep = Math.max(16, Math.floor(MAX_CACHE * 0.2));
      while (messageCache.size > keep) messageCache.delete(messageCache.keys().next().value);
      if (global.gc) global.gc();
    }
    if (usedMB > MEMORY_CRITICAL_MB) {
      logMessage("ERROR", `Memory critical (${Math.round(usedMB)} MB) — restarting.`);
      process.exit(1);
    }
  }, 30_000);

  process.on("unhandledRejection", (r) => logMessage("ERROR", `UnhandledRejection: ${String(r)}`));
  process.on("uncaughtException", (e) => {
    logMessage("ERROR", `UncaughtException: ${e?.message}`);
    setTimeout(() => process.exit(1), 800);
  });

  return sock;
}
