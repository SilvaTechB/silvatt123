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

// ✅ Status Saver Configuration
const STATUS_SAVER_ENABLED = process.env.Status_Saver === 'true';

// ✅ Enhanced Log Helper with improved rate limiting
const logLimiter = new Map();
const LOG_INTERVAL = 3000;

function logMessage(type, msg) {
  const now = Date.now();
  const lastLog = logLimiter.get(type);
  
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

// ✅ Improved Session Setup with better error handling
async function setupSession() {
  const sessionsDir = path.join(__dirname, 'sessions');
  const sessionPath = path.join(sessionsDir, 'creds.json');
  
  if (fs.existsSync(sessionPath)) {
    logMessage('INFO', '✅ Session file exists');
    return true;
  }

  if (!process.env.SESSION_ID || !process.env.SESSION_ID.startsWith('Silva~')) {
    logMessage('WARN', '❌ Invalid or missing SESSION_ID. Using QR code authentication instead.');
    return false;
  }

  logMessage('INFO', '⬇ Downloading session from silva servers💖...');
  const megaCode = process.env.SESSION_ID.replace('Silva~', '');

  try {
    // Dynamic import for better error handling
    const megaModule = await import('megajs');
    const mega = megaModule.default || megaModule;
    const { File } = mega;
    
    if (!File) {
      throw new Error('MegaJS File class not found');
    }

    const file = File.fromURL(`https://mega.nz/file/${megaCode}`);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Mega download timeout'));
      }, 30000); // 30 second timeout

      file.download((err, data) => {
        clearTimeout(timeout);
        
        if (err) {
          logMessage('ERROR', `❌ Mega download failed: ${err.message}`);
          return resolve(false); // Don't crash, just return false
        }

        try {
          if (!fs.existsSync(sessionsDir)) {
            fs.mkdirSync(sessionsDir, { recursive: true });
          }

          fs.writeFileSync(sessionPath, data);
          logMessage('SUCCESS', '✅ Session downloaded successfully💖.');
          resolve(true);
        } catch (writeError) {
          logMessage('ERROR', `❌ Failed to save session: ${writeError.message}`);
          resolve(false);
        }
      });
    });
  } catch (error) {
    logMessage('ERROR', `❌ Session setup failed: ${error.message}`);
    return false;
  }
}

// ✅ Function to safely get contact name
function getContactName(sock, jid) {
  try {
    const contact = sock?.contacts?.[jid] || {};
    return (
      contact.notify ||
      contact.name ||
      contact.pushname ||
      jid?.split("@")[0] ||
      "Unknown"
    );
  } catch (error) {
    return jid?.split("@")[0] || "Unknown";
  }
}

// ✅ Improved media download with timeout and better error handling
async function saveMediaToDisk(messageObj, msgType, caption) {
  try {
    const stream = await downloadContentFromMessage(
      messageObj[msgType],
      msgType.replace("Message", "")
    );
    
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
      // Prevent memory issues with large files
      if (buffer.length > 50 * 1024 * 1024) { // 50MB limit
        throw new Error('File too large');
      }
    }

    const statusDir = path.join(__dirname, "status_saver");
    if (!fs.existsSync(statusDir)) {
      fs.mkdirSync(statusDir, { recursive: true });
    }

    const extMap = { 
      imageMessage: "jpg", 
      videoMessage: "mp4", 
      audioMessage: "ogg" 
    };
    const ext = extMap[msgType] || "bin";
    const filename = path.join(statusDir, `${Date.now()}.${ext}`);
    fs.writeFileSync(filename, buffer);
    logMessage("DEBUG", `💾 Saved status ${msgType}`);
    return filename;
  } catch (err) {
    logMessage("ERROR", `saveMediaToDisk failed: ${err.message}`);
    return null;
  }
}

// ✅ Enhanced connection state management
let isConnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000;
let currentSocket = null;

