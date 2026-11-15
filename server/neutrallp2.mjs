// LP delta-neutral v2, cobertura completa (Jose, 2026-11-13): espejo de neutrallp.mjs con la cobertura en Extra Finance XLend
// (copia de Aave v3 en Base) en vez de Compound. Colateral USDC en XLend; deuda WETH por la parte de WETH del LP y deuda
// cbBTC por la parte de cbBTC. Contrato NeutralLpManagerV2 (contracts/src/NeutralLpManagerV2.sol). Estado en la clave "nlp2".
//   Apertura (una vez por etiqueta NLP2_OPEN): NLP2_USD USDC de la wallet + flash Morpho → XLend → WETH + cbBTC → LP → Revert → borrow.
//     Tamaño: LP V = a·C / (1 − a·r), a = NLP2_XLEND_LTV (deuda / colateral USDC), r = NLP2_REVERT_LTV (deuda USDC / valor LP).
//   Monitor cada NLP2_EVERY_S (60 s), mismas reglas que la v1:
//     · salud Revert < disparador → saca USDC de XLend y repaga Revert (cripto bajó);
//     · salud XLend (la del protocolo) < disparador → pide USDC en Revert y lo pone en XLend (cripto subió);
//     · si el traspaso no alcanza y una salud < emergencia → desapalanca 25 % con flashloan;
//     · fuera de rango N minutos seguidos → re-centra.
//     · comisiones por cobrar ≥ NLP2_COMPOUND_USD ($10) → las cobra, las pasa a USDC y las re-apalanca con el ciclo de la apertura
//       sobre la misma NFT (solo con el contrato nlm-v2.1 o posterior; NLP2_NEW_MANAGER=<etiqueta> despliega uno nuevo sin posición abierta).
//   Los umbrales toman NLP2_*; si no existen, los NLP_* de la v1 (para que las dos pruebas sean espejo).
//   Cierre: NLP2_CLOSE=<etiqueta>. Cada transacción se simula con eth_call antes de enviarse.
import fs from "node:fs";
import { ethers } from "ethers";
import { rangeTicks, amountsFor, recenterDue, rebalanceSwap } from "./revertloan.mjs";
import { NLP, openSizing, token0Share, recordCollected, feeTotals, feeText, lpAtPool, baseText, compoundSizing, afterCompound, COMPOUND_HAIRCUT } from "./neutrallp.mjs";

const ART = JSON.parse(fs.readFileSync(new URL("./artifacts/NeutralLpManagerV2.json", import.meta.url)));

export const NLP2 = {
  XPOOL: "0x09b11746DFD1b5a8325e30943F8B3D5000922E03", // XLend Pool (proxy, Aave v3 rev. 5) · verificado on-chain 2026-11-13
  A_USDC: "0xf17182f6f28Ded63B77A2Bb774c58aDe44612bE4",
  DEBT_WETH: "0xe99Ec9b8EA5322D8B5BDC66dad3D2294dC61b740",
  DEBT_CBBTC: "0x2AF3a2518d0a33907b0647E0654b75939dCA4D8A",
  RATE_ALERT_PCT: 5,
  OPEN_TX: "0xf6231e621a6c041c6374deee8c8031aac8bccc69e4603fea19eeb8b025594e90", // apertura de la espejo = inicio común (13 nov 18:33 UTC)
  OPEN_ID: "6565243", PEER_ID_AT_OPEN: "6543760",
};

const I = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)",
  "function loanInfo(uint256) view returns (uint256 debt, uint256 fullValue, uint256 collateralValue, uint256 liquidationCost, uint256 liquidationValue)",
  "function getUserAccountData(address) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
  "function oracle() view returns (address)",
  "function getValue(uint256 tokenId, address token) view returns (uint256 value, uint256 feeValue, uint256 price0X96, uint256 price1X96)",
]);
const M = new ethers.Interface(ART.abi);
const MAX128 = (1n << 128n) - 1n;
const env = (k, d) => process.env[`NLP2_${k}`] ?? process.env[`NLP_${k}`] ?? d;

// ---------------------------------------------------------------- funciones puras (test-local/test_neutrallp2.mjs)
/** Cantidades a pedir en XLend para un LP de valor V (USD): WETH crudo (18 dec) y cbBTC crudo (8 dec) en la proporción del rango. */
export function openBorrows(V, eth, btc, w0) {
  return { borrow0: BigInt(Math.floor(V * w0 / eth * 1e18)), borrow1: BigInt(Math.floor(V * (1 - w0) / btc * 1e8)) };
}
/** USDC a pasar de XLend a Revert para llevar Revert a `target` sin bajar XLend de `floor`. lt = umbral de liquidación (0.85). */
export function xlendToRevertAmount({ rColl, rDebt, xColl, xDebt, lt }, target, floor) {
  const want = rDebt - rColl / target;
  const room = xColl - floor * xDebt / lt;
  return Math.max(0, Math.min(want, room));
}
/** USDC a pasar de Revert a XLend para llevar XLend a `target` sin bajar Revert de `floor`. */
export function revertToXlendAmount({ rColl, rDebt, xColl, xDebt, lt }, target, floor) {
  const want = target * xDebt / lt - xColl;
  const room = rColl / floor - rDebt;
  return Math.max(0, Math.min(want, room));
}
/** Exposición neta por moneda en USD: lo que tiene el LP menos lo que se debe. x0/d0 en wei, x1/d1 en unidades de 8 decimales. */
export function netExposure({ x0, x1, d0, d1, eth, btc }) {
  const n0 = (x0 - d0) / 1e18 * eth, n1 = (x1 - d1) / 1e8 * btc;
  return { eth: n0, btc: n1, sum: n0 + n1 };
}
/** Swap del cierre: tras repagar cada deuda con su moneda, vende el sobrante de una para saldar lo que falta de la otra.
 *  px = cbBTC crudo por WETH crudo. Devuelve {sellToken0, amountIn, minOut} (amountIn 0 = sin swap). */
