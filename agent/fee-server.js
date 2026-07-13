// Restwise x402 fee-settlement service — speaks x402 v1 directly against the
// public Celo facilitator (api.x402.celo.org). No third-party SDK or API keys.
//
// POST /realize-fee is the vault's fee claim endpoint, gated by x402:
//   1. Unpaid request -> HTTP 402 Payment Required with terms (amount = vault.accruedFees(),
//      payable in USDC, the Celo stable with EIP-3009 transferWithAuthorization).
//   2. Agent retries with a signed X-PAYMENT authorization; this server has the
//      facilitator verify it, then settle the USDC transfer to the treasury on Celo.
//   3. On settlement this server (holder of the vault's feeCollector key) calls
//      vault.claimFee(agent) to release the accrued fee, reimbursing the agent.
// Net effect: the 10% performance fee reaches the treasury as a countable x402 payment.
import "dotenv/config";
import express from "express";
import { ethers } from "ethers";
import { config, TOKENS } from "./config.js";
import { VAULT_ABI } from "./abi.js";

const PORT = Number(process.env.FEE_SERVER_PORT ?? 4021);
const FACILITATOR = process.env.X402_FACILITATOR ?? "https://api.x402.celo.org";

const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
const feeCollector = new ethers.Wallet(process.env.FEE_COLLECTOR_PRIVATE_KEY, provider);
const vault = new ethers.Contract(config.vaultAddress, VAULT_ABI, feeCollector);
const TREASURY = process.env.TREASURY_ADDRESS ?? feeCollector.address; // receives the x402 payment

// Payment assets must support EIP-3009 for the "exact" scheme. On Celo both USDT
// and USDC do (domains verified against the on-chain DOMAIN_SEPARATORs). USDT is
// listed first because the agent wallet holds it.
const PAY_ASSETS = [
  { address: TOKENS.USDT.address, decimals: 6, eip712: { name: "Tether USD", version: "1" } },
  { address: TOKENS.USDC.address, decimals: 6, eip712: { name: "USDC", version: "2" } },
];

function paymentRequirements(amountUnits, resourceUrl) {
  return PAY_ASSETS.map((asset) => ({
    scheme: "exact",
    network: "celo",
    maxAmountRequired: String(amountUnits),
    resource: resourceUrl,
    description: "Restwise yield-optimizer performance fee settlement (10% of realized yield)",
    mimeType: "application/json",
    payTo: TREASURY,
    maxTimeoutSeconds: 600,
    asset: asset.address,
    extra: asset.eip712,
  }));
}

async function facilitatorCall(path, paymentPayload, requirements) {
  const headers = { "Content-Type": "application/json" };
  // /settle requires an API key from x402.celo.org (connect wallet -> sign -> key).
  if (process.env.X402_API_KEY) headers["X-API-Key"] = process.env.X402_API_KEY;
  const res = await fetch(`${FACILITATOR}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements: requirements }),
  });
  if (!res.ok) throw new Error(`facilitator ${path} failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const app = express();

app.post("/realize-fee", async (req, res) => {
  try {
    const accrued = await vault.accruedFees(); // normalized 18-dec USD units
    // Round the fee up to whole USDC units (6 decimals) so the payment fully covers it.
    const usdcUnits = (accrued + 10n ** 12n - 1n) / 10n ** 12n;
    if (usdcUnits === 0n) {
      return res.status(409).json({ error: "no accrued fees to settle" });
    }
    const resourceUrl = `${req.protocol}://${req.get("host")}/realize-fee`;
    const accepts = paymentRequirements(usdcUnits, resourceUrl);

    const header = req.headers["x-payment"];
    if (!header) {
      return res.status(402).json({ x402Version: 1, error: "X-PAYMENT header is required", accepts });
    }
    const paymentPayload = JSON.parse(Buffer.from(header, "base64").toString());

    // The v1 payload doesn't name its asset, so verify against each accepted
    // requirement until one matches the signature.
    let requirements = null;
    let invalidReason = "invalid payment";
    for (const candidate of accepts) {
      const verification = await facilitatorCall("/verify", paymentPayload, candidate);
      if (verification.isValid) { requirements = candidate; break; }
      invalidReason = verification.invalidReason ?? invalidReason;
    }
    if (!requirements) {
      return res.status(402).json({ x402Version: 1, error: invalidReason, accepts });
    }

    const settlement = await facilitatorCall("/settle", paymentPayload, requirements);
    if (!settlement.success) {
      return res
        .status(402)
        .json({ x402Version: 1, error: settlement.errorReason ?? "settlement failed", accepts });
    }

    // Payment settled on-chain -> release the vault's accrued fee to the paying agent,
    // in the configured claim asset (default USDm; the vault swaps via Mento if needed).
    const payer = ethers.getAddress(paymentPayload.payload.authorization.from);
    const claimAsset = TOKENS[config.feeClaimSymbol].address;
    const tx = await vault.claimFee(payer, claimAsset);
    const receipt = await tx.wait();

    res.setHeader("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settlement)).toString("base64"));
    res.json({ settled: true, amount: `$${ethers.formatUnits(accrued, 18)}`, settleTx: settlement.transaction, claimTx: receipt.hash });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, vault: config.vaultAddress, facilitator: FACILITATOR }));

app.listen(PORT, () => console.log(`Restwise fee server (x402 via ${FACILITATOR}) listening on :${PORT}`));
