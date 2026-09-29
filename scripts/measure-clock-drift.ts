/**
 * Measure how far a cluster's on-chain Clock is from real time.
 *
 * The hook decides market open/closed from Clock::unix_timestamp, which is a
 * stake-weighted estimate rather than a wall clock. This quantifies the error,
 * which bounds how wrong the hook can be at the open and close boundaries.
 */
import { Connection, PublicKey, clusterApiUrl } from "@solana/web3.js";

const CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");

async function drift(cluster: "mainnet-beta" | "devnet", samples = 5) {
  const c = new Connection(clusterApiUrl(cluster), "confirmed");
  const out: number[] = [];
  for (let i = 0; i < samples; i++) {
    const wallBefore = Date.now();
    const info = await c.getAccountInfo(CLOCK);
    const wallAfter = Date.now();
    if (!info) throw new Error("clock sysvar missing");
    // Clock layout: slot(8) epoch_start_timestamp(8) epoch(8)
    //               leader_schedule_epoch(8) unix_timestamp(8)
    const onChain = info.data.readBigInt64LE(32);
    // Compare against the midpoint of the RPC round trip.
    const wall = Math.round((wallBefore + wallAfter) / 2 / 1000);
    out.push(Number(onChain) - wall);
    await new Promise((r) => setTimeout(r, 1500));
  }
  return out;
}

(async () => {
  for (const cluster of ["mainnet-beta", "devnet"] as const) {
    try {
      const d = await drift(cluster);
      const min = Math.min(...d), max = Math.max(...d);
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      console.log(`${cluster.padEnd(13)} drift (on-chain minus real, seconds): ${d.join(", ")}`);
      console.log(`${" ".repeat(13)} min ${min}  max ${max}  mean ${mean.toFixed(1)}`);
    } catch (e: any) {
      console.log(`${cluster.padEnd(13)} failed: ${e.message}`);
    }
  }
  console.log("\nA positive number means the chain believes it is later than it is.");
  console.log("This is the window in which the hook can disagree with the real NYSE");
  console.log("bell, and it applies only within that many seconds of 09:30 or 16:00.");
})();
