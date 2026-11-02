import { getStore } from "@netlify/blobs"
import { ethers } from "ethers"

export const RPCS = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base.llamarpc.com",
  "https://1rpc.io/base",
]

/** Store JSON sobre Netlify Blobs con consistencia fuerte (lecturas ven la última escritura). */
export function jsonStore() {
  const s = getStore({ name: "arb-worker", consistency: "strong" })
  return {
    get: async (k: string) => (await s.get(k, { type: "json" })) ?? null,
    set: async (k: string, v: unknown) => { await s.setJSON(k, v) },
  }
}

/** Primer RPC que responda con chainId de Base. RPC_URL (variable de entorno) tiene prioridad. */
export async function baseProvider() {
  const custom = Netlify.env.get("RPC_URL")
  const list = custom ? [custom, ...RPCS] : RPCS
  for (const url of list) {
    try {
      const req = new ethers.FetchRequest(url)
      req.timeout = 15_000 // ninguna llamada puede colgar al worker más de 15 s
      const p = new ethers.JsonRpcProvider(req, 8453, { staticNetwork: true, batchMaxCount: 1 })
      await p.getBlockNumber()
      return { provider: p, url }
    } catch { /* siguiente */ }
  }
  throw new Error("ningún RPC de Base respondió")
}

/** Secreto compartido entre `kick` y `worker`, guardado en Blobs (no hace falta variable de entorno).
 *  Evita que cualquiera que conozca la URL lance workers. */
export async function workerSecret(store: ReturnType<typeof jsonStore>): Promise<string> {
  const env = Netlify.env.get("WORKER_TOKEN")
  if (env) return env
  const cur = (await store.get("secret")) as { token?: string } | null
  if (cur?.token) return cur.token
  const token = crypto.randomUUID() + crypto.randomUUID()
  await store.set("secret", { token })
  return token
}

/** Bitácora corta en Blobs (últimas 30 líneas) para ver qué hace el worker desde la página. */
export async function diag(store: ReturnType<typeof jsonStore>, msg: string) {
  try {
    const list = ((await store.get("diag")) as { t: number; m: string }[] | null) ?? []
    list.push({ t: Date.now(), m: msg })
    await store.set("diag", list.slice(-30))
  } catch { /* la bitácora nunca debe tumbar al worker */ }
  console.log(msg)
}
