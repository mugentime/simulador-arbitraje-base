// LP delta-neutral WETH/cbBTC (Jose, 2026-11-10): Uniswap v3 0.05 % (Base) como colateral en Revert Lend (deuda USDC) +
// cobertura en Compound v3 (colateral USDC, deuda WETH). Contrato NeutralLpManager (contracts/src/NeutralLpManager.sol).
//   Apertura (una vez por etiqueta NLP_OPEN): NLP_USD USDC de la wallet + flash Morpho → Compound → WETH → cbBTC → LP → Revert → borrow.
//     Tamaño: LP V = a·C / (1 − a·r), a = NLP_COMET_LTV (deuda WETH / colateral USDC), r = NLP_REVERT_LTV (deuda USDC / valor LP).
//   Monitor cada NLP_EVERY_S (60 s):
//     · salud Revert (colateral/deuda) < NLP_REVERT_TRIGGER → saca USDC de Compound y repaga Revert (cripto bajó);
//     · salud Compound (0.85·colateral / deuda) < NLP_COMET_TRIGGER → pide USDC en Revert y lo pone en Compound (cripto subió);
//     · si el traspaso no alcanza y una salud < NLP_EMERGENCY → desapalanca 25 % con flashloan (proporcional, sigue neutral);
//     · fuera de rango NLP_RECENTER_OUT_MIN minutos seguidos → re-centra (flash → repaga → cierra → reequilibra → mint → borrow).
//   Cierre de la posición anterior (RevertLoanManager WETH/USDC) con NLP_CLOSE_OLD=<etiqueta>: desapalanca todo, saca el NFT, USDC a la wallet.
//   Cada transacción se simula con eth_call antes de enviarse.
import fs from "node:fs";
import { ethers } from "ethers";
import { rangeTicks, amountsFor, recenterDue, rebalanceSwap } from "./revertloan.mjs";

const ART = JSON.parse(fs.readFileSync(new URL("./artifacts/NeutralLpManager.json", import.meta.url)));
const OLD = JSON.parse(fs.readFileSync(new URL("./artifacts/RevertLoanManager.json", import.meta.url)));

export const NLP = {
  VAULT: "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599",
  NPM: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  COMET: "0x46e6b214b524310239732D51387075E0e70970bf", // Compound v3 WETH (Base)
  POOL: "0x7aea2e8a3843516afa07293a10ac8e49906dabd1", // WETH/cbBTC 0.05 %
  ETHUSD_POOL: "0xd0b53D9277642d899DF5C87A3966A349A798F224", // WETH/USDC 0.05 % (precio)
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  CBBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  FEE: 500, SPACING: 10,
  COMET_LIQ_CF: 0.85, REVERT_CF: 0.775,
  OLD_MANAGER: "0xC4bD7851E5Dffe0c222f0943Bd7ec0C50625AF98",
  RPCS: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://1rpc.io/base", "https://base.drpc.org", "https://base.llamarpc.com"],
};

const I = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256 amount0,uint256 amount1)",
  "function loanInfo(uint256) view returns (uint256 debt, uint256 fullValue, uint256 collateralValue, uint256 liquidationCost, uint256 liquidationValue)",
  "function loans(uint256) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function borrowBalanceOf(address) view returns (uint256)",
  "function collateralBalanceOf(address,address) view returns (uint128)",
  "function isLiquidatable(address) view returns (bool)",
  "function lastTokenId() view returns (uint256)",
]);
const M = new ethers.Interface(ART.abi);
const MO = new ethers.Interface(OLD.abi);
const MAX128 = (1n << 128n) - 1n;

