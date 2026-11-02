// Cada 5 minutos (UTC; la zona horaria no importa para un intervalo): si no hay un worker
// vivo (latido de menos de 45 s), lanza uno nuevo. Así el worker corre 24/7 aunque nadie
// tenga la página abierta.
import type { Config, Context } from "@netlify/functions"
import { isAlive } from "../../src/worker.js"
import { jsonStore, workerSecret } from "../lib/shared.mts"

export default async (_req: Request, context: Context) => {
  const store = jsonStore()
  const stats = await store.get("stats")
  if (isAlive(stats, Date.now())) {
    console.log("worker vivo; nada que hacer")
    return
  }
  const token = await workerSecret(store)
  const base = context.site?.url || Netlify.env.get("URL")
  const res = await fetch(`${base}/api/worker-run`, { method: "POST", headers: { "x-worker-token": token } })
  console.log(`worker lanzado: ${res.status}`)
}

export const config: Config = { schedule: "*/5 * * * *" }
