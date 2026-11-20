// lp-spcx (Jose 2026-11-16, doc 38): LP propio SPCX/USDG en Aerodrome Slipstream (Robinhood Chain), rango ±SPX_RANGE_PCT,
// depositado en el gauge (cobra emisiones en xAERO), con el precio cubierto por un corto de xyz:SPCX en Hyperliquid.
//   Apertura (una vez por etiqueta SPX_OPEN): USDG de la wallet → parte a SPCX en el mismo pool → mint → gauge; corto = SPCX del LP.
//   Cada SPX_EVERY_S (60 s):
//     · reajuste del corto si el desfase pasa SPX_REBAL_PCT del LP y la orden llega al mínimo de Hyperliquid (~$10);
//     · fuera de rango SPX_OUT_MIN minutos seguidos → re-centra (gauge → retira → reparte → mint → gauge);
//     · cada SPX_CLAIM_EVERY_H horas cobra el xAERO (withdraw/deposit del gauge) y, si lo acumulado llega a SPX_COMPOUND_USD,
//       lo vende a USDG y lo reinvierte en el mismo LP (el corto sube en la siguiente vuelta);
//     · margen: uso > SPX_MARGIN_WARN → pasa USDC del dex principal al xyz; precio a < SPX_LIQ_CLOSE_PCT de la liquidación → cierra todo.
//   SPX_LIVE=1 envía; si no, modo lectura (calcula y reporta sin enviar nada). SPX_CLOSE=<etiqueta> cierra. SPX=0 apaga.
//   Cada transacción se simula con eth_call antes de enviarse.
// Fondeo (clase SpcxFund, corre en el worker de Base): SPX_FUND="robinhood:110,hyperliquid:42@<etiqueta>" manda USDC de Base con
// Relay a USDG en Robinhood y a USDC de Hyperliquid (destino: la propia wallet), una vez por tramo y etiqueta.
import { ethers } from "ethers";
import { rangeTicks, amountsFor, recenterDue, rebalanceSwap } from "./revertloan.mjs";
import { Hl, hedgeOrder } from "./hl.mjs";
import { parseQuote, BASE_ID, BASE_USDC } from "./bridge.mjs";

export const SPX = {
  POOL: "0x79ac9e4f5382b2157ad06ce57392ad3677a09c83",
  NPM: "0x4857DB576eE0e45F10525eC59527BfD10beeC60b",
  GAUGE: "0x8f9C022A1e2CE1AB8aE0CBF69E95B2207e33632F",
  ROUTER: "0x9Ee35Bf1bd69a03c6F0393582030fCe8Bb93D418",
  SPCX: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  XAERO: "0x9e148c5716b5aadcfd3b71ceae9ee7a9e22c29e2",
  XAERO_POOL: "0x8D1B33c22D6a13F7D9EDc0793BfC2DDB12b37367", // USDG/xAERO tickSpacing 200
  SPACING: 50, XAERO_SPACING: 200,
  COIN: "xyz:SPCX",
};
const I = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,bool)",
  "function token0() view returns (address)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function mint((address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline,uint160 sqrtPriceX96)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint128,uint256,uint256)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256,uint256)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256,uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  "function deposit(uint256 tokenId)",
  "function withdraw(uint256 tokenId)",
  "function stakedContains(address,uint256) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const MAX128 = (1n << 128n) - 1n;
const n = (x, d) => Number(ethers.formatUnits(x, d));

// ---------------------------------------------------------------- funciones puras (test-local/test_spcxlp.mjs)
/** USDG por SPCX a partir de sqrtPriceX96 (token0 SPCX 18 dec, token1 USDG 6 dec). */
export function spcxPrice(sqrtPriceX96) { const s = Number(sqrtPriceX96) / 2 ** 96; return s * s * 1e12; }
/** Precio del xAERO en USDG con el pool USDG(6)/xAERO(18) (token0 = USDG). */
export function xaeroPrice(sqrtPriceX96) { const s = Number(sqrtPriceX96) / 2 ** 96; const x = s * s * 1e-12; return x > 0 ? 1 / x : 0; }
/** Valor del LP y SPCX que contiene, desde liquidez y ticks. */
export function lpView(L, sqrtPriceX96, lower, upper) {
  const am = amountsFor(Number(L), Number(sqrtPriceX96) / 2 ** 96, lower, upper);
  const px = spcxPrice(sqrtPriceX96), spcx = am.a0 / 1e18, usdg = am.a1 / 1e6;
  return { spcx, usdg, px, usd: spcx * px + usdg };
}
/** ¿El precio se acerca a la liquidación del corto? Distancia relativa (positiva = margen restante). */
export function liqDistance(px, liqPx) { return liqPx > 0 && px > 0 ? (liqPx - px) / px : Infinity; }
/** APR anual de un rendimiento `usd` cobrado sobre `capital` en `days`. */
export const aprOf = (usd, capital, days) => (days > 0.02 && capital > 0 ? usd / capital / days * 365 * 100 : null);
/** APR de las emisiones: lo cobrado sobre el LP inicial, en el tiempo que cubren los cobros (de la apertura al ÚLTIMO cobro).
 *  Medirlo hasta "ahora" lo hace bajar entre cobro y cobro (1 cobro de un día leído 31 h después marcaba 187 % en vez de 244 %,
 *  y justo antes del segundo cobro marcaría la mitad): engaña contra el criterio de 300 % / 150 %. Sin cobros → null. */
export const emissionsApr = (rewardsUsd, lp, entryAt, lastClaimAt) => (rewardsUsd > 0 && lastClaimAt > entryAt ? aprOf(rewardsUsd, lp, (lastClaimAt - entryAt) / 86400_000) : null);
/** Confirmación del reajuste del corto (2026-11-19). El precio de SPCX da saltos de 1–2 % que se devuelven en minutos (sobre todo
 *  en la apertura de EE.UU.): reajustar en el primer cruce del umbral vendía abajo y recompraba arriba. En 2.4 días, 5 idas y
 *  vueltas costaron ≈ $0.82 (0.55 % del LP); 3 de ellas se deshicieron en 7–11 min. Regla: el desfase tiene que seguir fuera del
 *  umbral, del mismo lado, `confirmMin` minutos seguidos; si pasa `urgentX` veces el umbral se reajusta de inmediato.
 *  `dev` = {since, sign, maxUsd} del episodio en curso (o null). Devuelve {trade, dev, ended}: `ended` = episodio que se deshizo solo. */
export function hedgeGate(o, dev, now, { minDiffUsd = 0, confirmMin = 15, urgentX = 2 } = {}) {
  if (!o?.sz) return { trade: false, dev: null, ended: dev ?? null };
  const sign = o.isBuy ? 1 : -1;
  const flipped = !!dev && dev.sign !== sign;
  const d = dev && !flipped ? { ...dev, maxUsd: Math.max(dev.maxUsd ?? 0, o.usd) } : { since: now, sign, maxUsd: o.usd };
  const urgent = minDiffUsd > 0 && o.usd >= minDiffUsd * urgentX;
  if (urgent || !(confirmMin > 0) || now - d.since >= confirmMin * 60_000) return { trade: true, dev: null, ended: null, urgent, waitedMin: (now - d.since) / 60_000 };
  return { trade: false, dev: d, ended: flipped ? dev : null, started: !dev || flipped };
}
/** ¿El ancho del rango actual ya no es el pedido (cambió SPX_RANGE_PCT)? Compara medio ancho en ticks con tolerancia del 25 %
 *  (el redondeo al espaciado mueve el ancho unos pocos %; pasar de ±10 % a ±5 % lo cambia 100 %). */
