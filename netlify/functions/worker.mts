// Worker en segundo plano: corre el pipeline del protocolo bloque a bloque durante ~14 min
// y acumula resultados en Netlify Blobs. Lo lanza la función programada `kick` cada 5 min
// si no hay otro worker vivo. No envía transacciones.
import type { Config } from "@netlify/functions"
import { ethers } from "ethers"
import { isAlive, runWorker } from "../../src/worker.js"
import { baseProvider, diag, jsonStore, workerSecret } from "../lib/shared.mts"

const RUN_MS = 14 * 60 * 1000 + 20 * 1000 // background: límite de 15 min

export default async (req: Request) => {
  const started = Date.now()
  const store = jsonStore()
  await diag(store, "worker: arrancó")
  const token = await workerSecret(store)
  if (req.headers.get("x-worker-token") !== token) { await diag(store, "worker: token inválido, no corre"); return }
  if (isAlive(await store.get("stats"), Date.now())) { await diag(store, "worker: ya hay uno vivo, no corre"); return }
  try {
    const { provider, url } = await baseProvider()
    await diag(store, `worker: RPC ${new URL(url).host}`)
    const { stats, evicted } = await runWorker({
      ethers, provider, store, deadlineMs: started + RUN_MS, ltHours: Number(Netlify.env.get("LT_HOURS") ?? 2),
      log: (m: string) => { diag(store, `worker: ${m}`) },
    })
    await diag(store, `worker: fin · ${stats.blocksProcessed} bloques acumulados · ${stats.totals.episodes} oportunidades${evicted ? " · relevado por otro" : ""}`)
  } catch (e: any) {
    await diag(store, `worker: error ${e?.shortMessage || e?.message}`)
    const stats = (await store.get("stats")) as any
    if (stats) { stats.lastError = `worker: ${e?.shortMessage || e?.message}`; await store.set("stats", stats) }
  }
}

export const config: Config = { background: true, path: "/api/worker-run", method: "POST" }
