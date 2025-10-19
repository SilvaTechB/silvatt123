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

// ✅ Context Info
export const globalContextInfo = {
  forwardingScore: 999,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: "120363200367779016@newsletter",
    newsletterName: "◢◤ Silva Tech Nexus ◢◤",
    serverMessageId: 144
  }
};

// ✅ Configuration
const STATUS_SAVER_ENABLED = process.env.Status_Saver === 'true';

// ✅ Smart cache management
const messageCache = new Map();
const MAX_CACHE = 2000; // Balanced cache size
let cacheHits = 0;
let cacheMisses = 0;

// ✅ Log Helper
function logMessage(type, msg) {
  const colors = {
    INFO: chalk.cyan,
    ERROR: chalk.red,
    SUCCESS: chalk.green,
    EVENT: chalk.yellow,
    DEBUG: chalk.gray
  };
  const fn = colors[type] || ((t) => t);
  console.log(fn(`[${type}]`), msg);
}

// ✅ Optimized memory management (non-intrusive)
function optimizeMemory() {
  // Only clean if cache is getting large
  if (messageCache.size > MAX_CACHE * 0.8) {
    const keys = Array.from(messageCache.keys());
    // Remove oldest 20% of entries
    const removeCount = Math.floor(keys.length * 0.2);
    for (let i = 0; i < removeCount; i++) {
      messageCache.delete(keys[i]);
    }
    logMessage('DEBUG', `🧹 Cache optimized: ${messageCache.size} entries remaining`);
  }
}

// ✅ Session Setup (keep your working version)
async function setupSession() {
  const sessionsDir = path.join(__dirname, 'sessions');
  const sessionPath = path.join(sessionsDir, 'creds.json');
  
  if (fs.existsSync(sessionPath)) {
    logMessage('INFO', '✅ Session file already exists, skipping download.');
    return;
  }

  if (!process.env.SESSION_ID || !process.env.SESSION_ID.startsWith('Silva~')) {
    throw new Error('❌ Invalid or missing SESSION_ID. Must start with "Silva~"');
  }

  logMessage('INFO', '⬇ Downloading session from Mega.nz...');
  const megaCode = process.env.SESSION_ID.replace('Silva~', '');

  try {
    const mega = await import('megajs');
    const { File } = mega.default || mega;
    
    if (!File) {
      throw new Error('MegaJS File class not found');
    }

    const file = File.fromURL(`https://mega.nz/file/${megaCode}`);
    
    await new Promise((resolve, reject) => {
      file.download((err, data) => {
        if (err) {
          logMessage('ERROR', `❌ Mega download failed: ${err.message}`);
          return reject(new Error(`Mega download failed: ${err.message}`));
        }

        try {
          if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
          }
          fs.writeFileSync(sessionPath, data);
          logMessage('SUCCESS', '✅ Session downloaded and saved successfully.');
          resolve();
        } catch (writeError) {
          reject(new Error(`File write failed: ${writeError.message}`));
        }
      });
    });
  } catch (error) {
    logMessage('ERROR', `❌ Session setup failed: ${error.message}`);
    throw error;
  }
}

// ✅ Function to safely get contact name
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

// ✅ Efficient status processing - NO RATE LIMITING
function processStatusView(sock, msg) {
  if (msg.key.remoteJid !== "status@broadcast") return;
  
  // Only process if Status Saver is enabled
  if (STATUS_SAVER_ENABLED) {
    try {
      const jid = msg.key.participant || msg.participant || "unknown@s.whatsapp.net";
      const name = getContactName(sock, jid);

      // Log only occasionally to reduce spam but still show activity
      if (Math.random() < 0.3) { // 30% chance to log
        logMessage("INFO", `👀 Status viewed from ${name}`);
      }

      const inner =
        msg.message?.viewOnceMessageV2?.message ||
        msg.message?.viewOnceMessage?.message ||
        msg.message ||
        {};
      const msgType = Object.keys(inner)[0] || "";

      // Auto-react to show presence (optional)
      const emojis = ["❤️", "🔥", "💯", "👏"];
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      
      // Don't await this to avoid blocking
      sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: "status@broadcast",
            id: msg.key.id,
            participant: jid
          }
        }
      }).catch(() => {}); // Silent fail for reactions

    } catch (err) {
      // Silent fail for status processing errors
    }
  } else {
    // Minimal logging when status saver is disabled
    if (Math.random() < 0.1) { // 10% chance to log
      const jid = msg.key.participant || msg.participant || "unknown@s.whatsapp.net";
      const name = getContactName(sock, jid);
      logMessage("DEBUG", `👀 Status from ${name}`);
    }
  }
}

