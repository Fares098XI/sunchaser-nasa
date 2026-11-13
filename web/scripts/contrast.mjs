// Text contrast over the Syzygy tokens (src/ui/tokens.css): every text colour on every surface must reach 4.5:1 (WCAG AA).
// Run: node scripts/contrast.mjs   (exit code 1 on a failure)
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/ui/tokens.css", import.meta.url), "utf8");
const hex = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
const TEXT = ["highland", "ink", "regolith", "dust", "corona", "gold-leaf", "gold", "gold-bright", "amber", "flare", "prominence", "cloud", "lagoon", "ocean", "aurora", "marginal"];
const SURFACES = ["void", "surface", "raised"];

const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let fail = 0;
for (const t of TEXT) {
  if (!hex[t]) { console.log(`missing token --${t}`); fail++; continue; }
  const row = SURFACES.map((s) => { const r = ratio(hex[t], hex[s]); if (r < 4.5) fail++; return `${s} ${r.toFixed(1)}${r < 4.5 ? " FAIL" : ""}`; });
  console.log(`--${t.padEnd(12)} ${row.join("  ")}`);
}
console.log(fail ? `${fail} pair(s) below 4.5:1` : "all text pairs >= 4.5:1");
process.exit(fail ? 1 : 0);
