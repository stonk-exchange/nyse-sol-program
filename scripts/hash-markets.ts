/** Print the sha256 of each market preset, for ALLOWED_SCHEDULES in lib.rs. */
import { createHash } from "crypto";
import { MARKETS, Market } from "./markets/presets";
import { encodeScheduleForHash } from "./markets/hook";

for (const id of Object.keys(MARKETS)) {
  const m: Market = MARKETS[id];
  const digest = createHash("sha256").update(encodeScheduleForHash(m)).digest();
  console.log(`// ${m.label}`);
  console.log(`[${Array.from(digest).join(", ")}],`);
  console.log(`// hex: ${digest.toString("hex")}\n`);
}
