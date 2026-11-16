// Fondeo de la espejo desde cualquier cadena (orden de Jose 2026-11-16: "arregla el espejo para que sea cualquier cantidad de
// cualquier cadena que sea necesario"; fuentes aprobadas: todo, incluido el vault NVDAc; reponer los $10 que faltaron el 15 nov).
//
// Cuando al depósito diario de lp-neutral2 le falta USDC en Base, este módulo lo junta, una acción por vuelta y en este orden:
//   1) dólares sueltos en cualquier cadena (USDG de Robinhood, USDC/USDT de otras)      → USDC en Base con Relay
//   2) lo estacionado en Venus (BSC): retira solo lo que falta y luego lo puentea
//   3) otros tokens sueltos (WMON en Monad, VVV en Base…), del más grande al más chico → USDC en Base con Relay
//   4) como último recurso, un retiro parcial del vault NVDAc de Beefy (lo ejecuta la estrategia, en su propia vuelta)
// Nunca toca el nativo de cada cadena (es el gas), ni el WETH/cbBTC (los usan los otros módulos), ni saldos de menos de
// NLP2_FUND_MIN_SRC_USD ($3: la comisión fija los vuelve caros). Manda solo lo que falta (+2 %), no el saldo entero.
// Cada transacción se simula con eth_call y estimateGas antes de enviarse y pasa por la guardia de retiros: el destino de
// Relay es siempre la propia wallet. NLP2_FUND=0 lo apaga; NLP2_FUND_VAULT=0 deja fuera el vault.
import { ethers } from "ethers";
import { CHAINS } from "../src/chains.js";
import { parseQuote, BASE_ID, BASE_USDC } from "./bridge.mjs";
import { walletBalances } from "./beefywallet.mjs";
import { WithdrawGuard } from "./withdrawguard.mjs";

const RELAY = process.env.RELAY_API || "https://api.relay.link";
const STABLE = /^(USDC|USDT|USDG|DAI|USDC\.e|USDbC|FDUSD|USD1)$/i;
const EXTRA_CHAINS = { monad: { id: 143, rpcs: ["https://rpc.monad.xyz", "https://rpc1.monad.xyz", "https://monad-mainnet.drpc.org"] } };
const ERC = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const VTOK = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function exchangeRateStored() view returns (uint256)", "function redeem(uint256) returns (uint256)", "function redeemUnderlying(uint256) returns (uint256)"]);
// vToken de Venus → su subyacente (lo que queda en la wallet tras retirar)
const VENUS_UNDER = { "0xfd5840cd36d94d7229439859c0112a4185bc0255": { sym: "USDT", address: "0x55d398326f99059fF775485246999027B3197955", dec: 18 } };
const SEL = { transfer: "0xa9059cbb", transferFrom: "0x23b872dd" };

/** Lo que quedó debiendo cada depósito pasado contra el monto diario (faltantes de menos de $1 no cuentan), con tope. */
export function owedFromLog(log, addUsd, capUsd = addUsd) {
  let o = 0;
  for (const d of log ?? []) { const gap = addUsd - Number(d?.usd ?? 0); if (gap >= 1) o += gap; }
  return +Math.min(capUsd, o).toFixed(2);
}

/** Fuentes utilizables de la lectura de saldos, en orden: dólares, Venus y luego el resto de mayor a menor (pura, probada). */
export function fundSources(bal, { skip = new Set(), minUsd = 3 } = {}) {
  const out = [];
  for (const c of bal?.chains ?? []) for (const r of c.rows ?? []) {
    if (!r.address || !(r.usd >= minUsd)) continue; // sin dirección = nativo (gas): no se toca
    const sym = String(r.sym ?? "").toUpperCase(), a = String(r.address).toLowerCase();
    if (c.chain === "base" && a === BASE_USDC.toLowerCase()) continue; // ya es el destino
    if (skip.has(sym) || skip.has(`${sym}@${String(c.chain).toUpperCase()}`)) continue;
    out.push({ chain: c.chain, sym: r.sym, address: r.address, usd: r.usd, kind: r.venus ? "venus" : "token", rank: r.venus ? 1 : STABLE.test(r.sym) ? 0 : 2 });
  }
  return out.sort((x, y) => x.rank - y.rank || y.usd - x.usd);
}

/** Cuánto mandar de un saldo que vale inUsd para cubrir needUsd (+margen); todo si lo que sobraría es polvo (pura, probada). */
export function sendAmount(bal, inUsd, needUsd, { margin = 1.02, dustUsd = 1 } = {}) {
  if (!(inUsd > 0) || !(needUsd > 0) || bal <= 0n) return 0n;
  const want = needUsd * margin;
  if (want >= inUsd - dustUsd) return bal;
  return bal * BigInt(Math.round(want / inUsd * 1e6)) / 1_000_000n;
}

