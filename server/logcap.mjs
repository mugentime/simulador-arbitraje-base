// Límite de direcciones por eth_getLogs (publicnode: "A maximum of 10 addresses is allowed").
export function addrCapFromError(e) {
  const txt = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.info?.responseBody ?? ""} ${e?.error?.message ?? ""}`;
  const m = txt.match(/maximum of (\d+) addresses/i);
  return m ? Number(m[1]) : 0;
}
// Con límite: en un solo bloque se pide sin filtro de dirección (1 llamada; el llamador filtra por dirección),
// en un rango se trocea la lista de direcciones.
export async function callCapped(call, filter, cap) {
  const addrs = filter.address;
  if (!cap || !Array.isArray(addrs) || addrs.length <= cap) return call(filter);
  if (filter.fromBlock !== undefined && filter.fromBlock === filter.toBlock) {
    const want = new Set(addrs.map((a) => a.toLowerCase()));
    const { address, ...rest } = filter;
    return (await call(rest)).filter((l) => want.has(String(l.address).toLowerCase()));
  }
  const out = [];
  for (let i = 0; i < addrs.length; i += cap) out.push(...(await call({ ...filter, address: addrs.slice(i, i + cap) })));
  return out;
}
