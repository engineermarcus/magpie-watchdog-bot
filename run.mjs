import "dotenv/config";
import { sleep, checkOne, reportAvailability, fetchJson, DELAY_MS } from "./check.mjs";
import { sendWhatsAppMessage } from "./notify.mjs";

const CLIENT_SERVER = process.env.CLIENT_SERVER;
const ABORT_THRESHOLD = Number(process.env.FAILURE_RATE_ABORT_THRESHOLD || 0.3);

async function getFeed() {
  const res = await fetchJson(`${CLIENT_SERVER}/api/feed`);
  if (!res.ok) throw new Error(`Feed fetch failed: ${res.status}`);
  return res.body;
}

async function getSeasons(title, tmdbId) {
  const res = await fetchJson(`${CLIENT_SERVER}/api/seasons`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, subjectType: 2, tmdbId }),
  });
  if (!res.ok || !res.body?.seasons) return [];
  return res.body.seasons;
}

async function getEpisodeCount(title, season) {
  const res = await fetchJson(`${CLIENT_SERVER}/api/episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, season }),
  });
  if (!res.ok || !res.body?.episodes) return 0;
  return res.body.episodes.length;
}

async function main() {
  console.log("[watchdog] fetching feed...");
  const feed = await getFeed();

  const movies = [...(feed.movies || []), ...(feed.topRated || [])];
  const uniqueMovies = [...new Map(movies.map((m) => [m.id, m])).values()];
  const shows = feed.tv || [];

  console.log(`[watchdog] ${uniqueMovies.length} movies, ${shows.length} shows to check`);

  let total = 0;
  let failures = 0;
  const report = { unavailable: [], client_bugs: [], available_count: 0, available_titles: [] };

  const movieLimit = process.env.LIMIT ? Number(process.env.LIMIT) : uniqueMovies.length;
  for (const movie of uniqueMovies.slice(0, movieLimit)) {
    total++;
    console.log(`[checking] movie ${movie.id} (${movie.title})`);
    const result = await checkOne({ tmdbId: movie.id, subjectType: 1 });
    console.log(`  -> ${result.verdict}`);
    if (result.verdict === "available") {
      report.available_count++;
      report.available_titles.push({ id: movie.id, title: movie.title, type: "movie" });
    } else if (result.verdict === "client_bug") {
      failures++;
      report.client_bugs.push({ id: movie.id, title: movie.title });
      console.log(`[client_bug] movie ${movie.id} (${movie.title})`);
      console.log(`  client response: status=${result.clientRes.status} body=${JSON.stringify(result.clientRes.body)}`);
      console.log(`  dispatch response: status=${result.dispatchRes.status} body=${JSON.stringify(result.dispatchRes.body)}`);
    } else {
      failures++;
      report.unavailable.push({ id: movie.id, title: movie.title, type: "movie" });
      console.log(`[unavailable] movie ${movie.id} (${movie.title})`);
      const rep = await reportAvailability(movie.id, "movie", "unavailable");
      console.log(`  reported: ${rep.ok ? "ok" : "FAILED status=" + rep.status}`);
    }
    await sleep(DELAY_MS);
  }

  // Abort TV walk (and reporting) if failure rate already suggests an outage.
  const rateSoFar = total ? failures / total : 0;
  if (rateSoFar > ABORT_THRESHOLD) {
    console.log(`[watchdog] ABORT: failure rate ${rateSoFar.toFixed(2)} exceeds threshold ${ABORT_THRESHOLD} — likely outage, not reporting individual titles`);
    console.log(JSON.stringify({ aborted: true, rateSoFar, checked: total }, null, 2));
    try {
      await sendWhatsAppMessage(`*Magpie Watchdog: OUTAGE SUSPECTED*\nFailure rate ${(rateSoFar * 100).toFixed(0)}% after ${total} checks. Aborting run — this looks like infrastructure down, not missing titles.`);
    } catch (err) {
      console.error("[watchdog] WhatsApp notify failed:", err.message);
    }
    return;
  }

  const showLimit = process.env.SHOW_LIMIT ? Number(process.env.SHOW_LIMIT) : shows.length;
  for (const show of shows.slice(0, showLimit)) {
    const seasons = await getSeasons(show.title, show.id);
    for (const s of seasons) {
      const epCount = await getEpisodeCount(show.title, s.number);
      for (let ep = 1; ep <= epCount; ep++) {
        total++;
        const result = await checkOne({
          tmdbId: show.id,
          subjectType: 2,
          mediaType: "tv",
          season: s.number,
          episode: ep,
        });
        if (result.verdict === "available") {
          report.available_count++;
          report.available_titles.push({ id: show.id, title: show.title, type: "tv", season: s.number, episode: ep });
        } else if (result.verdict === "client_bug") {
          failures++;
          report.client_bugs.push({ id: show.id, title: show.title, season: s.number, episode: ep });
          console.log(`[client_bug] ${show.title} S${s.number}E${ep}`);
          console.log(`  client response: status=${result.clientRes.status} body=${JSON.stringify(result.clientRes.body)}`);
          console.log(`  dispatch response: status=${result.dispatchRes.status} body=${JSON.stringify(result.dispatchRes.body)}`);
        } else {
          failures++;
          report.unavailable.push({ id: show.id, title: show.title, type: "tv", season: s.number, episode: ep });
          console.log(`[unavailable] ${show.title} S${s.number}E${ep}`);
          const rep = await reportAvailability(show.id, "tv", "unavailable", s.number, ep);
          console.log(`  reported: ${rep.ok ? "ok" : "FAILED status=" + rep.status}`);
        }
        await sleep(DELAY_MS);
      }

      const rateNow = failures / total;
      if (rateNow > ABORT_THRESHOLD) {
        console.log(`[watchdog] ABORT mid-run: failure rate ${rateNow.toFixed(2)} — likely outage`);
        console.log(JSON.stringify({ aborted: true, rateNow, checked: total }, null, 2));
        try {
          await sendWhatsAppMessage(`*Magpie Watchdog: OUTAGE SUSPECTED*\nFailure rate ${(rateNow * 100).toFixed(0)}% after ${total} checks. Aborting run — this looks like infrastructure down, not missing titles.`);
        } catch (err) {
          console.error("[watchdog] WhatsApp notify failed:", err.message);
        }
        return;
      }
    }
  }

  console.log("[watchdog] run complete");
  console.log(JSON.stringify(report, null, 2));

  const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const label = (item) => item.type === "movie" ? item.title : `${item.title} S${item.season}E${item.episode}`;

  const summary = [
    `*Magpie Watchdog Report* — ${now}`,
    ``,
    `Checked ${total} title(s) this cycle.`,
  ];

  if (report.available_titles.length) {
    summary.push("", `✅ *Working (${report.available_titles.length}):*`);
    for (const item of report.available_titles.slice(0, 20)) {
      summary.push(`- ${label(item)}`);
    }
    if (report.available_titles.length > 20) {
      summary.push(`...and ${report.available_titles.length - 20} more confirmed working`);
    }
  }

  if (report.unavailable.length) {
    summary.push("", `❌ *Not available — confirmed missing on both client and dispatch (${report.unavailable.length}):*`);
    for (const item of report.unavailable.slice(0, 30)) {
      summary.push(`- ${label(item)}`);
    }
    if (report.unavailable.length > 30) {
      summary.push(`...and ${report.unavailable.length - 30} more`);
    }
  } else {
    summary.push("", `❌ Not available: none`);
  }

  if (report.client_bugs.length) {
    summary.push("", `⚠️ *Client server bug — dispatch has the stream but client server failed to serve it (${report.client_bugs.length}):*`);
    for (const item of report.client_bugs.slice(0, 10)) {
      summary.push(`- ${label(item)}`);
    }
  } else {
    summary.push("", `⚠️ Client bugs: none`);
  }

  const isFullRun = !process.env.LIMIT && !process.env.SHOW_LIMIT;
  if (isFullRun) {
    try {
      await sendWhatsAppMessage(summary.join("\n"));
    } catch (err) {
      console.error("[watchdog] WhatsApp notify failed:", err.message);
    }
  } else {
    console.log("[watchdog] test run (LIMIT/SHOW_LIMIT set) — skipping WhatsApp report");
  }
}

main().catch((err) => {
  console.error("[watchdog] fatal error:", err.message);
  process.exit(1);
});
