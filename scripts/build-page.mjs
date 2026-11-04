// Genera public/index.html (Netlify) a partir del tablero del servidor, apuntando a la API de Railway.
import fs from "node:fs";
const STATS = process.env.STATS_URL || "https://worker-production-1950.up.railway.app/api/stats";
// STATS_URLS="base=https://…/api/stats,polygon=https://…/api/stats" para varias cadenas (selector en la página)
const STATS_URLS = process.env.STATS_URLS || "base=https://worker-production-1950.up.railway.app/api/stats,polygon=https://worker-polygon-production.up.railway.app/api/stats,bsc=https://worker-bsc-production.up.railway.app/api/stats,arbitrum=https://worker-arbitrum-production.up.railway.app/api/stats,optimism=https://worker-optimism-production.up.railway.app/api/stats";
let s = fs.readFileSync(new URL("../server/dashboard.html", import.meta.url), "utf8");
const v = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
s = s.replace('<meta name="viewport"', `<meta name="stats-url" content="${STATS}">\n${STATS_URLS ? `<meta name="stats-urls" content="${STATS_URLS}">\n` : ""}<meta name="viewport"`);
s = s.replace("</main>", `<p class="sub" style="margin-top:18px">Página: versión ${v} (hora de México) · datos del servidor en Railway</p>\n</main>`);
fs.writeFileSync(new URL("../public/index.html", import.meta.url), s);
console.log("public/index.html generado · versión", v);
