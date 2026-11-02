// Resumen público del acumulado para el panel de la página.
import type { Config } from "@netlify/functions"
import { isAlive } from "../../src/worker.js"
import { jsonStore } from "../lib/shared.mts"

export default async () => {
  const store = jsonStore()
  const stats: any = await store.get("stats")
  const events: any[] = ((await store.get("events")) as any[]) ?? []
  if (!stats) return Response.json({ ready: false }, { headers: { "cache-control": "no-store" } })
  const topRoutes = Object.values(stats.byRoute ?? {})
    .sort((a: any, b: any) => b.netUsd - a.netUsd)
    .slice(0, 10)
  const { open, byRoute, ...rest } = stats
  return Response.json(
    { ready: true, alive: isAlive(stats, Date.now()), now: Date.now(), ...rest, openEpisodes: Object.keys(open ?? {}).length, topRoutes, recent: events.slice(-25).reverse() },
    { headers: { "cache-control": "no-store" } },
  )
}

export const config: Config = { path: "/api/stats", method: "GET" }
