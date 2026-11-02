// Worker en segundo plano: corre el pipeline del protocolo bloque a bloque durante ~14 min
// y acumula resultados en Netlify Blobs. Lo lanza la función programada `kick` cada 5 min
// si no hay otro worker vivo. No envía transacciones.
import type { Config } from "@netlify/functions"
import { ethers } from "ethers"
import { isAlive, runWorker } from "../../src/worker.js"
import { baseProvider, jsonStore, workerSecret } from "../lib/shared.mts"

const RUN_MS = 14 * 60 * 1000 + 20 * 1000 // background: límite de 15 min

export default async (req: Request) => {
  const started = Date.now()
  const store = jsonStore()
  const token = await workerSecret(store)
  if (req.headers.get("x-worker-token") !== token) { console.warn("worker: token inválido"); return }
  if (isAlive(await store.get("stats"), Date.now())) { console.log("worker: ya hay uno vivo"); return }
  try {
    const { provider, url } = await baseProvider()
    const { stats, evicted } = await runWorker({
      ethers, provider, store, deadlineMs: started + RUN_MS, ltHours: Number(Netlify.env.get("LT_HOURS") ?? 2),
      log: (m: string) => console.log(m),
    })
    console.log(`worker fin (${url}) bloques=${stats.blocksProcessed} episodios=${stats.totals.episodes} evicted=${evicted}`)
  } catch (e: any) {
    console.error("worker error", e)
    const stats = (await store.get("stats")) as any
    if (stats) { stats.lastError = `worker: ${e?.shortMessage || e?.message}`; await store.set("stats", stats) }
  }
}

export const config: Config = { background: true, path: "/api/worker-run", method: "POST" }
