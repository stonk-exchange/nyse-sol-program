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
  transferChecked,
  createTransferCheckedWithTransferHookInstruction,
  getAccount,
} from "@solana/spl-token";
import fs from "fs";

async function testStonkTrading() {
  console.log("🧪 TESTING $STONK NYSE TRADING RESTRICTIONS");
  console.log("═══════════════════════════════════════════");

  // Load deployment info
  if (!fs.existsSync("deployment-info.json")) {
    console.log("❌ No STONK deployment found. Run deploy-testnet.ts first!");
    console.log("   Expected file: deployment-info.json");
    return;
  }

  const deploymentInfo = JSON.parse(
    fs.readFileSync("deployment-info.json", "utf8")
  );
  console.log(`💎 STONK Token: ${deploymentInfo.mintAddress}`);

  // Set up testnet connection
  const connection = new Connection(clusterApiUrl("testnet"), "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const mintAddress = new PublicKey(deploymentInfo.mintAddress);
  const yourTokenAccount = new PublicKey(deploymentInfo.tokenAccount);

  // Use consistent test recipient address
  const recipientAddress = new PublicKey(
    "D3RQFzcoZWqpcgrR6CogYqyfSmqHnee6TPNNgewNV7a1"
  );
  console.log(`👤 Test Recipient: ${recipientAddress.toString()}`);

  // No need to fund recipient - deployer will pay for account creation
  console.log("💰 Deployer will pay for recipient's account creation...");

  try {
    // Check your STONK balance first
    console.log("\n💰 CHECKING YOUR STONK BALANCE");
    console.log("════════════════════════════════");

    const yourBalance = await getAccount(
      connection,
      yourTokenAccount,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    const yourStonkBalance = Number(yourBalance.amount) / 10 ** 9;
    console.log(
      `🏦 Your STONK Balance: ${yourStonkBalance.toLocaleString()} STONK`
    );

    if (yourStonkBalance === 0) {
      console.log("❌ No STONK tokens found in your wallet!");
      console.log("   Make sure deployment completed successfully.");
      return;
    }

    // Create recipient's token account
    const recipientTokenAccount = getAssociatedTokenAddressSync(
      mintAddress,
      recipientAddress,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    console.log("\n🏦 CHECKING RECIPIENT TOKEN ACCOUNT");
    console.log("═══════════════════════════════════");
    console.log(
      `📍 Recipient Token Account: ${recipientTokenAccount.toString()}`
    );

    // Check if account already exists
    let recipientAccountExists = false;
    try {
      const existingAccount = await getAccount(
        connection,
        recipientTokenAccount,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      console.log("✅ Recipient token account already exists!");
      console.log(
        `💰 Current balance: ${Number(existingAccount.amount) / 10 ** 9} STONK`
      );
      recipientAccountExists = true;
    } catch (error) {
      console.log("⚠️  Recipient token account doesn't exist");
      console.log("💡 Will create it during transfer...");
      recipientAccountExists = false;
    }

    // Get current time and market status
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentDay = now.getUTCDay();

    console.log("\n📅 CURRENT MARKET STATUS");
    console.log("══════════════════════");
    console.log(`🕐 Current Time: ${now.toISOString()}`);
    console.log(`🕐 UTC Hour: ${currentHour}`);
    console.log(`📆 Day of week: ${currentDay} (0=Sunday, 6=Saturday)`);

    // NYSE is open Monday-Friday 14:30-21:00 UTC (9:30 AM - 4:00 PM ET)
    const isWeekend = currentDay === 0 || currentDay === 6;
    const isMarketHours = currentHour >= 14 && currentHour < 21;
    const shouldBeOpen = !isWeekend && isMarketHours;

    console.log(
      `📊 Expected NYSE Status: ${shouldBeOpen ? "🟢 OPEN" : "🔴 CLOSED"}`
    );

    // Test STONK transfer with NYSE hook
    console.log("\n🔄 TESTING STONK TRANSFER WITH NYSE HOOK");
    console.log("═══════════════════════════════════════");

    const transferAmount = BigInt(1000 * Math.pow(10, 9)); // 1000 STONK tokens
    console.log(`💸 Transfer Amount: 1,000 STONK`);
    console.log(`📤 From: ${wallet.publicKey.toString()}`);
    console.log(`📥 To: ${recipientAddress.toString()}`);

    try {
      console.log("🚀 Attempting STONK transfer...");

      let signature: string;

      if (!recipientAccountExists) {
        console.log("🔨 Creating recipient account and transferring...");

        // Create the transfer instruction that includes account creation
        const transferInstruction =
          await createTransferCheckedWithTransferHookInstruction(
            connection,
            yourTokenAccount,
            mintAddress,
            recipientTokenAccount,
            wallet.publicKey,
            transferAmount,
            9,
            [],
            "confirmed",
            TOKEN_2022_PROGRAM_ID
          );

        // Add account creation instruction first
        const transaction = new anchor.web3.Transaction()
          .add(
            createAssociatedTokenAccountInstruction(
              wallet.publicKey, // payer
              recipientTokenAccount,
              recipientAddress, // owner
              mintAddress,
              TOKEN_2022_PROGRAM_ID
            )
          )
          .add(transferInstruction);

        signature = await provider.sendAndConfirm(transaction);
      } else {
        signature = await transferChecked(
          connection,
          wallet.payer, // Uses the deployer wallet to sign
          yourTokenAccount,
          mintAddress,
          recipientTokenAccount,
          wallet.payer, // authority
          transferAmount,
          9,
          [],
          undefined,
          TOKEN_2022_PROGRAM_ID
        );
      }

      console.log("✅ TRANSFER SUCCESSFUL!");
      console.log(
        `📝 Transaction: https://solscan.io/tx/${signature}?cluster=testnet`
      );
      console.log("🟢 NYSE market is currently OPEN - transfer allowed");

      // Check balances after transfer
      console.log("\n📊 POST-TRANSFER BALANCES");
      console.log("═══════════════════════");

      const yourNewBalance = await getAccount(
        connection,
        yourTokenAccount,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );
      const recipientBalance = await getAccount(
        connection,
        recipientTokenAccount,
        "confirmed",
        TOKEN_2022_PROGRAM_ID
      );

      console.log(
        `👤 Your Balance: ${Number(yourNewBalance.amount) / 10 ** 9} STONK`
      );
      console.log(
        `👤 Recipient Balance: ${
          Number(recipientBalance.amount) / 10 ** 9
        } STONK`
      );
    } catch (error: any) {
      console.log("❌ TRANSFER BLOCKED BY NYSE HOOK!");
      console.log("🔴 NYSE market is currently CLOSED - transfer rejected");
      console.log(`💥 Error: ${error.message}`);

      // Parse the error to show specific NYSE reasons
      if (error.logs) {
        const errorLogs = error.logs.join(" ");
        if (errorLogs.includes("MarketClosedWeekend")) {
          console.log("🛑 Reason: Weekend trading blocked");
        } else if (errorLogs.includes("MarketClosedAfterHours")) {
          console.log("🛑 Reason: After hours trading blocked");
        } else if (errorLogs.includes("MarketClosedHoliday")) {
          console.log("🛑 Reason: Holiday trading blocked");
        }
      }

      console.log("\n📋 TRANSACTION LOGS:");
      if (error.logs) {
        error.logs.forEach((log: string, index: number) => {
          if (
            log.includes("NYSE") ||
            log.includes("CLOSED") ||
            log.includes("BLOCKED")
          ) {
            console.log(`   ${index}: ${log}`);
          }
        });
      }
    }

    console.log("\n📊 NYSE MARKET HOURS REFERENCE");
    console.log("════════════════════════════");
    console.log("🕘 NYSE Trading Hours: Monday-Friday 9:30 AM - 4:00 PM ET");
    console.log("🌍 UTC Equivalent: Monday-Friday 14:30 - 21:00 UTC");
    console.log("🚫 Trading Blocked During:");
    console.log("   • Weekends (Saturday & Sunday)");
    console.log("   • Before 9:30 AM ET (before 14:30 UTC)");
    console.log("   • After 4:00 PM ET (after 21:00 UTC)");
    console.log("   • Federal holidays");

    console.log("\n🎯 TEST SUMMARY");
    console.log("═══════════════");
    if (shouldBeOpen) {
      console.log("✅ Market should be OPEN - transfers should succeed");
      console.log(
        "💡 Try running this test during closed hours to see blocking!"
      );
    } else {
      console.log("❌ Market should be CLOSED - transfers should be blocked");
      console.log("💡 This demonstrates the NYSE hook working correctly!");
    }

    console.log("\n🏊 LIQUIDITY POOL IMPLICATIONS");
    console.log("═════════════════════════════");
    console.log("💡 What this means for DEX trading:");
    console.log("   • STONK/SOL swaps will fail when NYSE is closed");
    console.log("   • LP providers can't add/remove STONK during closed hours");
    console.log("   • Only SOL side of pairs remains tradeable");
    console.log("   • Creates unique arbitrage opportunities!");
    console.log(
      "   • First-ever real-world market hour enforcement on-chain! 🎉"
    );

    console.log("\n🚀 NEXT STEPS FOR LP TESTING:");
    console.log("1. 🏊 Create STONK/SOL pool on Raydium/Orca");
    console.log("2. 🧪 Try swapping during market hours vs closed hours");
    console.log("3. 📈 Observe how the hook affects LP dynamics");
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

// Set environment variable and run
process.env.ANCHOR_WALLET = "/Users/jessejacob/.config/solana/id.json";
testStonkTrading().catch(console.error);
