// Cada 5 minutos (UTC; la zona horaria no importa para un intervalo): si no hay un worker
// vivo (latido de menos de 45 s), lanza uno nuevo. Así el worker corre 24/7 aunque nadie
// tenga la página abierta.
import type { Config, Context } from "@netlify/functions"
import { isAlive } from "../../src/worker.js"
import { diag, jsonStore, workerSecret } from "../lib/shared.mts"

export default async (_req: Request, context: Context) => {
  const store = jsonStore()
  const stats: any = await store.get("stats")
  // diagnóstico visible en los logs de Netlify (los de funciones en segundo plano no siempre aparecen)
  console.log(JSON.stringify({
    phase: stats?.phase ?? null, heartbeatAgeS: stats?.heartbeat ? Math.round((Date.now() - stats.heartbeat) / 1000) : null,
    runs: stats?.runs ?? 0, blocks: stats?.blocksProcessed ?? 0, lastBlock: stats?.lastBlock ?? null,
    episodes: stats?.totals?.episodes ?? 0, netUsd: stats?.totals?.netUsd ?? 0, universe: stats?.universe ?? null, lastError: stats?.lastError ?? null,
  }))
  if (isAlive(stats, Date.now())) return // vivo: nada que hacer
  const token = await workerSecret(store)
  const base = context.site?.url || Netlify.env.get("URL")
  const res = await fetch(`${base}/api/worker-run`, { method: "POST", headers: { "x-worker-token": token } })
  await diag(store, `programador: worker lanzado (HTTP ${res.status})`)
}

export const config: Config = { schedule: "*/5 * * * *" }
