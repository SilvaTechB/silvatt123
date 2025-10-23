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
const STATUS_SAVER_ENABLED = process.env.Status_Saver === 'true';

// ✅ Enhanced Log Helper with rate limiting
const logLimiter = new Map();
const LOG_INTERVAL = 5000; // 5 seconds between same-type logs

function logMessage(type, msg) {
  const now = Date.now();
  const lastLog = logLimiter.get(type);
  
  // Rate limit same-type logs to avoid spam
  if (lastLog && (now - lastLog) < LOG_INTERVAL) {
    return;
  }
  
  logLimiter.set(type, now);
  
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

// ✅ Fixed Session Setup from Mega.nz
async function setupSession() {
  const sessionsDir = path.join(__dirname, 'sessions');
  const sessionPath = path.join(sessionsDir, 'creds.json');
  
  // Check if session already exists
  if (fs.existsSync(sessionPath)) {
    logMessage('INFO', '✅ Session file exists');
    return;
  }

  // Validate SESSION_ID
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
          logMessage('SUCCESS', '✅ Session downloaded successfully.');
          resolve();
        } catch (writeError) {
          logMessage('ERROR', `❌ Failed to save session: ${writeError.message}`);
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

// ✅ Helper: save media from a message object to disk
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

    const extMap = { 
      imageMessage: "jpg", 
      videoMessage: "mp4", 
      audioMessage: "ogg" 
    };
    const ext = extMap[msgType] || "bin";
    const filename = path.join(statusDir, `${Date.now()}.${ext}`);
    fs.writeFileSync(filename, buffer);
    logMessage("SUCCESS", `💾 Saved status ${msgType}`);
    return filename;
  } catch (err) {
    logMessage("ERROR", `saveMediaToDisk failed: ${err.message}`);
    return null;
  }
}

// ✅ Connection state management
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY = 5000;

