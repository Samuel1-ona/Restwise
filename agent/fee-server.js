// Restwise x402 fee-settlement service.
//
// POST /realize-fee is the vault's fee claim endpoint, gated by x402:
//   1. Unpaid request -> HTTP 402 Payment Required with terms (amount = vault.accruedFees()).
//   2. Agent retries with a signed X-PAYMENT authorization; the facilitator settles
//      the stablecoin transfer to the treasury on Celo.
//   3. On settlement this server (holder of the vault's feeCollector key) calls
//      vault.claimFee(agent) to release the accrued fee, reimbursing the agent.
// Net effect: the 10% performance fee reaches the treasury as a countable x402 payment.
import "dotenv/config";
import express from "express";
import { ethers } from "ethers";
import { createThirdwebClient } from "thirdweb";
import { celo, celoSepolia } from "thirdweb/chains";
import { settlePayment, facilitator } from "thirdweb/x402";
import { config, TOKENS } from "./config.js";
import { VAULT_ABI } from "./abi.js";

const PORT = Number(process.env.FEE_SERVER_PORT ?? 4021);
const TREASURY = process.env.TREASURY_ADDRESS; // receives the x402 payment
const SERVER_WALLET = process.env.THIRDWEB_SERVER_WALLET; // thirdweb facilitator wallet

const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
const feeCollector = new ethers.Wallet(process.env.FEE_COLLECTOR_PRIVATE_KEY, provider);
const vault = new ethers.Contract(config.vaultAddress, VAULT_ABI, feeCollector);

const client = createThirdwebClient({ secretKey: process.env.THIRDWEB_SECRET_KEY });
const thirdwebFacilitator = facilitator({ client, serverWalletAddress: SERVER_WALLET });
const network = config.chainId === 42220 ? celo : celoSepolia;

const app = express();

app.post("/realize-fee", async (req, res) => {
  try {
    const accrued = await vault.accruedFees(); // normalized 18-dec USD units
    if (accrued === 0n) {
      return res.status(409).json({ error: "no accrued fees to settle" });
    }
    const price = `$${ethers.formatUnits(accrued, 18)}`;

    const paymentData = req.headers["payment-signature"] || req.headers["x-payment"];
    const result = await settlePayment({
      resourceUrl: `${req.protocol}://${req.get("host")}/realize-fee`,
      method: "POST",
      paymentData,
      payTo: TREASURY,
      network,
      price,
      facilitator: thirdwebFacilitator,
      routeConfig: {
        description: "Restwise yield-optimizer performance fee settlement (10% of realized yield)",
        mimeType: "application/json",
      },
    });

    if (result.status !== 200) {
      // First round-trip: respond 402 Payment Required with the signed terms.
      return res.status(result.status).set(result.responseHeaders).json(result.responseBody);
    }

    // Payment settled on-chain -> release the vault's accrued fee to the paying agent,
    // in the configured claim asset (default USDm; the vault swaps via Mento if needed).
    const payer = result.payer ?? req.headers["x-payer"] ?? feeCollector.address;
    const claimAsset = TOKENS[config.feeClaimSymbol].address;
    const tx = await vault.claimFee(payer, claimAsset);
    const receipt = await tx.wait();
    res.json({ settled: true, amount: price, claimTx: receipt.hash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, vault: config.vaultAddress }));

app.listen(PORT, () => console.log(`Restwise fee server (x402) listening on :${PORT}`));
