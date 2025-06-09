import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { NyseTokenHook } from "../target/types/nyse_token_hook";
import {
  PublicKey,
  Keypair,
  Connection,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import {
  Raydium,
  CREATE_CPMM_POOL_PROGRAM,
  CREATE_CPMM_POOL_FEE_ACC,
  DEVNET_PROGRAM_ID,
  getCpmmPdaAmmConfigId,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import fs from "fs";

async function testLiquidityPoolCreation() {
  console.log("🌊 TESTING RAYDIUM LIQUIDITY POOL CREATION");
  console.log("═══════════════════════════════════════════");

  // Load deployment info - prefer devnet, then latest
  let deploymentInfo;
  let deploymentFile;

  if (fs.existsSync("stonks-deployment-devnet.json")) {
    deploymentFile = "stonks-deployment-devnet.json";
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  } else if (fs.existsSync("stonks-deployment-latest.json")) {
    deploymentFile = "stonks-deployment-latest.json";
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  } else if (fs.existsSync("stonks-deployment.json")) {
    deploymentFile = "stonks-deployment.json";
    deploymentInfo = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  } else {
    console.log(
      "❌ No deployment info found. Run deploy-stonks-token.ts first!"
    );
    console.log(
      "   Looking for: stonks-deployment-devnet.json, stonks-deployment-latest.json, or stonks-deployment.json"
    );
    return;
  }

  console.log(`📄 Using deployment file: ${deploymentFile}`);
  const DEPLOYED_TOKEN = deploymentInfo.mintAddress;
  const network = deploymentInfo.network as "testnet" | "devnet";

  console.log(`💎 STONK Token: ${DEPLOYED_TOKEN}`);
  console.log(
    `🌐 Network: ${network.charAt(0).toUpperCase() + network.slice(1)}`
  );

  // Set up connection to the same network as deployment
  const connection = new Connection(clusterApiUrl(network), "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  console.log(`👤 Wallet: ${wallet.publicKey.toString()}`);

  try {
    // Initialize Raydium SDK for the selected network
    console.log(`🔧 Initializing Raydium SDK for ${network}...`);

    // Raydium SDK only supports devnet and mainnet, not testnet
    const raydiumCluster = network === "testnet" ? "devnet" : network;
    if (network === "testnet") {
      console.log(
        "⚠️  Note: Using devnet cluster for Raydium SDK (testnet not supported)"
      );
    }

    const raydium = await Raydium.load({
      owner: wallet.payer,
      connection: connection,
      cluster: raydiumCluster as "devnet" | "mainnet",
    });
    console.log("✅ Raydium SDK initialized!");

    // Get token info for your STONK token
    console.log("📊 Getting token information...");
    const mintA = await raydium.token.getTokenInfo(DEPLOYED_TOKEN);
    console.log(`✅ STONK Token Info:`, {
      address: mintA.address,
      decimals: mintA.decimals,
      symbol: mintA.symbol || "STONK",
    });

    // Get wrapped SOL info
    const mintB = await raydium.token.getTokenInfo(NATIVE_MINT.toBase58());
    console.log(`✅ SOL Token Info:`, {
      address: mintB.address,
      decimals: mintB.decimals,
      symbol: mintB.symbol || "SOL",
    });

    // Get CPMM fee configurations
    console.log("💰 Getting CPMM fee configurations...");
    const feeConfigs = await raydium.api.getCpmmConfigs();
    console.log(`✅ Found ${feeConfigs.length} fee configurations`);

    // Fix fee config IDs for devnet (as shown in SDK demo)
    if (raydium.cluster === "devnet") {
      feeConfigs.forEach((config) => {
        config.id = getCpmmPdaAmmConfigId(
          DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
          config.index
        ).publicKey.toBase58();
      });
      console.log("🔧 Updated fee config IDs for devnet");
    }

    const feeConfig = feeConfigs[0];
    console.log("📋 Using fee config:", {
      id: feeConfig.id,
      index: feeConfig.index,
      tradeFeeRate: feeConfig.tradeFeeRate,
      protocolFeeRate: feeConfig.protocolFeeRate,
    });

    // Calculate amounts for pool creation (reasonable initial liquidity)
    const stonkAmount = new BN(100000).mul(
      new BN(10).pow(new BN(mintA.decimals))
    ); // 100K STONK
    const solAmount = new BN(0.1 * 1e9); // 0.1 SOL

    console.log("💰 Pool amounts:", {
      stonk: `${stonkAmount
        .div(new BN(10).pow(new BN(mintA.decimals)))
        .toString()} STONK`,
      sol: `${solAmount
        .div(new BN(10).pow(new BN(mintB.decimals)))
        .toString()} SOL`,
    });

    // Create the CPMM pool
    console.log("🏊 Creating CPMM pool...");

    // Use proper program IDs based on network
    const programId =
      raydium.cluster === "devnet"
        ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM
        : CREATE_CPMM_POOL_PROGRAM;
    const poolFeeAccount =
      raydium.cluster === "devnet"
        ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC
        : CREATE_CPMM_POOL_FEE_ACC;

    console.log(`📍 Using ${network} CPMM program: ${programId.toString()}`);
    console.log(
      `📍 Using ${network} fee account: ${poolFeeAccount.toString()}`
    );

    const { execute, extInfo } = await raydium.cpmm.createPool({
      programId,
      poolFeeAccount,
      mintA,
      mintB,
      mintAAmount: stonkAmount,
      mintBAmount: solAmount,
      startTime: new BN(0), // Start immediately
      feeConfig,
      associatedOnly: false,
      ownerInfo: {
        useSOLBalance: true,
      },
    });

    console.log("📦 Pool creation info:", {
      poolId: extInfo.address.poolId.toString(),
      lpMint: extInfo.address.lpMint.toString(),
      vaultA: extInfo.address.vaultA.toString(),
      vaultB: extInfo.address.vaultB.toString(),
    });

    // Execute the pool creation transaction
    console.log("🚀 Executing pool creation transaction...");
    const { txId } = await execute({
      sendAndConfirm: true,
    });

    console.log("✅ POOL CREATED SUCCESSFULLY!");
    console.log(`📝 Transaction ID: ${txId}`);
    console.log(`🏊 Pool ID: ${extInfo.address.poolId.toString()}`);
    console.log(`🪙 LP Token Mint: ${extInfo.address.lpMint.toString()}`);

    // Save pool information
    const poolInfo = {
      poolId: extInfo.address.poolId.toString(),
      lpMint: extInfo.address.lpMint.toString(),
      vaultA: extInfo.address.vaultA.toString(),
      vaultB: extInfo.address.vaultB.toString(),
      mintA: DEPLOYED_TOKEN,
      mintB: NATIVE_MINT.toBase58(),
      txId,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(
      "pool-creation-info.json",
      JSON.stringify(poolInfo, null, 2)
    );
    console.log("💾 Pool info saved to pool-creation-info.json");

    // Display useful information
    console.log("\n🎯 NEXT STEPS");
    console.log("═════════════");
    console.log("✅ Your STONK/SOL liquidity pool is now live on devnet!");
    console.log("🔗 You can now:");
    console.log("   • Add more liquidity to the pool");
    console.log("   • Swap between STONK and SOL");
    console.log("   • Remove liquidity and claim fees");
    console.log("   • Monitor pool performance");

    console.log("\n⚠️  IMPORTANT NOTES");
    console.log("══════════════════");
    console.log("🕘 Remember: STONK has NYSE market hours restrictions!");
    console.log("   • Swaps will only work during NYSE trading hours");
    console.log("   • Monday-Friday 9:30 AM - 4:00 PM ET");
    console.log("   • This creates unique arbitrage opportunities");

    console.log("\n📊 Pool URLs (Devnet):");
    console.log(
      `🌊 Raydium Pool: https://raydium.io/pool/${extInfo.address.poolId.toString()}?mode=devnet`
    );
    console.log(
      `🔍 Solscan: https://solscan.io/account/${extInfo.address.poolId.toString()}?cluster=devnet`
    );
  } catch (error) {
    console.error("❌ Pool creation failed:", error);

    // Check if this is a transfer hook error (NYSE hours restriction)
    const errorStr = error.toString();
    if (
      errorStr.includes('Custom":6007') ||
      errorStr.includes('Custom":3007') ||
      errorStr.includes("Custom: 6007") ||
      errorStr.includes("Custom: 3007")
    ) {
      console.log("\n🕘 NYSE TRADING HOURS RESTRICTION DETECTED!");
      console.log("═══════════════════════════════════════════");

      const now = new Date();
      const et = new Date(
        now.toLocaleString("en-US", { timeZone: "America/New_York" })
      );
      const day = et.getDay(); // 0 = Sunday, 6 = Saturday
      const hour = et.getHours();
      const minute = et.getMinutes();

      console.log(`⏰ Current Eastern Time: ${et.toLocaleString()}`);
      console.log(
        `📅 Day: ${
          [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
          ][day]
        }`
      );

      // NYSE is open Monday-Friday 9:30 AM - 4:00 PM ET
      const isWeekend = day === 0 || day === 6;
      const currentMinutes = hour * 60 + minute;
      const openMinutes = 9 * 60 + 30; // 9:30 AM
      const closeMinutes = 16 * 60; // 4:00 PM
      const isMarketHours =
        currentMinutes >= openMinutes && currentMinutes < closeMinutes;
      const shouldBeOpen = !isWeekend && isMarketHours;

      console.log(
        `📊 Market Status: ${shouldBeOpen ? "🟢 OPEN" : "🔴 CLOSED"}`
      );

      if (!shouldBeOpen) {
        console.log("\n💡 SOLUTION: Wait for NYSE market hours");
        console.log(
          "   • NYSE Trading Hours: Monday-Friday 9:30 AM - 4:00 PM ET"
        );
        if (isWeekend) {
          console.log("   • Currently weekend - try on Monday");
        } else if (currentMinutes < openMinutes) {
          console.log(
            `   • Market opens at 9:30 AM ET (in ${Math.floor(
              (openMinutes - currentMinutes) / 60
            )}h ${(openMinutes - currentMinutes) % 60}m)`
          );
        } else {
          console.log(
            "   • Market closed for the day - try tomorrow at 9:30 AM ET"
          );
        }
        console.log(
          "   • This is because your STONK token enforces NYSE trading hours!"
        );
      } else {
        console.log("\n🤔 Market should be open but pool creation failed");
        console.log("   • There might be a holiday or other restriction");
        console.log("   • Try again in a few minutes");
      }
    } else if (error.message && error.message.includes("insufficient funds")) {
      console.log("\n💡 SOLUTION: You need more tokens in your wallet");
      console.log("   • Ensure you have enough STONK tokens");
      console.log("   • Ensure you have enough SOL for gas fees and liquidity");
      console.log("   • Run the deploy script to mint more tokens if needed");
    } else {
      console.log("\n🔍 Debug info:");
      console.log("   • Check your token balance");
      console.log("   • Verify the token address");
      console.log("   • Ensure you're on devnet");
      console.log("   • Error details:", errorStr);

      // Additional debugging for Custom: 6007
      if (errorStr.includes("6007")) {
        console.log("\n💡 Custom: 6007 could be:");
        console.log(
          "   • Transfer hook restriction (even during market hours)"
        );
        console.log("   • WSOL balance issue (we just wrapped 1 SOL)");
        console.log("   • Token metadata or extension issue");
        console.log("   • CPMM program specific error");
        console.log("   • Try with smaller amounts?");
      }
    }
  }
}

// Check wallet balances first
async function checkBalances() {
  console.log("💰 CHECKING WALLET BALANCES");
  console.log("══════════════════════════");

  // Load deployment info to get the correct network and token
  let deploymentInfo;
  if (fs.existsSync("stonks-deployment-devnet.json")) {
    deploymentInfo = JSON.parse(
      fs.readFileSync("stonks-deployment-devnet.json", "utf8")
    );
  } else if (fs.existsSync("stonks-deployment-latest.json")) {
    deploymentInfo = JSON.parse(
      fs.readFileSync("stonks-deployment-latest.json", "utf8")
    );
  } else if (fs.existsSync("stonks-deployment.json")) {
    deploymentInfo = JSON.parse(
      fs.readFileSync("stonks-deployment.json", "utf8")
    );
  } else {
    console.log("❌ No deployment info found for balance check");
    return;
  }

  const network = deploymentInfo.network as "testnet" | "devnet";
  const DEPLOYED_TOKEN = deploymentInfo.mintAddress;

  const connection = new Connection(clusterApiUrl(network), "confirmed");
  const wallet = anchor.Wallet.local();

  console.log(
    `🌐 Network: ${network.charAt(0).toUpperCase() + network.slice(1)}`
  );

  // Check SOL balance
  const solBalance = await connection.getBalance(wallet.publicKey);
  console.log(`💎 SOL Balance: ${solBalance / LAMPORTS_PER_SOL} SOL`);
  try {
    const tokenAccount = getAssociatedTokenAddressSync(
      new PublicKey(DEPLOYED_TOKEN),
      wallet.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    const account = await getAccount(
      connection,
      tokenAccount,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    console.log(`🏭 STONK Balance: ${Number(account.amount) / 10 ** 9} STONK`);
  } catch (error) {
    console.log("❌ No STONK token account found or balance is 0");
  }

  console.log("");
}

async function main() {
  await checkBalances();
  await testLiquidityPoolCreation();
}

main().catch(console.error);
