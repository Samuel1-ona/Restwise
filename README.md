# Restwise

Non-custodial "set & forget" **multi-stablecoin** vault on Celo. Users deposit
**USDT, USDC or USDm**; a keeper agent autonomously consolidates capital into the
best-paying venue across **Aave v3** (all three assets) and **Moola Market** (USDm),
converting between stables through **Mento V3 FPMM pools** with hard min-received
protection. The vault takes a **10% performance fee on realized yield only** (never
principal), settled through **x402** so each fee event is a countable HTTP-402
payment. The agent is registered in the **ERC-8004 Identity Registry** on Celo.

Modeled on Giza's ARMA/Optimizer pattern, built against the protocols documented in
`celo-org/celopedia-skills` and verified live on-chain.

## The venue matrix (verified on-chain 2026-07)

| Venue | Asset | Live supply APY* | Notes |
|---|---|---|---|
| Aave v3 | USDT | 0.39% | aToken `0xDeE9…e8Df` |
| Aave v3 | USDC | 1.52% | aToken `0xFF83…4785` |
| Aave v3 | USDm/cUSD | 2.57% | aToken `0xBba9…5a45` |
| Moola | USDm/cUSD | ~0% | mcUSD `0x9181…DBc3`; Aave-v2 fork ABI |

\* at time of writing — the whole point is that these move and the agent follows.

Moola lists **no USDT/USDC** market, so cross-asset moves are what make the vault
work: swaps route through the **Mento V3 FPMM Router**
(`0x4861…B6f6`, factory `0xa849…613b`) whose live pools pair USDT/USDm and
USDC/USDm — measured cost ≈0.1% per hop, two hops for USDT↔USDC. Per the
celopedia security guidance, every swap carries a **contract-enforced min-received
floor** (`maxSlippageBps`, default 0.5%, owner-capped at 2%) — a compromised keeper
cannot grief depositors with bad quotes.

## Layout

```
contracts/   Foundry — multi-asset YieldVault, 20 unit tests + 4 mainnet fork tests
agent/       Node.js keeper (4-venue decisions) + x402 fee server + ERC-8004 registration
frontend/    React (Vite) + wagmi + WalletConnect dashboard
.github/     Cron workflow running the agent every 6h
.agents/     celopedia-skills (installed via npx skills add celo-org/celopedia-skills)
```

## Contracts (`contracts/`)

`YieldVault.sol` — ERC-20 shares denominated in 18-dec "vault USD"; every supported
stable is normalized to 18 decimals and counted at $1 (the same parity Mento FPMM
pools trade at; every actual conversion is min-out protected). Funds live as
rebasing Aave aTokens / Moola mTokens.

| Risk control | Where |
|---|---|
| Reentrancy guards on all mutating flows | `nonReentrant` |
| Fee only on yield: high-water mark on price-per-share | `realizeFee()` |
| Swap min-received floor the keeper cannot undercut | `MinOutTooLow` in `rebalance()` |
| Withdrawal conversion loss capped at `maxSlippageBps` | `ShortfallExceedsTolerance` |
| Pause blocks deposits + rebalance, **never** withdrawals | `pause()` |
| Emergency drain to idle (no swaps) + auto-pause | `emergencyExit()` |
| Fee release restricted to the x402 settlement service | `claimFee()` |
| aTokens resolved from Aave's own registry at deploy | `Deploy.s.sol` |

```bash
cd contracts
forge test                                   # 20 unit tests (mocked venues + router)
RUN_FORK=true forge test --match-contract Fork   # 4 integration tests on forked mainnet:
                                             # real Aave supply/withdraw, real Moola leg,
                                             # real Mento USDT->USDm swap, fee on real yield
export PRIVATE_KEY=... CELOSCAN_API_KEY=...
forge script script/Deploy.s.sol --rpc-url celo --broadcast --verify
```

Deposits always enter Aave in the deposited asset (users never pay swap costs);
the agent consolidates on its next cycle. Withdrawals pay out in whichever stable
the user asks for, converting through Mento when needed (withdrawer bears ≤0.5%).

## Agent (`agent/`)