export class MirrorFund {
  constructor({ executor, provider, store, diag, strategy = () => null }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag; this.strategy = strategy;
    this.cfg = {
      on: process.env.NLP2_FUND !== "0",
      minUsd: Number(process.env.NLP2_FUND_MIN_USD ?? 2), // faltantes menores no se persiguen
      minSrcUsd: Number(process.env.NLP2_FUND_MIN_SRC_USD ?? 3), // saldos menores no se usan
      maxFeePct: Number(process.env.NLP2_FUND_MAX_FEE_PCT ?? 3), // comisión + deslizamiento máximos por envío
      transitMin: Number(process.env.NLP2_FUND_TRANSIT_MIN ?? 20),
      vault: process.env.NLP2_FUND_VAULT ?? "NVDAc-USDC",
      skip: new Set(String(process.env.NLP2_FUND_SKIP ?? "WETH,CBBTC,WBTC").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)),
    };
    this.busy = false; this.guards = new Map(); this.provs = new Map();
  }
  get me() { return this.x?.wallet?.address; }
  get live() { return this.cfg.on && this.x?.mode === "live" && !!this.me; }
  async init() { this.s = (await this.store.get("nlp2fund")) ?? { cycle: null, sends: [], cool: {}, queue: [], vault: null }; }
  async save() { await this.store.set("nlp2fund", this.s); }
  note(m) { return this.diag(`lp-neutral2: fondeo · ${m}`); }

  chain(key) {
    if (key === "base") return { id: BASE_ID, p: this.provider, local: true };
    if (this.provs.has(key)) return this.provs.get(key);
    const c = CHAINS[key] ?? EXTRA_CHAINS[key];
    if (!c) throw new Error(`cadena ${key} desconocida`);
    const rpcs = c.rpcs.filter((u) => !/publicnode/.test(u)).slice(0, 3); // publicnode responde 403 a varias lecturas
    const p = new ethers.FallbackProvider((rpcs.length ? rpcs : c.rpcs.slice(0, 3)).map((u, i) => ({ provider: new ethers.JsonRpcProvider(u, c.id, { staticNetwork: true }), priority: i + 1, weight: 1, stallTimeout: 2500 })), c.id, { quorum: 1 });
    const v = { id: c.id, p, local: false }; this.provs.set(key, v); return v;
  }
  /** Envía una tx ya simulada en la cadena indicada, por la guardia de retiros, y espera su recibo. */
  async sendOn(key, tx) {
    const { p, local } = this.chain(key);
    const full = { from: this.me, to: tx.to, data: tx.data ?? "0x", value: tx.value ?? 0n };
    await p.call(full);
    const gasLimit = (await p.estimateGas(full)) * 13n / 10n;
    const req = { to: full.to, data: full.data, value: full.value, gasLimit };
    let sent;
    if (local) sent = await this.x.withSender((w) => w.sendTransaction(req));
    else {
      if (!this.guards.has(key)) this.guards.set(key, new WithdrawGuard({ provider: p, me: this.me, diag: this.diag }));
      sent = await this.guards.get(key).wrap(this.x.wallet.connect(p)).sendTransaction(req);
    }
    const rc = await p.waitForTransaction(sent.hash, 1, 180_000);
    if (!rc || rc.status !== 1) throw new Error(`tx ${sent.hash} ${rc ? "revertida" : "sin recibo"}`);
    return sent.hash;
  }
  async quote(originId, token, amount) {
    const body = { user: this.me, recipient: this.me, originChainId: originId, destinationChainId: BASE_ID, originCurrency: token, destinationCurrency: BASE_USDC, amount: amount.toString(), tradeType: "EXACT_INPUT" };
    const res = await fetch(`${RELAY}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const q = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? JSON.stringify(q ?? {})).slice(0, 140)}`);
    return parseQuote(q);
  }
  async balances() {
    if (this._bal && Date.now() - this._bal.at < 120_000) return this._bal.v;
    const v = await walletBalances(this.me, { provider: this.provider });
    this._bal = { at: Date.now(), v }; return v;
  }

  /**
   * Una vuelta del fondeo del depósito `cycle` al que le faltan `gapUsd` de USDC en Base. Una acción por llamada.
   * Devuelve { pending } = todavía hay dinero en camino o fuentes por probar (el depósito debe esperar).
   */
  async step(cycle, gapUsd) {
    if (!this.live) return { pending: false };
    if (this.busy) return { pending: true };
    this.busy = true;
    try {
      const s = this.s, now = Date.now(), c = this.cfg;
      if (s.cycle !== cycle) { Object.assign(s, { cycle, sends: [], cool: {}, queue: [], vault: null, startedAt: now, outOfSources: false }); await this.note(`al depósito le faltan $${gapUsd.toFixed(2)} de USDC en Base · se buscan en las demás cadenas`); }
      for (const x of s.sends) if (x.status === "enviado") await this.poll(x).catch(() => {});
      const transit = s.sends.filter((x) => x.status === "enviado").reduce((a, x) => a + (x.outUsd || 0), 0);
      // retiro del vault en curso: lo hace la estrategia en su vuelta; aquí solo se sigue
      const st = this.strategy();
      if (s.vault?.status === "pendiente") {
        const q = st?.s?.fundReq;
        if (q && q.cycle === cycle && q.status !== "pendiente") { s.vault.status = q.status; s.vault.outUsd = q.outUsd ?? null; }
        else if (now - s.vault.at > 90 * 60_000) { s.vault.status = "vencido"; if (q && q.cycle === cycle) q.status = "vencido"; await this.note(`el retiro del vault ${c.vault} no terminó en 90 min · se deja de esperar`); }
        else return { pending: true };
      }
      const need = gapUsd - transit;
      if (need < c.minUsd) return { pending: transit > 0 };
      // 1) lo que dejó a medias un paso anterior (p. ej. el USDT recién retirado de Venus) y 2) el resto de las fuentes
      const list = [...s.queue.map((q) => ({ ...q, kind: "token", queued: true })), ...fundSources(await this.balances(), { skip: c.skip, minUsd: c.minSrcUsd })];
      for (const src of list) {
        const key = `${src.chain}:${String(src.address).toLowerCase()}`;
        if (!src.queued && (s.cool[key] ?? 0) > now) continue;
        try {
          const did = src.kind === "venus" ? await this.redeemVenus(src, need) : await this.sendToken(src, need);
          if (src.queued) s.queue = s.queue.filter((q) => `${q.chain}:${String(q.address).toLowerCase()}` !== key);
          this._bal = null;
          if (did) return { pending: true, acted: true }; // lo enviado cuenta como "en camino": no se manda dos veces
          s.cool[key] = now + 30 * 60_000; // nada utilizable aquí (saldo real menor que el de la lectura): no insistir
        } catch (e) {
          s.cool[key] = now + 30 * 60_000;
          if (src.queued) s.queue = s.queue.filter((q) => `${q.chain}:${String(q.address).toLowerCase()}` !== key);
          await this.note(`${src.sym} de ${src.chain} no se pudo usar · ${(e.shortMessage || e.message || String(e)).slice(0, 160)} · sigue con la siguiente fuente`);
          return { pending: true, acted: true }; // la siguiente fuente, en la próxima vuelta
        }
      }
      // 3) último recurso: retiro parcial del vault (una vez por depósito)
      if (c.vault && c.vault !== "0" && st?.s && !s.vault) {
        const usd = +(need * 1.03).toFixed(2);
        s.vault = { status: "pendiente", usd, at: now };
        st.s.fundReq = { cycle, spec: c.vault, usd, status: "pendiente", at: new Date(now).toISOString() };
        await this.note(`sin más saldos sueltos: se piden $${usd} al vault ${c.vault} (retiro parcial)`);
        return { pending: true, acted: true };
      }
      if (transit <= 0 && !s.outOfSources) { s.outOfSources = true; await this.note(`ya no hay de dónde tomar: faltan $${need.toFixed(2)} · el depósito entra con lo que hay y el resto queda pendiente`); }
      return { pending: transit > 0 };
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  /** Token suelto → USDC en Base con Relay. true si envió. */
  async sendToken(src, need) {
    const { id, p } = this.chain(src.chain), c = this.cfg;
    const bal = ERC.decodeFunctionResult("balanceOf", await p.call({ to: src.address, data: ERC.encodeFunctionData("balanceOf", [this.me]) }))[0];
    if (bal === 0n) return false;
    const dec = Number(ERC.decodeFunctionResult("decimals", await p.call({ to: src.address, data: ERC.encodeFunctionData("decimals") }))[0]);
    let q = await this.quote(id, src.address, bal);
    if (!(q.inUsd >= c.minSrcUsd)) return false; // el saldo real ya no alcanza el mínimo (la lectura de saldos tarda en refrescar)
    const amount = sendAmount(bal, q.inUsd, need);
    if (amount <= 0n) return false;
    if (amount < bal) q = await this.quote(id, src.address, amount);
    if (!q.txs.length || q.txs.length > 3 || q.txs.some((t) => t.chainId !== id)) throw new Error(`cotización de Relay inesperada (${q.txs.length} tx)`);
    if (q.txs.some((t) => t.value !== 0n || [SEL.transfer, SEL.transferFrom].includes(String(t.data).slice(0, 10).toLowerCase()))) throw new Error("la cotización de Relay pide un envío directo; no se firma");
    if (!Number.isFinite(q.inUsd) || !Number.isFinite(q.outUsd) || !(q.inUsd > 0)) throw new Error("cotización de Relay sin valores en dólares");
    const feePct = (1 - q.outUsd / q.inUsd) * 100;
    if (feePct > c.maxFeePct) throw new Error(`comisión + deslizamiento ${feePct.toFixed(1)} % > ${c.maxFeePct} %`);
    if (q.outUsd < c.minUsd) return false;
    let hash = null;
    for (const t of q.txs) hash = await this.sendOn(src.chain, t); // approve y depósito, en orden
    const rec = { at: new Date().toISOString(), t: Date.now(), chain: src.chain, sym: src.sym, amount: ethers.formatUnits(amount, dec), inUsd: q.inUsd, outUsd: q.outUsd, feePct: +feePct.toFixed(2), requestId: q.requestId, hash, status: q.requestId ? "enviado" : "hecho" };
    this.s.sends.push(rec);
    await this.note(`${rec.amount} ${src.sym} de ${src.chain} ($${q.inUsd.toFixed(2)}) → ~$${q.outUsd.toFixed(2)} USDC en Base vía Relay (comisión ${feePct.toFixed(2)} %) · tx ${hash}`);
    return true;
  }

  /** Venus: retira del préstamo solo lo que falta (o todo, si lo que quedaría es polvo); el subyacente se puentea en la vuelta siguiente. */
  async redeemVenus(src, need) {
    const u = VENUS_UNDER[String(src.address).toLowerCase()];
    if (!u) return false;
    const { p } = this.chain(src.chain), c = this.cfg;
    const vbal = VTOK.decodeFunctionResult("balanceOf", await p.call({ to: src.address, data: VTOK.encodeFunctionData("balanceOf", [this.me]) }))[0];
    if (vbal === 0n) return false;
    const rate = VTOK.decodeFunctionResult("exchangeRateStored", await p.call({ to: src.address, data: VTOK.encodeFunctionData("exchangeRateStored") }))[0];
    const under = vbal * rate / 10n ** 18n, underUsd = Number(ethers.formatUnits(under, u.dec));
    if (underUsd < c.minSrcUsd) return false;
    const want = need * 1.02, all = want >= underUsd - 1;
    const data = all ? VTOK.encodeFunctionData("redeem", [vbal]) : VTOK.encodeFunctionData("redeemUnderlying", [ethers.parseUnits(want.toFixed(6), u.dec)]);
    // Venus devuelve un código de error en vez de revertir: 0 = bien
    const code = BigInt(await p.call({ from: this.me, to: src.address, data }));
    if (code !== 0n) throw new Error(`Venus rechazaría el retiro (código ${code})`);
    const hash = await this.sendOn(src.chain, { to: src.address, data });
    this.s.queue.push({ chain: src.chain, sym: u.sym, address: u.address });
    await this.note(`retirados ~$${(all ? underUsd : want).toFixed(2)} de Venus (${src.chain}) · tx ${hash} · se puentean a Base en la siguiente vuelta`);
    return true;
  }

  async poll(x) {
    const j = await (await fetch(`${RELAY}/intents/status/v3?requestId=${x.requestId}`, { signal: AbortSignal.timeout(10_000) })).json().catch(() => null);
    const st = j?.status;
    if (st === "success") { x.status = "hecho"; await this.note(`llegó a Base · ~$${x.outUsd.toFixed(2)} USDC (${x.sym} de ${x.chain})`); }
    else if (st === "failure" || st === "refund") { x.status = "falló"; await this.note(`Relay ${st} · ${x.sym} de ${x.chain} · tx ${x.hash} (Relay devuelve el dinero al origen)`); }
    else if (Date.now() - x.t > this.cfg.transitMin * 60_000) { x.status = "vencido"; await this.note(`sin confirmación de llegada tras ${this.cfg.transitMin} min (estado ${st ?? "?"}) · ${x.sym} de ${x.chain} · tx ${x.hash}`); }
  }
}
