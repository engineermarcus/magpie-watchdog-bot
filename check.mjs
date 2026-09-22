import "dotenv/config";

const CLIENT_SERVER = process.env.CLIENT_SERVER;
const DISPATCH_SERVER = process.env.DISPATCH_SERVER;
const BOT_KEY = process.env.BOT_KEY;
const DELAY_MS = Number(process.env.DELAY_MS || 3000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(45000) });
    let body = null;
    try { body = await res.json(); } catch {}
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err.message };
  }
}

// Ask the client server to play a title. Returns { ok, status, body }.
async function checkClientPlay(tmdbId, subjectType, season, episode) {
  const payload = { subjectId: String(tmdbId), subjectType };
  if (subjectType === 2) {
    payload.season = season;
    payload.episode = episode;
  }
  return fetchJson(`${CLIENT_SERVER}/api/play`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Cross-check directly against dispatch when client fails.
async function checkDispatchResolve(tmdbId, mediaType, season, episode) {
  const payload = { tmdb_id: String(tmdbId), type: mediaType };
  if (mediaType === "tv") {
    payload.season = season;
    payload.episode = episode;
  }
  return fetchJson(`${DISPATCH_SERVER}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

// Report availability status back to the client server.
async function reportAvailability(tmdbId, type, status, season, episode) {
  const payload = { tmdbId: String(tmdbId), type, status };
  if (season !== undefined) payload.season = season;
  if (episode !== undefined) payload.episode = episode;
  return fetchJson(`${CLIENT_SERVER}/api/admin/availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Bot-Key": BOT_KEY },
    body: JSON.stringify(payload),
  });
}

// Core per-title check: client first, dispatch only as tiebreaker on failure.
// Returns one of: "available", "unavailable", "client_bug" (dispatch says ok, client doesn't)
async function checkOnceRaw({ tmdbId, subjectType, mediaType, season, episode }) {
  const clientRes = await checkClientPlay(tmdbId, subjectType, season, episode);
  const clientWorked = clientRes.ok && clientRes.body?.stream_url;

  if (clientWorked) {
    return { verdict: "available", clientRes };
  }

  // Client failed — cross-check dispatch directly.
  const dispatchRes = await checkDispatchResolve(tmdbId, mediaType, season, episode);
  const dispatchWorked = dispatchRes.ok && dispatchRes.body?.stream?.url;

  if (dispatchWorked) {
    return { verdict: "client_bug", clientRes, dispatchRes };
  }
  return { verdict: "unavailable", clientRes, dispatchRes };
}

// Retries once on any non-"available" verdict before trusting it — Render
// free-tier cold starts and transient network blips otherwise look like
// real failures.
async function checkOne(args) {
  const first = await checkOnceRaw(args);
  if (first.verdict === "available") return first;

  await sleep(5000);
  const second = await checkOnceRaw(args);
  return second; // trust the second attempt regardless — avoids infinite retry loops
}

export { sleep, checkOne, reportAvailability, fetchJson, DELAY_MS };