export function closeSwap({ x0, x1, d0, d1, px }, slipBps = 80) {
  const exc0 = Math.max(0, x0 - d0), rem0 = Math.max(0, d0 - x0), exc1 = Math.max(0, x1 - d1), rem1 = Math.max(0, d1 - x1), k = 1 - slipBps / 1e4;
  if (rem1 > 0 && exc0 > 0) { const amountIn = Math.min(exc0, rem1 / px * 1.004); return { sellToken0: true, amountIn: BigInt(Math.floor(amountIn)), minOut: BigInt(Math.floor(amountIn * px * k)) }; }
  if (rem0 > 0 && exc1 > 0) { const amountIn = Math.min(exc1, rem0 * px * 1.004); return { sellToken0: false, amountIn: BigInt(Math.floor(amountIn)), minOut: BigInt(Math.floor(amountIn / px * k)) }; }
  return { sellToken0: false, amountIn: 0n, minOut: 0n };
}

/** Re-centrado del 2026-11-14 16:44 (hora de México), anterior al registro de comisiones cobradas. Valores exactos del recibo
 *  0xeb8f472c…fe698f90: Collect #6565243 = 0.046578023808680974 WETH + 242 sat; DecreaseLiquidity = 0.046482776686998241 WETH + 0.
 *  Comisiones = la diferencia: 0.000095247121682733 WETH + 0.00000242 cbBTC, a ETH $1,748 y BTC $63,580 ≈ $0.320. */
export function backfillFirstRecenter(s) {
  const h = (s.history ?? []).find((x) => String(x.from) === "6565243" && String(x.to) === "6587053");
  if (!h || (s.feeLog ?? []).some((x) => x.tokenId === "6565243")) return false;
  const usd = 0.000095247121682733 * 1748 + 0.00000242 * 63580;
  s.feeLog = [...(s.feeLog ?? []), { t: h.t, tokenId: "6565243", fee0: "95247121682733", fee1: "242", usd, tx: "0xeb8f472c033897ad5919b179cb1ddddcf08ac44f470adb2377e73e75fe698f90", backfill: true }];
  s.feesCollectedUsd = (s.feesCollectedUsd ?? 0) + usd;
  s.nftSince ??= h.t;
  return true;
}

export class NeutralLp2 {
  /** peer: instancia de la v1 (NeutralLp); si existe se usa su proveedor, que ya maneja RPC privados y cambio por fallas. */
  constructor({ executor, provider, store, diag, peer }) {
    this.x = executor; this._p = provider; this.store = store; this.diag = diag; this.peer = peer ?? null;
    this.cfg = {
      tag: process.env.NLP2_OPEN || null,
      usd: Number(process.env.NLP2_USD ?? 50),
      a: Number(process.env.NLP2_XLEND_LTV ?? process.env.NLP_COMET_LTV ?? 0.78),
      r: Number(env("REVERT_LTV", 0.725)),
      rangePct: Number(env("RANGE_PCT", 2)),
      outMin: Number(env("RECENTER_OUT_MIN", 30)), // 2026-11-14: 60 → 30
      cooldownMin: Number(env("RECENTER_COOLDOWN_MIN", 30)),
      revertTrigger: Number(env("REVERT_TRIGGER", 1.04)),
      xlendTrigger: Number(process.env.NLP2_XLEND_TRIGGER ?? process.env.NLP_COMET_TRIGGER ?? 1.05),
      revertTarget: Number(env("REVERT_TARGET", 1.075)),
      xlendTarget: Number(process.env.NLP2_XLEND_TARGET ?? process.env.NLP_COMET_TARGET ?? 1.09),
      revertFloor: Number(env("REVERT_FLOOR", 1.045)),
      xlendFloor: Number(process.env.NLP2_XLEND_FLOOR ?? process.env.NLP_COMET_FLOOR ?? 1.06),
      emergency: Number(env("EMERGENCY", 1.025)),
      everyS: Math.max(15, Number(env("EVERY_S", 60))),
      slipBps: Number(env("SLIP_BPS", 80)),
      minEth: ethers.parseEther(String(env("MIN_ETH", "0.002"))),
      close: process.env.NLP2_CLOSE || null, // etiqueta: cierra todo y deja USDC/WETH/cbBTC en la wallet
      compoundUsd: Number(env("COMPOUND_USD", 10)), // comisiones por cobrar que disparan el re-apalancamiento (0 = apagado)
      compoundCooldownMin: Number(env("COMPOUND_COOLDOWN_MIN", 10)),
      newManager: process.env.NLP2_NEW_MANAGER || null, // etiqueta: sin posición abierta, despliega el contrato de esta versión
    };
    this.busy = false; this.timer = null; this.lastLine = 0; this.lastRates = 0; this.lastRateAlert = 0;
  }
  get provider() { return this.peer?.provider ?? this._p; }
  set provider(p) { this._p = p; }
  get me() { return this.x?.wallet?.address; }
  get live() { return this.x?.mode === "live" && !!this.me; }