export async function silvaConnect() {
  if (isConnecting) {
    logMessage('WARN', 'Connection already in progress, skipping...');
    return;
  }

  isConnecting = true;
  
  try {
    // ✅ Setup session first
    await setupSession();
    logMessage('SUCCESS', '✅ Session setup completed');
  } catch (error) {
    logMessage('ERROR', `Session setup failed: ${error.message}`);
    logMessage('INFO', 'Falling back to QR code authentication...');
  }

  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  // ✅ Enhanced socket configuration for stability
  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
    version,
    browser: ["Silva MD Pro", "Chrome", "4.0.0"],
    // ✅ Connection stability options
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    emitOwnEvents: true,
    defaultQueryTimeoutMs: 60000,
    // ✅ Reduce connection overhead
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    maxRetries: 3,
    // ✅ Optimize message processing
    msgRetryCounterCache: new Map(),
    getMessage: async () => ({}) // Minimal message fetching
  });

  // ---------- local in-memory cache for anti-delete ----------
  const messageCache = new Map();
  const MAX_CACHE = 5000;

  // ---------- connection updates with improved reconnection logic ----------
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (connection === "open") {
      logMessage("SUCCESS", "🟢 Connected to WhatsApp successfully!");
      reconnectAttempts = 0; // Reset on successful connection
      isConnecting = false;
      
      // Log status saver status
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
        logMessage("DEBUG", `Welcome message failed: ${e.message}`);
      }

      // follow newsletters if available
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
          logMessage("DEBUG", `Newsletter follow failed: ${err.message}`);
        }
      }
    }

    if (connection === "close") {
      isConnecting = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || 'Unknown error';
      
      if (statusCode === 401) { // Session invalid
        logMessage("ERROR", "🔴 Session invalid. Please update SESSION_ID.");
        try {
          fs.rmSync(path.join(__dirname, 'sessions'), { recursive: true, force: true });
          logMessage("INFO", "🗑️ Invalid session cleared.");
        } catch (e) {
          logMessage("ERROR", `Failed to clear session: ${e.message}`);
        }
      }
      
      reconnectAttempts++;
      
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logMessage("ERROR", `🔴 Max reconnection attempts reached. Please check your connection.`);
        return;
      }
      
      const delay = RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1); // Exponential backoff
      logMessage("WARN", `🔴 Disconnected (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}). Reconnecting in ${delay/1000}s...`);
      
      setTimeout(() => {
        if (!isConnecting) {
          silvaConnect();
        }
      }, delay);
    }

    // Show QR code only if session doesn't exist and QR is available
    if (qr && !sock.authState.creds.registered) {
      logMessage("INFO", "📱 QR Code generated - scan to authenticate");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ---------- load plugins ----------
  await loadPlugins();

  // ✅ Optimized message processing with better error handling
  let processingMessages = false;
  
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Prevent overlapping message processing
    if (processingMessages) {
      return;
    }
    
    processingMessages = true;
    
    try {
      // bail if no messages
      if (!Array.isArray(messages) || messages.length === 0) return;

      for (const msg of messages) {
        if (!msg?.key) continue;

        // cache only non-empty messages (so recovery is possible)
        if (msg.message) {
          const cacheKey = `${msg.key.remoteJid}-${msg.key.id}`;
          messageCache.set(cacheKey, msg);
          // keep cache size bounded
          if (messageCache.size > MAX_CACHE) {
            const firstKey = messageCache.keys().next().value;
            messageCache.delete(firstKey);
          }
        }

        // status handling separately
        if (msg.key.remoteJid === "status@broadcast") {
          // Only process status if Status Saver is enabled
          if (STATUS_SAVER_ENABLED) {
            try {
              const jid = msg.key.participant || msg.participant || "unknown@s.whatsapp.net";
              const name = getContactName(sock, jid);

              logMessage("DEBUG", `👀 Status from ${name}`);

              const inner =
                msg.message?.viewOnceMessageV2?.message ||
                msg.message?.viewOnceMessage?.message ||
                msg.message ||
                {};
              const msgType = Object.keys(inner)[0] || "";

              // auto-react
              const emojis = ["❤️", "🔥", "💯", "👏"];
              const emoji = emojis[Math.floor(Math.random() * emojis.length)];
              
              try {
                await sock.sendMessage(jid, {
                  react: {
                    text: emoji,
                    key: {
                      remoteJid: "status@broadcast",
                      id: msg.key.id,
                      participant: jid
                    }
                  }
                });
              } catch (reactError) {
                logMessage("DEBUG", `React failed: ${reactError.message}`);
              }

              // save media
              if (["imageMessage", "videoMessage", "audioMessage"].includes(msgType)) {
                await saveMediaToDisk(inner, msgType, `💾 *Saved Status From:* ${name}`);
              }
            } catch (err) {
              logMessage("DEBUG", `Status handler error: ${err.message}`);
            }
          }
          continue; // skip command handling for status
        }

        // handle commands/plugins for normal messages
        if (msg.message) {
          try {
            await handleMessage(sock, msg);
          } catch (handleError) {
            logMessage("ERROR", `Message handler error: ${handleError.message}`);
          }
        }
      }
    } catch (err) {
      logMessage("ERROR", `messages.upsert handler crashed: ${err.message}`);
    } finally {
      processingMessages = false;
    }
  });

  // ✅ Optimized anti-delete with rate limiting
  let lastDeleteProcess = 0;
  const DELETE_PROCESS_INTERVAL = 1000;
  
  sock.ev.on("messages.update", async (updates) => {
    const now = Date.now();
    if (now - lastDeleteProcess < DELETE_PROCESS_INTERVAL) {
      return; // Skip if we're processing too fast
    }
    lastDeleteProcess = now;
    
    for (const { key, update } of updates) {
      try {
        // deleted message (message set to null)
        if (update?.message === null && !key.fromMe) {
          const remoteJid = key.remoteJid;
          const messageID = key.id;
          const cacheKey = `${remoteJid}-${messageID}`;
          const originalMsg = messageCache.get(cacheKey);

          if (!originalMsg?.message) {
            // couldn't find original — notify owner
            try {
              await sock.sendMessage(sock.user.id, {
                text: `🚨 A message was deleted in *${remoteJid}*, but it could not be recovered.`,
                contextInfo: globalContextInfo
              });
            } catch (sendError) {
              logMessage("DEBUG", `Failed to send recovery notification: ${sendError.message}`);
            }
            continue;
          }

          const sender = key.participant || remoteJid;
          // notify owner
          try {
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

                if (msg[mType]?.caption) sendPayload.caption = msg[mType].caption;
                if (msg[mType]?.mimetype) sendPayload.mimetype = msg[mType].mimetype;
                if (mType === "documentMessage" && msg.documentMessage?.filename) {
                  sendPayload.fileName = msg.documentMessage.filename;
                }

                await sock.sendMessage(sock.user.id, sendPayload);
              } catch (mediaError) {
                logMessage("ERROR", `Reupload media failed: ${mediaError.message}`);
                await sock.sendMessage(sock.user.id, {
                  text: `⚠️ Recovered media could not be reuploaded: ${mediaError.message}`,
                  contextInfo: globalContextInfo
                });
              }
            } else {
              await sock.sendMessage(sock.user.id, {
                text: `📦 Recovered (unsupported type: ${mType}).`,
                contextInfo: globalContextInfo
              });
            }
          } catch (sendError) {
            logMessage("ERROR", `Failed to send recovered message: ${sendError.message}`);
          }

          logMessage("EVENT", `Recovered deleted message from ${sender}`);
        }
      } catch (err) {
        logMessage("ERROR", `Anti-delete handler error: ${err.message}`);
      }
    }
  });

  // ---------- ensure status_saver dir exists (only if status saver is enabled) ----------
  if (STATUS_SAVER_ENABLED) {
    const statusDir = path.join(__dirname, "status_saver");
    if (!fs.existsSync(statusDir)) fs.mkdirSync(statusDir, { recursive: true });
  }

  return sock;
}

// ✅ Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  logMessage('ERROR', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logMessage('ERROR', `Uncaught Exception: ${error.message}`);
  logMessage('ERROR', error.stack);
});
