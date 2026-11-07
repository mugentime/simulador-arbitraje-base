// Guardia de retiros (orden de Jose 2026-11-06 19:34: "Deten cualquier retiro no explicitamente autorizado. Genera una
// white list"; 19:39: "solamente hay una cuenta de la que aceptamos retiros y es la que se uso para hacer el ultimo
// deposito de eth"). Toda tx que firme el bot pasa por aquí: se bloquea si saca fondos hacia una dirección que no sea la
// propia wallet ni una de WITHDRAW_WHITELIST:
//   · valor nativo hacia una cuenta sin código (EOA),
//   · ERC20 transfer / transferFrom hacia otra dirección,
//   · approve a una cuenta sin código.
// Los envíos a contratos (routers, vaults, Relay con recipient = la propia wallet) siguen permitidos.
import { ethers } from "ethers";

const SEL = { transfer: "0xa9059cbb", transferFrom: "0x23b872dd", approve: "0x095ea7b3" };
const ABI = new ethers.Interface(["function transfer(address,uint256)", "function transferFrom(address,address,uint256)", "function approve(address,uint256)"]);
export const whitelist = () => (process.env.WITHDRAW_WHITELIST || "").split(",").map((x) => x.trim().toLowerCase()).filter((x) => /^0x[0-9a-f]{40}$/.test(x));

export class WithdrawGuard {
  constructor({ provider, me, diag = async () => {} }) { this.provider = provider; this.me = String(me).toLowerCase(); this.diag = diag; this.codeCache = new Map(); this.blocked = []; }
  allowed(a) { a = String(a || "").toLowerCase(); return a === this.me || whitelist().includes(a); }
  async isEoa(a) {
    a = String(a).toLowerCase();
    if (!this.codeCache.has(a)) this.codeCache.set(a, (await this.provider.getCode(a)) === "0x");
    return this.codeCache.get(a);
  }
  /** Lanza si la tx sacaría fondos a una dirección no autorizada. */
  async check(tx) {
    const to = String(tx.to || "").toLowerCase();
    const data = String(tx.data || "0x"); const sel = data.slice(0, 10).toLowerCase();
    let why = null;
    if (!to) { if (BigInt(tx.value ?? 0) > 0n) why = "creación de contrato con valor"; }
    else if (BigInt(tx.value ?? 0) > 0n && !this.allowed(to) && (await this.isEoa(to))) why = `envío de ${ethers.formatEther(BigInt(tx.value))} nativo a ${to}`;
    else if (sel === SEL.transfer) { const [r] = ABI.decodeFunctionData("transfer", data); if (!this.allowed(r)) why = `transfer de token ${to} a ${r}`; }
    else if (sel === SEL.transferFrom) { const [, r] = ABI.decodeFunctionData("transferFrom", data); if (!this.allowed(r)) why = `transferFrom de token ${to} a ${r}`; }
    else if (sel === SEL.approve) { const [sp] = ABI.decodeFunctionData("approve", data); if (!this.allowed(sp) && (await this.isEoa(sp))) why = `approve de token ${to} a la cuenta ${sp}`; }
    if (why) {
      this.blocked.push({ at: new Date().toISOString(), why });
      await this.diag(`GUARDIA DE RETIROS: tx bloqueada (${why}); solo se permiten retiros a la propia wallet o a WITHDRAW_WHITELIST`);
      const e = new Error(`bloqueada por la guardia de retiros: ${why}`); e.code = "WITHDRAW_BLOCKED"; throw e;
    }
  }
  /** Envuelve un firmante: sendTransaction / signTransaction pasan por check(). */
  wrap(w) {
    if (!w || w.__guarded) return w;
    const g = this;
    return new Proxy(w, {
      get(t, k, r) {
        if (k === "__guarded") return true;
        if (k === "sendTransaction" || k === "signTransaction") return async (tx) => { await g.check(tx); return t[k](tx); };
        if (k === "signer") return g.wrap(t.signer);
        const v = Reflect.get(t, k, r); return typeof v === "function" ? v.bind(t) : v;
      },
    });
  }
}
