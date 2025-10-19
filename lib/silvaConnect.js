// lib/silvaConnect.js
import pkg from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import pino from "pino";
import { loadPlugins, handleMessage } from "./handler.js";

const {
  makeWASocket,
  useMultiFileAuthState,
  downloadContentFromMessage,
  fetchLatestBaileysVersion
} = pkg;

const __dirname = path.resolve();

// ✅ Context Info (used in forwarded or bot messages)
export const globalContextInfo = {
  forwardingScore: 999,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: "120363200367779016@newsletter",
    newsletterName: "◢◤ Silva Tech Nexus ◢◤",
    serverMessageId: 144
  }
};

// ✅ Status Saver Configuration
const STATUS_SAVER_ENABLED = process.env.Status_Saver === "true";

// ✅ Pino Logger (lightweight & fast)
const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard"
          }
        }
});

// ✅ Fixed Session Setup from Mega.nz
async function setupSession() {
  const sessionsDir = path.join(__dirname, "sessions");
  const sessionPath = path.join(sessionsDir, "creds.json");

  if (fs.existsSync(sessionPath)) {
    logger.info("✅ Session file already exists, skipping download.");
    return;
  }

  if (!process.env.SESSION_ID || !process.env.SESSION_ID.startsWith("Silva~")) {
    throw new Error("❌ Invalid or missing SESSION_ID. Must start with 'Silva~'");
  }

  logger.info("⬇ Downloading session from Mega.nz...");
  const megaCode = process.env.SESSION_ID.replace("Silva~", "");

  try {
    const mega = await import("megajs");
    const { File } = mega.default || mega;

    if (!File) throw new Error("MegaJS File class not found in imported module");

    const file = File.fromURL(`https://mega.nz/file/${megaCode}`);

    await new Promise((resolve, reject) => {
      file.download((err, data) => {
        if (err) {
          logger.error(`❌ Mega download failed: ${err.message}`);
          return reject(err);
        }

        try {
          if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
          fs.writeFileSync(sessionPath, data);
          logger.info("✅ Session downloaded and saved successfully.");
          resolve();
        } catch (writeErr) {
          logger.error(`❌ Failed to save session: ${writeErr.message}`);
          reject(writeErr);
        }
      });
    });
  } catch (err) {
    logger.error(`❌ Session setup failed: ${err.message}`);
    throw err;
  }
}

// ✅ Helper: Get contact name safely
function getContactName(sock, jid) {
  const contact = sock?.contacts?.[jid] || {};
  return (
    contact.notify ||
    contact.name ||
    contact.pushname ||
    jid?.split("@")[0] ||
    "Unknown"
  );
}

// ✅ Save media (status)
async function saveMediaToDisk(messageObj, msgType, caption) {
  try {
    const stream = await downloadContentFromMessage(
      messageObj[msgType],
      msgType.replace("Message", "")
    );
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

    const statusDir = path.join(__dirname, "status_saver");
    if (!fs.existsSync(statusDir)) fs.mkdirSync(statusDir, { recursive: true });

    const extMap = { imageMessage: "jpg", videoMessage: "mp4", audioMessage: "ogg" };
    const ext = extMap[msgType] || "bin";
    const filename = path.join(statusDir, `${Date.now()}.${ext}`);
    fs.writeFileSync(filename, buffer);
    logger.info(`💾 Saved status ${msgType} -> ${filename}`);
    return filename;
  } catch (err) {
    logger.error(`saveMediaToDisk failed: ${err.message}`);
    return null;
  }
}