// ---------------------------------------------------------------- funciones puras (test-local/test_neutrallp.mjs)
/** Tamaño de apertura: C USDC propios → LP V, flash F (= deuda Revert), colateral Compound A, deuda WETH (USD) = V. */
export function openSizing(C, a, r) {
  const V = a * C / (1 - a * r);
  return { V, F: r * V, A: C + r * V, wethUsd: V };
}
/** Fracción del valor en token0 para un rango (unidades crudas: P = token1 crudo por token0 crudo). */
export function token0Share(sqrtP, lower, upper) {
  const u = amountsFor(1e18, sqrtP, lower, upper), P = sqrtP * sqrtP;
  return u.a0 * P / (u.a0 * P + u.a1);
}
/** Saludes: Revert = colateral/deuda (liquidable < 1); Compound = 0.85·colateral USDC / deuda WETH en USD (liquidable < 1). */
export function healths({ rColl, rDebt, cColl, cDebtUsd }) {
  return { revert: rDebt > 0 ? rColl / rDebt : Infinity, comet: cDebtUsd > 0 ? NLP.COMET_LIQ_CF * cColl / cDebtUsd : Infinity };
}
/** USDC a pasar de Compound a Revert para llevar Revert a `target` sin bajar Compound de `floor`. */
export function cometToRevertAmount({ rColl, rDebt, cColl, cDebtUsd }, target, floor) {
  const want = rDebt - rColl / target;
  const room = cColl - floor * cDebtUsd / NLP.COMET_LIQ_CF;
  return Math.max(0, Math.min(want, room));
}
/** USDC a pasar de Revert a Compound para llevar Compound a `target` sin bajar Revert de `floor`. */
export function revertToCometAmount({ rColl, rDebt, cColl, cDebtUsd }, target, floor) {
  const want = target * cDebtUsd / NLP.COMET_LIQ_CF - cColl;
  const room = rColl / floor - rDebt;
  return Math.max(0, Math.min(want, room));
}

export class NeutralLp {
  constructor({ executor, provider, store, diag }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    this.cfg = {
      tag: process.env.NLP_OPEN || null,
      usd: Number(process.env.NLP_USD ?? 50),
      a: Number(process.env.NLP_COMET_LTV ?? 0.65),
      r: Number(process.env.NLP_REVERT_LTV ?? 0.65),
      rangePct: Number(process.env.NLP_RANGE_PCT ?? 2),
      outMin: Number(process.env.NLP_RECENTER_OUT_MIN ?? 60),
      cooldownMin: Number(process.env.NLP_RECENTER_COOLDOWN_MIN ?? 30),
      revertTrigger: Number(process.env.NLP_REVERT_TRIGGER ?? 1.10),
      cometTrigger: Number(process.env.NLP_COMET_TRIGGER ?? 1.15),
      revertTarget: Number(process.env.NLP_REVERT_TARGET ?? 1.19),
      cometTarget: Number(process.env.NLP_COMET_TARGET ?? 1.30),
      revertFloor: Number(process.env.NLP_REVERT_FLOOR ?? 1.12),
      cometFloor: Number(process.env.NLP_COMET_FLOOR ?? 1.18),
      emergency: Number(process.env.NLP_EMERGENCY ?? 1.06),
      everyS: Math.max(15, Number(process.env.NLP_EVERY_S ?? 60)),
      slipBps: Number(process.env.NLP_SLIP_BPS ?? 80),
      minEth: ethers.parseEther(process.env.NLP_MIN_ETH ?? "0.002"),
      closeOld: process.env.NLP_CLOSE_OLD || null,
      close: process.env.NLP_CLOSE || null, // etiqueta: cierra todo y deja USDC/WETH en la wallet
    };
    this.busy = false; this.timer = null; this.lastLine = 0;
  }
  get me() { return this.x?.wallet?.address; }
  get live() { return this.x?.mode === "live" && !!this.me; }

