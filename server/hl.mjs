// Cliente mínimo de Hyperliquid para la cobertura de lp-spcx (Jose 2026-11-16): SDK @nktkas/hyperliquid con la llave del bot.
// Mercados HIP-3 ("xyz:SPCX"): el margen de cada dex es aparte; el USDC se pasa del dex principal al "xyz" con sendAsset.
// Órdenes: IOC límite a mark ± deslizamiento (equivale a mercado con tope de precio).
import { ethers } from "ethers";
import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { SymbolConverter, formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

/** Tamaño a operar para llevar la posición de `cur` a `target` (negativo = corto), redondeado a szDecimals; 0 si la orden quedaría
 *  bajo `minUsd` o el desfase es menor que `minDiffUsd` (pura, probada). */
export function hedgeOrder(target, cur, px, szDecimals, { minUsd = 10.5, minDiffUsd = 0 } = {}) {
  const diff = target - cur;
  const q = 10 ** szDecimals;
  const sz = Math.round(Math.abs(diff) * q) / q;
  if (sz === 0 || !(px > 0)) return { sz: 0, isBuy: diff > 0, reason: "sin desfase" };
  const usd = sz * px;
  if (usd < minDiffUsd) return { sz: 0, isBuy: diff > 0, reason: `desfase $${usd.toFixed(2)} bajo el umbral $${minDiffUsd.toFixed(2)}` };
  if (usd < minUsd) return { sz: 0, isBuy: diff > 0, reason: `desfase $${usd.toFixed(2)} bajo la orden mínima $${minUsd}` };
  // reduceOnly cuando solo achica el corto sin cruzar a largo
  const reduceOnly = cur < 0 && diff > 0 && target <= 0;
  return { sz, isBuy: diff > 0, usd, reduceOnly };
}

export class Hl {
  constructor({ privateKey, dex = "xyz" }) {
    this.wallet = new ethers.Wallet(privateKey);
    this.me = this.wallet.address;
    this.dex = dex;
    this.t = new HttpTransport({ timeout: 20_000 });
    this.info = new InfoClient({ transport: this.t });
    this.ex = new ExchangeClient({ transport: this.t, wallet: this.wallet });
  }
  async init() {
    this.conv = await SymbolConverter.create({ transport: this.t, dexs: [this.dex] });
    const sm = await this.info.spotMeta();
    const u = sm.tokens.find((x) => x.name === "USDC");
    this.usdcToken = u ? `${u.name}:${u.tokenId}` : "USDC";
    return this;
  }
  asset(coin) { const a = this.conv.getAssetId(coin); if (a === undefined) throw new Error(`Hyperliquid: ${coin} no existe`); return a; }
  szDec(coin) { return this.conv.getSzDecimals(coin) ?? 0; }
  /** Precio marca y funding (por hora) del activo del dex. */
  async mark(coin) {
    const [meta, ctxs] = await this.info.metaAndAssetCtxs({ dex: this.dex });
    const i = meta.universe.findIndex((x) => x.name === coin);
    if (i < 0) throw new Error(`Hyperliquid: ${coin} sin contexto`);
    return { px: Number(ctxs[i].markPx), oracle: Number(ctxs[i].oraclePx), funding: Number(ctxs[i].funding), maxLev: meta.universe[i].maxLeverage };
  }
  /** Estado del dex: posición del activo (tamaño con signo), margen, valor de la cuenta y USDC del dex principal. */
  async state(coin) {
    const [d, main] = await Promise.all([this.info.clearinghouseState({ user: this.me, dex: this.dex }), this.info.clearinghouseState({ user: this.me })]);
    const p = d.assetPositions.find((x) => x.position.coin === coin)?.position;
    const acct = Number(d.marginSummary.accountValue), used = Number(d.marginSummary.totalMarginUsed);
    return {
      size: p ? Number(p.szi) : 0, entry: p ? Number(p.entryPx) : null, upnl: p ? Number(p.unrealizedPnl) : 0, liqPx: p?.liquidationPx ? Number(p.liquidationPx) : null,
      funding: p ? -Number(p.cumFunding?.sinceOpen ?? 0) : 0, // positivo = cobrado
      account: acct, marginUsed: used, usage: acct > 0 ? used / acct : 0, withdrawable: Number(d.withdrawable),
      mainUsdc: Number(main.withdrawable),
    };
  }
  async setLeverage(coin, lev) { return this.ex.updateLeverage({ asset: this.asset(coin), isCross: true, leverage: lev }); }
  /** Orden IOC con tope de precio = mark ± slip. Devuelve tamaño y precio promedio ejecutados. */
  async ioc(coin, isBuy, sz, { slip = 0.01, reduceOnly = false } = {}) {
    const { px } = await this.mark(coin), d = this.szDec(coin);
    const limit = formatPrice(String(px * (isBuy ? 1 + slip : 1 - slip)), d);
    const r = await this.ex.order({ orders: [{ a: this.asset(coin), b: isBuy, p: limit, s: formatSize(String(sz), d), r: reduceOnly, t: { limit: { tif: "Ioc" } } }], grouping: "na" });
    const st = r.response.data.statuses[0];
    if (st?.filled) return { sz: Number(st.filled.totalSz), px: Number(st.filled.avgPx), oid: st.filled.oid };
    throw new Error(`Hyperliquid: orden sin ejecutar · ${JSON.stringify(st).slice(0, 160)}`);
  }
  /** Pasa USDC entre el dex principal ("") y el del activo. */
  async moveUsdc(amount, toDex = true) {
    return this.ex.sendAsset({ destination: this.me, sourceDex: toDex ? "" : this.dex, destinationDex: toDex ? this.dex : "", token: this.usdcToken, amount: amount.toFixed(2) });
  }
}