export async function silvaConnect() {
  try {
    await setupSession();
    logger.info("✅ Session setup completed");
  } catch (err) {
    logger.error(`Session setup failed: ${err.message}`);
    logger.warn("Falling back to QR code authentication...");
  }

  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    version,
    browser: ["Silva MD Pro", "Chrome", "4.0.0"]
  });

  // ✅ Optimized message cache
  const messageCache = new Map();
  const MAX_CACHE = 1000;

  // ---------- Connection Handling ----------
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      logger.info("🟢 Connected to WhatsApp successfully!");

      if (STATUS_SAVER_ENABLED) logger.info("🔄 Auto Status Saver: ENABLED");
      else logger.info("⏸️ Auto Status Saver: DISABLED");

      try {
        const jid = sock.user.id.includes(":")
          ? `${sock.user.id.split(":")[0]}@s.whatsapp.net`
          : sock.user.id;

        await sock.sendMessage(jid, {
          text: `✅ *Silva MD Pro Connected!*\nStatus Saver: ${STATUS_SAVER_ENABLED ? "ENABLED" : "DISABLED"}`,
          contextInfo: globalContextInfo
        });
      } catch (e) {
        logger.error(`Welcome message failed: ${e.message}`);
      }

      const newsletters = [
        "120363276154401733@newsletter",
        "120363200367779016@newsletter",
        "120363199904258143@newsletter"
      ];

      for (const nid of newsletters) {
        try {
          if (typeof sock.newsletterFollow === "function") {
            await sock.newsletterFollow(nid);
            logger.info(`✅ Followed newsletter ${nid}`);
          }
        } catch (err) {
          logger.error(`Newsletter follow failed: ${err.message}`);
        }
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === 401) {
        logger.error("🔴 Session invalid. Please update SESSION_ID.");
        try {
          fs.rmSync(path.join(__dirname, "sessions"), { recursive: true, force: true });
          logger.warn("🗑️ Invalid session cleared.");
        } catch (e) {
          logger.error(`Failed to clear session: ${e.message}`);
        }
      }
      logger.error("🔴 Disconnected. Reconnecting...");
      setTimeout(() => silvaConnect(), 5000);
    }

    if (qr && !sock.authState.creds.registered) {
      logger.info("📱 QR Code generated - scan to authenticate");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ---------- Load Plugins ----------
  await loadPlugins();

  // ---------- Handle Messages ----------
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      if (!Array.isArray(messages) || !messages.length) return;

      for (const msg of messages) {
        if (!msg?.key) continue;

        // Cache management
        if (msg.message) {
          const cacheKey = `${msg.key.remoteJid}-${msg.key.id}`;
          messageCache.set(cacheKey, msg);

          if (messageCache.size > MAX_CACHE) {
            const keys = Array.from(messageCache.keys()).slice(0, messageCache.size - MAX_CACHE);
            for (const k of keys) messageCache.delete(k);
          }
        }

        // Handle status@broadcast separately
        if (msg.key.remoteJid === "status@broadcast") {
          if (!STATUS_SAVER_ENABLED) {
            if (Math.random() < 0.02)
              logger.debug("👀 Status ignored (Status Saver disabled)");
            continue;
          }

          try {
            const jid = msg.key.participant || msg.participant || "unknown@s.whatsapp.net";
            const name = getContactName(sock, jid);
            logger.info(`👀 Status viewed from ${name} (${jid})`);

            const inner =
              msg.message?.viewOnceMessageV2?.message ||
              msg.message?.viewOnceMessage?.message ||
              msg.message || {};
            const msgType = Object.keys(inner)[0] || "";

            const emojis = ["❤️", "🔥", "💯", "👏"];
            const emoji = emojis[Math.floor(Math.random() * emojis.length)];
            await sock.sendMessage(jid, {
              react: { text: emoji, key: { remoteJid: "status@broadcast", id: msg.key.id, participant: jid } }
            });

            if (["imageMessage", "videoMessage", "audioMessage"].includes(msgType)) {
              const caption = `💾 *Saved Status From:* ${name}`;
              await saveMediaToDisk(inner, msgType, caption);
            }
          } catch (err) {
            logger.error(`Status handler error: ${err.message}`);
          }
          continue;
        }

        // Normal message command handler
        if (msg.message) await handleMessage(sock, msg);
      }
    } catch (err) {
      logger.error(`messages.upsert crashed: ${err.message}`);
    }
  });

  // ---------- messages.update: anti-delete ----------
  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      try {
        if (update?.message === null && !key.fromMe) {
          const remoteJid = key.remoteJid;
          const cacheKey = `${remoteJid}-${key.id}`;
          const originalMsg = messageCache.get(cacheKey);
          if (!originalMsg?.message) continue;

          const sender = key.participant || remoteJid;
          const msg = originalMsg.message;
          const mType = Object.keys(msg)[0];
          const text = msg.conversation || msg.extendedTextMessage?.text || "";

          await sock.sendMessage(sock.user.id, {
            text: `🚨 *Anti-Delete Triggered!*\n👤 ${sender}\n💬 ${remoteJid}\n📎 ${text || "[Recovered media]"}`,
            contextInfo: globalContextInfo
          });

          logger.info(`Recovered deleted message from ${sender}`);
        }
      } catch (err) {
        logger.error(`Anti-delete handler crashed: ${err.message}`);
      }
    }
  });

  // Ensure status saver dir exists
  if (STATUS_SAVER_ENABLED) {
    const statusDir = path.join(__dirname, "status_saver");
    if (!fs.existsSync(statusDir)) fs.mkdirSync(statusDir, { recursive: true });
  }

  return sock;
}