export function widthChanged(lower, upper, pct) {
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !(pct > 0) || upper <= lower) return false;
  const want = Math.log(1 + pct / 100) / Math.log(1.0001);
  return Math.abs((upper - lower) / 2 - want) / want > 0.25;
}

// ---------------------------------------------------------------- módulo (worker de Robinhood)
export class SpcxLp {
  constructor({ executor, provider, store, diag }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    this.cfg = {
      tag: process.env.SPX_OPEN || null,
      close: process.env.SPX_CLOSE || null,
      live: process.env.SPX_LIVE === "1",
      usd: Number(process.env.SPX_USD ?? 150),
      rangePct: Number(process.env.SPX_RANGE_PCT ?? 10),
      lev: Number(process.env.SPX_HEDGE_LEV ?? 4),
      rebalPct: Number(process.env.SPX_REBAL_PCT ?? 5),
      minOrderUsd: Number(process.env.SPX_MIN_ORDER_USD ?? 10.5),
      hedgeConfirmMin: Number(process.env.SPX_HEDGE_CONFIRM_MIN ?? 15),
      hedgeUrgentX: Number(process.env.SPX_HEDGE_URGENT_X ?? 3),
      reset: process.env.SPX_RESET || null, // etiqueta: reinicia la cuenta (inicio, cobros y contadores) una vez, con la lectura del momento
      outMin: Number(process.env.SPX_OUT_MIN ?? 60),
      claimEveryH: Number(process.env.SPX_CLAIM_EVERY_H ?? 24),
      compoundUsd: Number(process.env.SPX_COMPOUND_USD ?? 10),
      hlMarginUsd: Number(process.env.SPX_HL_MARGIN_USD ?? 38),
      marginWarn: Number(process.env.SPX_MARGIN_WARN ?? 0.6),
      liqClosePct: Number(process.env.SPX_LIQ_CLOSE_PCT ?? 5),
      slipBps: Number(process.env.SPX_SLIP_BPS ?? 100),
      everyS: Math.max(20, Number(process.env.SPX_EVERY_S ?? 60)),
      reportMin: Number(process.env.SPX_REPORT_MIN ?? 60),
      minEth: ethers.parseEther(process.env.SPX_MIN_ETH ?? "0.0003"),
    };
    this.busy = false; this.timer = null;
  }
  get me() { return this.x.wallet.address; }
  c(a) { return new ethers.Contract(a, I, this.provider); }
  dl() { return BigInt(Math.floor(Date.now() / 1000) + 600); }
  async init() {
    this.s = (await this.store.get("spcx")) ?? { runs: {}, actions: 0, recenters: 0, hedges: 0, rewardsUsd: 0, history: [], claims: [] };
    this.hl = await new Hl({ privateKey: process.env.PRIVATE_KEY.trim() }).init();
    const [d0, d1, t0] = await Promise.all([this.c(SPX.SPCX).decimals(), this.c(SPX.USDG).decimals(), this.c(SPX.POOL).token0()]);
    if (Number(d0) !== 18 || Number(d1) !== 6 || t0.toLowerCase() !== SPX.SPCX.toLowerCase()) throw new Error(`pool inesperado (dec ${d0}/${d1}, token0 ${t0})`);
    const code = await this.provider.getCode(SPX.NPM);
    if (!code.includes(I.getFunction("mint").selector.slice(2))) throw new Error("el gestor de posiciones no tiene el mint de Slipstream esperado");
    return this;
  }
  async save() { await this.store.set("spcx", this.s); }
  start() { const loop = async () => { await this.tick().catch(async (e) => { await this.note(`error ${(e.shortMessage || e.message || String(e)).slice(0, 200)}`).catch(() => {}); }); this.timer = setTimeout(loop, this.cfg.everyS * 1000); }; this.timer = setTimeout(loop, 5_000); }
  async note(m) { this.s.lastNote = m; await this.diag(`lp-spcx: ${m}`); }
  /** USDG apartado para la apertura (el DCA y el puente diario de Robinhood no lo usan). */
  reserveUsdg() { return !this.s?.tokenId && this.cfg.tag && !this.s?.runs?.[this.cfg.tag]?.done && !this.s?.closed ? ethers.parseUnits(this.cfg.usd.toFixed(2), 6) : 0n; }

