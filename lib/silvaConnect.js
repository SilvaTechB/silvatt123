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

// ---------------- Global contextInfo used by plugins ----------------
export const globalContextInfo = {
  forwardingScore: 999,
  isForwarded: true,
  forwardedNewsletterMessageInfo: {
    newsletterJid: "120363200367779016@newsletter",
    newsletterName: "◢◤ Silva Tech Nexus ◢◤",
    serverMessageId: 144
  }
};

// ---------------- Configurable behavior ----------------
const STATUS_SAVER_ENABLED = false; // removed per request
const LOG_RATE_LIMIT_MS = 2500;
const MAX_CACHE = 800; // small cache for anti-delete
const MESSAGE_PROCESS_DELAY_MS = 75; // small delay between message processing to avoid spikes
const MEMORY_WARN_THRESHOLD_MB = 400; // warn and trim when above
const MEMORY_CRITICAL_MB = 512; // if >512MB, still try to trim and then exit (Heroku may kill anyway)
const MAX_RECONNECTS = 8;

// ---------------- Simple rate-limited logger ----------------
const lastLogAt = new Map();
function logMessage(type, msg) {
  const now = Date.now();
  const last = lastLogAt.get(type) || 0;
  if (now - last < LOG_RATE_LIMIT_MS) return; // rate limit per type
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

// ---------------- Safe helpers ----------------
function safeGetUserJid(sock) {
  try {
    if (!sock?.user) return null;
    const id = sock.user.id || sock.user?.wa || sock.user;
    if (!id) return null;
    return id.includes(":") ? `${id.split(":")[0]}@s.whatsapp.net` : id;
  } catch {
    return null;
  }
}

function getContactName(sock, jid) {
  try {
    const contact = sock?.contacts?.[jid] || {};
    return contact.notify || contact.name || contact.pushname || (jid || "unknown").split("@")[0];
  } catch {
    return (jid || "unknown").split("@")[0];
  }
}

// ---------------- Session fetch (optional) ----------------
async function tryDownloadSessionFromMega() {
  const sessionsDir = path.join(__dirname, "sessions");
  const sessionPath = path.join(sessionsDir, "creds.json");
  if (fs.existsSync(sessionPath)) {
    logMessage("INFO", "Session exists locally - skipping download.");
    return true;
  }
  const sess = process.env.SESSION_ID;
  if (!sess || !sess.startsWith("Silva~")) {
    logMessage("DEBUG", "SESSION_ID not configured or invalid - use QR auth.");
    return false;
  }
  const code = sess.replace("Silva~", "");
  logMessage("INFO", "⬇ Downloading session from silva servers...");
  try {
    const megaMod = await import("megajs").catch(() => null);
    const mega = megaMod?.default || megaMod;
    if (!mega?.File) {
      logMessage("ERROR", "megajs not available or invalid - skipping session download.");
      return false;
    }
    const file = mega.File.fromURL(`https://mega.nz/file/${code}`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Mega download timeout")), 25000);
      file.download((err, data) => {
        clearTimeout(timeout);
        if (err) return reject(err);
        if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
        fs.writeFileSync(sessionPath, data);
        resolve(true);
      });
    });
    logMessage("SUCCESS", "✅ Session downloaded successfully.");
    return true;
  } catch (err) {
    logMessage("ERROR", `Session download failed: ${err.message}`);
    return false;
  }
}

