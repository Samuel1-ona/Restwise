// x402 fee settlement client.
//
// The performance fee is never a silent contract-level transfer: the agent POSTs to
// the fee endpoint, receives HTTP 402 with payment terms, signs a stablecoin payment
// authorization, and the facilitator settles it on Celo. Once the server confirms
// settlement it releases the vault's accrued fee (claimFee) back to the agent wallet,
// so every realized fee is one countable x402 payment.
import { createThirdwebClient } from "thirdweb";
import { privateKeyToAccount } from "thirdweb/wallets";
import { wrapFetchWithPayment } from "thirdweb/x402";
import { config, requireConfig } from "./config.js";

export async function settleFeeViaX402(feeUnits) {
  requireConfig("feeEndpoint", "thirdwebClientId", "keeperPrivateKey");

  const client = createThirdwebClient({ clientId: config.thirdwebClientId });
  const account = privateKeyToAccount({ client, privateKey: config.keeperPrivateKey });
  const fetchWithPayment = wrapFetchWithPayment({ client, account });

  const response = await fetchWithPayment(config.feeEndpoint, { method: "POST" });
  if (!response.ok) {
    throw new Error(`fee settlement failed: HTTP ${response.status} ${await response.text()}`);
  }
  const body = await response.json();
  return { paidUnits: feeUnits, claimTx: body.claimTx, payer: account.address };
}
