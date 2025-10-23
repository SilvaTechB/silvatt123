import os from "os";
import process from "process";

let handler = async (m, { conn }) => {
  try {
    const uptime = process.uptime(); // seconds
    const days = Math.floor(uptime / (60 * 60 * 24));
    const hours = Math.floor((uptime % (60 * 60 * 24)) / (60 * 60));
    const minutes = Math.floor((uptime % (60 * 60)) / 60);
    const seconds = Math.floor(uptime % 60);

    const uptimeText = `
🟢 *Silva MD Pro Uptime Status*
━━━━━━━━━━━━━━━━━━
🧠 *System:* ${os.type()} ${os.release()}
💻 *Platform:* ${os.platform()}
🕒 *Uptime:* ${days}d ${hours}h ${minutes}m ${seconds}s
📦 *RAM:* ${(os.totalmem() / (1024 ** 3)).toFixed(2)} GB
⚙️ *CPU:* ${os.cpus()[0].model}
━━━━━━━━━━━━━━━━━━
✨ Silva Tech Nexus
`.trim();

    // ✅ FIX: Ensure JID decoding never fails
    const decoded = conn?.user?.id ? conn.user : {};
    const jid = decoded?.id || m.chat;

    await conn.sendMessage(jid, { text: uptimeText });
  } catch (err) {
    console.error("❌ Uptime Plugin Error:", err);
    await m.reply("⚠️ Failed to fetch uptime info. Please try again later.");
  }
};

handler.help = ["uptime"];
handler.tags = ["info"];
handler.command = /^uptime$/i;
handler.register = true;

export default handler;
