// Préstamo propio en Revert Lend (Jose, 2026-11-09): LP de comisiones como colateral, préstamo máximo en USDC y monitor cada minuto.
//   Apertura (una vez por etiqueta RVL_LOAN_OPEN=<etiqueta>, Base):
//     1) fondeo: wrap ETH → WETH y swap ETH → USDC (Uniswap v3 0.05 %) para tener ~mitad y mitad de RVL_LOAN_USD;
//     2) mint de una posición Uniswap v3 WETH-USDC 0.3 % (el pool con más comisiones que acepta Revert) en ±RVL_LOAN_RANGE_PCT;
//     3) NFT → V3Vault de Revert (safeTransferFrom, dueño = esta wallet);
//     4) borrow del máximo que permite el vault (95 % del valor de colateral; factor del par = mínimo de los dos tokens) × RVL_LOAN_BORROW_FRAC.
//   Monitor (cada RVL_LOAN_EVERY_S, 60 s): loanInfo → salud = valor de colateral / deuda.
//     Si la salud < RVL_LOAN_TRIGGER_HF: desapalanca hasta RVL_LOAN_TARGET_HF repagando con el USDC de la wallet; si no alcanza,
//     cambia ETH → USDC (sin bajar de RVL_LOAN_MIN_ETH) y repaga. Cada paso se simula con eth_call antes de enviarse.
// Solo lectura de la cadena + transacciones de la propia wallet (la guardia de retiros sigue activa).
import { ethers } from "ethers";

export const RVL = {
  VAULT: "0x36AEAe0E411a1E28372e0d66f02E57744EbE7599", // Revert Lend V3Vault (Uniswap v3), activo USDC
  NPM: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", // Uniswap v3 NonfungiblePositionManager (Base)
  POOL: "0x6c561B446416E1A00E8E93E221854d6eA4171372", // WETH-USDC 0.3 %
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
  "function positions(uint256) view returns (uint96,address,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)",
  "function ownerOf(uint256) view returns (address)",
  "function loanInfo(uint256) view returns (uint256 debt, uint256 fullValue, uint256 collateralValue, uint256 liquidationCost, uint256 liquidationValue)",
  "function borrow(uint256 tokenId, uint256 assets)",
  "function repay(uint256 tokenId, uint256 amount, bool isShare) returns (uint256, uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);

// ---------------------------------------------------------------- funciones puras (probadas en test-local/test_revertloan.mjs)
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
    };
    this.busy = false; this.timer = null; this.lastLine = 0;
  }
  get me() { return this.x?.wallet?.address; }
  get live() { return this.x?.mode === "live" && !!this.me; }

  async init() {
    this.s = (await this.store.get("rvloan")) ?? { runs: {}, tokenId: null, events: [], minHf: null, maxHf: null, actions: 0 };
    if (process.env.RVL_LOAN_TOKENID && !this.s.tokenId) this.s.tokenId = process.env.RVL_LOAN_TOKENID;
  }
  async save() { this.s.updatedAt = Date.now(); await this.store.set("rvloan", this.s); }
  async note(m) { this.s.events.unshift({ t: Date.now(), m }); this.s.events.length = Math.min(this.s.events.length, 40); await this.diag(`revert-préstamo: ${m}`); }

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
  async price() { const s0 = await this.c(RVL.POOL).slot0(); return { p: priceFromSqrt(s0.sqrtPriceX96), tick: Number(s0.tick) }; }

  async tick() {
    if (this.busy || !this.live) return;
    this.busy = true;
    try {
      const tag = this.cfg.tag;
      if (tag && !this.s.runs[tag]?.done) await this.open(tag);
      if (this.s.tokenId) await this.monitor();
    } finally { this.busy = false; await this.save().catch(() => {}); }
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
        if (owner.toLowerCase() === this.me.toLowerCase()) await this.send(`NFT #${run.tokenId} → Revert V3Vault`, { to: RVL.NPM, data: I.encodeFunctionData("safeTransferFrom", [this.me, RVL.VAULT, run.tokenId]) });
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
    const id = this.s.tokenId;
    const li = await this.c(RVL.VAULT).loanInfo(id);
    if (li.debt === 0n) { if (!this.s.repaid) { this.s.repaid = true; await this.note(`#${id} sin deuda`); } return; }
    const hf = health(li.collateralValue, li.debt);
    const { p, tick } = await this.price();
    const pos = await this.c(RVL.NPM).positions(id).catch(() => null);
    const inRange = pos ? tick >= Number(pos.tickLower) && tick < Number(pos.tickUpper) : null;
    this.s.last = { t: Date.now(), hf, debt: Number(li.debt) / 1e6, value: Number(li.fullValue) / 1e6, collateral: Number(li.collateralValue) / 1e6, liquidatable: li.liquidationCost > 0n, ethUsd: p, inRange, owed0: pos ? Number(pos.tokensOwed0) / 1e18 : null, owed1: pos ? Number(pos.tokensOwed1) / 1e6 : null };
    this.s.minHf = this.s.minHf === null ? hf : Math.min(this.s.minHf, hf); this.s.maxHf = this.s.maxHf === null ? hf : Math.max(this.s.maxHf, hf);
    if (Date.now() - this.lastLine > 30 * 60_000) { this.lastLine = Date.now(); console.log(`${new Date().toISOString()} ${this.line()}`); }
    if (hf >= this.cfg.trigger && li.liquidationCost === 0n) return;
    // desapalancar
    const need = repayFor(li.collateralValue, li.debt, this.cfg.target);
    await this.note(`salud ${hf.toFixed(4)} < ${this.cfg.trigger}${li.liquidationCost > 0n ? " (¡liquidable!)" : ""} · ETH $${p.toFixed(2)} · repago necesario $${ethers.formatUnits(need, 6)}`);
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
    if (amt === 0n) return;
    await this.approve(RVL.USDC, RVL.VAULT, amt);
    await this.send(`repago ${ethers.formatUnits(amt, 6)} USDC (salud ${hf.toFixed(4)} → objetivo ${this.cfg.target})`, { to: RVL.VAULT, data: I.encodeFunctionData("repay", [id, amt, false]) });
    this.s.actions++;
  }

  line() {
    const l = this.s.last; if (!l) return "revert-préstamo: sin datos";
    return `revert-préstamo: #${this.s.tokenId} · salud ${l.hf.toFixed(4)} (mín ${this.s.minHf?.toFixed(4)}) · deuda $${l.debt.toFixed(2)} · valor $${l.value.toFixed(2)} · colateral $${l.collateral.toFixed(2)} · ETH $${l.ethUsd.toFixed(2)} · en rango ${l.inRange ? "sí" : "no"} · comisiones por cobrar ${l.owed0 ?? "-"} WETH / ${l.owed1 ?? "-"} USDC · desapalancamientos ${this.s.actions}`;
  }
  view() { return { cfg: { ...this.cfg, reserveEth: ethers.formatEther(this.cfg.reserveEth), minEth: ethers.formatEther(this.cfg.minEth) }, ...this.s, line: this.line() }; }
}
