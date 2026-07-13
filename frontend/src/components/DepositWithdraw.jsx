import { useState } from "react";
import { parseUnits } from "viem";
import { useAccount, useWriteContract, usePublicClient, useReadContract } from "wagmi";
import { TOKENS, SYMBOLS, VAULT_ADDRESS, VAULT_ABI, ERC20_ABI } from "../config/contracts";
import { usePosition } from "../hooks/useVault";

function AssetSelect({ value, onChange }) {
  return (
    <select className="asset-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

export default function DepositWithdraw({ vault }) {
  const [depositAsset, setDepositAsset] = useState("USDT");
  const [withdrawAsset, setWithdrawAsset] = useState("USDT");
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient();
  const { shares, refetchShares } = usePosition();

  const depositToken = TOKENS[depositAsset];
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: depositToken.address, abi: ERC20_ABI, functionName: "allowance",
    args: [address, VAULT_ADDRESS],
    query: { enabled: Boolean(address && VAULT_ADDRESS) },
  });

  async function run(label, fn) {
    if (!isConnected) return setStatus("Connect a wallet first.");
    if (!VAULT_ADDRESS) return setStatus("No vault configured — append ?vault=0x… to the URL.");
    setBusy(true);
    try {
      await fn();
      setStatus(`${label} ✓`);
      vault.refetch(); refetchShares(); refetchAllowance();
    } catch (e) {
      setStatus(`Failed: ${e.shortMessage ?? e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const deposit = () =>
    run("Deposited", async () => {
      const amount = parseUnits(depositAmount || "0", depositToken.decimals);
      if (amount === 0n) throw new Error("enter an amount");
      if ((allowance ?? 0n) < amount) {
        setStatus(`Approving ${depositAsset}…`);
        const hash = await writeContractAsync({
          address: depositToken.address, abi: ERC20_ABI, functionName: "approve",
          args: [VAULT_ADDRESS, amount],
        });
        await client.waitForTransactionReceipt({ hash });
      }
      setStatus("Depositing…");
      const hash = await writeContractAsync({
        address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "deposit",
        args: [depositToken.address, amount],
      });
      await client.waitForTransactionReceipt({ hash });
    });

  const withdraw = (all) =>
    run("Withdrawn", async () => {
      let burnShares;
      if (all) {
        burnShares = shares ?? 0n;
      } else {
        // Shares are 18-dec "vault USD", so the requested dollar amount converts directly.
        const normAmount = parseUnits(withdrawAmount || "0", 18);
        burnShares = await client.readContract({
          address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "convertToShares", args: [normAmount],
        });
        // Cap at the wallet's share balance: a share is worth slightly under $1 after
        // swap costs, so "withdraw $1.00" on a $0.999 position would otherwise revert
        // with ERC20InsufficientBalance on the burn.
        if (shares != null && burnShares > shares) burnShares = shares;
      }
      if (burnShares === 0n) throw new Error("nothing to withdraw");
      setStatus(`Withdrawing in ${withdrawAsset}…`);
      const hash = await writeContractAsync({
        address: VAULT_ADDRESS, abi: VAULT_ABI, functionName: "withdraw",
        args: [burnShares, TOKENS[withdrawAsset].address],
      });
      await client.waitForTransactionReceipt({ hash });
    });

  return (
    <section className="card">
      <h2>Deposit / Withdraw</h2>
      <p className="muted">
        Deposit USDT, USDC or USDm — the agent consolidates into the best-paying market.
        Withdraw in whichever stable you want; cross-stable exits route through Mento
        (≈0.1% max 0.5%).
      </p>
      <div className="field-row">
        <input type="number" min="0" step="any" placeholder="Amount"
          value={depositAmount} onChange={(e) => setDepositAmount(e.target.value)} />
        <AssetSelect value={depositAsset} onChange={setDepositAsset} />
        <button className="btn btn-primary" disabled={busy} onClick={deposit}>
          {busy ? <span className="spinner" /> : "Deposit"}
        </button>
      </div>
      <div className="divider" />
      <div className="field-row">
        <input type="number" min="0" step="any" placeholder="Amount (USD)"
          value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)} />
        <AssetSelect value={withdrawAsset} onChange={setWithdrawAsset} />
        <button className="btn" disabled={busy} onClick={() => withdraw(false)}>Withdraw</button>
      </div>
      <button className="btn btn-ghost btn-full" disabled={busy} onClick={() => withdraw(true)}>
        Withdraw everything as {withdrawAsset}
      </button>
      {status && (
        <p className={/fail|connect|enter|nothing/i.test(status) ? "status-error" : "muted"}>{status}</p>
      )}
    </section>
  );
}