  async sim(tx) { const t = { from: this.me, ...tx }; await this.provider.call(t); return (await this.provider.estimateGas(t)) * 13n / 10n; }
  async send(step, tx) {
    if (!this.cfg.live) throw new Error(`${step}: modo lectura`);
    const gasLimit = await this.sim(tx);
    const eth = await this.provider.getBalance(this.me), fee = await this.provider.getFeeData();
    if (eth - gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) < this.cfg.minEth) throw new Error(`${step}: dejaría menos de ${ethers.formatEther(this.cfg.minEth)} ETH de gas`);
    const r = await this.x.withSender((w) => w.sendTransaction({ ...tx, gasLimit }));
    const rc = await this.provider.waitForTransaction(r.hash, 1, 180_000);
    if (!rc || rc.status !== 1) throw new Error(`${step}: ${r.hash} ${rc ? "revertida" : "sin recibo"}`);
    this.s.actions++; this.s.lastTx = { step, hash: r.hash, at: Date.now() }; await this.save();
    return rc;
  }
  async approve(token, spender, amount, step) {
    if (BigInt(await this.c(token).allowance(this.me, spender)) >= amount) return;
    await this.send(`approve ${step}`, { to: token, data: I.encodeFunctionData("approve", [spender, ethers.MaxUint256]) });
  }
  async bal(token) { return BigInt(await this.c(token).balanceOf(this.me)); }

  /** Lectura completa: pool, posición, gauge, xAERO, Hyperliquid. */
  async read() {
    const [s0, xs0] = await Promise.all([this.c(SPX.POOL).slot0(), this.c(SPX.XAERO_POOL).slot0()]);
    const r = { sqrtP: s0[0], tick: Number(s0[1]), px: spcxPrice(s0[0]), xaeroPx: xaeroPrice(xs0[0]) };
    r.xaero = n(await this.bal(SPX.XAERO), 18); r.usdgW = n(await this.bal(SPX.USDG), 6); r.spcxW = n(await this.bal(SPX.SPCX), 18);
    r.eth = n(await this.provider.getBalance(this.me), 18);
    if (this.s.tokenId) {
      const p = await this.c(SPX.NPM).positions(this.s.tokenId);
      r.lower = Number(p.tickLower); r.upper = Number(p.tickUpper); r.L = p.liquidity;
      Object.assign(r, { lp: lpView(p.liquidity, s0[0], r.lower, r.upper) });
      r.inRange = r.tick >= r.lower && r.tick < r.upper;
      r.staked = (await this.c(SPX.NPM).ownerOf(this.s.tokenId)).toLowerCase() === SPX.GAUGE.toLowerCase();
    }
    r.m = await this.hl.mark(SPX.COIN); r.h = await this.hl.state(SPX.COIN);
    r.hlTotal = r.h.account + r.h.mainUsdc;
    // aviso una vez (y cada vez que cambie) de cómo se está leyendo la cuenta de Hyperliquid
    if (this._hlUnified !== r.h.unified) {
      this._hlUnified = r.h.unified;
      await this.note(`Hyperliquid: cuenta ${r.h.unified ? "unificada" : "estándar"} · saldo $${r.hlTotal.toFixed(2)}${r.h.unified ? ` (= USDC spot, ya incluye el PnL sin realizar $${(r.h.openPnl ?? 0).toFixed(2)}; el dex ${this.hl.dex} solo muestra $${r.h.dexAccount.toFixed(2)})` : ` (dex ${this.hl.dex} $${r.h.account.toFixed(2)} + principal $${r.h.mainUsdc.toFixed(2)})`} · margen usado $${r.h.marginUsed.toFixed(2)} (${(r.h.usage * 100).toFixed(0)} %)`);
    }
    r.capital = (r.lp?.usd ?? 0) + r.hlTotal + r.xaero * r.xaeroPx;
    return r;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      let r = await this.read();
      this.last = r;
      if (this.cfg.close && this.s.tokenId && !this.s.runs[`close:${this.cfg.close}`]?.done) { await this.closeAll(this.cfg.close, r); return; }
      if (!this.s.tokenId && this.cfg.tag && !this.s.runs[this.cfg.tag]?.done && !this.s.closed) {
        const st = this.s.runs[this.cfg.tag]?.step;
        if (this.cfg.live && (st === "swap" || st === "mint")) await this.resumeOpen(this.cfg.tag, r); else await this.open(this.cfg.tag, r);
        return;
      }
      if (!this.s.tokenId || this.s.closed) return;
      // apertura o re-centrado cortados después del mint: deposita la NFT en el gauge y fija el capital inicial
      if (this.cfg.live && r.staked === false && (r.L ?? 0n) > 0n) { await this.note(`#${this.s.tokenId} fuera del gauge → depósito`); await this.stake(this.s.tokenId, "reanudación"); r = await this.read(); }
      if (!this.s.entry && r.lp && Math.abs(r.h.size) > 0) { this.s.entry = { usd: r.capital, lp: r.lp.usd, hl: r.hlTotal, px: r.px, at: Date.now() }; if (this.cfg.tag && this.s.runs[this.cfg.tag]) { this.s.runs[this.cfg.tag].done = true; this.s.runs[this.cfg.tag].step = "hecho"; } }
      // margen y liquidación del corto
      const dist = liqDistance(r.m.px, r.h.liqPx);
      if (r.h.size < 0 && dist * 100 < this.cfg.liqClosePct) { await this.note(`precio a ${(dist * 100).toFixed(1)} % de la liquidación del corto → cierre`); await this.closeAll(`liq-${Date.now()}`, r); return; }
      if (r.h.usage > this.cfg.marginWarn && r.h.mainUsdc >= 1 && this.cfg.live) { await this.hl.moveUsdc(Math.floor(r.h.mainUsdc * 100) / 100, true); await this.note(`uso de margen ${(r.h.usage * 100).toFixed(0)} % → $${r.h.mainUsdc.toFixed(2)} del dex principal al xyz`); }
      // re-centrado
      this.s.outSince = r.inRange ? null : (this.s.outSince ?? Date.now());
      const pend = this.s.recenterPending?.from === this.s.tokenId;
      const width = this.cfg.live && r.staked !== undefined && widthChanged(r.lower, r.upper, this.cfg.rangePct);
      if (pend || width) {
        // re-centrado cortado a medias (los tokens están en la wallet) o cambio de ancho (SPX_RANGE_PCT): no se toca el corto hasta terminar
        if (Date.now() - (this.s.recenterTryAt ?? 0) < (pend ? 2 : 10) * 60_000) return;
        this.s.recenterTryAt = Date.now(); await this.save();
        await this.note(pend ? `reanuda el re-centrado de #${this.s.tokenId}` : `cambio de ancho: ±${this.cfg.rangePct} % (rango actual [${r.lower}, ${r.upper}]) → re-centra`);
        await this.recenter(r); r = await this.read();
      }
      else if (recenterDue(r.inRange, this.s.outSince, Date.now(), this.cfg.outMin)) { await this.recenter(r); r = await this.read(); }
      // cobro de emisiones y reinversión
      else if (Date.now() - (this.s.claimAt ?? this.s.openedAt ?? Date.now()) >= this.cfg.claimEveryH * 3600_000) { await this.claim(r); r = await this.read(); }
      // reinicio de la cuenta (Jose 2026-11-20: "reinicia la cuenta de la posición a partir de este nuevo rango"): una vez por etiqueta
      if (this.cfg.reset && this.s.resetTag !== this.cfg.reset && r.lp && r.inRange && Math.abs(r.h.size) > 0 && !this.s.recenterPending && !widthChanged(r.lower, r.upper, this.cfg.rangePct)) {
        const old = this.s.entry;
        this.s.entry = { usd: r.capital, lp: r.lp.usd, hl: r.hlTotal, px: r.px, at: Date.now() };
        Object.assign(this.s, { resetTag: this.cfg.reset, rewardsUsd: 0, claims: [], recenters: 0, hedges: 0, hedgeSkips: 0, hedgeSlipUsd: 0, reportAt: 0 });
        await this.note(`cuenta reiniciada (${this.cfg.reset}): inicio $${r.capital.toFixed(2)} = LP $${r.lp.usd.toFixed(2)} + Hyperliquid $${r.hlTotal.toFixed(2)} + xAERO en wallet $${(r.xaero * r.xaeroPx).toFixed(2)} · rango [${r.lower}, ${r.upper}] (±${this.cfg.rangePct} %) · SPCX $${r.px.toFixed(2)} · corto ${r.h.size}${old ? ` · cuenta anterior: inicio $${old.usd.toFixed(2)}, terminó en $${r.capital.toFixed(2)}` : ""}`);
        await this.save();
      }
      await this.hedge(r);
      await this.report(r);
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  async hedge(r) {
    const target = -(r.lp?.spcx ?? 0);
    const minDiffUsd = (r.lp?.usd ?? 0) * this.cfg.rebalPct / 100;
    const o = hedgeOrder(target, r.h.size, r.m.px, this.hl.szDec(SPX.COIN), { minUsd: this.cfg.minOrderUsd, minDiffUsd });
    if (!this.cfg.live) { if (o.sz) this.s.planHedge = { ...o, target, cur: r.h.size, at: Date.now() }; return null; }
    // confirmación: el desfase debe durar (o ser grande) para reajustar; los saltos que se devuelven solos no se operan
    const now = Date.now(), g = hedgeGate(o, this.s.hedgeDev ?? null, now, { minDiffUsd, confirmMin: this.cfg.hedgeConfirmMin, urgentX: this.cfg.hedgeUrgentX });
    this.s.hedgeDev = g.dev;
    if (g.ended) {
      this.s.hedgeSkips = (this.s.hedgeSkips ?? 0) + 1;
      await this.note(`reajuste evitado: el desfase (máx. $${(g.ended.maxUsd ?? 0).toFixed(2)}, pedía ${g.ended.sign > 0 ? "recomprar" : "vender"}) se deshizo solo en ${Math.max(1, Math.round((now - g.ended.since) / 60_000))} min · evitados ${this.s.hedgeSkips}`);
    }
    if (!g.trade) {
      if (g.started) await this.note(`desfase $${o.usd.toFixed(2)} (pide ${o.isBuy ? "recomprar" : "vender"} ${o.sz} SPCX): espera ${this.cfg.hedgeConfirmMin} min de confirmación (inmediato desde $${(minDiffUsd * this.cfg.hedgeUrgentX).toFixed(2)})`);
      return null;
    }
    const f = await this.hl.ioc(SPX.COIN, o.isBuy, o.sz, { reduceOnly: o.reduceOnly });
    this.s.hedges++;
    // deslizamiento contra el precio del perpetuo leído justo antes (lo único del reajuste que es costo puro; la comisión de Hyperliquid va aparte)
    const slip = Number.isFinite(Number(f.px)) && r.m.px > 0 ? Math.max(0, (o.isBuy ? Number(f.px) - r.m.px : r.m.px - Number(f.px)) * Number(f.sz)) : 0;
    this.s.hedgeSlipUsd = (this.s.hedgeSlipUsd ?? 0) + slip;
    await this.note(`corto ${o.isBuy ? "−" : "+"}${f.sz} SPCX a $${f.px} ($${(f.sz * f.px).toFixed(2)}) · objetivo ${target.toFixed(3)} · antes ${r.h.size} · ${g.urgent ? "inmediato (desfase grande)" : `confirmado ${Math.round(g.waitedMin)} min`} · perp $${r.m.px.toFixed(2)} · deslizamiento $${slip.toFixed(3)} (total $${this.s.hedgeSlipUsd.toFixed(2)})`);
    return f;
  }

  /** Reparte `usdg` (crudo) entre SPCX y USDG para el rango [lower, upper] con un swap en el mismo pool. */
  async splitAndSwap(x0, x1, sqrtP, lower, upper, step) {
    const sw = rebalanceSwap(Number(x0), Number(x1), Number(sqrtP) / 2 ** 96, lower, upper, this.cfg.slipBps);
    if (sw.amountIn <= 0n) return;
    const [tin, tout] = sw.sellToken0 ? [SPX.SPCX, SPX.USDG] : [SPX.USDG, SPX.SPCX];
    await this.approve(tin, SPX.ROUTER, sw.amountIn, step);
    await this.send(`swap ${step}`, { to: SPX.ROUTER, data: I.encodeFunctionData("exactInputSingle", [{ tokenIn: tin, tokenOut: tout, tickSpacing: SPX.SPACING, recipient: this.me, deadline: this.dl(), amountIn: sw.amountIn, amountOutMinimum: sw.minOut, sqrtPriceLimitX96: 0n }]) });
  }
  async mint(a0, a1, lower, upper, step) {
    await this.approve(SPX.SPCX, SPX.NPM, a0, step); await this.approve(SPX.USDG, SPX.NPM, a1, step);
    const rc = await this.send(`mint ${step}`, { to: SPX.NPM, data: I.encodeFunctionData("mint", [{ token0: SPX.SPCX, token1: SPX.USDG, tickSpacing: SPX.SPACING, tickLower: lower, tickUpper: upper, amount0Desired: a0, amount1Desired: a1, amount0Min: 0n, amount1Min: 0n, recipient: this.me, deadline: this.dl(), sqrtPriceX96: 0n }]) });
    let id = null;
    for (const lg of rc.logs) { if (lg.address.toLowerCase() !== SPX.NPM.toLowerCase()) continue; try { const ev = I.parseLog(lg); if (ev?.name === "Transfer" && ev.args.from === ethers.ZeroAddress && ev.args.to.toLowerCase() === this.me.toLowerCase()) id = ev.args.tokenId.toString(); } catch {} }
    if (!id) throw new Error(`mint ${step}: sin NFT en el recibo ${rc.hash}`);
    return id;
  }
  async stake(id, step) {
    await this.send(`approve gauge ${step}`, { to: SPX.NPM, data: I.encodeFunctionData("approve", [SPX.GAUGE, id]) });
    await this.send(`gauge deposit ${step}`, { to: SPX.GAUGE, data: I.encodeFunctionData("deposit", [id]) });
  }
  /** Saca la NFT del gauge (cobra el xAERO). Devuelve el xAERO recibido (crudo). */
  async unstake(id, step) {
    if ((await this.c(SPX.NPM).ownerOf(id)).toLowerCase() !== SPX.GAUGE.toLowerCase()) return 0n;
    const before = await this.bal(SPX.XAERO);
    await this.send(`gauge withdraw ${step}`, { to: SPX.GAUGE, data: I.encodeFunctionData("withdraw", [id]) });
    const got = (await this.bal(SPX.XAERO)) - before;
    return got > 0n ? got : 0n;
  }
  recordReward(raw, px) {
    const usd = n(raw, 18) * px;
    if (usd <= 0) return 0;
    this.s.rewardsUsd = (this.s.rewardsUsd ?? 0) + usd;
    this.s.claims = [...(this.s.claims ?? []), { t: Date.now(), xaero: n(raw, 18), usd }].slice(-60);
    return usd;
  }
  /** Vende todo el xAERO de la wallet a USDG (pool tickSpacing 200). Devuelve USDG recibido (crudo). */
  async sellXaero(step) {
    const amt = await this.bal(SPX.XAERO);
    if (amt === 0n) return 0n;
    const s0 = await this.c(SPX.XAERO_POOL).slot0(), px = xaeroPrice(s0[0]);
    const minOut = ethers.parseUnits((n(amt, 18) * px * (1 - this.cfg.slipBps * 2 / 10_000)).toFixed(6), 6);
    await this.approve(SPX.XAERO, SPX.ROUTER, amt, step);
    const before = await this.bal(SPX.USDG);
    await this.send(`venta xAERO ${step}`, { to: SPX.ROUTER, data: I.encodeFunctionData("exactInputSingle", [{ tokenIn: SPX.XAERO, tokenOut: SPX.USDG, tickSpacing: SPX.XAERO_SPACING, recipient: this.me, deadline: this.dl(), amountIn: amt, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }]) });
    const got = (await this.bal(SPX.USDG)) - before;
    this.s.xaeroSold = [...(this.s.xaeroSold ?? []), { t: Date.now(), xaero: n(amt, 18), usdg: n(got, 6), expected: n(amt, 18) * px }].slice(-30);
    return got;
  }

  async open(tag, r) {
    const run = (this.s.runs[tag] ??= { startedAt: Date.now(), step: "inicio" });
    const usdgNeed = ethers.parseUnits(this.cfg.usd.toFixed(2), 6), usdgHave = await this.bal(SPX.USDG);
    const hlHave = r.hlTotal;
    const lo = rangeTicks(r.tick, this.cfg.rangePct, SPX.SPACING);
    const plan = rebalanceSwap(0, Number(usdgNeed), Number(r.sqrtP) / 2 ** 96, lo.lower, lo.upper, this.cfg.slipBps);
    const spcxOut = Number(plan.amountIn) / 1e6 / r.px;
    const summary = `apertura ${tag}: $${this.cfg.usd} · rango [${lo.lower}, ${lo.upper}] (±${this.cfg.rangePct} %, SPCX $${(r.px * 1.0001 ** (lo.lower - r.tick)).toFixed(2)}–$${(r.px * 1.0001 ** (lo.upper - r.tick)).toFixed(2)}) · swap ${n(plan.amountIn, 6).toFixed(2)} USDG → ~${spcxOut.toFixed(4)} SPCX · corto ~${spcxOut.toFixed(2)} ${SPX.COIN} (${(spcxOut * r.m.px).toFixed(2)} $) a ${this.cfg.lev}× · USDG en wallet ${n(usdgHave, 6).toFixed(2)}/${this.cfg.usd} · Hyperliquid $${hlHave.toFixed(2)}/${this.cfg.hlMarginUsd} · SPCX pool $${r.px.toFixed(2)} vs perp $${r.m.px.toFixed(2)} · funding ${(r.m.funding * 8760 * 100).toFixed(1)} %/año`;
    // margen de Hyperliquid desde el USDG sobrante de Robinhood (lo que pasa del LP), con Relay; una vez cada 30 min mientras falte
    if (this.cfg.live && hlHave < this.cfg.hlMarginUsd * 0.9 && usdgHave >= usdgNeed && Date.now() - (run.hlFundAt ?? 0) > 30 * 60_000) {
      const spare = n(usdgHave - usdgNeed, 6), want = +(this.cfg.hlMarginUsd - hlHave + 1.5).toFixed(2);
      if (spare >= Math.max(6, want)) { run.hlFundAt = Date.now(); await this.fundHl(want); return; }
    }
    const funded = usdgHave >= usdgNeed && hlHave >= this.cfg.hlMarginUsd * 0.9;
    if (!this.cfg.live || !funded) {
      if (Date.now() - (run.noteAt ?? 0) > 3600_000) { run.noteAt = Date.now(); await this.note(`${this.cfg.live ? "" : "(lectura) "}${summary} · ${funded ? "fondos listos" : "esperando fondos"}${this.cfg.live ? "" : " · no envía nada (SPX_LIVE=1 para abrir)"}`); }
      return;
    }
    await this.note(summary);
    // margen en el dex xyz y apalancamiento
    if (r.h.account < this.cfg.hlMarginUsd * 0.9 && r.h.mainUsdc > 1) await this.hl.moveUsdc(Math.floor(r.h.mainUsdc * 100) / 100, true);
    await this.hl.setLeverage(SPX.COIN, this.cfg.lev).catch(async (e) => this.note(`apalancamiento: ${e.message}`));
    run.step = "swap"; await this.save();
    await this.splitAndSwap(0n, usdgNeed, r.sqrtP, lo.lower, lo.upper, "apertura");
    const a0 = await this.bal(SPX.SPCX), usdgNow = await this.bal(SPX.USDG);
    const a1 = usdgNow - (usdgHave - usdgNeed) > 0n ? usdgNow - (usdgHave - usdgNeed) : 0n; // solo lo apartado; el resto de la wallet no se toca
    await this.finishOpen(run, lo, a0, a1);
  }
  /** Reanuda una apertura cortada a media (p. ej. reinicio tras el swap): usa el SPCX de la wallet y completa con USDG hasta SPX_USD. */
  async resumeOpen(tag, r) {
    const run = this.s.runs[tag];
    const x0 = await this.bal(SPX.SPCX), usdgHave = await this.bal(SPX.USDG);
    const v0 = n(x0, 18) * r.px, needU = Math.max(0, this.cfg.usd - v0);
    let x1 = ethers.parseUnits(needU.toFixed(6), 6); if (x1 > usdgHave) x1 = usdgHave;
    const lo = rangeTicks(r.tick, this.cfg.rangePct, SPX.SPACING);
    await this.note(`reanuda apertura ${tag} (paso "${run.step}"): ${n(x0, 18).toFixed(4)} SPCX ($${v0.toFixed(2)}) + ${n(x1, 6).toFixed(2)} USDG · rango [${lo.lower}, ${lo.upper}]`);
    if (r.h.account < this.cfg.hlMarginUsd * 0.9 && r.h.mainUsdc > 1) await this.hl.moveUsdc(Math.floor(r.h.mainUsdc * 100) / 100, true);
    await this.hl.setLeverage(SPX.COIN, this.cfg.lev).catch(async (e) => this.note(`apalancamiento: ${e.message}`));
    const b0 = x0, bU = usdgHave;
    await this.splitAndSwap(x0, x1, r.sqrtP, lo.lower, lo.upper, "apertura (ajuste)");
    const a0 = await this.bal(SPX.SPCX), uNow = await this.bal(SPX.USDG);
    const a1 = uNow - (bU - x1) > 0n ? uNow - (bU - x1) : 0n;
    void b0;
    await this.finishOpen(run, lo, a0, a1);
  }
  async finishOpen(run, lo, a0, a1) {
    run.step = "mint"; await this.save();
    const id = await this.mint(a0, a1, lo.lower, lo.upper, "apertura");
    this.s.tokenId = id; this.s.openedAt = Date.now(); this.s.claimAt = Date.now(); await this.save();
    run.step = "gauge";
    await this.stake(id, "apertura");
    const r2 = await this.read();
    await this.hedge(r2);
    const r3 = await this.read();
    this.s.entry = { usd: r3.capital, lp: r3.lp.usd, hl: r3.hlTotal, px: r3.px, at: Date.now() };
    run.done = true; run.step = "hecho";
    await this.note(`abierta #${id} · LP $${r3.lp.usd.toFixed(2)} (${r3.lp.spcx.toFixed(4)} SPCX + ${r3.lp.usdg.toFixed(2)} USDG) en gauge · corto ${r3.h.size} SPCX · capital $${r3.capital.toFixed(2)}`);
  }

  /** USDG de Robinhood → USDC de Hyperliquid (cuenta = esta wallet) con Relay. */
  async fundHl(usd) {
    const me = this.me, amt = ethers.parseUnits(usd.toFixed(2), 6);
    const body = { user: me, recipient: me, originChainId: 4663, destinationChainId: 1337, originCurrency: SPX.USDG, destinationCurrency: "0x00000000000000000000000000000000", amount: amt.toString(), tradeType: "EXACT_INPUT" };
    const res = await fetch(`${process.env.RELAY_API || "https://api.relay.link"}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const q = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? "").slice(0, 160)}`);
    const qp = parseQuote(q);
    if (!qp.txs.length || qp.txs.some((t) => t.chainId !== 4663)) throw new Error("cotización de Relay inesperada");
    const feePct = qp.inUsd > 0 && qp.outUsd > 0 ? (1 - qp.outUsd / qp.inUsd) * 100 : null;
    if (feePct !== null && feePct > 8) throw new Error(`comisión de Relay ${feePct.toFixed(1)} %`);
    const hashes = [];
    for (const t of qp.txs) hashes.push((await this.send(`relay ${t.step} → Hyperliquid`, { to: t.to, data: t.data, value: t.value })).hash);
    await this.note(`margen: $${usd} USDG → ~$${qp.outUsd?.toFixed?.(2) ?? "?"} USDC en Hyperliquid vía Relay (comisión ${feePct?.toFixed?.(2) ?? "?"} %) · txs ${hashes.join(", ")}`);
  }

  async claim(r) {
    if (!this.cfg.live) { this.s.claimAt = Date.now(); return; }
    const id = this.s.tokenId;
    const got = await this.unstake(id, "cobro");
    const usd = this.recordReward(got, r.xaeroPx);
    const walletUsd = n(await this.bal(SPX.XAERO), 18) * r.xaeroPx;
    let added = 0;
    if (walletUsd >= this.cfg.compoundUsd) {
      const usdg = await this.sellXaero("reinversión");
      const s0 = await this.c(SPX.POOL).slot0();
      const before0 = await this.bal(SPX.SPCX), beforeU = await this.bal(SPX.USDG);
      await this.splitAndSwap(0n, usdg, s0[0], r.lower, r.upper, "reinversión");
      const a0 = (await this.bal(SPX.SPCX)) - before0 + 0n, aU = (await this.bal(SPX.USDG)) - (beforeU - usdg);
      const add0 = a0 > 0n ? a0 : 0n, add1 = aU > 0n ? aU : 0n;
      await this.approve(SPX.SPCX, SPX.NPM, add0, "reinversión"); await this.approve(SPX.USDG, SPX.NPM, add1, "reinversión");
      await this.send("increaseLiquidity reinversión", { to: SPX.NPM, data: I.encodeFunctionData("increaseLiquidity", [{ tokenId: id, amount0Desired: add0, amount1Desired: add1, amount0Min: 0n, amount1Min: 0n, deadline: this.dl() }]) });
      added = n(usdg, 6);
    }
    await this.stake(id, "cobro");
    this.s.claimAt = Date.now();
    await this.note(`cobro #${id}: ${n(got, 18).toFixed(4)} xAERO ($${usd.toFixed(2)})${added ? ` · reinvertidos $${added.toFixed(2)} en el LP` : ` · acumulado $${walletUsd.toFixed(2)} (reinvierte desde $${this.cfg.compoundUsd})`}`);
  }

  /** Retira toda la liquidez y cobra (NFT fuera del gauge). Devuelve [spcx, usdg] crudos recibidos. */
  async drain(id, step) {
    const got = await this.unstake(id, step);
    this.recordReward(got, this.last?.xaeroPx ?? 0);
    const p = await this.c(SPX.NPM).positions(id);
    const b0 = await this.bal(SPX.SPCX), b1 = await this.bal(SPX.USDG);
    if (p.liquidity > 0n) await this.send(`decreaseLiquidity ${step}`, { to: SPX.NPM, data: I.encodeFunctionData("decreaseLiquidity", [{ tokenId: id, liquidity: p.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: this.dl() }]) });
    await this.send(`collect ${step}`, { to: SPX.NPM, data: I.encodeFunctionData("collect", [{ tokenId: id, recipient: this.me, amount0Max: MAX128, amount1Max: MAX128 }]) });
    return [(await this.bal(SPX.SPCX)) - b0, (await this.bal(SPX.USDG)) - b1];
  }

  async recenter(r) {
    if (!this.cfg.live) { if (Date.now() - (this.s.dryRecenterNoteAt ?? 0) > 3600_000) { this.s.dryRecenterNoteAt = Date.now(); await this.note(`(lectura) fuera de rango ${this.cfg.outMin} min → re-centraría`); } return; }
    const from = this.s.tokenId;
    // Reanudable: antes de retirar se guarda lo que ya había en la wallet (no se toca). Si un paso falla después del retiro,
    // la siguiente pasada sigue con lo que haya de más en la wallet en vez de intentar retirar otra vez una NFT vacía.
    let pd = this.s.recenterPending?.from === from ? this.s.recenterPending : null;
    const rew0 = this.s.rewardsUsd ?? 0;
    if (!pd) {
      pd = this.s.recenterPending = { from, base0: (await this.bal(SPX.SPCX)).toString(), base1: (await this.bal(SPX.USDG)).toString(), at: Date.now() };
      await this.save();
    }
    await this.drain(from, "re-centrado"); // en la reanudación no hace nada (ya está fuera del gauge y sin liquidez)
    await this.save();
    if (n(await this.bal(SPX.XAERO), 18) * r.xaeroPx >= this.cfg.compoundUsd) await this.sellXaero("re-centrado");
    const s0 = await this.c(SPX.POOL).slot0(), tick = Number(s0[1]);
    const lo = rangeTicks(tick, this.cfg.rangePct, SPX.SPACING);
    const base0 = BigInt(pd.base0), base1 = BigInt(pd.base1);
    const pos = (v) => (v > 0n ? v : 0n);
    const x0 = pos((await this.bal(SPX.SPCX)) - base0), x1 = pos((await this.bal(SPX.USDG)) - base1);
    if (x0 === 0n && x1 === 0n) throw new Error(`re-centrado de #${from}: no hay SPCX ni USDG de la posición en la wallet`);
    await this.splitAndSwap(x0, x1, s0[0], lo.lower, lo.upper, "re-centrado");
    const a0 = pos((await this.bal(SPX.SPCX)) - base0), a1 = pos((await this.bal(SPX.USDG)) - base1);
    const id = await this.mint(a0, a1, lo.lower, lo.upper, "re-centrado");
    this.s.tokenId = id; this.s.outSince = null; this.s.recenters++; this.s.recenterPending = null;
    this.s.history = [...(this.s.history ?? []), { t: Date.now(), from, to: id, tick }].slice(-50);
    await this.save();
    await this.stake(id, "re-centrado");
    this.s.claimAt = Date.now();
    const rew = (this.s.rewardsUsd ?? 0) - rew0;
    await this.note(`re-centrado #${from} → #${id} · rango [${lo.lower}, ${lo.upper}] (±${this.cfg.rangePct} %, SPCX $${(spcxPrice(s0[0]) * 1.0001 ** (lo.lower - tick)).toFixed(2)}–$${(spcxPrice(s0[0]) * 1.0001 ** (lo.upper - tick)).toFixed(2)}) · SPCX $${spcxPrice(s0[0]).toFixed(2)}${rew > 0 ? ` · xAERO cobrado al salir del gauge $${rew.toFixed(2)}` : ""}`);
  }

  async closeAll(tag, r) {
    const run = (this.s.runs[`close:${tag}`] ??= { startedAt: Date.now() });
    if (!this.cfg.live) { await this.note(`(lectura) cierre ${tag}: sacaría #${this.s.tokenId} del gauge, vendería todo a USDG y cerraría el corto de ${r.h.size}`); run.done = true; return; }
    const id = this.s.tokenId;
    const [x0] = await this.drain(id, "cierre");
    if (x0 > 0n) {
      const s0 = await this.c(SPX.POOL).slot0(), px = spcxPrice(s0[0]);
      const minOut = ethers.parseUnits((n(x0, 18) * px * (1 - this.cfg.slipBps / 10_000)).toFixed(6), 6);
      await this.approve(SPX.SPCX, SPX.ROUTER, x0, "cierre");
      await this.send("swap cierre SPCX→USDG", { to: SPX.ROUTER, data: I.encodeFunctionData("exactInputSingle", [{ tokenIn: SPX.SPCX, tokenOut: SPX.USDG, tickSpacing: SPX.SPACING, recipient: this.me, deadline: this.dl(), amountIn: x0, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }]) });
    }
    if (n(await this.bal(SPX.XAERO), 18) * (r.xaeroPx || 0) >= 1) await this.sellXaero("cierre");
    const h = await this.hl.state(SPX.COIN);
    if (h.size < 0) await this.hl.ioc(SPX.COIN, true, Math.abs(h.size), { reduceOnly: true, slip: 0.02 });
    const h2 = await this.hl.state(SPX.COIN);
    if (h2.withdrawable > 0.5) await this.hl.moveUsdc(Math.floor(h2.withdrawable * 100) / 100, false).catch(() => {});
    this.s.closed = true; run.done = true;
    const r2 = await this.read();
    await this.note(`cerrada #${id} (${tag}) · USDG en wallet ${r2.usdgW.toFixed(2)} · Hyperliquid $${r2.hlTotal.toFixed(2)} · resultado ${this.s.entry ? `$${(r2.usdgW - 0 + r2.hlTotal - this.s.entry.usd).toFixed(2)} aprox.` : "—"}`);
  }

  view() {
    const r = this.last;
    return { ready: !!r, live: this.cfg.live, tokenId: this.s?.tokenId ?? null, closed: !!this.s?.closed, entry: this.s?.entry ?? null, rewardsUsd: this.s?.rewardsUsd ?? 0, recenters: this.s?.recenters ?? 0, hedges: this.s?.hedges ?? 0, lastNote: this.s?.lastNote ?? null, planHedge: this.s?.planHedge ?? null,
      now: r ? { px: r.px, perp: r.m.px, funding: r.m.funding, inRange: r.inRange ?? null, lp: r.lp ?? null, short: r.h.size, liqPx: r.h.liqPx, usage: r.h.usage, hl: r.hlTotal, xaero: r.xaero, xaeroPx: r.xaeroPx, capital: r.capital, usdgWallet: r.usdgW, eth: r.eth } : null };
  }

  async report(r) {
    if (Date.now() - (this.s.reportAt ?? 0) < this.cfg.reportMin * 60_000) return;
    this.s.reportAt = Date.now();
    const e = this.s.entry;
    const net = (r.lp?.spcx ?? 0) + r.h.size;
    const rew = this.s.rewardsUsd ?? 0;
    const res = e ? r.capital - e.usd : null;
    await this.note(`#${this.s.tokenId} · LP $${r.lp.usd.toFixed(2)} ${r.inRange ? "en rango" : `FUERA de rango desde ${this.s.outSince ? Math.round((Date.now() - this.s.outSince) / 60000) + " min" : "?"}`} [${r.lower}, ${r.upper}] · SPCX en LP ${r.lp.spcx.toFixed(4)} · corto ${r.h.size} · neto ${net.toFixed(4)} SPCX ($${(net * r.px).toFixed(2)}) · Hyperliquid $${r.hlTotal.toFixed(2)} uso ${(r.h.usage * 100).toFixed(0)} %${r.h.liqPx ? ` liq $${r.h.liqPx.toFixed(2)}` : ""} · funding ${(r.m.funding * 8760 * 100).toFixed(1)} %/año (cobrado $${r.h.funding.toFixed(3)}) · xAERO cobrado $${rew.toFixed(2)} (sin vender en wallet $${(r.xaero * r.xaeroPx).toFixed(2)}) = ${emissionsApr(rew, e?.lp ?? 0, e?.at ?? 0, (this.s.claims ?? []).at(-1)?.t ?? 0)?.toFixed(0) ?? "—"} % anual sobre el LP · capital $${r.capital.toFixed(2)}${e ? ` (inicio $${e.usd.toFixed(2)}, ${res >= 0 ? "+" : ""}$${res.toFixed(2)} = ${(res / e.usd * 100).toFixed(2)} %)` : ""} · SPCX $${r.px.toFixed(2)} perp $${r.m.px.toFixed(2)} · re-centrados ${this.s.recenters} reajustes ${this.s.hedges}`);
  }
}

