/**
 * Quick test for AI stop-loss module
 * Run with: npx tsx test-ai-stoploss.ts
 */

import { initAIStopLoss, getAIStopLossSuggestion } from "./src/lib/ai-stoploss";

async function main() {
  console.log("Testing AI Stop-Loss with BlockRun LLM...\n");

  // Initialize
  initAIStopLoss({ enabled: true });

  // Test data - simulating ETH prices
  const recentPrices = [3245.50, 3252.30, 3248.10, 3260.00, 3255.80, 3270.20, 3265.40, 3280.00, 3275.50, 3290.00];
  const entryPrice = 3290.00;

  console.log("Test Case: LONG ETH");
  console.log(`Entry Price: $${entryPrice}`);
  console.log(`Recent Prices: ${recentPrices.slice(-5).map(p => `$${p}`).join(", ")}`);
  console.log("");

  try {
    const suggestion = await getAIStopLossSuggestion("long", entryPrice, recentPrices, "ETH");
    console.log("✅ AI Response:");
    console.log(`   Stop-Loss: ${suggestion.stopLossPct.toFixed(2)}%`);
    console.log(`   Reasoning: ${suggestion.reasoning}`);
    console.log(`   Stop Price: $${(entryPrice * (1 - suggestion.stopLossPct / 100)).toFixed(2)}`);
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

main();