// ✅ Cleanup function to prevent memory leaks
function cleanupSocket(sock) {
  if (sock && typeof sock.end === 'function') {
    try {
      sock.end();
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

export async function silvaConnect() {
  if (isConnecting) {
    logMessage('WARN', 'Connection already in progress, skipping...');
    return;
  }

  isConnecting = true;
  
  try {
    // Cleanup previous socket if exists
    if (currentSocket) {
      cleanupSocket(currentSocket);
      currentSocket = null;
    }

    // ✅ Setup session with fallback
    const sessionResult = await setupSession();
    if (!sessionResult) {
      logMessage('INFO', 'Proceeding with QR code authentication...');
    }

    const { state, saveCreds } = await useMultiFileAuthState("./sessions");
    const { version } = await fetchLatestBaileysVersion();

    // ✅ Enhanced socket configuration for better stability
    const sock = makeWASocket({
      logger: pino({ level: "silent" }),
      printQRInTerminal: true,
      auth: state,
      version,
      browser: ["Silva MD Pro", "Chrome", "4.0.0"],
      // ✅ Improved connection stability
      markOnlineOnConnect: false, // Set to false to reduce reconnection issues
      generateHighQualityLinkPreview: false, // Reduce processing load
      emitOwnEvents: false, // Reduce event duplication
      defaultQueryTimeoutMs: 30000,
      // ✅ Connection optimization
      keepAliveIntervalMs: 20000,
      connectTimeoutMs: 30000,
      maxRetries: 2,
      // ✅ Memory optimization
      msgRetryCounterCache: new Map(),
      getMessage: async () => ({})
    });

    currentSocket = sock;

    // ---------- local in-memory cache for anti-delete ----------
    const messageCache = new Map();
    const MAX_CACHE = 1000; // Reduced to prevent memory issues

    // ✅ Improved connection updates with better error handling
    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;
        
        if (connection === "open") {
          logMessage("SUCCESS", "🟢 Connected to WhatsApp successfully!");
          reconnectAttempts = 0;
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

          // Follow newsletters with error handling
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
          
          logMessage("WARN", `Connection closed: ${errorMessage} (status: ${statusCode})`);
          
          if (statusCode === 401) {
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
            logMessage("ERROR", `🔴 Max reconnection attempts reached. Restarting process...`);
            process.exit(1); // Let process manager handle restart
            return;
          }
          
          const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 60000);
          logMessage("WARN", `🔴 Disconnected (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}). Reconnecting in ${delay/1000}s...`);
          
          setTimeout(() => {
            if (!isConnecting) {
              silvaConnect().catch(err => {
                logMessage("ERROR", `Reconnection failed: ${err.message}`);
              });
            }
          }, delay);
        }

        if (qr && !sock.authState.creds.registered) {
          logMessage("INFO", "📱 QR Code generated - scan to authenticate");
        }
      } catch (error) {
        logMessage("ERROR", `Connection update error: ${error.message}`);
        isConnecting = false;
      }
    });

    sock.ev.on("creds.update", saveCreds);

    // ✅ Load plugins with error handling
    try {
      await loadPlugins();
      logMessage("SUCCESS", "✅ Plugins loaded successfully");
    } catch (pluginError) {
      logMessage("ERROR", `Plugin loading failed: ${pluginError.message}`);
    }

    // ✅ Improved message processing with queue-like behavior
    let isProcessing = false;
    const messageQueue = [];
    
    async function processMessageQueue() {
      if (isProcessing || messageQueue.length === 0) return;
      
      isProcessing = true;
      const msg = messageQueue.shift();
      
      try {
        if (msg.key.remoteJid === "status@broadcast") {
          if (STATUS_SAVER_ENABLED) {
            await handleStatusMessage(sock, msg);
          }
        } else if (msg.message) {
          await handleMessage(sock, msg);
        }
      } catch (error) {
        logMessage("ERROR", `Message processing error: ${error.message}`);
      } finally {
        isProcessing = false;
        // Process next message after a short delay
        setTimeout(processMessageQueue, 100);
      }
    }

    // ✅ Separate status message handler
    async function handleStatusMessage(sock, msg) {
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

        // Auto-react with timeout
        try {
          await Promise.race([
            sock.sendMessage(jid, {
              react: {
                text: "❤️",
                key: {
                  remoteJid: "status@broadcast",
                  id: msg.key.id,
                  participant: jid
                }
              }
            }),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('React timeout')), 5000)
            )
          ]);
        } catch (reactError) {
          logMessage("DEBUG", `React failed: ${reactError.message}`);
        }

        // Save media if applicable
        if (["imageMessage", "videoMessage", "audioMessage"].includes(msgType)) {
          await saveMediaToDisk(inner, msgType, `💾 *Saved Status From:* ${name}`);
        }
      } catch (err) {
        logMessage("ERROR", `Status handler error: ${err.message}`);
      }
    }

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (!Array.isArray(messages) || messages.length === 0) return;

      // Add messages to queue instead of processing immediately
      messages.forEach(msg => {
        if (msg?.key) {
          messageQueue.push(msg);
          
          // Cache message for anti-delete
          if (msg.message) {
            const cacheKey = `${msg.key.remoteJid}-${msg.key.id}`;
            messageCache.set(cacheKey, msg);
            if (messageCache.size > MAX_CACHE) {
              const firstKey = messageCache.keys().next().value;
              messageCache.delete(firstKey);
            }
          }
        }
      });
      
      // Start processing if not already
      processMessageQueue();
    });

    // ✅ Improved anti-delete with better error handling
    let lastDeleteProcess = 0;
    const DELETE_PROCESS_INTERVAL = 2000;
    
    sock.ev.on("messages.update", async (updates) => {
      const now = Date.now();
      if (now - lastDeleteProcess < DELETE_PROCESS_INTERVAL) {
        return;
      }
      lastDeleteProcess = now;
      
      for (const { key, update } of updates) {
        try {
          if (update?.message === null && !key.fromMe) {
            await handleDeletedMessage(sock, key, messageCache);
          }
        } catch (err) {
          logMessage("ERROR", `Anti-delete handler error: ${err.message}`);
        }
      }
    });

    // ✅ Separate deleted message handler
    async function handleDeletedMessage(sock, key, messageCache) {
      const remoteJid = key.remoteJid;
      const messageID = key.id;
      const cacheKey = `${remoteJid}-${messageID}`;
      const originalMsg = messageCache.get(cacheKey);

      if (!originalMsg?.message) {
        try {
          await sock.sendMessage(sock.user.id, {
            text: `🚨 A message was deleted in *${remoteJid}*, but it could not be recovered.`,
            contextInfo: globalContextInfo
          });
        } catch (sendError) {
          logMessage("DEBUG", `Failed to send recovery notification: ${sendError.message}`);
        }
        return;
      }

      const sender = key.participant || remoteJid;
      
      try {
        await sock.sendMessage(sock.user.id, {
          text: `🚨 *Anti-Delete Triggered!*\n👤 *Sender:* ${sender}\n💬 *Chat:* ${remoteJid}\n📎 *Recovered message below ↓*`,
          contextInfo: globalContextInfo
        });

        const msg = originalMsg.message;
        const mType = Object.keys(msg)[0];

        if (mType === "conversation" || mType === "extendedTextMessage") {
          const text = msg.conversation || msg.extendedTextMessage?.text || "[Text message]";
          await sock.sendMessage(sock.user.id, { text, contextInfo: globalContextInfo });
        } else if ([
          "imageMessage",
          "videoMessage",
          "audioMessage",
          "stickerMessage",
          "documentMessage"
        ].includes(mType)) {
          await handleMediaRecovery(sock, msg, mType);
        } else {
          await sock.sendMessage(sock.user.id, {
            text: `📦 Recovered (unsupported type: ${mType}).`,
            contextInfo: globalContextInfo
          });
        }
        
        logMessage("EVENT", `Recovered deleted message from ${sender}`);
      } catch (sendError) {
        logMessage("ERROR", `Failed to send recovered message: ${sendError.message}`);
      }
    }

    // ✅ Separate media recovery handler
    async function handleMediaRecovery(sock, msg, mType) {
      try {
        const stream = await downloadContentFromMessage(
          msg[mType],
          mType.replace("Message", "")
        );
        
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
          buffer = Buffer.concat([buffer, chunk]);
        }

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
    }

    // ✅ Ensure status_saver dir exists only if enabled
    if (STATUS_SAVER_ENABLED) {
      const statusDir = path.join(__dirname, "status_saver");
      if (!fs.existsSync(statusDir)) {
        fs.mkdirSync(statusDir, { recursive: true });
      }
    }

    return sock;

  } catch (error) {
    isConnecting = false;
    logMessage("ERROR", `Connection setup failed: ${error.message}`);
    
    // Attempt reconnection after delay
    reconnectAttempts++;
    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 60000);
      logMessage("WARN", `Retrying connection in ${delay/1000}s... (attempt ${reconnectAttempts})`);
      
      setTimeout(() => {
        silvaConnect().catch(err => {
          logMessage("ERROR", `Retry connection failed: ${err.message}`);
        });
      }, delay);
    } else {
      logMessage("ERROR", "Max connection attempts reached. Please check your configuration.");
    }
  }
}

// ✅ Enhanced global error handlers
process.on('unhandledRejection', (reason, promise) => {
  logMessage('ERROR', `Unhandled Rejection at: ${promise}, reason: ${reason}`);
});

process.on('uncaughtException', (error) => {
  logMessage('ERROR', `Uncaught Exception: ${error.message}`);
  logMessage('ERROR', error.stack);
  // Don't exit immediately, allow the process to try to recover
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

// ✅ Memory usage monitoring
setInterval(() => {
  const used = process.memoryUsage();
  if (used.heapUsed > 500 * 1024 * 1024) { // 500MB threshold
    logMessage('WARN', `High memory usage: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
  }
}, 60000); // Check every minute