  async init() {
    this.s = (await this.store.get("nlp")) ?? { runs: {}, tokenId: null, events: [], actions: 0, recenters: 0, transfers: 0, deleverages: 0 };
    if (process.env.NLP_MANAGER_ADDRESS) this.s.manager = process.env.NLP_MANAGER_ADDRESS;
  }
  async save() { this.s.updatedAt = Date.now(); await this.store.set("nlp", this.s); }
  async note(m) { this.s.events.unshift({ t: Date.now(), m }); this.s.events.length = Math.min(this.s.events.length, 80); await this.diag(`lp-neutral: ${m}`); }
  /** RPC privados (Alchemy, NodeReal) de Base: se prueban y, si responden, van primero en la lista. Nunca se registra la URL. */
  async probePrivate() {
    // NODEREAL_KEY: admite la clave sola o la URL completa pegada (se toma lo que va tras /v1/)
    const nrRaw = String(process.env.NODEREAL_KEY ?? "").trim(), nrKey = nrRaw.includes("/v1/") ? nrRaw.split("/v1/")[1].replace(/\/+$/, "") : nrRaw;
    const nrUrl = nrKey ? `https://open-platform.nodereal.io/${nrKey}/base/` : null;
    const cands = [["alchemy", process.env.ALCHEMY_KEY && `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`], ["nodereal", nrUrl]];
    // Coinbase CDP: CDP_RPC_URL admite la URL completa o solo la clave. dRPC: DRPC_KEY.
    const cdpRaw = String(process.env.CDP_RPC_URL ?? "").trim(), drpc = String(process.env.DRPC_KEY ?? "").trim();
    cands.unshift(["coinbase", cdpRaw ? (/^https?:\/\//.test(cdpRaw) ? cdpRaw : `https://api.developer.coinbase.com/rpc/v1/base/${cdpRaw}`) : null]);
    cands.splice(1, 0, ["drpc", drpc ? `https://lb.drpc.org/ogrpc?network=base&dkey=${drpc}` : null]);
    const out = [], ok = [];
    for (const [name, url] of cands) {
      if (!url) { out.push(`${name}: sin clave`); continue; }
      try {
        const t0 = Date.now();
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }), signal: AbortSignal.timeout(8000) });
        const j = await res.json().catch(() => ({}));
        if (j.result) { ok.push(url); out.push(`${name}: OK (${Date.now() - t0} ms, bloque ${parseInt(j.result, 16)})`); }
        else out.push(`${name}: NO responde · HTTP ${res.status} · ${String(j.error?.message ?? "sin detalle").slice(0, 90)}`);
      } catch (e) { out.push(`${name}: NO responde · ${String(e.name || "error")} ${String(e.cause?.code ?? e.code ?? "")}${name === "coinbase" ? ` · valor de ${cdpRaw.length} caracteres${/^https?:\/\//.test(cdpRaw) ? " (URL)" : " (solo clave)"}${/\s/.test(cdpRaw) ? " con espacios" : ""}` : ""}${name === "nodereal" ? ` · clave de ${nrKey.length} caracteres${/^[0-9a-f]+$/i.test(nrKey) ? "" : " con caracteres raros"}${nrRaw !== nrKey ? " (venía con URL o espacios)" : ""}` : ""}`); }
    }
    this.rpcs = [...ok, ...NLP.RPCS];
    if (ok.length) { this.provider = new ethers.JsonRpcProvider(ok[0], 8453, { staticNetwork: true }); this.rpcIdx = 0; }
    await this.diag(`lp-neutral: RPC privados en Base · ${out.join(" | ")} · en uso: ${ok.length ? "privado" : "públicos"} (${this.rpcs.length} en la lista)`);
  }
  start() {
    if (this.timer) return;
    this.probePrivate().catch(() => {});
    setInterval(() => this.probePrivate().catch(() => {}), 6 * 3600_000).unref?.();
    const run = () => this.tick().then(() => { this.errs = 0; }).catch((e) => this.onError(e));
    this.timer = setInterval(run, this.cfg.everyS * 1000);
    setTimeout(run, 8_000);
  }
  /** Errores de RPC (410, sin respuesta, timeout): tras 2 seguidos cambia a otro RPC público de Base (2026-11-11: 1 h ciego por un RPC caído). */
  async onError(e) {
    const msg = (e.shortMessage || e.message || String(e)).slice(0, 180);
    this.errs = (this.errs ?? 0) + 1;
    if (this.errs >= 2 && /410|missing response|timeout|ECONN|network|503|502|429|rate/i.test(msg)) {
      const L = this.rpcs ?? NLP.RPCS;
      this.rpcIdx = ((this.rpcIdx ?? -1) + 1) % L.length;
      this.provider = new ethers.JsonRpcProvider(L[this.rpcIdx], 8453, { staticNetwork: true });
      this.errs = 0;
      await this.note(`RPC con fallas → cambia a ${new URL(L[this.rpcIdx]).host}`).catch(() => {});
      return;
    }
    await this.note(`error ${msg}`).catch(() => {});
  }
  c(addr) { return new ethers.Contract(addr, I, this.provider); }
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
      if (this.cfg.closeOld && !this.s.runs[`old:${this.cfg.closeOld}`]?.done) await this.closeOld(this.cfg.closeOld);
      await this.ensureManager();
      if (this.cfg.close && this.s.tokenId && !this.s.runs[`close:${this.cfg.close}`]?.done) { await this.closeAll(this.cfg.close); if (!this.s.closed) return; }
      // re-apertura con otro apalancamiento: posición cerrada + etiqueta de apertura nueva → abre de nuevo en la misma vuelta
      if (this.s.closed && this.cfg.tag && !this.s.runs[this.cfg.tag]?.done) {
        this.s.baseUsd ??= this.s.entry?.usd ?? this.cfg.usd;
        this.s.history = [...(this.s.history ?? []), { t: Date.now(), from: this.s.tokenId, to: null, why: "cierre para reabrir" }].slice(-50);
        this.s.tokenId = null; this.s.closed = false; this.s.outSince = null; this.s.minRevert = undefined; this.s.minComet = undefined; this.s.last = null;
      }
      if (this.cfg.tag && !this.s.runs[this.cfg.tag]?.done && !this.s.tokenId) await this.open(this.cfg.tag);
      if (this.s.tokenId && !this.s.closed) await this.monitor();
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  // ---------------------------------------------------------------- lecturas
  async prices() {
    const e = await this.c(NLP.ETHUSD_POOL).slot0(), s = await this.c(NLP.POOL).slot0();
    const se = Number(e.sqrtPriceX96) / 2 ** 96, sp = Number(s.sqrtPriceX96) / 2 ** 96;
    const eth = se * se * 1e12, px = sp * sp; // px = cbBTC crudo por WETH crudo
    return { eth, btc: eth / (px * 1e10), px, sqrtP: sp, tick: Number(s.tick) };
  }
  async read() {
    const id = this.s.tokenId, m = this.s.manager, pr = await this.prices();
    const li = await this.c(NLP.VAULT).loanInfo(id);
    const pos = await this.c(NLP.NPM).positions(id);
    const cColl = Number(await this.c(NLP.COMET).collateralBalanceOf(m, NLP.USDC)) / 1e6;
    const cDebt = Number(await this.c(NLP.COMET).borrowBalanceOf(m)) / 1e18;
    const x = { rColl: Number(li.collateralValue) / 1e6, rDebt: Number(li.debt) / 1e6, rValue: Number(li.fullValue) / 1e6, cColl, cDebt, cDebtUsd: cDebt * pr.eth };
    const h = healths(x);
    const inRange = pr.tick >= Number(pos.tickLower) && pr.tick < Number(pos.tickUpper);
    return { ...x, h, pr, pos, li, inRange, equity: x.rValue - x.rDebt + x.cColl - x.cDebtUsd };
  }

  // ---------------------------------------------------------------- contrato
  async ensureManager() {
    if (this.s.manager || (this.s.managerTries ?? 0) >= 3) return;
    try {
      const args = [this.me, NLP.VAULT, NLP.NPM, NLP.MORPHO, NLP.ROUTER, NLP.COMET, NLP.USDC, NLP.WETH, NLP.CBBTC, NLP.FEE];
      const rc = await this.send("despliegue NeutralLpManager", { data: ART.bytecode + M.encodeDeploy(args).slice(2) });
      this.s.manager = rc.contractAddress; await this.save();
      await this.note(`contrato NeutralLpManager en ${rc.contractAddress}`);
    } catch (e) { this.s.managerTries = (this.s.managerTries ?? 0) + 1; await this.note(`despliegue falló (${this.s.managerTries}/3) · ${(e.shortMessage || e.message).slice(0, 160)}`); }
  }

  /** Cierra la posición WETH/USDC del RevertLoanManager anterior: todo a USDC en la wallet. */
  async closeOld(tag) {
    const run = (this.s.runs[`old:${tag}`] ??= { tries: 0 });
    if (run.tries >= 3) return; run.tries++;
    try {
      const om = NLP.OLD_MANAGER, id = await this.c(om).lastTokenId();
      const vault = this.c(NLP.VAULT), owner = (await vault.ownerOf(id).catch(() => ethers.ZeroAddress)).toLowerCase();
      const tx = (fn, a) => ({ to: om, data: MO.encodeFunctionData(fn, a) });
      if (owner === om.toLowerCase()) {
        const li = await vault.loanInfo(id);
        if (li.debt > 0n) {
          const pos = await this.c(NLP.NPM).positions(id);
          await this.send(`cierre posición anterior #${id}: desapalanca todo (deuda $${ethers.formatUnits(li.debt, 6)})`, tx("deleverage", [{ tokenId: id, liquidity: pos.liquidity, minUsdcOut: 0n, deadline: this.dl() }, li.debt * 1003n / 1000n]));
        }
        await this.send(`cierre posición anterior #${id}: NFT vacío a la wallet`, tx("removeTo", [id, this.me]));
      }
      for (const t of [NLP.USDC, NLP.WETH]) {
        const b = await this.c(t).balanceOf(om);
        if (b > 0n) await this.send(`cierre posición anterior: ${t === NLP.USDC ? `${ethers.formatUnits(b, 6)} USDC` : `${ethers.formatEther(b)} WETH`} a la wallet`, tx("sweep", [t, this.me, 0n]));
      }
      run.done = true; await this.note(`posición anterior #${id} cerrada · USDC en wallet ${ethers.formatUnits(await this.c(NLP.USDC).balanceOf(this.me), 6)}`);
    } catch (e) { await this.note(`cierre posición anterior falló (${run.tries}/3) · ${(e.shortMessage || e.message).slice(0, 180)}`); }
  }

  async open(tag) {
    const run = (this.s.runs[tag] ??= { tries: 0 });
    if (!this.s.manager || run.tries >= 3) return;
    const have = Number(await this.c(NLP.USDC).balanceOf(this.me)) / 1e6;
    // tras un cierre puede faltar algo de centavos: abre con lo que hay si es ≥ 97 % de lo pedido
    const C = have >= this.cfg.usd ? this.cfg.usd : have >= this.cfg.usd * 0.97 ? Math.floor(have * 100) / 100 : this.cfg.usd;
    if (have < C) { if (!run.waitNoted) { run.waitNoted = true; await this.note(`apertura ${tag}: esperando fondeo · USDC en wallet $${have.toFixed(2)} de $${C}`); } return; }
    run.tries++;
    try {
      const pr = await this.prices();
      const { V, F, A } = openSizing(C, this.cfg.a, this.cfg.r);
      const { lower, upper } = rangeTicks(pr.tick, this.cfg.rangePct, NLP.SPACING);
      const w0 = token0Share(pr.sqrtP, lower, upper);
      const borrowWeth = BigInt(Math.floor(V / pr.eth * 1e18));
      const sellWeth = BigInt(Math.floor(Number(borrowWeth) * (1 - w0) * 0.999));
      const minBtcOut = BigInt(Math.floor(Number(sellWeth) * pr.px * (1 - this.cfg.slipBps / 1e4)));
      const usdcIn = BigInt(Math.round(C * 1e6)), flash = BigInt(Math.floor(F * 1e6));
      const allow = await this.c(NLP.USDC).allowance(this.me, this.s.manager);
      if (allow < usdcIn) await this.send("approve USDC → NeutralLpManager", { to: NLP.USDC, data: I.encodeFunctionData("approve", [this.s.manager, usdcIn]) });
      await this.note(`apertura ${tag}: $${C} propios · LP $${V.toFixed(2)} (WETH ${(w0 * 100).toFixed(0)} % / cbBTC) rango ticks [${lower}, ${upper}] ±${this.cfg.rangePct} % · Compound: colateral $${A.toFixed(2)}, deuda ${ethers.formatEther(borrowWeth)} WETH · Revert: deuda $${F.toFixed(2)}`);
      await this.send(`apertura ${tag}: flash $${F.toFixed(2)} → Compound → WETH → cbBTC → LP → Revert → préstamo`, this.mgr("open", [{ usdcIn, borrowWeth, sellWeth, minBtcOut, tickLower: lower, tickUpper: upper, deadline: this.dl() }, flash]));
      this.s.tokenId = (await new ethers.Contract(this.s.manager, ART.abi, this.provider).tokenId()).toString();
      run.done = true; this.s.openedAt = Date.now(); this.s.entry = { usd: this.s.baseUsd ?? C, put: C, eth: pr.eth, btc: pr.btc, V, F, A, t: Date.now() };
      const r = await this.read();
      await this.note(`abierta #${this.s.tokenId} · LP $${r.rValue.toFixed(2)} · Revert deuda $${r.rDebt.toFixed(2)} salud ${r.h.revert.toFixed(3)} · Compound colateral $${r.cColl.toFixed(2)} deuda ${r.cDebt.toFixed(6)} WETH salud ${r.h.comet.toFixed(3)} · capital $${r.equity.toFixed(2)}`);
    } catch (e) { await this.note(`apertura ${tag} falló (${run.tries}/3) · ${(e.shortMessage || e.message).slice(0, 200)}`); }
  }

  async monitor() {
    const r = await this.read(), id = this.s.tokenId, cfg = this.cfg;
    this.s.last = { t: Date.now(), revert: r.h.revert, comet: r.h.comet, lp: r.rValue, rDebt: r.rDebt, cColl: r.cColl, cDebt: r.cDebt, cDebtUsd: r.cDebtUsd, equity: r.equity, eth: r.pr.eth, btc: r.pr.btc, inRange: r.inRange, ticks: [Number(r.pos.tickLower), Number(r.pos.tickUpper)], tick: r.pr.tick };
    // comisiones puras: lo que el LP tiene por cobrar (lectura on-chain), sin efecto de precio
    try {
      const f = await this.provider.call({ from: NLP.VAULT, to: NLP.NPM, data: I.encodeFunctionData("collect", [{ tokenId: id, recipient: NLP.VAULT, amount0Max: MAX128, amount1Max: MAX128 }]) }).then((d) => I.decodeFunctionResult("collect", d));
      const usd = Number(f[0]) / 1e18 * r.pr.eth + Number(f[1]) / 1e8 * r.pr.btc;
      const days = (Date.now() - (this.s.openedAt ?? Date.now())) / 86400_000;
      this.s.last.fees = usd; this.s.last.feeDays = days;
      this.s.last.feeAprLp = days > 0.02 && r.rValue > 0 ? usd / r.rValue / days * 365 * 100 : null;
      this.s.last.feeAprCap = days > 0.02 && this.s.entry?.usd ? usd / this.s.entry.usd / days * 365 * 100 : null;
    } catch {}
    this.s.minRevert = Math.min(this.s.minRevert ?? Infinity, r.h.revert); this.s.minComet = Math.min(this.s.minComet ?? Infinity, r.h.comet);
    if (Date.now() - this.lastLine > 30 * 60_000) { this.lastLine = Date.now(); console.log(`${new Date().toISOString()} ${this.line()}`); }

    // 1) salud: traspasos entre los dos lados
    if (r.h.revert < cfg.revertTrigger) {
      const amt = cometToRevertAmount(r, cfg.revertTarget, cfg.cometFloor);
      if (amt >= 0.5) { await this.send(`salud Revert ${r.h.revert.toFixed(3)} (cripto bajó) → $${amt.toFixed(2)} de Compound a Revert`, this.mgr("cometToRevert", [id, BigInt(Math.floor(amt * 1e6))])); this.s.transfers++; return; }
    }
    if (r.h.comet < cfg.cometTrigger) {
      const amt = revertToCometAmount(r, cfg.cometTarget, cfg.revertFloor);
      if (amt >= 0.5) { await this.send(`salud Compound ${r.h.comet.toFixed(3)} (cripto subió) → $${amt.toFixed(2)} de Revert a Compound`, this.mgr("revertToComet", [id, BigInt(Math.floor(amt * 1e6))])); this.s.transfers++; return; }
    }
    if (Math.min(r.h.revert, r.h.comet) < cfg.emergency) { await this.deleverage(r, 0.25, `salud baja (Revert ${r.h.revert.toFixed(3)}, Compound ${r.h.comet.toFixed(3)})`, r.h.comet < r.h.revert); return; }

    // 2) rango
    if (!r.inRange) {
      if (!this.s.outSince) { this.s.outSince = Date.now(); await this.note(`fuera de rango (tick ${r.pr.tick}, rango [${r.pos.tickLower}, ${r.pos.tickUpper}]) · espera ${cfg.outMin} min`); }
    } else if (this.s.outSince) { await this.note(`volvió al rango tras ${((Date.now() - this.s.outSince) / 60_000).toFixed(0)} min · sin re-centrar`); this.s.outSince = null; }
    const due = !r.inRange && recenterDue(false, this.s.outSince, Date.now(), cfg.outMin);
    if (due && Date.now() - (this.s.lastRecenter ?? 0) > cfg.cooldownMin * 60_000) await this.recenter(r);
  }

  async recenter(r) {
    const id = this.s.tokenId, cfg = this.cfg;
    this.s.lastRecenter = Date.now();
    try {
      const L = Number(r.pos.liquidity), am = amountsFor(L, r.pr.sqrtP, Number(r.pos.tickLower), Number(r.pos.tickUpper));
      const fees = await this.provider.call({ from: NLP.VAULT, to: NLP.NPM, data: I.encodeFunctionData("collect", [{ tokenId: id, recipient: NLP.VAULT, amount0Max: MAX128, amount1Max: MAX128 }]) }).then((d) => I.decodeFunctionResult("collect", d)).catch(() => [0n, 0n]);
      const x0 = am.a0 + Number(fees[0]), x1 = am.a1 + Number(fees[1]);
      const { lower, upper } = rangeTicks(r.pr.tick, cfg.rangePct, NLP.SPACING);
      const sw = rebalanceSwap(x0, x1, r.pr.sqrtP, lower, upper, cfg.slipBps);
      const flash = r.li.debt * 1003n / 1000n + 10n;
      const args = { tokenId: id, tickLower: lower, tickUpper: upper, sellToken0: sw.sellToken0, swapAmountIn: sw.amountIn, swapMinOut: sw.minOut, deadline: this.dl() };
      await this.send(`re-centra #${id} → ticks [${lower}, ${upper}] (WETH en BTC ${(r.pr.px * 1e10).toFixed(6)})`, this.mgr("recenter", [args, flash]));
      const nid = (await new ethers.Contract(this.s.manager, ART.abi, this.provider).tokenId()).toString();
      this.s.history = [...(this.s.history ?? []), { t: Date.now(), from: id, to: nid }].slice(-50);
      this.s.tokenId = nid; this.s.recenters++; this.s.outSince = null;
      const n = await this.read();
      await this.note(`re-centrado: nueva #${nid} · salud Revert ${n.h.revert.toFixed(3)} Compound ${n.h.comet.toFixed(3)} · capital $${n.equity.toFixed(2)}`);
    } catch (e) { await this.note(`re-centrado falló · ${(e.shortMessage || e.message).slice(0, 180)} · reintenta tras el enfriamiento`); }
  }

  /** Reduce todo en proporción `frac` (LP, deuda Revert, deuda WETH, colateral Compound). */
  /** cometWeak: retira de Compound solo lo del flash (baja la deuda WETH más que el colateral → sube la salud de Compound);
   *  si no, retira la fracción del colateral y el sobrante repaga Revert (sube la salud de Revert). */
  async deleverage(r, frac, why, cometWeak = false) {
    const id = this.s.tokenId;
    const liq = BigInt(Math.floor(Number(r.pos.liquidity) * frac));
    const flash = BigInt(Math.floor(r.rDebt * frac * 1e6));
    const withdraw = cometWeak ? flash * 1002n / 1000n + 1n : BigInt(Math.floor(r.cColl * frac * 1e6));
    const minWethOut = 0n;
    for (const k of cometWeak ? [1, 1.05, 1.1] : [1, 0.9, 0.8]) {
      const tx = this.mgr("deleverage", [{ tokenId: id, liquidity: liq, withdrawUsdc: BigInt(Math.floor(Number(withdraw) * k)), minWethOut, close: false, deadline: this.dl() }, flash]);
      try { await this.sim(tx); } catch { continue; }
      await this.send(`${why}: desapalanca ${(frac * 100).toFixed(0)} % con flashloan`, tx); this.s.deleverages++; return true;
    }
    await this.note(`${why}: el desapalancamiento no simuló`); return false;
  }

  /** Cierra todo: repaga Revert, saca el NFT, cbBTC→WETH, repaga Compound, retira el USDC; saldos al dueño. */
  async closeAll(tag) {
    const run = (this.s.runs[`close:${tag}`] ??= { tries: 0 });
    if (run.tries >= 3) return; run.tries++;
    try {
      const r = await this.read(), id = this.s.tokenId;
      const flash = r.li.debt * 1003n / 1000n + 10n;
      let sent = false;
      for (const k of [1, 0.98, 0.95, 0.9, 0.8]) {
        const tx = this.mgr("deleverage", [{ tokenId: id, liquidity: 0n, withdrawUsdc: BigInt(Math.floor(r.cColl * k * 1e6)), minWethOut: 0n, close: true, deadline: this.dl() }, flash]);
        try { await this.sim(tx); } catch { continue; }
        await this.send(`cierre ${tag}: repaga todo y retira ${(k * 100).toFixed(0)} % del colateral de Compound`, tx); sent = true; break;
      }
      if (!sent) throw new Error("ninguna variante de cierre simuló");
      const rest = Number(await this.c(NLP.COMET).collateralBalanceOf(this.s.manager, NLP.USDC));
      const debt = await this.c(NLP.COMET).borrowBalanceOf(this.s.manager);
      if (rest > 0 && debt === 0n) await this.send(`cierre ${tag}: resto del colateral de Compound`, this.mgr("cometWithdraw", [NLP.USDC, BigInt(rest)]));
      for (const t of [NLP.USDC, NLP.WETH, NLP.CBBTC]) if ((await this.c(t).balanceOf(this.s.manager)) > 0n) await this.send(`cierre ${tag}: saldo a la wallet`, this.mgr("sweep", [t, 0n]));
      run.done = true; this.s.closed = true;
      await this.note(`cerrada · wallet USDC ${ethers.formatUnits(await this.c(NLP.USDC).balanceOf(this.me), 6)} · deuda WETH restante ${ethers.formatEther(debt)}`);
    } catch (e) { await this.note(`cierre ${tag} falló (${run.tries}/3) · ${(e.shortMessage || e.message).slice(0, 180)}`); }
  }

  line() {
    const l = this.s.last; if (!l) return `lp-neutral: ${this.s.tokenId ? `#${this.s.tokenId}` : "sin posición"}`;
    const e = this.s.entry;
    return `lp-neutral: #${this.s.tokenId} · LP $${l.lp.toFixed(2)} ${l.inRange ? "en rango" : "FUERA de rango"} · Revert deuda $${l.rDebt.toFixed(2)} salud ${l.revert.toFixed(3)} · Compound colateral $${l.cColl.toFixed(2)} deuda ${l.cDebt.toFixed(6)} WETH ($${l.cDebtUsd.toFixed(2)}) salud ${l.comet.toFixed(3)}${l.fees != null ? ` · comisiones por cobrar $${l.fees.toFixed(3)} en ${(l.feeDays * 24).toFixed(1)} h${l.feeAprCap != null ? ` = ${l.feeAprCap.toFixed(0)} % anual sobre el capital (${l.feeAprLp.toFixed(0)} % sobre el LP)` : ""}` : ""} · capital $${l.equity.toFixed(2)}${e ? ` (inicio $${e.usd}, ${((l.equity / e.usd - 1) * 100).toFixed(2)} %)` : ""} · ETH $${l.eth.toFixed(0)} BTC $${l.btc.toFixed(0)} · re-centrados ${this.s.recenters} traspasos ${this.s.transfers} desapalancamientos ${this.s.deleverages}`;
  }
  view() { return { ready: true, manager: this.s.manager, tokenId: this.s.tokenId, entry: this.s.entry, last: this.s.last, minRevert: this.s.minRevert, minComet: this.s.minComet, recenters: this.s.recenters, transfers: this.s.transfers, deleverages: this.s.deleverages, events: this.s.events.slice(0, 30), line: this.line(), cfg: this.cfg }; }
}
