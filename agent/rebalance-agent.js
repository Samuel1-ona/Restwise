// Restwise rebalance agent ("keeper") — multi-asset edition.
//
// Transparent threshold rule, no ML: read the supply APY of all four venues
// (Aave v3 USDT / USDC / USDm and Moola USDm), pick the best, and move funds
// parked in worse venues into it — but only when the expected gain over the
// holding period beats gas + swap cost by a safety margin. Swap legs are quoted
// live on the Mento FPMM router and executed with a hard min-received.
// Every evaluation — acted on or not — is written to decisions.json, and every
// executed move also lands on-chain in the Rebalanced event with the APYs seen.
import { ethers } from "ethers";
import fs from "node:fs";
import { config, requireConfig, TOKENS, VENUES } from "./config.js";
import {
  VAULT_ABI, AAVE_V3_POOL_ABI, MOOLA_POOL_ABI, MENTO_ROUTER_ABI, AAVE_ORACLE_ABI,
} from "./abi.js";
import { settleFeeViaX402 } from "./x402-settle.js";

const RAY = 10n ** 27n;
const SECONDS_PER_YEAR = 31_536_000;

requireConfig("vaultAddress", "keeperPrivateKey");

const provider = new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
const keeper = new ethers.Wallet(config.keeperPrivateKey, provider);
const vault = new ethers.Contract(config.vaultAddress, VAULT_ABI, keeper);
const aavePool = new ethers.Contract(config.aavePool, AAVE_V3_POOL_ABI, provider);
const moolaPool = new ethers.Contract(config.moolaPool, MOOLA_POOL_ABI, provider);
const router = new ethers.Contract(config.mentoRouter, MENTO_ROUTER_ABI, provider);
const oracle = new ethers.Contract(config.aaveOracle, AAVE_ORACLE_ABI, provider);

/** Ray-scaled per-second-compounded APR -> APY in basis points. */
function rayRateToApyBps(rate) {
  const apr = Number(rate) / Number(RAY);
  const apy = (1 + apr / SECONDS_PER_YEAR) ** SECONDS_PER_YEAR - 1;
  return Math.round(apy * 10_000);
}

const norm = (amount, decimals) => Number(ethers.formatUnits(amount, decimals));

/** APY of every venue, straight from on-chain reserve data. */
async function getVenueApys() {
  const reads = VENUES.map((v) => {
    const pool = v.protocol === "aave" ? aavePool : moolaPool;
    return pool.getReserveData(TOKENS[v.symbol].address);
  });
  const data = await Promise.all(reads);
  return VENUES.map((v, i) => ({ ...v, apyBps: rayRateToApyBps(data[i].currentLiquidityRate) }));
}

/** Vault balances per venue, in the venue asset's own units. */
async function getVenueBalances() {
  const [assets, , inAave, inMoola] = await vault.currentAllocation();
  const indexOf = (symbol) =>
    assets.findIndex((a) => a.toLowerCase() === TOKENS[symbol].address.toLowerCase());
  return VENUES.map((v) => {
    const i = indexOf(v.symbol);
    return { ...v, balance: v.protocol === "aave" ? inAave[i] : inMoola[i] };
  });
}

function mentoRoutes(fromAddr, toAddr) {
  if (fromAddr === config.routeHub || toAddr === config.routeHub) {
    return [{ from: fromAddr, to: toAddr, factory: config.fpmmFactory }];
  }
  return [
    { from: fromAddr, to: config.routeHub, factory: config.fpmmFactory },
    { from: config.routeHub, to: toAddr, factory: config.fpmmFactory },
  ];
}

/** Live Mento quote for moving `amount` of `from` into `to`; null when same asset. */
async function quoteSwap(fromSym, toSym, amount) {
  if (fromSym === toSym) return null;
  const routes = mentoRoutes(TOKENS[fromSym].address, TOKENS[toSym].address);
  const amounts = await router.getAmountsOut(amount, routes);
  const out = amounts[amounts.length - 1];
  const costUsd = norm(amount, TOKENS[fromSym].decimals) - norm(out, TOKENS[toSym].decimals);
  return { out, costUsd, minOut: (out * BigInt(10_000 - config.quoteSlackBps)) / 10_000n };
}

async function estimateGasCostUsd(txRequest) {
  let gas;
  try {
    gas = await keeper.estimateGas(txRequest);
  } catch {
    gas = 1_200_000n; // conservative fallback (cross-asset rebalance with 2 swap hops)
  }
  const { gasPrice } = await provider.getFeeData();
  const celoUsd = Number(await oracle.getAssetPrice(config.celoToken)) / 1e8;
  return (Number(gas * (gasPrice ?? 5_000_000_000n)) / 1e18) * celoUsd;
}

