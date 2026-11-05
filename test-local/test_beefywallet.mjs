// Beefy wallet: monto subyacente por tipo de vault y neto depositado por vault desde el historial
import { underlyingAmount, netDepositsByVault } from "../server/beefywallet.mjs";
let fails = 0; const ok = (c, m) => { console.log((c ? "OK " : "FALLA ") + m); if (!c) fails++; };
const E18 = 10n ** 18n;
ok(Math.abs(underlyingAmount({ type: "standard", shares: 2n * E18, ppfs: 15n * E18 / 10n }) - 3) < 1e-12, "standard: 2 acciones × 1.5 = 3");
ok(Math.abs(underlyingAmount({ type: "standard", shares: 2n * E18, ppfs: 15n * 10n ** 5n, tokenDecimals: 6 }) - 3) < 1e-12, "standard con subyacente de 6 decimales");
ok(underlyingAmount({ type: "gov", shares: 5n * E18 }) === 5, "reward pool: 1 a 1");
const n = netDepositsByVault([{ product_key: "beefy:vault:base:x-vault", usd_diff: 10, display_name: "X", datetime: "2026-11-01" }, { product_key: "beefy:vault:base:x-vault", usd_diff: -3 }, { product_key: "beefy:vault:base:y", usd_diff: "4.5" }]);
ok(n["x-vault"].netUsd === 7 && n["x-vault"].txs === 2 && n.y.netUsd === 4.5, "neto depositado por vault");
process.exit(fails ? 1 : 0);
