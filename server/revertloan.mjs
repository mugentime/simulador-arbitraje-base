// Préstamo propio en Revert Lend (Jose, 2026-11-09): LP de comisiones como colateral, préstamo máximo en USDC y monitor cada minuto.
//   Apertura (una vez por etiqueta RVL_LOAN_OPEN=<etiqueta>, Base):
//     1) fondeo: wrap ETH → WETH y swap ETH → USDC (Uniswap v3 0.05 %) para tener ~mitad y mitad de RVL_LOAN_USD;
//     2) mint de una posición Uniswap v3 WETH-USDC 0.3 % (el pool con más comisiones que acepta Revert) en ±RVL_LOAN_RANGE_PCT;
//     3) NFT → V3Vault de Revert; 4) borrow del máximo (95 % del valor de colateral) × RVL_LOAN_BORROW_FRAC.
//   Contrato RevertLoanManager (contracts/src/RevertLoanManager.sol): dueño del préstamo en el vault; desapalanca y re-centra en
//   una sola transacción con flashloan de Morpho Blue (0 %). Se despliega solo (RVL_LOAN_MANAGER=0 lo desactiva) y la posición
//   que era de la wallet se migra al contrato (repago con el USDC de la wallet → remove → depósito con dueño = contrato → borrow).
//   Monitor (cada RVL_LOAN_EVERY_S, 60 s): loanInfo → salud = valor de colateral / deuda; precio y rango.
//     · salud < RVL_LOAN_TRIGGER_HF → desapalanca hasta RVL_LOAN_TARGET_HF con flashloan (respaldo: repago con USDC/ETH de la wallet);
//     · precio fuera de rango o a más de RVL_LOAN_RECENTER_AT de la mitad del rango → re-centra (si la salud es baja, primero desapalanca).
//   Cada transacción se simula con eth_call antes de enviarse.
import fs from "node:fs";
import { ethers } from "ethers";

const ART = JSON.parse(fs.readFileSync(new URL("./artifacts/RevertLoanManager.json", import.meta.url)));

export const RVL = {
  VAULT: "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599", // Revert Lend V3Vault (Uniswap v3), activo USDC
  NPM: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", // Uniswap v3 NonfungiblePositionManager (Base)
  POOL: "0x6c561B446416E1A00E8E93E221854d6eA4171372", // WETH-USDC 0.3 %
  MORPHO: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb", // Morpho Blue (flashloan 0 %)
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481", // SwapRouter02
  FEE: 3000, SPACING: 60, SWAP_FEE: 500,
  BORROW_BUFFER: 0.95, // BORROW_SAFETY_BUFFER_X32 del vault
};