function logDecision(entry) {
  const log = fs.existsSync(config.decisionsLog)
    ? JSON.parse(fs.readFileSync(config.decisionsLog, "utf8"))
    : [];
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(config.decisionsLog, JSON.stringify(log, null, 2));
  console.log(`[decision] ${entry.action}: ${entry.reason}`);
}

export async function checkAndRebalance() {
  const apys = await getVenueApys();
  const balances = await getVenueBalances();
  const venueState = apys.map((v, i) => ({ ...v, balance: balances[i].balance }));
  const snapshot = Object.fromEntries(
    venueState.map((v) => [v.id, { apyBps: v.apyBps, balance: norm(v.balance, TOKENS[v.symbol].decimals) }])
  );

  const best = venueState.reduce((a, b) => (b.apyBps > a.apyBps ? b : a));
  const totalUsd = venueState.reduce((s, v) => s + norm(v.balance, TOKENS[v.symbol].decimals), 0);
  if (totalUsd < 0.01) {
    return logDecision({ action: "skip", reason: "vault is empty", venues: snapshot });
  }

  let acted = false;
  for (const src of venueState) {
    if (src.id === best.id || src.balance === 0n) continue;
    const deltaBps = best.apyBps - src.apyBps;
    const amountUsd = norm(src.balance, TOKENS[src.symbol].decimals);
    const base = { venues: snapshot, from: src.id, to: best.id, amountUsd, deltaBps };

    if (deltaBps < config.minDeltaBps) {
      logDecision({ ...base, action: "skip", reason: `edge ${deltaBps}bps below ${config.minDeltaBps}bps threshold` });
      continue;
    }

    // Costs: one-off swap cost (real, from the live Mento quote) + gas.
    const quote = await quoteSwap(src.symbol, best.symbol, src.balance);
    const swapCostUsd = quote?.costUsd ?? 0;
    const minOut = quote?.minOut ?? 0n;
    const args = [
      TOKENS[src.symbol].address, src.protocol === "moola",
      TOKENS[best.symbol].address, best.protocol === "moola",
      src.balance, minOut, src.apyBps, best.apyBps,
    ];
    const gasCostUsd = await estimateGasCostUsd(await vault.rebalance.populateTransaction(...args));

    // Core economics: stablecoin units ~= USD, so the edge is directly comparable.
    const expectedGainUsd = amountUsd * (deltaBps / 10_000) * (config.rebalancePeriodDays / 365);
    const totalCostUsd = gasCostUsd + swapCostUsd;
    if (expectedGainUsd <= totalCostUsd * config.safetyMargin) {
      logDecision({
        ...base,
        action: "skip",
        reason: `gain $${expectedGainUsd.toFixed(6)} <= (gas $${gasCostUsd.toFixed(6)} + swap $${swapCostUsd.toFixed(6)}) x ${config.safetyMargin}`,
        expectedGainUsd, gasCostUsd, swapCostUsd,
      });
      continue;
    }

    const tx = await vault.rebalance(...args);
    const receipt = await tx.wait();
    acted = true;
    logDecision({
      ...base,
      action: "rebalance",
      reason: `moved $${amountUsd.toFixed(2)} ${src.id} -> ${best.id}: +${deltaBps}bps, gain $${expectedGainUsd.toFixed(6)} > cost $${totalCostUsd.toFixed(6)} x ${config.safetyMargin}`,
      expectedGainUsd, gasCostUsd, swapCostUsd,
      txHash: receipt.hash,
    });
  }

  if (acted) await realizeAndSettleFee();
}

async function realizeAndSettleFee() {
  const feeTx = await vault.realizeFee();
  await feeTx.wait();
  const accrued = await vault.accruedFees(); // normalized 18-dec USD
  const feeUsd = Number(ethers.formatUnits(accrued, 18));
  if (feeUsd < config.minFeeToSettle) {
    return logDecision({ action: "fee-skip", reason: `accrued fee $${feeUsd} below settlement minimum` });
  }
  if (!config.feeEndpoint) {
    return logDecision({
      action: "fee-hold",
      reason: `fee $${feeUsd} accrued on-chain; X402_FEE_ENDPOINT not configured, will settle later`,
    });
  }
  const result = await settleFeeViaX402(feeUsd);
  logDecision({ action: "fee-settled", reason: `x402 payment settled for $${feeUsd}`, ...result });
}

async function main() {
  console.log(`Restwise agent | keeper ${keeper.address} | vault ${config.vaultAddress}`);
  await checkAndRebalance();
  if (process.env.RUN_ONCE === "true") return;
  setInterval(() => checkAndRebalance().catch(console.error), config.intervalMs);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