export async function silvaConnect() {
  try {
    await setupSession();
    logMessage('SUCCESS', '✅ Session setup completed');
  } catch (error) {
    logMessage('ERROR', `Session setup failed: ${error.message}`);
    logMessage('INFO', 'Falling back to QR code authentication...');
  }

  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    version,
    browser: ["Silva MD Pro", "Chrome", "4.0.0"],
    // Additional optimization for Heroku
    markOnlineOnConnect: false,
    syncFullHistory: false,
    linkPreviewImageThumbnailWidth: 64
  });

  // ---------- Smart cache management ----------
  const memoryOptimizer = setInterval(optimizeMemory, 300000); // Every 5 minutes

  // ---------- connection updates ----------
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (connection === "open") {
      logMessage("SUCCESS", "🟢 Connected to WhatsApp successfully!");
      
      if (STATUS_SAVER_ENABLED) {
        logMessage("INFO", "🔄 Auto Status Saver: ENABLED");
      } else {
        logMessage("INFO", "⏸️ Auto Status Saver: DISABLED");
      }

      try {
        const jid = sock.user.id.includes(":")
          ? `${sock.user.id.split(":")[0]}@s.whatsapp.net`
          : sock.user.id;

        await sock.sendMessage(jid, {
          text: `✅ *Silva MD Pro is now connected!*\n\nAutomation, anti-delete & plugin system active.\nStatus Saver: ${STATUS_SAVER_ENABLED ? 'ENABLED' : 'DISABLED'}`,
          contextInfo: globalContextInfo
        });
      } catch (e) {
        logMessage("ERROR", `Welcome message failed: ${e.message}`);
      }

      // Newsletter following
      const newsletters = [
        "120363276154401733@newsletter",
        "120363200367779016@newsletter",
        "120363199904258143@newsletter"
      ];
      
      for (const nid of newsletters) {
        try {
          if (typeof sock.newsletterFollow === "function") {
            await sock.newsletterFollow(nid);
            logMessage("SUCCESS", `✅ Followed newsletter ${nid}`);
          }
        } catch (err) {
          // Silent fail for newsletter follows
        }
      }
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === 401) {
        logMessage("ERROR", "🔴 Session invalid. Please update SESSION_ID.");
        try {
          fs.rmSync(path.join(__dirname, 'sessions'), { recursive: true, force: true });
          logMessage("INFO", "🗑️ Invalid session cleared.");
        } catch (e) {
          logMessage("ERROR", `Failed to clear session: ${e.message}`);
        }
      }
      logMessage("ERROR", "🔴 Disconnected. Reconnecting...");
      
      // Clean up optimizer
      clearInterval(memoryOptimizer);
      
      setTimeout(() => silvaConnect(), 5000);
    }

    if (qr && !sock.authState.creds.registered) {
      logMessage("INFO", "📱 QR Code generated - scan to authenticate");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ---------- load plugins ----------
  await loadPlugins();

  // ---------- Optimized messages.upsert - FULL FUNCTIONALITY ----------
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    try {
      if (!Array.isArray(messages) || messages.length === 0) return;

      for (const msg of messages) {
        if (!msg?.key) continue;

        // ✅ Process status views IMMEDIATELY (no delays)
        if (msg.key.remoteJid === "status@broadcast") {
          processStatusView(sock, msg);
          continue; // Skip command handling for status
        }

        // ✅ Cache all regular messages for anti-delete
        if (msg.message) {
          const cacheKey = `${msg.key.remoteJid}-${msg.key.id}`;
          messageCache.set(cacheKey, msg);
          
          // Simple cache management - remove oldest if needed
          if (messageCache.size > MAX_CACHE) {
            const firstKey = messageCache.keys().next().value;
            messageCache.delete(firstKey);
          }
        }

        // ✅ Handle commands/plugins for normal messages
        if (msg.message && msg.key.remoteJid !== "status@broadcast") {
          await handleMessage(sock, msg);
        }
      }
    } catch (err) {
      logMessage("ERROR", `Message handler: ${err.message}`);
    }
  });

  // ---------- messages.update: anti-delete recovery (FULL FUNCTIONALITY) ----------
  sock.ev.on("messages.update", async (updates) => {
    for (const { key, update } of updates) {
      try {
        // deleted message (message set to null)
        if (update?.message === null && !key.fromMe) {
          const remoteJid = key.remoteJid;
          const messageID = key.id;
          const cacheKey = `${remoteJid}-${messageID}`;
          const originalMsg = messageCache.get(cacheKey);

          // Remove from cache after recovery attempt
          messageCache.delete(cacheKey);

          if (!originalMsg?.message) {
            // couldn't find original — notify owner
            await sock.sendMessage(sock.user.id, {
              text: `🚨 A message was deleted in *${remoteJid}*, but it could not be recovered.`,
              contextInfo: globalContextInfo
            });
            continue;
          }

          const sender = key.participant || remoteJid;
          // notify owner
          await sock.sendMessage(sock.user.id, {
            text: `🚨 *Anti-Delete Triggered!*\n👤 *Sender:* ${sender}\n💬 *Chat:* ${remoteJid}\n📎 *Recovered message below ↓*`,
            contextInfo: globalContextInfo
          });

          // determine message type
          const msg = originalMsg.message;
          const mType = Object.keys(msg)[0];

          // text-like
          if (mType === "conversation" || mType === "extendedTextMessage") {
            const text =
              msg.conversation || msg.extendedTextMessage?.text || "[Text message]";
            await sock.sendMessage(sock.user.id, { text, contextInfo: globalContextInfo });
          }
          // media-like (image, video, audio, sticker, document)
          else if (
            [
              "imageMessage",
              "videoMessage",
              "audioMessage",
              "stickerMessage",
              "documentMessage"
            ].includes(mType)
          ) {
            try {
              const stream = await downloadContentFromMessage(
                msg[mType],
                mType.replace("Message", "")
              );
              let buffer = Buffer.from([]);
              for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

              const sendPayload = {
                contextInfo: globalContextInfo
              };

              const field = mType.replace("Message", "");
              sendPayload[field] = buffer;

              // include caption/mimetype if available
              if (msg[mType]?.caption) sendPayload.caption = msg[mType].caption;
              if (msg[mType]?.mimetype) sendPayload.mimetype = msg[mType].mimetype;
              if (mType === "documentMessage" && msg.documentMessage?.filename) {
                sendPayload.fileName = msg.documentMessage.filename;
              }

              await sock.sendMessage(sock.user.id, sendPayload);
            } catch (err) {
              logMessage("ERROR", `Reupload media failed: ${err.message}`);
              await sock.sendMessage(sock.user.id, {
                text: `⚠️ Recovered media could not be reuploaded: ${err.message}`,
                contextInfo: globalContextInfo
              });
            }
          } else {
            await sock.sendMessage(sock.user.id, {
              text: `📦 Recovered (unsupported type: ${mType}). Content preview:\n\`\`\`${JSON.stringify(
                msg,
                null,
                2
              )}\`\`\``,
              contextInfo: globalContextInfo
            });
          }

          logMessage("EVENT", `Recovered deleted message from ${sender}`);
        }
      } catch (err) {
        logMessage("ERROR", `Anti-delete handler: ${err.message}`);
      }
    }
  });

  // ---------- Cleanup on exit ----------
  process.on('SIGINT', () => {
    clearInterval(memoryOptimizer);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    clearInterval(memoryOptimizer);
    process.exit(0);
  });

  return sock;
}
