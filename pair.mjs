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
let codeRequested = false;

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
  console.log("[pair] session saved to Supabase");
}

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestWaWebVersion({});

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !sock.authState.creds.registered && !codeRequested) {
      codeRequested = true;
      const code = await sock.requestPairingCode(PHONE_NUMBER);
      console.log(`\n[pair] Your pairing code: ${code.match(/.{1,4}/g).join("-")}\n`);
      console.log("[pair] Enter this in WhatsApp > Linked Devices > Link with phone number\n");
    }

    if (connection === "open") {
      console.log("[pair] Connected successfully!");
      await saveSession();
      process.exit(0);
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log("[pair] connection closed, reconnect:", shouldReconnect, "reason:", statusCode);
      if (shouldReconnect) {
        setTimeout(connect, 2000);
      } else {
        console.log("[pair] logged out — auth invalid, delete auth_temp and retry");
        process.exit(1);
      }
    }
  });
}

connect().catch((err) => {
  console.error("[pair] fatal:", err);
  process.exit(1);
});