// ---------------------------------------------------------------- fondeo (worker de Base)
/** SPX_FUND="robinhood:110,hyperliquid:42@etiqueta" → [{dest, usd}], tag (pura, probada).
 *  Un tramo "hyperliquid:20:eth" (Jose 2026-11-20: "usen fondos de donde haya", para el margen del corto) se paga con el ETH de
 *  Base que sobra de la reserva de gas, en una sola tx de Relay; nunca toma USDC de Base (ese es del depósito diario). */
export function parseSpxFund(v) {
  const m = /^\s*(.+?)\s*@\s*([\w.-]+)\s*$/.exec(v ?? "");
  if (!m) return null;
  const legs = m[1].split(",").map((x) => x.trim()).filter(Boolean).map((x) => { const [dest, usd, src] = x.split(":"); const l = { dest: dest.trim().toLowerCase(), usd: Number(usd) }; if (/^eth$/i.test((src ?? "").trim())) l.src = "eth"; return l; }).filter((l) => ["robinhood", "hyperliquid"].includes(l.dest) && l.usd > 0);
  return legs.length ? { legs, tag: m[2] } : null;
}
const DEST = { robinhood: { id: 4663, currency: SPX.USDG }, hyperliquid: { id: 1337, currency: "0x00000000000000000000000000000000" } };
export class SpcxFund {
  constructor({ executor, provider, store, diag }) { this.x = executor; this.provider = provider; this.store = store; this.diag = diag; this.busy = false; this.nextAt = 0; }
  get plan() { return parseSpxFund(process.env.SPX_FUND); }
  async init() { this.s = (await this.store.get("spcxfund")) ?? {}; }
  async save() { await this.store.set("spcxfund", this.s); }
  /** USDC de Base apartado para los tramos pendientes (el DCA y las recargas no lo usan). */
  reserve() { const p = this.plan; if (!p) return 0n; const st = this.s?.[p.tag] ?? {}; const usd = p.legs.filter((l) => !st[l.dest]?.done && l.src !== "eth").reduce((a, l) => a + l.usd, 0); return ethers.parseUnits(usd.toFixed(2), 6); }
  async onBlock() {
    const p = this.plan;
    if (!p || this.busy || Date.now() < this.nextAt || !this.x?.wallet || this.x.mode !== "live") return;
    this.busy = true; this.nextAt = Date.now() + 60_000;
    const st = (this.s[p.tag] ??= {});
    try {
      const me = this.x.wallet.address;
      for (const l of p.legs) {
        const L = (st[l.dest] ??= {});
        if (L.done || (L.retryAt && Date.now() < L.retryAt) || L.final) continue;
        if (l.src === "eth") { await this.legFromEth(p.tag, l, L, me); await this.save(); return; }
        const usdc = BigInt(await this.provider.call({ to: BASE_USDC, data: I.encodeFunctionData("balanceOf", [me]) }));
        const amt = ethers.parseUnits(l.usd.toFixed(2), 6);
        if (usdc < amt) { if (Date.now() - (L.waitAt ?? 0) > 3600_000) { L.waitAt = Date.now(); await this.diag(`spcx fondeo ${p.tag}: ${l.dest} $${l.usd} esperando USDC en Base (hay ${ethers.formatUnits(usdc, 6)})`); } return; }
        const d = DEST[l.dest];
        const body = { user: me, recipient: me, originChainId: BASE_ID, destinationChainId: d.id, originCurrency: BASE_USDC, destinationCurrency: d.currency, amount: amt.toString(), tradeType: "EXACT_INPUT" };
        const res = await fetch(`${process.env.RELAY_API || "https://api.relay.link"}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
        const q = await res.json().catch(() => null);
        if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? "").slice(0, 160)}`);
        const qp = parseQuote(q);
        if (!qp.txs.length || qp.txs.some((t) => t.chainId !== BASE_ID)) throw new Error("cotización de Relay inesperada");
        const feePct = qp.inUsd > 0 && qp.outUsd > 0 ? (1 - qp.outUsd / qp.inUsd) * 100 : null;
        if (feePct !== null && feePct > Number(process.env.SPX_FUND_MAX_FEE_PCT ?? 5)) throw new Error(`comisión ${feePct.toFixed(1)} %`);
        const hashes = [];
        for (const t of qp.txs) {
          const tx = { from: me, to: t.to, data: t.data, value: t.value };
          await this.provider.call(tx);
          const gasLimit = (await this.provider.estimateGas(tx)) * 13n / 10n;
          const sent = await this.x.withSender((w) => w.sendTransaction({ to: t.to, data: t.data, value: t.value, gasLimit }));
          const rc = await this.provider.waitForTransaction(sent.hash, 1, 120_000);
          if (!rc || rc.status !== 1) throw new Error(`${t.step} ${sent.hash} ${rc ? "revertida" : "sin recibo"}`);
          hashes.push(sent.hash);
        }
        Object.assign(L, { done: true, at: new Date().toISOString(), outUsd: qp.outUsd, feePct, txs: hashes });
        await this.diag(`spcx fondeo ${p.tag}: $${l.usd} USDC de Base → ~$${qp.outUsd?.toFixed?.(2) ?? "?"} en ${l.dest} vía Relay (comisión ${feePct?.toFixed?.(2) ?? "?"} %) · txs ${hashes.join(", ")}`);
        await this.save();
        return; // un tramo por vuelta
      }
    } catch (e) {
      const msg = (e.shortMessage || e.message || String(e)).slice(0, 240);
      const L = Object.values(st).find((x) => !x.done) ?? {};
      L.n = (L.n ?? 0) + 1; L.retryAt = Date.now() + 10 * 60_000; if (L.n > 10) L.final = true;
      await this.diag(`spcx fondeo ${p.tag}: intento ${L.n} falló · ${msg}`);
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }
  async relayQuote(body) {
    const res = await fetch(`${process.env.RELAY_API || "https://api.relay.link"}/quote/v2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    const q = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Relay ${res.status}: ${(q?.message ?? "").slice(0, 160)}`);
    return parseQuote(q);
  }
  /** Tramo pagado con el ETH de Base que sobra de la reserva de gas → destino con Relay (una sola tx con valor, hacia un contrato). */
  async legFromEth(tag, l, L, me) {
    const d = DEST[l.dest];
    const reserve = ethers.parseEther(Math.max(0.003, Number(process.env.NLP2_FUND_GAS_RESERVE_ETH ?? 0.01) || 0.01).toFixed(6));
    const avail = (await this.provider.getBalance(me)) - reserve;
    const base = { user: me, recipient: me, originChainId: BASE_ID, destinationChainId: d.id, originCurrency: ethers.ZeroAddress, destinationCurrency: d.currency, tradeType: "EXACT_INPUT" };
    const wait = async (why) => { if (Date.now() - (L.waitAt ?? 0) > 3600_000) { L.waitAt = Date.now(); await this.diag(`spcx fondeo ${tag}: ${l.dest} $${l.usd} con ETH de Base · ${why}`); } };
    if (avail <= 0n) return wait("no hay ETH por encima de la reserva de gas");
    const all = await this.relayQuote({ ...base, amount: avail.toString() });
    if (!(all.inUsd > 0) || all.inUsd < l.usd * 1.02) return wait(`el ETH disponible vale $${Number(all.inUsd).toFixed(2)}: no alcanza`);
    const amount = avail * BigInt(Math.round(l.usd * 1.01 / all.inUsd * 1e6)) / 1_000_000n;
    const qp = await this.relayQuote({ ...base, amount: amount.toString() });
    if (qp.txs.length !== 1 || qp.txs[0].chainId !== BASE_ID) throw new Error(`cotización de Relay inesperada (${qp.txs.length} tx)`);
    const t = qp.txs[0];
    if (t.value !== amount) throw new Error("la cotización de Relay no manda exactamente el monto pedido; no se firma");
    if (["0xa9059cbb", "0x23b872dd"].includes(String(t.data).slice(0, 10).toLowerCase())) throw new Error("la cotización de Relay pide un envío directo; no se firma");
    if ((await this.provider.getCode(t.to)) === "0x") throw new Error("el destino de la cotización no es un contrato; no se firma");
    if (!Number.isFinite(qp.inUsd) || !Number.isFinite(qp.outUsd) || !(qp.inUsd > 0)) throw new Error("cotización de Relay sin valores en dólares");
    if (qp.inUsd > l.usd * 1.1) throw new Error(`la cotización saldría en $${qp.inUsd.toFixed(2)}, más de lo pedido ($${l.usd})`);
    const feePct = (1 - qp.outUsd / qp.inUsd) * 100;
    if (feePct > Number(process.env.SPX_FUND_MAX_FEE_PCT ?? 5)) throw new Error(`comisión ${feePct.toFixed(1)} %`);
    const tx = { from: me, to: t.to, data: t.data, value: t.value };
    await this.provider.call(tx);
    const gasLimit = (await this.provider.estimateGas(tx)) * 13n / 10n;
    const sent = await this.x.withSender((w) => w.sendTransaction({ to: t.to, data: t.data, value: t.value, gasLimit }));
    Object.assign(L, { done: true, at: new Date().toISOString(), outUsd: qp.outUsd, feePct, txs: [sent.hash], eth: ethers.formatEther(amount) }); // enviado = hecho: nunca se manda dos veces
    await this.save();
    const rc = await this.provider.waitForTransaction(sent.hash, 1, 120_000).catch(() => null);
    await this.diag(`spcx fondeo ${tag}: ${Number(ethers.formatEther(amount)).toFixed(6)} ETH de Base ($${qp.inUsd.toFixed(2)}; queda la reserva de gas) → ~$${qp.outUsd.toFixed(2)} en ${l.dest} vía Relay (comisión ${feePct.toFixed(2)} %) · tx ${sent.hash}${!rc ? " · sin recibo todavía" : rc.status !== 1 ? " · REVERTIDA: no llegó, hay que repetirlo con otra etiqueta" : ""}`);
  }
}