  async init() {
    this.s = (await this.store.get("nlp2")) ?? { runs: {}, tokenId: null, events: [], actions: 0, recenters: 0, transfers: 0, deleverages: 0 };
    if (process.env.NLP2_MANAGER_ADDRESS && !this.s.oldManagers?.length) this.s.manager = process.env.NLP2_MANAGER_ADDRESS;
    backfillFirstRecenter(this.s);
  }
  /** Contrato nuevo (una vez por etiqueta y solo sin posición abierta): olvida el anterior para que ensureManager despliegue esta versión. */
  async renewManager() {
    const tag = this.cfg.newManager, run = `mgr:${tag}`;
    if (!tag || this.s.runs[run]?.done || (this.s.tokenId && !this.s.closed)) return;
    if (this.s.manager) this.s.oldManagers = [...(this.s.oldManagers ?? []), this.s.manager];
    this.s.oldManagers ??= ["-"]; // desde aquí manda el contrato desplegado, no la variable *_MANAGER_ADDRESS
    this.s.manager = null; this.s.managerTries = 0; this.s.canCompound = false; this.s.runs[run] = { done: true };
    await this.note(`NLP2_NEW_MANAGER=${tag}: se despliega el contrato nuevo (${ART.version}, re-apalanca comisiones)${this.s.oldManagers.at(-1) !== "-" ? ` · anterior ${this.s.oldManagers.at(-1)}` : ""}`);
    await this.ensureManager();
  }
  async save() { this.s.updatedAt = Date.now(); await this.store.set("nlp2", this.s); }
  async note(m) { this.s.events.unshift({ t: Date.now(), m }); this.s.events.length = Math.min(this.s.events.length, 80); await this.diag(`lp-neutral2: ${m}`); }
  start() {
    if (this.timer) return;
    const run = () => this.tick().catch((e) => this.note(`error ${(e.shortMessage || e.message || String(e)).slice(0, 180)}`).catch(() => {}));
    this.timer = setInterval(run, this.cfg.everyS * 1000);
    setTimeout(run, 20_000); // después del primer ciclo de la v1
  }
  c(addr, p = this.provider) { return new ethers.Contract(addr, I, p); }
  mgr(fn, args) { return { to: this.s.manager, data: M.encodeFunctionData(fn, args) }; }
  dl() { return BigInt(Math.floor(Date.now() / 1000) + 600); }
  async sim(tx) { const t = { from: this.me, ...tx }; await this.provider.call(t); return (await this.provider.estimateGas(t)) * 13n / 10n; }
  async send(step, tx) {
    const gasLimit = await this.sim(tx);
    const eth = await this.provider.getBalance(this.me), fee = await this.provider.getFeeData();
    if (eth - gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) < this.cfg.minEth) throw new Error(`${step}: dejaría menos de ${ethers.formatEther(this.cfg.minEth)} ETH`);
    const r = await this.x.withSender((w) => w.sendTransaction({ ...tx, gasLimit }));
    const rc = await this.provider.waitForTransaction(r.hash, 1, 180_000);
    if (!rc || rc.status !== 1) throw new Error(`${step}: ${r.hash} ${rc ? "revertida" : "sin recibo"}`);
    await this.note(`${step} · tx ${r.hash}`); this.s.actions++;
    return rc;
  }

  async tick() {
    if (this.busy || !this.live) return;
    this.busy = true;
    try {
      await this.ensureManager();
      if (this.cfg.close && this.s.tokenId && !this.s.runs[`close:${this.cfg.close}`]?.done) { await this.closeAll(this.cfg.close); if (!this.s.closed) return; }
      await this.renewManager();
      if (this.s.closed && this.cfg.tag && !this.s.runs[this.cfg.tag]?.done) {
        this.s.baseUsd ??= this.s.entry?.usd ?? this.cfg.usd;
        this.s.history = [...(this.s.history ?? []), { t: Date.now(), from: this.s.tokenId, to: null, why: "cierre para reabrir" }].slice(-50);
        this.s.tokenId = null; this.s.closed = false; this.s.outSince = null; this.s.minRevert = undefined; this.s.minXlend = undefined; this.s.last = null; this.s.reopen = true;
      }
      if (this.cfg.tag && !this.s.runs[this.cfg.tag]?.done && !this.s.tokenId) await this.open(this.cfg.tag);
      if (this.s.tokenId && !this.s.closed) await this.monitor();
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  // ---------------------------------------------------------------- lecturas
  async prices(bt, p) {
    const o = bt != null ? { blockTag: bt } : {};
    const e = await this.c(NLP.ETHUSD_POOL, p).slot0(o), s = await this.c(NLP.POOL, p).slot0(o);
    const se = Number(e.sqrtPriceX96) / 2 ** 96, sp = Number(s.sqrtPriceX96) / 2 ** 96;
    const eth = se * se * 1e12, px = sp * sp; // px = cbBTC crudo por WETH crudo
    return { eth, btc: eth / (px * 1e10), px, sqrtP: sp, tick: Number(s.tick) };
  }
  /** Tasas de préstamo variables de XLend en % anual (palabra 4 de getReserveData, en ray). */
  async rates() {
    const one = async (asset) => {
      const d = await this.provider.call({ to: NLP2.XPOOL, data: "0x35ea6a75" + asset.slice(2).toLowerCase().padStart(64, "0") });
      return Number(BigInt("0x" + d.slice(2 + 64 * 4, 2 + 64 * 5))) / 1e25;
    };
    return { weth: await one(NLP.WETH), btc: await one(NLP.CBBTC) };
  }
  /** Lee la posición (opcional: otra NFT, un bloque pasado y otro proveedor). El capital se valúa todo a precio del pool:
   *  LP (rango + comisiones por cobrar) − deuda Revert + colateral XLend − deudas WETH y cbBTC. Revert y XLend solo dan las saludes. */
  async read(id = this.s.tokenId, bt, p) {
    const o = bt != null ? { blockTag: bt } : {}, m = this.s.manager, pr = await this.prices(bt, p);
    const li = await this.c(NLP.VAULT, p).loanInfo(id, o);
    const pos = await this.c(NLP.NPM, p).positions(id, o);
    const acct = await this.c(NLP2.XPOOL, p).getUserAccountData(m, o);
    const aUsdc = Number(await this.c(NLP2.A_USDC, p).balanceOf(m, o)) / 1e6;
    const d0 = await this.c(NLP2.DEBT_WETH, p).balanceOf(m, o), d1 = await this.c(NLP2.DEBT_CBBTC, p).balanceOf(m, o);
    const f = await this.pendingFees(id, bt, p).catch(() => null);
    const debtUsd = Number(d0) / 1e18 * pr.eth + Number(d1) / 1e8 * pr.btc; // a precio del pool, como la v1
    const x = {
      rColl: Number(li.collateralValue) / 1e6, rDebt: Number(li.debt) / 1e6, rValue: Number(li.fullValue) / 1e6,
      xColl: Number(acct.totalCollateralBase) / 1e8, xDebt: Number(acct.totalDebtBase) / 1e8, lt: Number(acct.currentLiquidationThreshold) / 1e4 || 0.85, // a precio del oráculo de XLend
      aUsdc, d0, d1, debtUsd,
    };
    const h = { revert: x.rDebt > 0 ? x.rColl / x.rDebt : Infinity, xlend: acct.totalDebtBase > 0n ? Number(acct.healthFactor) / 1e18 : Infinity };
    const inRange = pr.tick >= Number(pos.tickLower) && pr.tick < Number(pos.tickUpper);
    const am = amountsFor(Number(pos.liquidity), pr.sqrtP, Number(pos.tickLower), Number(pos.tickUpper));
    const net = netExposure({ x0: am.a0, x1: am.a1, d0: Number(d0), d1: Number(d1), eth: pr.eth, btc: pr.btc });
    const lp = lpAtPool(am, f, pr), lpValue = lp.fees != null ? lp.value : x.rValue; // sin lectura de comisiones: el valor de Revert (ya las incluye)
    return { ...x, h, pr, pos, li, am, net, inRange, lpValue, feesUsd: lp.fees, equity: lpValue - x.rDebt + aUsdc - debtUsd, equityRevert: x.rValue - x.rDebt + aUsdc - debtUsd };
  }
  async pendingFees(id, bt, p = this.provider) {
    return p.call({ from: NLP.VAULT, to: NLP.NPM, data: I.encodeFunctionData("collect", [{ tokenId: id, recipient: NLP.VAULT, amount0Max: MAX128, amount1Max: MAX128 }]), ...(bt != null ? { blockTag: bt } : {}) }).then((d) => I.decodeFunctionResult("collect", d));
  }

  // ---------------------------------------------------------------- contrato
  async ensureManager() {
    if (this.s.manager || (this.s.managerTries ?? 0) >= 3 || !this.cfg.tag) return;
    try {
      const args = [this.me, NLP.VAULT, NLP.NPM, NLP.MORPHO, NLP.ROUTER, NLP2.XPOOL, NLP.USDC, NLP.WETH, NLP.CBBTC, NLP.FEE, NLP2.DEBT_WETH, NLP2.DEBT_CBBTC];
      const rc = await this.send("despliegue NeutralLpManagerV2", { data: ART.bytecode + M.encodeDeploy(args).slice(2) });
      this.s.manager = rc.contractAddress; this.s.canCompound = !!M.getFunction("compound"); await this.save();
      await this.note(`contrato NeutralLpManagerV2 (${ART.version}) en ${rc.contractAddress}`);
    } catch (e) { this.s.managerTries = (this.s.managerTries ?? 0) + 1; await this.note(`despliegue falló (${this.s.managerTries}/3) · ${(e.shortMessage || e.message).slice(0, 160)}`); }
  }

  async open(tag) {
    const run = (this.s.runs[tag] ??= { tries: 0 });
    if (!this.s.manager || run.tries >= 3) return;
    const have = Number(await this.c(NLP.USDC).balanceOf(this.me)) / 1e6;
    const C = have >= this.cfg.usd ? this.cfg.usd : have >= this.cfg.usd * 0.97 ? Math.floor(have * 100) / 100 : this.cfg.usd;
    if (have < C) { if (!run.waitNoted) { run.waitNoted = true; await this.note(`apertura ${tag}: esperando fondeo · USDC en wallet $${have.toFixed(2)} de $${C}`); } return; }
    run.tries++;
    try {
      const pr = await this.prices();
      const { V, F, A } = openSizing(C, this.cfg.a, this.cfg.r);
      const { lower, upper } = rangeTicks(pr.tick, this.cfg.rangePct, NLP.SPACING);
      const w0 = token0Share(pr.sqrtP, lower, upper);
      const { borrow0, borrow1 } = openBorrows(V, pr.eth, pr.btc, w0);
      const usdcIn = BigInt(Math.round(C * 1e6)), flash = BigInt(Math.floor(F * 1e6));
      const allow = await this.c(NLP.USDC).allowance(this.me, this.s.manager);
      if (allow < usdcIn) await this.send("approve USDC → NeutralLpManagerV2", { to: NLP.USDC, data: I.encodeFunctionData("approve", [this.s.manager, usdcIn]) });
      await this.note(`apertura ${tag}: $${C} propios · LP $${V.toFixed(2)} (WETH ${(w0 * 100).toFixed(0)} % / cbBTC) rango ticks [${lower}, ${upper}] ±${this.cfg.rangePct} % · XLend: colateral $${A.toFixed(2)}, deuda ${ethers.formatEther(borrow0)} WETH + ${ethers.formatUnits(borrow1, 8)} cbBTC · Revert: deuda $${F.toFixed(2)}`);
      await this.send(`apertura ${tag}: flash $${F.toFixed(2)} → XLend → WETH + cbBTC → LP → Revert → préstamo`, this.mgr("open", [{ usdcIn, borrow0, borrow1, tickLower: lower, tickUpper: upper, deadline: this.dl() }, flash]));
      this.s.tokenId = (await new ethers.Contract(this.s.manager, ART.abi, this.provider).tokenId()).toString();
      run.done = true; this.s.openedAt = this.s.reopen && this.s.openedAt ? this.s.openedAt : Date.now(); this.s.reopen = false; this.s.nftSince = Date.now();
      this.s.entry = { usd: this.s.baseUsd ?? C, put: C, eth: pr.eth, btc: pr.btc, V, F, A, t: Date.now() };
      await this.save();
      const r = await this.read();
      await this.note(`abierta #${this.s.tokenId} · LP $${r.lpValue.toFixed(2)} · Revert deuda $${r.rDebt.toFixed(2)} salud ${r.h.revert.toFixed(3)} · XLend colateral $${r.aUsdc.toFixed(2)} deuda ${(Number(r.d0) / 1e18).toFixed(6)} WETH + ${(Number(r.d1) / 1e8).toFixed(6)} cbBTC salud ${r.h.xlend.toFixed(3)} · capital $${r.equity.toFixed(2)}`);
    } catch (e) { await this.note(`apertura ${tag} falló (${run.tries}/3) · ${(e.shortMessage || e.message).slice(0, 200)}`); }
  }

  async monitor() {
    const r = await this.read(), id = this.s.tokenId, cfg = this.cfg;
    this.s.last = { ...(this.s.last?.rates ? { rates: this.s.last.rates } : {}), t: Date.now(), revert: r.h.revert, xlend: r.h.xlend, lp: r.lpValue, rDebt: r.rDebt, xColl: r.aUsdc, d0: Number(r.d0) / 1e18, d1: Number(r.d1) / 1e8, debtUsd: r.debtUsd, net: r.net, equity: r.equity, eth: r.pr.eth, btc: r.pr.btc, inRange: r.inRange, ticks: [Number(r.pos.tickLower), Number(r.pos.tickUpper)], tick: r.pr.tick };
    // comisiones puras: lo que el LP tiene por cobrar (lectura on-chain), sin efecto de precio
    if (r.feesUsd != null) Object.assign(this.s.last, feeTotals(this.s, r.feesUsd, r.lpValue), { compounds: this.s.compounds ?? 0 }); // por cobrar + cobradas, desde la apertura
    if (Date.now() - this.lastRates > 10 * 60_000) {
      try {
        this.s.last.rates = await this.rates(); this.lastRates = Date.now();
        const hi = Math.max(this.s.last.rates.weth, this.s.last.rates.btc);
        if (hi > NLP2.RATE_ALERT_PCT && Date.now() - this.lastRateAlert > 6 * 3600_000) { this.lastRateAlert = Date.now(); await this.note(`AVISO tasa de préstamo alta en XLend · WETH ${this.s.last.rates.weth.toFixed(2)} % · cbBTC ${this.s.last.rates.btc.toFixed(2)} % anual`); }
      } catch {}
    }
    this.s.minRevert = Math.min(this.s.minRevert ?? Infinity, r.h.revert); this.s.minXlend = Math.min(this.s.minXlend ?? Infinity, r.h.xlend);
    if (Date.now() - this.lastLine > 30 * 60_000) { this.lastLine = Date.now(); console.log(`${new Date().toISOString()} ${this.line()}`); }

    // 1) salud: traspasos entre los dos lados
    if (r.h.revert < cfg.revertTrigger) {
      const amt = xlendToRevertAmount(r, cfg.revertTarget, cfg.xlendFloor);
      if (amt >= 0.5) { await this.send(`salud Revert ${r.h.revert.toFixed(3)} (cripto bajó) → $${amt.toFixed(2)} de XLend a Revert`, this.mgr("xlendToRevert", [id, BigInt(Math.floor(amt * 1e6))])); this.s.transfers++; return; }
    }
    if (r.h.xlend < cfg.xlendTrigger) {
      const amt = revertToXlendAmount(r, cfg.xlendTarget, cfg.revertFloor);
      if (amt >= 0.5) { await this.send(`salud XLend ${r.h.xlend.toFixed(3)} (cripto subió) → $${amt.toFixed(2)} de Revert a XLend`, this.mgr("revertToXlend", [id, BigInt(Math.floor(amt * 1e6))])); this.s.transfers++; return; }
    }
    if (Math.min(r.h.revert, r.h.xlend) < cfg.emergency) { await this.deleverage(r, 0.25, `salud baja (Revert ${r.h.revert.toFixed(3)}, XLend ${r.h.xlend.toFixed(3)})`, r.h.xlend < r.h.revert); return; }

    // 2) rango
    if (!r.inRange) {
      if (!this.s.outSince) { this.s.outSince = Date.now(); await this.note(`fuera de rango (tick ${r.pr.tick}, rango [${r.pos.tickLower}, ${r.pos.tickUpper}]) · espera ${cfg.outMin} min`); }
    } else if (this.s.outSince) { await this.note(`volvió al rango tras ${((Date.now() - this.s.outSince) / 60_000).toFixed(0)} min · sin re-centrar`); this.s.outSince = null; }
    const due = !r.inRange && recenterDue(false, this.s.outSince, Date.now(), cfg.outMin);
    if (due && Date.now() - (this.s.lastRecenter ?? 0) > cfg.cooldownMin * 60_000) await this.recenter(r);
    // 3) ganancia realizada: comisiones por cobrar ≥ umbral → cobra y re-apalanca
    else if (cfg.compoundUsd > 0 && r.inRange && r.feesUsd != null && r.feesUsd >= cfg.compoundUsd) await this.compound(r);
    if (!this.revertChecked) { this.revertChecked = true; await this.checkRevertValue(r.pr).catch((e) => this.note(`chequeo Revert falló · ${(e.shortMessage || e.message).slice(0, 120)}`)); }
    if (!this.s.base && !this.baseTried) { this.baseTried = true; await this.computeBase().catch((e) => this.note(`base del inicio común falló · ${(e.shortMessage || e.message).slice(0, 300)}`)); }
  }

  /** Base del inicio común: estado de las DOS posiciones en el bloque de la apertura de la espejo (13 nov 18:33 UTC), valuado igual
   *  que ahora (todo a precio del pool). Se calcula una vez en la cadena (requiere estado histórico) y queda guardada. */
  async computeBase() {
    const rpcs = [["en uso", this.provider], ...NLP.RPCS.map((u) => [new URL(u).host, new ethers.JsonRpcProvider(u, 8453, { staticNetwork: true })])];
    const errs = [];
    for (const [name, p] of rpcs) {
      try {
        const rc = await p.getTransactionReceipt(NLP2.OPEN_TX);
        if (!rc) throw new Error("sin recibo de la apertura");
        const B = rc.blockNumber, blk = await p.getBlock(B);
        const pack = (r) => ({ block: B, t: blk.timestamp * 1000, equity: r.equity, feesTotal: r.feesUsd ?? 0, equityRevert: r.equityRevert, lp: r.lpValue, eth: r.pr.eth, btc: r.pr.btc, rpc: name });
        const me = await this.read(NLP2.OPEN_ID, B, p);
        if (me.feesUsd == null) throw new Error("sin comisiones en el bloque histórico");
        const base = pack(me);
        let peerBase = null;
        if (this.peer?.s?.manager) { const po = await this.peer.read(NLP2.PEER_ID_AT_OPEN, B, p); if (po.feesUsd == null) throw new Error("sin comisiones de la original en el bloque histórico"); peerBase = pack(po); }
        this.s.base = base; await this.save();
        if (peerBase) { this.peer.s.base = peerBase; await this.peer.save?.(); }
        const d = new Date(base.t).toISOString().slice(0, 16).replace("T", " ");
        await this.note(`base del inicio común recalculada en la cadena (bloque ${B}, ${d} UTC, RPC ${name}) · ETH $${base.eth.toFixed(2)} BTC $${base.btc.toFixed(0)} · espejo: capital $${base.equity.toFixed(3)} a precio del pool (con el oráculo de Revert $${base.equityRevert.toFixed(3)}), comisiones $${base.feesTotal.toFixed(3)}${peerBase ? ` · original: capital $${peerBase.equity.toFixed(3)} a precio del pool (con el oráculo de Revert $${peerBase.equityRevert.toFixed(3)}), comisiones ganadas $${peerBase.feesTotal.toFixed(3)}` : " · original: sin dato"}`);
        return;
      } catch (e) { errs.push(`${name}: ${(e.shortMessage || e.message).slice(0, 70)}`); }
    }
    throw new Error(errs.join(" | "));
  }

  /** Una vez por arranque: ¿el valor del LP que da Revert (y que entra en el "capital") ya incluye las comisiones por cobrar?
   *  Compara el valor del oráculo de Revert con el capital del LP y con las comisiones, las dos a precio de ese oráculo. */
  async checkRevertValue(pr) {
    const vault = this.c(NLP.VAULT), oracle = this.c(await vault.oracle());
    const ids = [["espejo", this.s.tokenId], ["original", this.peer?.s?.tokenId]].filter(([, id]) => id);
    for (const [who, id] of ids) {
      const [li, gv, pos, f] = await Promise.all([vault.loanInfo(id), oracle.getValue(id, NLP.USDC), this.c(NLP.NPM).positions(id), this.pendingFees(id)]);
      const Q = 2 ** 96, p0 = Number(gv.price0X96) / Q, p1 = Number(gv.price1X96) / Q;
      const am = amountsFor(Number(pos.liquidity), pr.sqrtP, Number(pos.tickLower), Number(pos.tickUpper));
      const V = Number(gv.value) / 1e6, P = (am.a0 * p0 + am.a1 * p1) / 1e6, F = (Number(f[0]) * p0 + Number(f[1]) * p1) / 1e6, Fo = Number(gv.feeValue) / 1e6;
      const incl = Math.abs(V - (P + F)) < Math.abs(V - P);
      await this.note(`chequeo Revert ${who} #${id}: valor del LP $${V.toFixed(3)} (préstamo $${(Number(li.fullValue) / 1e6).toFixed(3)}) · capital del LP $${P.toFixed(3)} · comisiones por cobrar $${F.toFixed(3)} (oráculo $${Fo.toFixed(3)}) · valor − capital = $${(V - P).toFixed(3)} → el valor ${incl ? "SÍ" : "NO"} incluye las comisiones`);
    }
  }

  /** Re-apalanca la ganancia realizada: cobra las comisiones, las pasa a USDC y repite con ellas el ciclo de la apertura sobre la
   *  misma NFT (USDC + flash → XLend → WETH + cbBTC → más liquidez → Revert presta el flash). Prueba el apalancamiento máximo
   *  (k = 1) y, si las saludes esperadas quedan bajo su piso o no simula, una fracción menor. */
  async compound(r) {
    const id = this.s.tokenId, cfg = this.cfg, now = Date.now();
    if (now - (this.s.lastCompoundTry ?? 0) < cfg.compoundCooldownMin * 60_000) return false;
    this.s.lastCompoundTry = now;
    if (!this.s.canCompound) {
      if (now - (this.s.compoundNoteAt ?? 0) > 24 * 3600_000) { this.s.compoundNoteAt = now; await this.note(`comisiones por cobrar $${r.feesUsd.toFixed(2)} ≥ $${cfg.compoundUsd}: este contrato es de la versión anterior y no puede re-apalancar · hace falta abrir la posición con el contrato nuevo (NLP2_NEW_MANAGER)`); }
      return false;
    }
    try {
      const C = r.feesUsd * (1 - COMPOUND_HAIRCUT);
      const minUsdcOut = BigInt(Math.floor(r.feesUsd * (1 - cfg.slipBps / 1e4 - COMPOUND_HAIRCUT) * 1e6));
      const w0 = token0Share(r.pr.sqrtP, Number(r.pos.tickLower), Number(r.pos.tickUpper));
      let why = "las saludes esperadas quedan bajo su piso";
      for (const k of [1, 0.66, 0.33]) {
        const z = compoundSizing(C, cfg.a, cfg.r, k);
        const h = afterCompound({ rColl: r.rColl, rDebt: r.rDebt, rValue: r.rValue, hColl: r.xColl, hDebt: r.xDebt, lt: r.lt }, z, r.feesUsd);
        if (h.revert < cfg.revertFloor || h.hedge < cfg.xlendFloor) continue;
        const { borrow0, borrow1 } = openBorrows(z.V, r.pr.eth, r.pr.btc, w0);
        const tx = this.mgr("compound", [{ tokenId: id, borrow0, borrow1, minUsdcOut, deadline: this.dl() }, BigInt(Math.floor(z.F * 1e6))]);
        try { await this.sim(tx); } catch (e) { why = `no simuló (${(e.shortMessage || e.message || String(e)).slice(0, 100)})`; continue; }
        const rc = await this.send(`re-apalanca: cobra $${r.feesUsd.toFixed(2)} de comisiones → LP +$${z.V.toFixed(2)} · Revert +$${z.F.toFixed(2)} · XLend colateral +$${z.A.toFixed(2)} (apalancamiento ${(k * 100).toFixed(0)} % del máximo)`, tx);
        const got = recordCollected(this.s, { from: id, rc, eth: r.pr.eth, btc: r.pr.btc });
        this.s.compounds = (this.s.compounds ?? 0) + 1; this.s.compoundedUsd = (this.s.compoundedUsd ?? 0) + (got ? this.s.feeLog.at(-1).usd : r.feesUsd);
        await this.save();
        const n = await this.read();
        await this.note(`re-apalancado (${this.s.compounds}) · antes: LP $${r.lpValue.toFixed(2)} salud Revert ${r.h.revert.toFixed(3)} XLend ${r.h.xlend.toFixed(3)} capital $${r.equity.toFixed(2)} · después: LP $${n.lpValue.toFixed(2)} salud Revert ${n.h.revert.toFixed(3)} XLend ${n.h.xlend.toFixed(3)} capital $${n.equity.toFixed(2)} · neto ETH $${n.net.eth.toFixed(2)} BTC $${n.net.btc.toFixed(2)} · re-apalancado en total $${this.s.compoundedUsd.toFixed(2)}`);
        return true;
      }
      await this.note(`re-apalancamiento pospuesto · ${why} · reintenta en ${cfg.compoundCooldownMin} min`);
    } catch (e) { await this.note(`re-apalancamiento falló · ${(e.shortMessage || e.message).slice(0, 180)} · reintenta en ${cfg.compoundCooldownMin} min`); }
    return false;
  }

  async recenter(r) {
    const id = this.s.tokenId, cfg = this.cfg;
    this.s.lastRecenter = Date.now();
    try {
      const fees = await this.pendingFees(id).catch(() => [0n, 0n]);
      const x0 = r.am.a0 + Number(fees[0]), x1 = r.am.a1 + Number(fees[1]);
      const { lower, upper } = rangeTicks(r.pr.tick, cfg.rangePct, NLP.SPACING);
      const sw = rebalanceSwap(x0, x1, r.pr.sqrtP, lower, upper, cfg.slipBps);
      const flash = r.li.debt * 1003n / 1000n + 10n;
      const args = { tokenId: id, tickLower: lower, tickUpper: upper, sellToken0: sw.sellToken0, swapAmountIn: sw.amountIn, swapMinOut: sw.minOut, deadline: this.dl() };
      const rc = await this.send(`re-centra #${id} → ticks [${lower}, ${upper}] (WETH en BTC ${(r.pr.px * 1e10).toFixed(6)})`, this.mgr("recenter", [args, flash]));
      const nid = (await new ethers.Contract(this.s.manager, ART.abi, this.provider).tokenId()).toString();
      this.s.history = [...(this.s.history ?? []), { t: Date.now(), from: id, to: nid }].slice(-50);
      const got = recordCollected(this.s, { from: id, rc, eth: r.pr.eth, btc: r.pr.btc });
      this.s.tokenId = nid; this.s.recenters++; this.s.outSince = null;
      await this.save();
      const n = await this.read();
      await this.note(`re-centrado: nueva #${nid} · salud Revert ${n.h.revert.toFixed(3)} XLend ${n.h.xlend.toFixed(3)} · capital $${n.equity.toFixed(2)}${got ? ` · comisiones cobradas ${ethers.formatEther(got.fee0)} WETH + ${ethers.formatUnits(got.fee1, 8)} cbBTC ($${this.s.feeLog.at(-1).usd.toFixed(3)}), reinvertidas en la NFT nueva · cobradas en total $${this.s.feesCollectedUsd.toFixed(3)}` : " · comisiones cobradas: no se encontraron en el recibo"}`);
    } catch (e) { await this.note(`re-centrado falló · ${(e.shortMessage || e.message).slice(0, 180)} · reintenta tras el enfriamiento`); }
  }

  /** Reduce todo en proporción `frac` (LP, deuda Revert, deudas de XLend con las monedas retiradas, colateral XLend).
   *  xlendWeak: retira de XLend solo lo del flash (baja la deuda más que el colateral → sube la salud de XLend);
   *  si no, retira la fracción del colateral y el sobrante repaga Revert (sube la salud de Revert). */
  async deleverage(r, frac, why, xlendWeak = false) {
    const id = this.s.tokenId;
    const liq = BigInt(Math.floor(Number(r.pos.liquidity) * frac));
    const flash = BigInt(Math.floor(r.rDebt * frac * 1e6));
    const withdraw = xlendWeak ? flash * 1002n / 1000n + 1n : BigInt(Math.floor(r.aUsdc * frac * 1e6));
    for (const k of xlendWeak ? [1, 1.05, 1.1] : [1, 0.9, 0.8]) {
      const tx = this.mgr("deleverage", [{ tokenId: id, liquidity: liq, withdrawUsdc: BigInt(Math.floor(Number(withdraw) * k)), sellToken0: false, swapAmountIn: 0n, swapMinOut: 0n, close: false, deadline: this.dl() }, flash]);
      try { await this.sim(tx); } catch { continue; }
      await this.send(`${why}: desapalanca ${(frac * 100).toFixed(0)} % con flashloan`, tx); this.s.deleverages++; return true;
    }
    await this.note(`${why}: el desapalancamiento no simuló`); return false;
  }

  /** Cierra todo: repaga Revert, saca el NFT, cada moneda repaga su deuda (swap del sobrante hacia la otra), retira el USDC; saldos al dueño. */
  async closeAll(tag) {
    const run = (this.s.runs[`close:${tag}`] ??= { tries: 0 });
    if (run.tries >= 3) return; run.tries++;
    try {
      const r = await this.read(), id = this.s.tokenId, m = this.s.manager;
      const fees = await this.pendingFees(id).catch(() => [0n, 0n]);
      const sw = closeSwap({ x0: r.am.a0 + Number(fees[0]), x1: r.am.a1 + Number(fees[1]), d0: Number(r.d0), d1: Number(r.d1), px: r.pr.px }, this.cfg.slipBps);
      const flash = r.li.debt * 1003n / 1000n + 10n;
      let sent = false;
      for (const k of [1, 0.98, 0.95, 0.9, 0.8]) {
        const tx = this.mgr("deleverage", [{ tokenId: id, liquidity: 0n, withdrawUsdc: BigInt(Math.floor(r.aUsdc * k * 1e6)), sellToken0: sw.sellToken0, swapAmountIn: sw.amountIn, swapMinOut: sw.minOut, close: true, deadline: this.dl() }, flash]);
        try { await this.sim(tx); } catch { continue; }
        const rc = await this.send(`cierre ${tag}: repaga todo y retira ${(k * 100).toFixed(0)} % del colateral de XLend`, tx); sent = true;
        const got = recordCollected(this.s, { from: id, rc, eth: r.pr.eth, btc: r.pr.btc }); // las comisiones cobradas al cerrar siguen contando
        await this.note(`cierre ${tag}: capital antes de cerrar $${r.equity.toFixed(2)}${got ? ` · comisiones cobradas $${this.s.feeLog.at(-1).usd.toFixed(3)} · cobradas en total $${this.s.feesCollectedUsd.toFixed(3)}` : ""}`);
        await this.save(); break;
      }
      if (!sent) throw new Error("ninguna variante de cierre simuló");
      // deuda residual (polvo): se compra con USDC del colateral
      for (let i = 0; i < 2; i++) {
        const pr = await this.prices();
        for (const [tok, debtTok, dec, px, sym] of [[NLP.WETH, NLP2.DEBT_WETH, 18, pr.eth, "WETH"], [NLP.CBBTC, NLP2.DEBT_CBBTC, 8, pr.btc, "cbBTC"]]) {
          const d = Number(await this.c(debtTok).balanceOf(m)) / 10 ** dec;
          if (d <= 0) continue;
          const usd = d * px * 1.02 + 0.05;
          await this.send(`cierre ${tag}: compra ${d.toFixed(8)} ${sym} con $${usd.toFixed(2)} del colateral y repaga`, this.mgr("trimDebt", [tok, BigInt(Math.ceil(usd * 1e6)), 0n]));
        }
      }
      const debt0 = await this.c(NLP2.DEBT_WETH).balanceOf(m), debt1 = await this.c(NLP2.DEBT_CBBTC).balanceOf(m);
      if (debt0 === 0n && debt1 === 0n && (await this.c(NLP2.A_USDC).balanceOf(m)) > 0n) await this.send(`cierre ${tag}: resto del colateral de XLend`, this.mgr("xlendWithdraw", [NLP.USDC, ethers.MaxUint256]));
      for (const t of [NLP.USDC, NLP.WETH, NLP.CBBTC]) if ((await this.c(t).balanceOf(m)) > 0n) await this.send(`cierre ${tag}: saldo a la wallet`, this.mgr("sweep", [t, 0n]));
      run.done = true; this.s.closed = true;
      await this.note(`cerrada · wallet USDC ${ethers.formatUnits(await this.c(NLP.USDC).balanceOf(this.me), 6)} · deuda restante ${ethers.formatEther(debt0)} WETH + ${ethers.formatUnits(debt1, 8)} cbBTC`);
    } catch (e) { await this.note(`cierre ${tag} falló (${run.tries}/3) · ${(e.shortMessage || e.message).slice(0, 180)}`); }
  }

  line() {
    const l = this.s.last; if (!l) return `lp-neutral2: ${this.s.tokenId ? `#${this.s.tokenId}` : "sin posición"}`;
    const e = this.s.entry;
    return `lp-neutral2: #${this.s.tokenId} · LP $${l.lp.toFixed(2)} ${l.inRange ? "en rango" : "FUERA de rango"} · Revert deuda $${l.rDebt.toFixed(2)} salud ${l.revert.toFixed(3)} · XLend colateral $${l.xColl.toFixed(2)} deuda ${l.d0.toFixed(6)} WETH + ${l.d1.toFixed(6)} cbBTC ($${l.debtUsd.toFixed(2)}) salud ${l.xlend.toFixed(3)}${l.rates ? ` · tasas WETH ${l.rates.weth.toFixed(2)} % cbBTC ${l.rates.btc.toFixed(2)} %` : ""} · neto ETH $${l.net.eth.toFixed(2)} BTC $${l.net.btc.toFixed(2)}${feeText(l)} · capital $${l.equity.toFixed(2)}${e ? ` (inicio $${e.usd}, ${((l.equity / e.usd - 1) * 100).toFixed(2)} %)` : ""}${baseText(l, this.s.base)} · ETH $${l.eth.toFixed(0)} BTC $${l.btc.toFixed(0)} · re-centrados ${this.s.recenters} traspasos ${this.s.transfers} desapalancamientos ${this.s.deleverages}${this.s.compounds ? ` re-apalancamientos ${this.s.compounds}` : ""}`;
  }
  view() { return { ready: true, manager: this.s.manager, tokenId: this.s.tokenId, entry: this.s.entry, last: this.s.last, minRevert: this.s.minRevert, minXlend: this.s.minXlend, recenters: this.s.recenters, transfers: this.s.transfers, deleverages: this.s.deleverages, compounds: this.s.compounds ?? 0, canCompound: !!this.s.canCompound, events: this.s.events.slice(0, 30), line: this.line(), cfg: { ...this.cfg, minEth: this.cfg.minEth.toString() } }; }
}