// ---------------- Main exported function ----------------
export async function silvaConnect() {
  // Try optional session download but don't fail if it doesn't work
  try {
    await tryDownloadSessionFromMega();
  } catch (e) {
    logMessage("WARN", `Session download attempt threw: ${e.message}`);
  }

  // create sessions dir if missing
  const sessionsDir = path.join(__dirname, "sessions");
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState("./sessions");
  const { version } = await fetchLatestBaileysVersion();

  // socket config tuned for Heroku
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

  // small in-memory cache for anti-delete
  const messageCache = new Map();

  // plugin loader
  try {
    await loadPlugins();
  } catch (err) {
    logMessage("ERROR", `Plugin load error: ${err.message}`);
  }

  // connection handling & welcome
  let reconnectCount = 0;
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === "open") {
      reconnectCount = 0;
      logMessage("SUCCESS", "🟢 Connected to WhatsApp successfully!");
      const jid = safeGetUserJid(sock);
      if (jid) {
        sock.sendMessage(jid, {
          text: `✅ *Silva MD Pro is connected*\nAnti-delete active. Plugins loaded.`,
          contextInfo: globalContextInfo
        }).catch(() => {});
      }
      // auto-follow newsletters if supported
      const newsletterIds = [
        "120363276154401733@newsletter",
        "120363200367779016@newsletter",
        "120363199904258143@newsletter"
      ];
      for (const id of newsletterIds) {
        if (typeof sock.newsletterFollow === "function") {
          sock.newsletterFollow(id).then(() => {
            logMessage("SUCCESS", `Followed newsletter ${id}`);
          }).catch(e => {
            logMessage("DEBUG", `newsletterFollow ${id} failed: ${e.message}`);
          });
        }
      }
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      logMessage("WARN", `Connection closed (code ${code || "unknown"})`);
      if (code === 401) {
        logMessage("ERROR", "Session invalid (401). Clearing sessions and require reauth.");
        try { fs.rmSync(path.join(__dirname, "sessions"), { recursive: true, force: true }); } catch {}
        process.exit(1);
      }
      // backoff reconnect
      reconnectCount++;
      const delay = Math.min(5000 * (1.4 ** (reconnectCount - 1)), 60_000);
      setTimeout(() => {
        silvaConnect().catch(err => logMessage("ERROR", `Reconnect attempt failed: ${err.message}`));
      }, delay);
    }

    if (qr && !sock.authState?.creds?.registered) {
      logMessage("INFO", "QR generated — scan to authenticate.");
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ---------------- Message queue + processor ----------------
  const messageQueue = [];
  let processing = false;

  async function processQueue() {
    if (processing) return;
    processing = true;
    while (messageQueue.length) {
      const msg = messageQueue.shift();
      try {
        // ignore status@broadcast entirely (no status saver)
        if (msg.key?.remoteJid === "status@broadcast") continue;

        // normal messages -> dispatch to plugin handler
        if (msg.message) {
          await handleMessage(sock, msg).catch(e => {
            logMessage("DEBUG", `Plugin handler error: ${e?.message || e}`);
          });
        }
      } catch (err) {
        logMessage("ERROR", `processQueue error: ${err.message}`);
      }
      // small pause to avoid spikes
      await new Promise(r => setTimeout(r, MESSAGE_PROCESS_DELAY_MS));
    }
    processing = false;
  }

  sock.ev.on("messages.upsert", ({ messages }) => {
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const m of messages) {
      if (!m?.key) continue;

      // cache for anti-delete only if it has content
      if (m.message) {
        const cacheKey = `${m.key.remoteJid}-${m.key.id}`;
        messageCache.set(cacheKey, m);
        if (messageCache.size > MAX_CACHE) {
          // trim oldest 20%
          const toRemove = Math.max(1, Math.floor(MAX_CACHE * 0.2));
          for (let i = 0; i < toRemove; i++) {
            const oldest = messageCache.keys().next().value;
            if (!oldest) break;
            messageCache.delete(oldest);
          }
          logMessage("DEBUG", "Trimmed messageCache to keep memory low");
        }
      }

      // enqueue message (status@broadcast will be ignored later)
      messageQueue.push(m);
    }
    processQueue().catch(e => logMessage("ERROR", `processQueue top-level error: ${e.message}`));
  });

  // ---------------- Anti-delete (messages.update) ----------------
  let lastDeleteAt = 0;
  sock.ev.on("messages.update", async (updates) => {
    const now = Date.now();
    if (now - lastDeleteAt < 800) return; // rate limit deletes processing
    lastDeleteAt = now;

    for (const { key, update } of updates) {
      try {
        // ignore deleted status messages (per request)
        if (key.remoteJid === "status@broadcast") continue;

        if (update?.message === null && !key.fromMe) {
          const cacheKey = `${key.remoteJid}-${key.id}`;
          const original = messageCache.get(cacheKey);
          if (!original?.message) {
            // couldn't recover
            const owner = safeGetUserJid(sock);
            if (owner) {
              sock.sendMessage(owner, {
                text: `🚨 A message was deleted in *${key.remoteJid}*, but recovery data is not available.`,
                contextInfo: globalContextInfo
              }).catch(() => {});
            }
            continue;
          }

          // send recovered message to owner only
          const ownerJid = safeGetUserJid(sock);
          if (!ownerJid) continue;
          try {
            await sock.sendMessage(ownerJid, {
              text: `🚨 *Anti-Delete* — Recovered a message from ${key.participant || key.remoteJid}`,
              contextInfo: globalContextInfo
            }).catch(() => {});
          } catch {}

          // handle text-like and media separately
          try {
            const msgObj = original.message;
            const mType = Object.keys(msgObj)[0];

            if (mType === "conversation" || mType === "extendedTextMessage") {
              const text = msgObj.conversation || msgObj.extendedTextMessage?.text || "[text]";
              await sock.sendMessage(ownerJid, { text, contextInfo: globalContextInfo }).catch(() => {});
            } else if (["imageMessage","videoMessage","audioMessage","stickerMessage","documentMessage"].includes(mType)) {
              try {
                const stream = await downloadContentFromMessage(msgObj[mType], mType.replace("Message", ""));
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);

                const field = mType.replace("Message", "");
                const payload = { contextInfo: globalContextInfo };
                payload[field] = buffer;
                if (msgObj[mType]?.caption) payload.caption = msgObj[mType].caption;
                if (msgObj[mType]?.mimetype) payload.mimetype = msgObj[mType].mimetype;
                if (mType === "documentMessage" && msgObj.documentMessage?.filename) payload.fileName = msgObj.documentMessage.filename;

                await sock.sendMessage(ownerJid, payload).catch(() => {});
              } catch (mediaErr) {
                logMessage("DEBUG", `Media recovery failed: ${mediaErr.message}`);
                await sock.sendMessage(ownerJid, { text: `⚠️ Media recovery failed: ${mediaErr.message}` }).catch(() => {});
              }
            } else {
              // fallback: send preview
              await sock.sendMessage(ownerJid, { text: `Recovered unsupported type: ${mType}\n\`\`\`${JSON.stringify(msgObj, null, 2)}\`\`\`` }).catch(() => {});
            }
          } catch (err) {
            logMessage("ERROR", `Recover send error: ${err.message}`);
          }
        }
      } catch (err) {
        logMessage("ERROR", `messages.update handler error: ${err.message}`);
      }
    }
  });

  // ---------------- Memory monitor: trims caches and attempts GC ----------------
  setInterval(() => {
    try {
      const usedMB = process.memoryUsage().rss / 1024 / 1024;
      if (usedMB > MEMORY_WARN_THRESHOLD_MB) {
        logMessage("WARN", `Memory high: ${Math.round(usedMB)} MB — trimming caches.`);
        // aggressively trim cache
        const keep = Math.max(16, Math.floor(MAX_CACHE * 0.2));
        while (messageCache.size > keep) messageCache.delete(messageCache.keys().next().value);
        // try global.gc() if available (run node with --expose-gc to enable)
        if (typeof global.gc === "function") {
          try { global.gc(); logMessage("DEBUG", "Ran GC"); } catch {}
        }
      }
      if (usedMB > MEMORY_CRITICAL_MB) {
        logMessage("ERROR", `Memory critically high: ${Math.round(usedMB)} MB — exiting to allow restart.`);
        // let the process manager restart the dyno
        process.exit(1);
      }
    } catch (err) {
      logMessage("ERROR", `Memory monitor error: ${err.message}`);
    }
  }, 30_000);

  // ---------------- ensure sessions/status dirs exist ----------------
  try { if (!fs.existsSync(path.join(__dirname, "sessions"))) fs.mkdirSync(path.join(__dirname, "sessions"), { recursive: true }); } catch {}
  try { if (!fs.existsSync(path.join(__dirname, "status_saver"))) fs.mkdirSync(path.join(__dirname, "status_saver"), { recursive: true }); } catch {}

  // error handling hooks
  process.on("unhandledRejection", (r) => logMessage("ERROR", `UnhandledRejection: ${String(r)}`));
  process.on("uncaughtException", (e) => {
    logMessage("ERROR", `UncaughtException: ${e?.message || e}`);
    logMessage("ERROR", e?.stack || "");
    // exit after short delay to let logs flush
    setTimeout(() => process.exit(1), 500);
  });

  return sock;
}