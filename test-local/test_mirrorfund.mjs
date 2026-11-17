// Fondeo de la espejo desde cualquier cadena: faltante arrastrado, orden de fuentes, monto a enviar y el flujo paso a paso.
import { ethers } from "ethers";
import { MirrorFund, owedFromLog, fundSources, sendAmount } from "../server/mirrorfund.mjs";
import { BASE_USDC } from "../server/bridge.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };

ok(owedFromLog([{ usd: 39.97 }], 50) === 10.03, "depósito de $39.97 deja $10.03 por reponer");
ok(owedFromLog([{ usd: 39.97 }, { usd: 49.96 }], 50) === 10.03, "un faltante de centavos no cuenta");
ok(owedFromLog([{ usd: 10 }, { usd: 10 }], 50) === 50, "tope = un depósito");
ok(owedFromLog(undefined, 50) === 0, "sin depósitos no debe nada");

const VUSDT = "0xfD5840Cd36d94D7229439859C0112a4185BC0255", USDT = "0x55d398326f99059fF775485246999027B3197955", WMON = "0x00000000000000000000000000000000000000a1", USDG = "0x00000000000000000000000000000000000000a2", VVV = "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf";
const inv = { chains: [
  { chain: "robinhood", rows: [{ sym: "ETH", usd: 9.88 }, { sym: "WETH", usd: 5.57, address: "0x00000000000000000000000000000000000000a3" }, { sym: "USDG", usd: 42.85, address: USDG }, { sym: "DELL", usd: 0.93, address: "0x00000000000000000000000000000000000000a4" }] },
  { chain: "base", rows: [{ sym: "ETH", usd: 9.09 }, { sym: "USDC", usd: 42.8, address: BASE_USDC }, { sym: "VVV", usd: 7.28, address: VVV }, { sym: "cbBTC", usd: 5, address: "0x00000000000000000000000000000000000000a5" }] },
  { chain: "monad", rows: [{ sym: "MON", usd: 0.38 }, { sym: "WMON", usd: 15.66, address: WMON }] },
  { chain: "bsc", rows: [{ sym: "BNB", usd: 0.58 }, { sym: "vUSDT (Venus)", usd: 10.01, address: VUSDT, venus: true }] },
  { chain: "arbitrum", rows: [{ sym: "USDC", usd: 1, address: "0x00000000000000000000000000000000000000a6" }] },
] };
const src = fundSources(inv, { skip: new Set(["WETH", "CBBTC"]), minUsd: 3 });
ok(src.map((x) => x.sym).join(",") === "USDG,vUSDT (Venus),WMON,VVV", `orden: dólares, Venus, resto de mayor a menor (${src.map((x) => x.sym).join(",")})`);
ok(!src.some((x) => /^(ETH|MON|BNB|WETH|cbBTC|DELL)$/.test(x.sym)) && !src.some((x) => x.chain === "base" && x.sym === "USDC"), "no toca gas, WETH, cbBTC, polvo ni el USDC de Base");

ok(sendAmount(1000n, 15.66, 7.2) === 468n, "manda solo lo que falta + 2 %");
ok(sendAmount(1000n, 10, 9.5) === 1000n && sendAmount(1000n, 10, 30) === 1000n, "si sobraría polvo o no alcanza, manda todo");
ok(sendAmount(1000n, 0, 5) === 0n && sendAmount(0n, 10, 5) === 0n, "sin valor o sin saldo no manda");

