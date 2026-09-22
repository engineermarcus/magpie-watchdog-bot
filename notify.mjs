import "dotenv/config";
import makeWASocket, { useMultiFileAuthState, fetchLatestWaWebVersion, Browsers, DisconnectReason } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import pg from "pg";
import fs from "fs";
import path from "path";

const DATABASE_URL = process.env.DATABASE_URL;
const PHONE_NUMBER = "254725693306";
const AUTH_DIR = "./auth_temp";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function loadSession() {
  const res = await pool.query("select data from wa_session where id = 'main'");
  if (!res.rows.length) throw new Error("No saved WhatsApp session found — run pair.mjs first");
  const sessionData = res.rows[0].data;
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  for (const [filename, content] of Object.entries(sessionData)) {
    fs.writeFileSync(path.join(AUTH_DIR, filename), content, "utf8");
  }
}

async function saveSession() {
  const files = fs.readdirSync(AUTH_DIR);
  const sessionData = {};
  for (const file of files) {
    sessionData[file] = fs.readFileSync(path.join(AUTH_DIR, file), "utf8");
  }
  await pool.query(
    `insert into wa_session (id, data, updated_at) values ('main', $1, now())
     on conflict (id) do update set data = excluded.data, updated_at = now()`,
    [JSON.stringify(sessionData)]
  );
}

export async function sendWhatsAppMessage(text) {
  await loadSession();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion({});

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    logger: pino({ level: "silent" }),
  });

  return new Promise((resolve, reject) => {
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        try {
          const jid = `${PHONE_NUMBER}@s.whatsapp.net`;
          await sock.sendMessage(jid, { text });
          await saveSession();
          console.log("[notify] message sent");
          sock.end();
          resolve();
        } catch (err) {
          reject(err);
        }
      }

      if (connection === "close") {
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          reject(new Error("Logged out — session invalid, re-run pair.mjs"));
        }
      }
    });
  });
}

// Allow running directly for a quick test: node notify.mjs "test message"
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const msg = process.argv[2] || "Magpie Watchdog test message";
  sendWhatsAppMessage(msg)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[notify] failed:", err);
      process.exit(1);
    });
}