Transparent threshold rule over four venues — no ML, imitating Giza's "Thoughts":

1. Read all four supply APYs from `getReserveData().currentLiquidityRate` (ray → APY).
2. Pick the best venue; for each other venue holding funds, move only if
   `expectedGain > (gasCost + swapCost) × SAFETY_MARGIN` — swap cost measured from a
   **live Mento `getAmountsOut` quote**, gas priced in USD via the Aave oracle's CELO
   feed. Fully on-chain inputs, no price APIs.
3. `minOut` = live quote − 10bps slack; the contract independently enforces its own floor.
4. Every evaluation (acted or skipped, with the why) appends to `decisions.json`;
   executed moves emit the on-chain `Rebalanced` event with both venues' APYs.
5. After rebalancing: `realizeFee()` checkpoints yield; the fee settles via x402.

```bash
cd agent && npm install && cp .env.example .env   # fill in keys + vault address
npm run agent:once      # single evaluation (what the GitHub Actions cron runs)
npm run agent           # long-running loop, every 6h
npm run fee-server      # x402 fee-settlement endpoint (separate key/role)
AGENT_METADATA_URI=ipfs://<CID> npm run register  # ERC-8004 identity
```

### ERC-8004 (per current spec — old shapes fail 8004scan validation)

`agent-metadata.json` uses `"type": "https://eips.ethereum.org/EIPS/eip-8004#registration-v1"`
and a `services` array with `endpoint` keys. **Pin it to IPFS** and register the
`ipfs://` URI — https URIs are mutable and get flagged. Registry:
`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (Celo mainnet).

### x402 fee flow (Track 2)

```
agent ──POST /realize-fee──▶ fee server ──402 + terms ($ = vault.accruedFees())──▶
agent signs stablecoin payment ──▶ thirdweb facilitator settles on Celo ──▶
fee server confirms ──▶ vault.claimFee(agent, USDm) releases the fee
```

The treasury receives the fee **as an x402 payment**; the agent is reimbursed from
the vault in `FEE_CLAIM_SYMBOL` (USDT, USDC or USDm — all three are x402-supported
tokens on Celo). Every gas-justified rebalance cycle = one x402 payment.

## Frontend (`frontend/`)

React (Vite) + wagmi v2 + viem, componentized, all reads auto-refresh every 15s.
Wallets: injected (MiniPay auto-connects), MetaMask, WalletConnect (set
`VITE_WALLETCONNECT_PROJECT_ID`, free at cloud.reown.com); one-click switch-to-Celo.

- Deposit in USDT/USDC/USDm with auto-approve; withdraw in any of the three
- Live venue table: all four APYs with the current "best" flagged, vault balance per venue
- Stacked allocation bar in fixed per-venue colors
- Agent decision log from `Rebalanced`/`FeeRealized`/`FeeClaimed` events
- Growth-of-$100 chart: Restwise (best venue net of fee) vs three single-asset baselines

```bash
cd frontend && npm install
npm run dev            # http://localhost:5173/?vault=0xYourVaultAddress
```

## Mainnet deployment checklist

- [x] `forge test` green (20 unit + 4 fork)
- [ ] `forge script script/Deploy.s.sol --rpc-url celo --broadcast --verify`
- [ ] Fund keeper wallet with CELO for gas
- [ ] Seed deposit so the demo has TVL
- [ ] Deploy fee server, set `X402_FEE_ENDPOINT`
- [ ] Pin `agent-metadata.json` to IPFS → `npm run register` → ERC-8004 agent ID
- [ ] Set GitHub repo secrets (`KEEPER_PRIVATE_KEY`, `THIRDWEB_CLIENT_ID`) and vars
      (`VAULT_ADDRESS`, `X402_FEE_ENDPOINT`) for the cron
- [ ] Optional: Self Agent ID + Celo Agent Visa (Tourist tier is automatic after 1 tx)

## v2 (pitch line, not built)

Morpho Blue is live on Celo (isolated markets) — a natural 5th venue. Compound v3
remains a governance proposal. Carbon DeFi could replace the keeper's swap leg with
gasless recurring strategies.
