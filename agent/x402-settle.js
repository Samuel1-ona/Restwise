// x402 fee settlement client — speaks x402 v1 directly, no third-party SDK.
//
// The performance fee is never a silent contract-level transfer: the agent POSTs to
// the fee endpoint, receives HTTP 402 with payment terms, signs an EIP-3009
// transferWithAuthorization for the exact amount, and retries with the X-PAYMENT
// header. The Celo facilitator (api.x402.celo.org) settles the stablecoin transfer
// on-chain. Once the server confirms settlement it releases the vault's accrued fee
// (claimFee) back to the agent wallet, so every realized fee is one countable x402
// payment.
import { ethers } from "ethers";
import { config, requireConfig } from "./config.js";

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export async function settleFeeViaX402(feeUsd) {
  requireConfig("feeEndpoint", "keeperPrivateKey");
  const wallet = new ethers.Wallet(config.keeperPrivateKey);

  const unpaid = await fetch(config.feeEndpoint, { method: "POST" });
  if (unpaid.status !== 402) {
    throw new Error(`expected 402 with payment terms, got HTTP ${unpaid.status} ${await unpaid.text()}`);
  }
  const { x402Version, accepts } = await unpaid.json();
  const req = accepts?.find((a) => a.scheme === "exact" && a.network === "celo");
  if (!req) throw new Error("fee server offered no exact/celo payment option");

  const authorization = {
    from: wallet.address,
    to: req.payTo,
    value: req.maxAmountRequired,
    validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + (req.maxTimeoutSeconds ?? 600)),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(
    {
      name: req.extra.name,
      version: req.extra.version,
      chainId: config.chainId,
      verifyingContract: req.asset,
    },
    EIP3009_TYPES,
    authorization
  );

  const paymentHeader = Buffer.from(
    JSON.stringify({ x402Version, scheme: "exact", network: "celo", payload: { signature, authorization } })
  ).toString("base64");

  const paid = await fetch(config.feeEndpoint, {
    method: "POST",
    headers: { "X-PAYMENT": paymentHeader },
  });
  if (!paid.ok) throw new Error(`fee settlement failed: HTTP ${paid.status} ${await paid.text()}`);
  const body = await paid.json();
  const receiptHeader = paid.headers.get("X-PAYMENT-RESPONSE");
  const settlement = receiptHeader ? JSON.parse(Buffer.from(receiptHeader, "base64").toString()) : null;
  return { paidUnits: feeUsd, settleTx: settlement?.transaction, claimTx: body.claimTx, payer: wallet.address };
}