const I = new ethers.Interface([
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function safeTransferFrom(address from,address to,uint256 tokenId)",
  "function safeTransferFrom(address from,address to,uint256 tokenId,bytes data)",
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function ownerOf(uint256) view returns (address)",
  "function loans(uint256) view returns (uint256)",
  "function loanInfo(uint256) view returns (uint256 debt, uint256 fullValue, uint256 collateralValue, uint256 liquidationCost, uint256 liquidationValue)",
  "function borrow(uint256 tokenId, uint256 assets)",
  "function repay(uint256 tokenId, uint256 amount, bool isShare) returns (uint256, uint256)",
  "function remove(uint256 tokenId, address recipient, bytes data)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const M = new ethers.Interface(ART.abi);

// ---------------------------------------------------------------- funciones puras (test-local/test_revertloan.mjs)
/** USDC por WETH a partir de sqrtPriceX96 (token0 = WETH 18 dec, token1 = USDC 6 dec). */
export function priceFromSqrt(sqrtPriceX96) { const s = Number(sqrtPriceX96) / 2 ** 96; return s * s * 1e12; }
/** Ticks del rango ±pct alrededor de `tick`, alineados al espaciado (inferior hacia abajo, superior hacia arriba). */
export function rangeTicks(tick, pct, spacing = RVL.SPACING) {
  const d = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
  return { lower: Math.floor((tick - d) / spacing) * spacing, upper: Math.ceil((tick + d) / spacing) * spacing };
}
/** Préstamo adicional permitido: colateral × 95 % × fracción − deuda, con un margen para intereses/precio entre la lectura y el envío. */
export function borrowable(collateralValue, debt, frac = 1, marginBps = 30) {
  const cap = collateralValue * BigInt(Math.round(RVL.BORROW_BUFFER * frac * 1e6)) / 1_000_000n;
  const x = cap * BigInt(10_000 - marginBps) / 10_000n - debt;
  return x > 0n ? x : 0n;
}
/** Repago para dejar la salud (colateral/deuda) en `target`. */
export function repayFor(collateralValue, debt, target) {
  const want = collateralValue * 1_000_000n / BigInt(Math.round(target * 1e6));
  return debt > want ? debt - want : 0n;
}
export const health = (collateralValue, debt) => (debt > 0n ? Number(collateralValue) / Number(debt) : Infinity);
const sqrtAt = (tick) => Math.sqrt(1.0001 ** tick);
/** Cantidades crudas (token0, token1) de una liquidez L en [a, b] al precio sqrtP (todo en unidades crudas, como Uniswap). */
export function amountsFor(L, sqrtP, tickA, tickB) {
  const sa = sqrtAt(tickA), sb = sqrtAt(tickB), s = Math.min(Math.max(sqrtP, sa), sb);
  return { a0: L * (1 / s - 1 / sb), a1: L * (s - sa) };
}
/** ¿Hay que re-centrar? Fuera de rango o a más de `at` (0–1) de la mitad del rango desde el centro (en ticks). */
export function needsRecenter(tick, lower, upper, at = 0.8) {
  if (tick < lower || tick >= upper) return true;
  const c = (lower + upper) / 2, half = (upper - lower) / 2;
  return Math.abs(tick - c) > at * half;
}
/** Swap para pasar de (x0, x1) crudos al reparto que pide el rango nuevo al precio actual. Devuelve {sellToken0, amountIn, minOut}. */
export function rebalanceSwap(x0, x1, sqrtP, newLower, newUpper, slipBps = 60) {
  const P = sqrtP * sqrtP; // token1 crudo por token0 crudo
  const unit = amountsFor(1e18, sqrtP, newLower, newUpper);
  const w0 = unit.a0 * P / (unit.a0 * P + unit.a1); // parte del valor en token0
  const T = x0 * P + x1;
  const t0 = w0 * T / P;
  const k = 1 - slipBps / 10_000;
  if (x0 > t0) { const amountIn = (x0 - t0) * 0.999; return { sellToken0: true, amountIn: BigInt(Math.floor(amountIn)), minOut: BigInt(Math.floor(amountIn * P * k)) }; }
  const amountIn = (t0 - x0) * P * 0.999;
  return { sellToken0: false, amountIn: BigInt(Math.floor(amountIn)), minOut: BigInt(Math.floor(amountIn / P * k)) };
}

// ---------------------------------------------------------------- módulo
export class RevertLoan {
  constructor({ executor, provider, store, diag }) {
    this.x = executor; this.provider = provider; this.store = store; this.diag = diag;
    this.cfg = {
      tag: process.env.RVL_LOAN_OPEN || null,
      usd: Number(process.env.RVL_LOAN_USD ?? 30),
      rangePct: Number(process.env.RVL_LOAN_RANGE_PCT ?? 10),
      frac: Math.min(1, Number(process.env.RVL_LOAN_BORROW_FRAC ?? 1)),
      trigger: Number(process.env.RVL_LOAN_TRIGGER_HF ?? 1.02),
      target: Number(process.env.RVL_LOAN_TARGET_HF ?? 1.06),
      everyS: Math.max(15, Number(process.env.RVL_LOAN_EVERY_S ?? 60)),
      reserveEth: ethers.parseEther(process.env.RVL_LOAN_RESERVE_ETH ?? "0.02"), // lo que debe quedar para el DCA al abrir
      minEth: ethers.parseEther(process.env.RVL_LOAN_MIN_ETH ?? "0.003"), // piso de gas en un rescate
      slipBps: Number(process.env.RVL_LOAN_SLIP_BPS ?? 100),
      manager: process.env.RVL_LOAN_MANAGER !== "0",
      recenterAt: Number(process.env.RVL_LOAN_RECENTER_AT ?? 0.8),
      recenterMinHf: Number(process.env.RVL_LOAN_RECENTER_MIN_HF ?? 1.08),
      recenterCooldownMin: Number(process.env.RVL_LOAN_RECENTER_COOLDOWN_MIN ?? 30),
      payoutTo: process.env.RVL_LOAN_PAYOUT_TO || null, // a dónde manda el contrato el USDC prestado (default: esta wallet)
    };
    this.busy = false; this.timer = null; this.lastLine = 0;
  }
  get me() { return this.x?.wallet?.address; }
  get live() { return this.x?.mode === "live" && !!this.me; }
  get payout() { return this.cfg.payoutTo || this.me; }

  async init() {
    this.s = (await this.store.get("rvloan")) ?? { runs: {}, tokenId: null, events: [], minHf: null, maxHf: null, actions: 0 };
    this.s.recenters ??= 0; this.s.history ??= [];
    if (process.env.RVL_LOAN_TOKENID && !this.s.tokenId) this.s.tokenId = process.env.RVL_LOAN_TOKENID;
    if (process.env.RVL_LOAN_MANAGER_ADDRESS) this.s.manager = process.env.RVL_LOAN_MANAGER_ADDRESS;
  }
  async save() { this.s.updatedAt = Date.now(); await this.store.set("rvloan", this.s); }
  async note(m) { this.s.events.unshift({ t: Date.now(), m }); this.s.events.length = Math.min(this.s.events.length, 60); await this.diag(`revert-préstamo: ${m}`); }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch((e) => this.note(`error ${(e.shortMessage || e.message || String(e)).slice(0, 160)}`).catch(() => {})), this.cfg.everyS * 1000);
    setTimeout(() => this.tick().catch(() => {}), 5_000);
  }

  c(addr) { return new ethers.Contract(addr, I, this.provider); }
  async sim(tx) { const t = { from: this.me, ...tx }; await this.provider.call(t); return (await this.provider.estimateGas(t)) * 13n / 10n; }
  async send(step, tx, { floorEth } = {}) {
    const gasLimit = await this.sim(tx);
    const eth = await this.provider.getBalance(this.me);
    const fee = await this.provider.getFeeData();
    const cost = gasLimit * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n);
    const floor = floorEth ?? this.cfg.minEth;
    if (eth - (tx.value ?? 0n) - cost < floor) throw new Error(`${step}: dejaría menos de ${ethers.formatEther(floor)} ETH`);
    const r = await this.x.withSender((w) => w.sendTransaction({ ...tx, gasLimit }));
    const rc = await this.provider.waitForTransaction(r.hash, 1, 180_000);
    if (!rc || rc.status !== 1) throw new Error(`${step}: ${r.hash} ${rc ? "revertida" : "sin recibo"}`);
    await this.note(`${step} · tx ${r.hash}`);
    return rc;
  }
  async approve(token, spender, amount) {
    const cur = await this.c(token).allowance(this.me, spender);
    if (cur >= amount) return;
    await this.send(`approve ${token === RVL.USDC ? "USDC" : "WETH"} → ${spender === RVL.VAULT ? "vault" : spender === RVL.NPM ? "NPM" : spender}`, { to: token, data: I.encodeFunctionData("approve", [spender, amount]) });
  }
  async state() { const s0 = await this.c(RVL.POOL).slot0(); return { p: priceFromSqrt(s0.sqrtPriceX96), tick: Number(s0.tick), sqrtP: Number(s0.sqrtPriceX96) / 2 ** 96 }; }
  async price() { return this.state(); }

  async tick() {
    if (this.busy || !this.live) return;
    this.busy = true;
    try {
      const tag = this.cfg.tag;
      if (tag && !this.s.runs[tag]?.done) await this.open(tag);
      if (this.s.tokenId && this.cfg.manager) { await this.ensureManager(); await this.migrate(); }
      if (this.s.tokenId) await this.monitor();
    } finally { this.busy = false; await this.save().catch(() => {}); }
  }

  // ---------------------------------------------------------------- contrato con flashloan
  async ensureManager() {
    if (this.s.manager) return;
    if (this.s.managerTries >= 3) return;
    try {
      const args = [this.me, RVL.VAULT, RVL.NPM, RVL.MORPHO, RVL.ROUTER, RVL.WETH, RVL.USDC, RVL.FEE, RVL.SWAP_FEE];
      const data = ART.bytecode + M.encodeDeploy(args).slice(2);
      const rc = await this.send("despliegue RevertLoanManager (flashloan Morpho)", { data });
      if (!rc.contractAddress) throw new Error("sin dirección de contrato en el recibo");
      this.s.manager = rc.contractAddress; await this.save();
      await this.note(`contrato RevertLoanManager en ${rc.contractAddress}`);
    } catch (e) { this.s.managerTries = (this.s.managerTries ?? 0) + 1; await this.note(`despliegue del contrato falló (${this.s.managerTries}/3) · ${(e.shortMessage || e.message).slice(0, 160)}`); }
  }
  mgr(fn, args) { return { to: this.s.manager, data: M.encodeFunctionData(fn, args) }; }

  /** Pasa el préstamo de la wallet al contrato: repago total con el USDC de la wallet → remove → depósito (dueño = contrato) → borrow. */
  async migrate() {
    if (!this.s.manager) return;
    const id = this.s.tokenId, vault = this.c(RVL.VAULT);
    const owner = (await vault.ownerOf(id)).toLowerCase();
    if (owner === this.s.manager.toLowerCase()) {
      // ya es del contrato; si la migración se cortó antes del borrow, se completa aquí
      if (this.s.migrating) { const li = await vault.loanInfo(id); if (li.debt === 0n) await this.borrowMax(id, "migración"); this.s.migrating = false; await this.save(); }
      return;
    }
    let m = (this.s.migration ??= { tries: 0 });
    const mt = process.env.RVL_LOAN_MIGRATE_TAG || "m1";
    if (m.tag !== mt) { m = this.s.migration = { tries: 0, tag: mt }; }
    if (m.tries >= 3) { if (!m.gaveUp) { m.gaveUp = true; this.s.migrating = false; await this.note(`migración al contrato detenida tras 3 intentos · ${m.error}`); } return; }
    try {
      this.s.migrating = true;
      const npmOwner = (await this.c(RVL.NPM).ownerOf(id)).toLowerCase();
      if (owner === this.me.toLowerCase()) {
        const shares = await vault.loans(id);
        if (shares > 0n) {
          const li = await vault.loanInfo(id);
          const need = li.debt + li.debt / 1000n + 10n;
          let usdc = await this.c(RVL.USDC).balanceOf(this.me);
          if (usdc < need) {
            // falta USDC (la estrategia de DCA usa el USDC libre de la wallet): se completa con ETH sin bajar de la reserva
            const { p } = await this.state();
            const ethIn = ethers.parseEther((Number(need - usdc) / 1e6 / p * 1.03).toFixed(18));
            const prm = { tokenIn: RVL.WETH, tokenOut: RVL.USDC, fee: RVL.SWAP_FEE, recipient: this.me, amountIn: ethIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
            const simOut = I.decodeFunctionResult("exactInputSingle", await this.provider.call({ from: this.me, to: RVL.ROUTER, value: ethIn, data: I.encodeFunctionData("exactInputSingle", [prm]) }))[0];
            prm.amountOutMinimum = simOut * BigInt(10_000 - this.cfg.slipBps) / 10_000n;
            await this.send(`migración: swap ${ethers.formatEther(ethIn)} ETH → USDC para repagar`, { to: RVL.ROUTER, value: ethIn, data: I.encodeFunctionData("exactInputSingle", [prm]) }, { floorEth: this.cfg.reserveEth });
            usdc = await this.c(RVL.USDC).balanceOf(this.me);
          }
          if (usdc < need) throw new Error(`USDC insuficiente para repagar (${ethers.formatUnits(usdc, 6)} < ${ethers.formatUnits(need, 6)})`);
          await this.approve(RVL.USDC, RVL.VAULT, need);
          await this.send(`migración: repago total ${ethers.formatUnits(li.debt, 6)} USDC`, { to: RVL.VAULT, data: I.encodeFunctionData("repay", [id, shares, true]) });
        }
        await this.send(`migración: NFT #${id} sale del vault`, { to: RVL.VAULT, data: I.encodeFunctionData("remove", [id, this.me, "0x"]) });
      }
      if ((await this.c(RVL.NPM).ownerOf(id)).toLowerCase() === this.me.toLowerCase() || npmOwner === this.me.toLowerCase()) {
        const data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [this.s.manager]);
        await this.send(`migración: NFT #${id} → vault con dueño = contrato`, { to: RVL.NPM, data: I.encodeFunctionData("safeTransferFrom(address,address,uint256,bytes)", [this.me, RVL.VAULT, id, data]) });
      }
      await this.borrowMax(id, "migración");
      this.s.migrating = false; await this.save();
    } catch (e) { m.tries++; m.error = (e.shortMessage || e.message).slice(0, 200); await this.note(`migración: error (${m.tries}/3) · ${m.error}`); }
  }
  async borrowMax(id, why) {
    const li = await this.c(RVL.VAULT).loanInfo(id);
    let amt = borrowable(li.collateralValue, li.debt, this.cfg.frac);
    for (let i = 0; i < 6 && amt > 0n; i++) {
      try { await this.sim(this.mgr("borrow", [id, amt, this.payout])); break; } catch { amt = amt * 99n / 100n; }
    }
    if (amt <= 0n) return 0n;
    await this.send(`${why}: borrow ${ethers.formatUnits(amt, 6)} USDC → ${this.payout === this.me ? "wallet del bot" : this.payout}`, this.mgr("borrow", [id, amt, this.payout]));
    const after = await this.c(RVL.VAULT).loanInfo(id);
    await this.note(`${why}: deuda $${ethers.formatUnits(after.debt, 6)} · valor $${ethers.formatUnits(after.fullValue, 6)} · salud ${health(after.collateralValue, after.debt).toFixed(4)}`);
    return amt;
  }

  /** Desapalanca con flashloan: repaga `need` y retira la liquidez equivalente (+2 %, +25 % por intento si la simulación falla). */
  async flashDeleverage(id, need, li, why) {
    const pos = await this.c(RVL.NPM).positions(id);
    const L = pos.liquidity;
    for (const bump of [1.02, 1.08, 1.2, 1.4]) {
      let frac = Number(need) / Number(li.fullValue) * bump; if (frac > 1) frac = 1;
      const liq = BigInt(Math.floor(Number(L) * frac));
      const tx = this.mgr("deleverage", [{ tokenId: id, liquidity: liq, minUsdcOut: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) }, need]);
      try { await this.sim(tx); } catch { continue; }
      await this.send(`${why}: desapalanca con flashloan · repago $${ethers.formatUnits(need, 6)} · retira ${(frac * 100).toFixed(2)} % de la liquidez`, tx);
      this.s.actions++;
      return true;
    }
    return false;
  }

  async walletRepay(id, need, p) {
    let usdc = await this.c(RVL.USDC).balanceOf(this.me);
    if (usdc < need) {
      const short = need - usdc;
      const eth = await this.provider.getBalance(this.me);
      const ethIn = ethers.parseEther((Number(short) / 1e6 / p * 1.03).toFixed(18));
      if (eth - ethIn > this.cfg.minEth) {
        const prm = { tokenIn: RVL.WETH, tokenOut: RVL.USDC, fee: RVL.SWAP_FEE, recipient: this.me, amountIn: ethIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
        const simOut = I.decodeFunctionResult("exactInputSingle", await this.provider.call({ from: this.me, to: RVL.ROUTER, value: ethIn, data: I.encodeFunctionData("exactInputSingle", [prm]) }))[0];
        prm.amountOutMinimum = simOut * BigInt(10_000 - this.cfg.slipBps) / 10_000n;
        await this.send(`rescate: swap ${ethers.formatEther(ethIn)} ETH → USDC`, { to: RVL.ROUTER, value: ethIn, data: I.encodeFunctionData("exactInputSingle", [prm]) });
        usdc = await this.c(RVL.USDC).balanceOf(this.me);
      } else await this.note(`ALERTA: sin USDC ni ETH suficientes para desapalancar (USDC $${ethers.formatUnits(usdc, 6)}, ETH ${ethers.formatEther(eth)})`);
    }
    const amt = usdc < need ? usdc : need;
    if (amt === 0n) return false;
    await this.approve(RVL.USDC, RVL.VAULT, amt);
    await this.send(`repago con la wallet ${ethers.formatUnits(amt, 6)} USDC`, { to: RVL.VAULT, data: I.encodeFunctionData("repay", [id, amt, false]) });
    this.s.actions++;
    return true;
  }

  async recenter(id, li, st, pos) {
    const { lower, upper } = rangeTicks(st.tick, this.cfg.rangePct);
    const L = Number(pos.liquidity);
    const now = amountsFor(L, st.sqrtP, Number(pos.tickLower), Number(pos.tickUpper));
    const sw = rebalanceSwap(now.a0 + Number(pos.tokensOwed0), now.a1 + Number(pos.tokensOwed1), st.sqrtP, lower, upper);
    const flash = li.debt + li.debt / 2000n + 10n; // deuda + 0.05 % (intereses entre la lectura y el envío)
    const args = { tokenId: id, tickLower: lower, tickUpper: upper, sellToken0: sw.sellToken0, swapAmountIn: sw.amountIn, swapMinOut: sw.minOut, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
    const tx = this.mgr("recenter", [args, flash]);
    try { await this.sim(tx); }
    catch (e) {
      // sin swap si la simulación falla por el mínimo de salida (precio movido); el mint usa lo que haya
      const tx2 = this.mgr("recenter", [{ ...args, swapAmountIn: 0n, swapMinOut: 0n }, flash]);
      try { await this.sim(tx2); await this.note(`re-centrado: simulación con swap falló (${(e.shortMessage || e.message).slice(0, 80)}); se hace sin reequilibrar`); return this.doRecenter(tx2, id, lower, upper, st); }
      catch (e2) { await this.note(`re-centrado: simulación falló · ${(e2.shortMessage || e2.message).slice(0, 140)}`); this.s.lastRecenterTry = Date.now(); return false; }
    }
    return this.doRecenter(tx, id, lower, upper, st);
  }
  async doRecenter(tx, id, lower, upper, st) {
    await this.send(`re-centra #${id} con flashloan → ticks ${lower}…${upper} (ETH $${st.p.toFixed(2)})`, tx);
    const newId = (await new ethers.Contract(this.s.manager, M, this.provider).lastTokenId()).toString();
    this.s.history.unshift({ t: Date.now(), from: id, to: newId, lower, upper, ethUsd: st.p }); this.s.history.length = Math.min(this.s.history.length, 30);
    this.s.tokenId = newId; this.s.recenters++; this.s.lastRecenter = Date.now();
    const after = await this.c(RVL.VAULT).loanInfo(newId);
    await this.note(`re-centrado: nueva posición #${newId} · deuda $${ethers.formatUnits(after.debt, 6)} · valor $${ethers.formatUnits(after.fullValue, 6)} · salud ${health(after.collateralValue, after.debt).toFixed(4)}`);
    return true;
  }

  /** Apertura idempotente por pasos (si un paso falla, se retoma en el siguiente minuto desde donde quedó). */
  async open(tag) {
    const run = (this.s.runs[tag] ??= { step: "fund", startedAt: Date.now(), tries: 0 });
    if (run.tries >= 5) { if (!run.gaveUp) { run.gaveUp = true; await this.note(`apertura ${tag} detenida tras 5 intentos · último error: ${run.error}`); } return; }
    try {
      const { p, tick } = await this.price();
      if (run.step === "fund") {
        const usdcNeed = BigInt(Math.floor(this.cfg.usd / 2 * 1e6));
        const wethNeed = ethers.parseEther((this.cfg.usd / 2 / p).toFixed(18));
        const usdcBal = await this.c(RVL.USDC).balanceOf(this.me);
        const wethBal = await this.c(RVL.WETH).balanceOf(this.me);
        const usdcShort = usdcNeed > usdcBal ? usdcNeed - usdcBal : 0n;
        const ethForUsdc = usdcShort > 0n ? ethers.parseEther((Number(usdcShort) / 1e6 / p * 1.02).toFixed(18)) : 0n;
        const wrap = wethNeed > wethBal ? wethNeed - wethBal : 0n;
        const bal = await this.provider.getBalance(this.me);
        if (bal - ethForUsdc - wrap < this.cfg.reserveEth) throw new Error(`fondos insuficientes: ${ethers.formatEther(bal)} ETH, se necesitan ${ethers.formatEther(ethForUsdc + wrap)} + reserva ${ethers.formatEther(this.cfg.reserveEth)}`);
        await this.note(`apertura ${tag}: posición ~$${this.cfg.usd} WETH-USDC 0.3 % ±${this.cfg.rangePct} % · ETH $${p.toFixed(2)} · wrap ${ethers.formatEther(wrap)} ETH · swap ${ethers.formatEther(ethForUsdc)} ETH → USDC`);
        if (ethForUsdc > 0n) {
          const prm = { tokenIn: RVL.WETH, tokenOut: RVL.USDC, fee: RVL.SWAP_FEE, recipient: this.me, amountIn: ethForUsdc, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n };
          const simOut = I.decodeFunctionResult("exactInputSingle", await this.provider.call({ from: this.me, to: RVL.ROUTER, value: ethForUsdc, data: I.encodeFunctionData("exactInputSingle", [prm]) }))[0];
          prm.amountOutMinimum = simOut * BigInt(10_000 - this.cfg.slipBps) / 10_000n;
          await this.send("swap ETH → USDC", { to: RVL.ROUTER, value: ethForUsdc, data: I.encodeFunctionData("exactInputSingle", [prm]) }, { floorEth: this.cfg.reserveEth });
        }
        if (wrap > 0n) await this.send("wrap ETH → WETH", { to: RVL.WETH, value: wrap, data: I.encodeFunctionData("deposit", []) }, { floorEth: this.cfg.reserveEth });
        run.step = "mint"; await this.save();
      }
      if (run.step === "mint") {
        const amt0 = await this.c(RVL.WETH).balanceOf(this.me);
        const usdcBal = await this.c(RVL.USDC).balanceOf(this.me);
        const amt1 = usdcBal < BigInt(Math.floor(this.cfg.usd / 2 * 1e6)) ? usdcBal : BigInt(Math.floor(this.cfg.usd / 2 * 1e6));
        await this.approve(RVL.WETH, RVL.NPM, amt0);
        await this.approve(RVL.USDC, RVL.NPM, amt1);
        const { lower, upper } = rangeTicks(tick, this.cfg.rangePct);
        const prm = { token0: RVL.WETH, token1: RVL.USDC, fee: RVL.FEE, tickLower: lower, tickUpper: upper, amount0Desired: amt0, amount1Desired: amt1, amount0Min: 0n, amount1Min: 0n, recipient: this.me, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) };
        const simRes = I.decodeFunctionResult("mint", await this.provider.call({ from: this.me, to: RVL.NPM, data: I.encodeFunctionData("mint", [prm]) }));
        prm.amount0Min = simRes.amount0 * BigInt(10_000 - this.cfg.slipBps) / 10_000n;
        prm.amount1Min = simRes.amount1 * BigInt(10_000 - this.cfg.slipBps) / 10_000n;
        const rc = await this.send(`mint WETH-USDC 0.3 % ticks ${lower}…${upper} (${ethers.formatEther(simRes.amount0)} WETH + ${ethers.formatUnits(simRes.amount1, 6)} USDC)`, { to: RVL.NPM, data: I.encodeFunctionData("mint", [prm]) });
        const tr = rc.logs.filter((l) => l.address.toLowerCase() === RVL.NPM.toLowerCase()).map((l) => { try { return I.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Transfer" && e.args.to.toLowerCase() === this.me.toLowerCase());
        if (!tr) throw new Error("mint sin evento Transfer: no se pudo leer el tokenId");
        run.tokenId = tr.args.tokenId.toString(); run.ticks = { lower, upper }; run.entryPrice = p; this.s.tokenId = run.tokenId;
        run.step = "deposit"; await this.save();
        await this.note(`posición NFT #${run.tokenId} creada`);
      }
      if (run.step === "deposit") {
        const owner = await this.c(RVL.NPM).ownerOf(run.tokenId);
        if (owner.toLowerCase() === this.me.toLowerCase()) await this.send(`NFT #${run.tokenId} → Revert V3Vault`, { to: RVL.NPM, data: I.encodeFunctionData("safeTransferFrom(address,address,uint256)", [this.me, RVL.VAULT, run.tokenId]) });
        const vOwner = await this.c(RVL.VAULT).ownerOf(run.tokenId);
        if (vOwner.toLowerCase() !== this.me.toLowerCase()) throw new Error(`el vault no registra esta wallet como dueña del #${run.tokenId} (${vOwner})`);
        run.step = "borrow"; await this.save();
      }
      if (run.step === "borrow") {
        const li = await this.c(RVL.VAULT).loanInfo(run.tokenId);
        let amt = borrowable(li.collateralValue, li.debt, this.cfg.frac);
        for (let i = 0; i < 6 && amt > 0n; i++) {
          try { await this.sim({ to: RVL.VAULT, data: I.encodeFunctionData("borrow", [run.tokenId, amt]) }); break; }
          catch { amt = amt * 99n / 100n; }
        }
        if (amt <= 0n) throw new Error("no hay monto que se pueda pedir");
        await this.send(`borrow ${ethers.formatUnits(amt, 6)} USDC (valor $${ethers.formatUnits(li.fullValue, 6)}, colateral $${ethers.formatUnits(li.collateralValue, 6)})`, { to: RVL.VAULT, data: I.encodeFunctionData("borrow", [run.tokenId, amt]) });
        const after = await this.c(RVL.VAULT).loanInfo(run.tokenId);
        run.borrowed = ethers.formatUnits(amt, 6); run.hfOpen = health(after.collateralValue, after.debt);
        run.step = "open"; run.done = true; run.openedAt = Date.now(); await this.save();
        await this.note(`préstamo abierto · deuda $${ethers.formatUnits(after.debt, 6)} · valor $${ethers.formatUnits(after.fullValue, 6)} · salud ${run.hfOpen.toFixed(4)} · monitor cada ${this.cfg.everyS} s (desapalanca < ${this.cfg.trigger} → ${this.cfg.target})`);
      }
    } catch (e) {
      run.tries++; run.error = (e.shortMessage || e.message || String(e)).slice(0, 200); await this.save();
      await this.note(`apertura ${tag} paso ${run.step}: error (${run.tries}/5) · ${run.error}`);
    }
  }

  async monitor() {
    if (this.s.migrating) return;
    const id = this.s.tokenId, vault = this.c(RVL.VAULT);
    const li = await vault.loanInfo(id);
    const st = await this.state();
    const pos = await this.c(RVL.NPM).positions(id).catch(() => null);
    const owner = (await vault.ownerOf(id).catch(() => ethers.ZeroAddress)).toLowerCase();
    const viaManager = !!this.s.manager && owner === this.s.manager.toLowerCase();
    const hf = health(li.collateralValue, li.debt);
    const inRange = pos ? st.tick >= Number(pos.tickLower) && st.tick < Number(pos.tickUpper) : null;
    this.s.last = { t: Date.now(), hf, debt: Number(li.debt) / 1e6, value: Number(li.fullValue) / 1e6, collateral: Number(li.collateralValue) / 1e6, liquidatable: li.liquidationCost > 0n, ethUsd: st.p, tick: st.tick, inRange, ticks: pos ? [Number(pos.tickLower), Number(pos.tickUpper)] : null, owner: viaManager ? "contrato" : owner === this.me.toLowerCase() ? "wallet" : owner };
    if (li.debt > 0n) { this.s.minHf = this.s.minHf === null ? hf : Math.min(this.s.minHf, hf); this.s.maxHf = this.s.maxHf === null ? hf : Math.max(this.s.maxHf, hf); }
    if (Date.now() - this.lastLine > 30 * 60_000) { this.lastLine = Date.now(); console.log(`${new Date().toISOString()} ${this.line()}`); }

    // 0) posición del contrato sin deuda (p. ej. migración o re-centrado cortados por un reinicio): vuelve a pedir el máximo
    if (viaManager && li.debt === 0n && !this.s.closed && process.env.RVL_LOAN_CLOSE !== "1") { await this.borrowMax(id, "préstamo"); return; }
    // 1) salud
    if (li.debt > 0n &&(hf < this.cfg.trigger || li.liquidationCost > 0n)) {
      const need = repayFor(li.collateralValue, li.debt, this.cfg.target);
      await this.note(`salud ${hf.toFixed(4)} < ${this.cfg.trigger}${li.liquidationCost > 0n ? " (¡liquidable!)" : ""} · ETH $${st.p.toFixed(2)} · repago necesario $${ethers.formatUnits(need, 6)}`);
      if (viaManager && await this.flashDeleverage(id, need, li, "salud baja")) return;
      if (viaManager) await this.note("flashloan no simuló; respaldo con la wallet");
      await this.walletRepay(id, need, st.p);
      return;
    }
    // 2) rango
    if (viaManager && pos && li.debt > 0n && needsRecenter(st.tick, Number(pos.tickLower), Number(pos.tickUpper), this.cfg.recenterAt)) {
      const since = Date.now() - Math.max(this.s.lastRecenter ?? 0, this.s.lastRecenterTry ?? 0);
      if (since < this.cfg.recenterCooldownMin * 60_000) return;
      if (hf < this.cfg.recenterMinHf) {
        // margen antes de re-centrar (la posición nueva pierde un poco por el swap)
        const need = repayFor(li.collateralValue, li.debt, this.cfg.recenterMinHf + 0.02);
        await this.note(`re-centrado: primero desapalanca (salud ${hf.toFixed(4)} < ${this.cfg.recenterMinHf})`);
        if (!(await this.flashDeleverage(id, need, li, "antes de re-centrar"))) this.s.lastRecenterTry = Date.now();
        return;
      }
      await this.note(`precio ${inRange ? "cerca del borde" : "fuera"} del rango [${pos.tickLower}, ${pos.tickUpper}] (tick ${st.tick}, ETH $${st.p.toFixed(2)}) → re-centra`);
      await this.recenter(id, li, st, pos);
    }
  }

  line() {
    const l = this.s.last; if (!l) return "revert-préstamo: sin datos";
    return `revert-préstamo: #${this.s.tokenId} (${l.owner}) · salud ${Number.isFinite(l.hf) ? l.hf.toFixed(4) : "∞"} (mín ${this.s.minHf?.toFixed(4)}) · deuda $${l.debt.toFixed(2)} · valor $${l.value.toFixed(2)} · colateral $${l.collateral.toFixed(2)} · ETH $${l.ethUsd.toFixed(2)} · en rango ${l.inRange ? "sí" : "no"} · desapalancamientos ${this.s.actions} · re-centrados ${this.s.recenters}`;
  }
  view() { return { cfg: { ...this.cfg, reserveEth: ethers.formatEther(this.cfg.reserveEth), minEth: ethers.formatEther(this.cfg.minEth) }, ...this.s, line: this.line() }; }
}