// ---- flujo: faltan $17.20; hay Venus $10.01 y WMON $15.66 (el USDG ya se acabó)
{
  const me = ethers.Wallet.createRandom().address, notes = [], sent = [], quotes = [];
  const ERC = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
  const V = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function exchangeRateStored() view returns (uint256)", "function redeem(uint256) returns (uint256)", "function redeemUnderlying(uint256) returns (uint256)"]);
  const bals = { [USDT.toLowerCase()]: 0n, [WMON.toLowerCase()]: ethers.parseEther("1036.69"), [VUSDT.toLowerCase()]: 40_000_000_000n };
  const prov = { call: async (tx) => {
    const to = tx.to.toLowerCase(), sel = tx.data.slice(0, 10);
    if (sel === ERC.getFunction("balanceOf").selector) return ERC.encodeFunctionResult("balanceOf", [bals[to] ?? 0n]);
    if (sel === ERC.getFunction("decimals").selector) return ERC.encodeFunctionResult("decimals", [18]);
    if (sel === V.getFunction("exchangeRateStored").selector) return V.encodeFunctionResult("exchangeRateStored", [ethers.parseEther("10.01") * 10n ** 18n / 40_000_000_000n]);
    if (sel === V.getFunction("redeem").selector || sel === V.getFunction("redeemUnderlying").selector) return ethers.zeroPadValue("0x00", 32);
    return "0x"; } };
  const status = {};
  globalThis.fetch = async (url, o) => {
    if (String(url).includes("/quote/v2")) {
      const b = JSON.parse(o.body); quotes.push(b);
      const px = b.originCurrency.toLowerCase() === WMON.toLowerCase() ? 15.66 / 1036.69 : 1, inUsd = Number(ethers.formatEther(BigInt(b.amount))) * px, id = `0xr${quotes.length}`;
      return { ok: true, json: async () => ({ steps: [
        { id: "approve", kind: "transaction", items: [{ data: { to: b.originCurrency, data: "0x095ea7b3", value: "0", chainId: b.originChainId } }] },
        { id: "deposit", kind: "transaction", requestId: id, items: [{ data: { to: "0x00000000000000000000000000000000000000bb", data: "0x99", value: "0", chainId: b.originChainId } }] }],
        details: { currencyIn: { amountUsd: String(inUsd) }, currencyOut: { amountUsd: String(inUsd * 0.995), amount: String(Math.floor(inUsd * 0.995 * 1e6)) } } }) };
    }
    const id = new URL(url).searchParams.get("requestId"); return { ok: true, json: async () => ({ status: status[id] ?? "pending" }) };
  };
  const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
  const strat = { s: {} };
  const mf = new MirrorFund({ executor: { wallet: { address: me }, mode: "live" }, provider: prov, store, diag: async (m) => notes.push(m), strategy: () => strat });
  await mf.init();
  const ids = { bsc: 56, monad: 143, base: 8453 };
  mf.chain = (k) => ({ id: ids[k], p: prov, local: false });
  mf.sendOn = async (k, tx) => { sent.push({ k, ...tx }); if (tx.data.startsWith(V.getFunction("redeem").selector)) { bals[USDT.toLowerCase()] = ethers.parseEther("10.01"); bals[VUSDT.toLowerCase()] = 0n; } return `0xh${sent.length}`; };
  let view = { chains: inv.chains.filter((c) => ["monad", "bsc"].includes(c.chain)) };
  mf.balances = async () => view;

  let r = await mf.step(111, 17.2);
  ok(r.pending && sent.length === 1 && sent[0].k === "bsc" && sent[0].data.startsWith(V.getFunction("redeem").selector) && mf.s.queue[0]?.sym === "USDT", "1) Venus primero: retira todo (lo que sobraría es polvo) y encola el USDT");
  r = await mf.step(111, 17.2);
  ok(r.pending && sent.length === 3 && quotes.at(-1).originCurrency === USDT && quotes.at(-1).originChainId === 56 && quotes.at(-1).recipient === me && quotes.at(-1).destinationCurrency === BASE_USDC, "2) puentea el USDT de BSC a USDC en Base (approve + depósito), destino la propia wallet");
  ok(mf.s.sends.length === 1 && mf.s.sends[0].status === "enviado" && Math.abs(mf.s.sends[0].outUsd - 9.96) < 0.01 && !mf.s.queue.length, "queda en camino ~$9.96");
  r = await mf.step(111, 17.2);
  const q3 = quotes.at(-1), part = Number(ethers.formatEther(BigInt(q3.amount))) * 15.66 / 1036.69;
  ok(r.pending && q3.originCurrency === WMON && q3.originChainId === 143 && Math.abs(part - (17.2 - 9.96) * 1.02) < 0.05 && sent.length === 5, `3) de WMON manda solo lo que falta (~$${part.toFixed(2)} de $15.66)`);
  const n = sent.length;
  r = await mf.step(111, 17.2);
  ok(r.pending && sent.length === n && !strat.s.fundReq, "4) con todo en camino espera: no manda más ni toca el vault");
  status["0xr1"] = "success"; status["0xr3"] = "success";
  r = await mf.step(111, 0.3);
  ok(!r.pending && mf.s.sends.every((x) => x.status === "hecho") && sent.length === n, "5) llegó: deja de esperar");
  ok(notes.some((m) => /lp-neutral2: fondeo · .*WMON de monad/.test(m)) && notes.some((m) => /llegó a Base/.test(m)), "deja rastro en los logs con el prefijo lp-neutral2: fondeo");

  // nuevo depósito sin saldos sueltos: pide al vault una sola vez y espera a la estrategia
  view = { chains: [] };
  r = await mf.step(222, 50);
  ok(r.pending && strat.s.fundReq?.cycle === 222 && strat.s.fundReq.spec === "NVDAc-USDC" && Math.abs(strat.s.fundReq.usd - 51.5) < 0.01 && strat.s.fundReq.status === "pendiente", "6) sin saldos sueltos pide el faltante (+3 %) al vault NVDAc");
  r = await mf.step(222, 50); ok(r.pending, "espera mientras la estrategia retira");
  strat.s.fundReq.status = "hecho"; strat.s.fundReq.outUsd = 51.2;
  r = await mf.step(222, 0.2); ok(!r.pending && mf.s.vault.status === "hecho", "7) retiro hecho: el depósito sigue");
  delete strat.s.fundReq; mf.s.vault.status = "error";
  r = await mf.step(222, 20); ok(!r.pending && !strat.s.fundReq && notes.some((m) => /ya no hay de dónde tomar/.test(m)), "8) el vault se pide una sola vez por depósito; si no hay más, lo dice y no bloquea");

  // comisión alta o cotización rara: no firma
  view = { chains: [{ chain: "monad", rows: [{ sym: "WMON", usd: 15.66, address: WMON }] }] };
  const f0 = globalThis.fetch;
  globalThis.fetch = async (url, o) => { const b = JSON.parse(o.body); return { ok: true, json: async () => ({ steps: [{ id: "deposit", kind: "transaction", requestId: "0xbad", items: [{ data: { to: "0x00000000000000000000000000000000000000bb", data: "0x99", value: "0", chainId: b.originChainId } }] }], details: { currencyIn: { amountUsd: "10" }, currencyOut: { amountUsd: "9", amount: "9000000" } } }) }; };
  const n2 = sent.length; mf.cfg.vault = "0";
  r = await mf.step(333, 30);
  ok(sent.length === n2 && notes.some((m) => /comisión \+ deslizamiento 10\.0 %/.test(m)), "9) comisión de 10 % > 3 %: no envía y lo anota");
  globalThis.fetch = async (url, o) => { const b = JSON.parse(o.body); return { ok: true, json: async () => ({ steps: [{ id: "deposit", kind: "transaction", requestId: "0xbad", items: [{ data: { to: "0x00000000000000000000000000000000000000bb", data: "0xa9059cbb" + "00".repeat(64), value: "0", chainId: b.originChainId } }] }], details: { currencyIn: { amountUsd: "10" }, currencyOut: { amountUsd: "9.95", amount: "9950000" } } }) }; };
  mf.s.cool = {};
  r = await mf.step(333, 30);
  ok(sent.length === n2 && notes.some((m) => /envío directo; no se firma/.test(m)), "10) una cotización que pide un transfer directo no se firma");
  globalThis.fetch = f0;
}
// ---- nativo que sobra de la reserva de gas (Jose 2026-11-17: "que el bot use los fondos disponibles siempre")
{
  const inv2 = { chains: [
    { chain: "base", rows: [{ sym: "ETH", amount: 0.17726, usd: 319.07 }, { sym: "WETH", amount: 0.0006, usd: 1.1, address: "0x00000000000000000000000000000000000000a3" }] },
    { chain: "robinhood", rows: [{ sym: "ETH", amount: 0.0054, usd: 9.7 }, { sym: "USDG", amount: 5, usd: 5, address: USDG }] },
    { chain: "bsc", rows: [{ sym: "BNB", amount: 0.5, usd: 300 }] },
    { chain: "arbitrum", rows: [{ sym: "ETH", amount: 0.0112, usd: 20.2 }] },
  ] };
  const a = fundSources(inv2, { skip: new Set(["WETH"]), minUsd: 3, nativeReserve: { ETH: 0.01 } });
  ok(a.map((x) => `${x.sym}@${x.chain}`).join(",") === "USDG@robinhood,ETH@base", `dólares primero y luego el ETH que sobra de la reserva (${a.map((x) => `${x.sym}@${x.chain}`).join(",")})`);
  const e = a.find((x) => x.kind === "native");
  ok(Math.abs(e.usd - 319.07 * (0.16726 / 0.17726)) < 0.01 && /^0x0{40}$/.test(e.address), "el ETH utilizable es el saldo menos la reserva de gas");
  ok(!a.some((x) => x.sym === "BNB") && !a.some((x) => x.chain === "robinhood" && x.sym === "ETH") && !a.some((x) => x.chain === "arbitrum"), "gas bajo la reserva, sobrante de centavos y nativos sin reserva definida no se tocan");
  ok(!fundSources(inv2, { minUsd: 3 }).some((x) => x.kind === "native"), "sin reserva definida el nativo no se toca (comportamiento anterior)");

  // flujo: faltan $52; solo hay ETH en Base → cambia lo que falta (+2 %) y deja el resto
  const me = ethers.Wallet.createRandom().address, notes = [], sent = [], quotes = [];
  const px = 1800, bal0 = ethers.parseEther("0.17726");
  const prov = { getBalance: async () => bal0, call: async () => "0x" };
  const f0 = globalThis.fetch; let mode = "ok";
  globalThis.fetch = async (url, o) => {
    if (String(url).includes("/quote/v2")) {
      const b = JSON.parse(o.body); quotes.push(b);
      const inUsd = Number(ethers.formatEther(BigInt(b.amount))) * px;
      const value = mode === "mas" ? (BigInt(b.amount) + 1n).toString() : b.amount;
      return { ok: true, json: async () => ({ steps: [{ id: "swap", kind: "transaction", requestId: "0xq", items: [{ data: { to: "0x00000000000000000000000000000000000000bb", data: "0x99", value, chainId: b.originChainId } }] }],
        details: { currencyIn: { amountUsd: String(inUsd) }, currencyOut: { amountUsd: String(inUsd * (mode === "caro" ? 0.9 : 0.997)) } } }) };
    }
    return { ok: true, json: async () => ({ status: "success" }) };
  };
  const mem = {}; const store = { get: async (k) => mem[k], set: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
  const mk = async () => { const mf = new MirrorFund({ executor: { wallet: { address: me }, mode: "live" }, provider: prov, store: { get: async () => undefined, set: async () => {} }, diag: async (m) => notes.push(m), strategy: () => null });
    await mf.init(); mf.chain = () => ({ id: 8453, p: prov, local: true }); mf.sendOn = async (k, tx) => { sent.push({ k, ...tx }); return `0xn${sent.length}`; };
    mf.balances = async () => ({ chains: [inv2.chains[0]] }); mf.cfg.vault = "0"; return mf; };
  let mf = await mk();
  ok(mf.cfg.nativeReserve.ETH === 0.01, "reserva de gas por omisión: 0.01 ETH");
  let r = await mf.step(501, 52);
  const want = 52 * 1.02 / px;
  ok(r.pending && sent.length === 1 && sent[0].k === "base" && Math.abs(Number(ethers.formatEther(sent[0].value)) - want) < 1e-6, `11) manda solo el ETH que hace falta (${sent[0] ? ethers.formatEther(sent[0].value) : "nada"})`);
  ok(quotes[0].originCurrency === "0x0000000000000000000000000000000000000000" && quotes[0].originChainId === 8453 && quotes[0].recipient === me && BigInt(quotes[0].amount) === bal0 - ethers.parseEther("0.01"), "11b) cotiza el nativo de Base menos la reserva, con destino a la propia wallet");
  ok(notes.some((m) => /ETH de base .*queda la reserva de gas de 0\.01 ETH.* USDC en Base vía Relay/.test(m)), "11c) lo avisa en el log");
  // una cotización que manda más valor del pedido o cobra de más no se firma
  mode = "mas"; mf = await mk(); const n0 = sent.length; await mf.step(502, 52);
  ok(sent.length === n0 && notes.some((m) => /no manda exactamente el monto pedido/.test(m)), "12) valor distinto al pedido: no se firma");
  mode = "caro"; mf = await mk(); await mf.step(503, 52);
  ok(sent.length === n0 && notes.some((m) => /comisión \+ deslizamiento 10\.0 %/.test(m)), "13) comisión alta: no se firma");
  // NLP2_FUND_GAS_RESERVE_ETH=off: no toca el nativo
  mode = "ok"; mf = await mk(); mf.cfg.nativeReserve = null; r = await mf.step(504, 52);
  ok(sent.length === n0 && r.pending === false, "14) con la reserva apagada el nativo no se usa");
  globalThis.fetch = f0;
}
console.log(fails ? "HAY FALLAS" : "todo OK"); process.exit(fails ? 1 : 0);
