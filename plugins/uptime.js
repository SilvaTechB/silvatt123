import os from "os";
import { globalContextInfo } from "../lib/silvaConnect.js";

const formatTime = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
};

const handler = async (m, { conn }) => {
  try {
    const uptime = formatTime(process.uptime());
    const cpu = os.cpus()[0]?.model || "Unknown CPU";
    const platform = os.platform()?.toUpperCase() || "Unknown";
    const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
    const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
    const latency = m.messageTimestamp
      ? new Date().getTime() - m.messageTimestamp * 1000
      : 0;

    const caption = `
┏━━━━━━━━━━━━━━━━━━┓
      ⚙️ *Silva MD Pro Status*
┗━━━━━━━━━━━━━━━━━━┛

🕒 *Uptime:* ${uptime}
⚡ *Latency:* ${latency} ms
🖥 *CPU:* ${cpu}
🏗 *Platform:* ${platform}
🛠 *RAM:* ${freeMem} GB / ${totalMem} GB

✨ _Engineered by Silva Tech Inc_
`.trim();

    await conn.sendMessage(
      m.chat,
      {
        image: { url: "https://files.catbox.moe/5uli5p.jpeg" },
        caption,
        contextInfo: globalContextInfo,
      },
      { quoted: m }
    );
  } catch (error) {
    console.error("❌ Uptime Plugin Error:", error);
    await conn.sendMessage(
      m.chat,
      {
        text: "⚠️ *Failed to fetch runtime details.*\nPlease check your bot logs for more info.",
        contextInfo: globalContextInfo,
      },
      { quoted: m }
    );
  }
};

handler.help = ["uptime", "runtime"];
handler.tags = ["system", "info"];
handler.command = ["uptime", "runtime"];
handler.private = false;

export default handler;
