import { useState, useEffect } from "react";
import { useAccount, useConnect, useConnectors, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { celo } from "wagmi/chains";

/** Wallet connection: injected (MiniPay / browser extension), MetaMask, and
 *  WalletConnect when a project ID is configured. MiniPay is auto-connected. */
export default function ConnectButton() {
  const [open, setOpen] = useState(false);
  const { address, isConnected } = useAccount();
  const { connect, isPending, error } = useConnect();
  const connectors = useConnectors();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();

  // MiniPay expects dApps to connect silently with its injected provider.
  useEffect(() => {
    if (window.ethereum?.isMiniPay && !isConnected) {
      const injected = connectors.find((c) => c.type === "injected");
      if (injected) connect({ connector: injected });
    }
  }, [connectors, isConnected, connect]);

  useEffect(() => {
    if (isConnected) setOpen(false);
  }, [isConnected]);

  if (isConnected) {
    return (
      <div className="wallet-chip">
        {chainId !== celo.id && (
          <button className="btn btn-warn" onClick={() => switchChain({ chainId: celo.id })}>
            Switch to Celo
          </button>
        )}
        <span className="addr">{address.slice(0, 6)}…{address.slice(-4)}</span>
        <button className="btn btn-ghost" onClick={() => disconnect()}>Disconnect</button>
      </div>
    );
  }

  return (
    <>
      <button className="btn btn-primary" onClick={() => setOpen(true)}>Connect wallet</button>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Connect a wallet</h3>
            {connectors.map((connector) => (
              <button
                key={connector.uid}
                className="btn connector-btn"
                disabled={isPending}
                onClick={() => connect({ connector })}
              >
                {connector.name}
                {connector.type === "injected" && window.ethereum?.isMiniPay ? " (MiniPay)" : ""}
              </button>
            ))}
            {!connectors.some((c) => c.id === "walletConnect") && (
              <p className="muted">
                Set <code>VITE_WALLETCONNECT_PROJECT_ID</code> to enable WalletConnect (mobile wallets via QR).
              </p>
            )}
            {error && <p className="error">{error.shortMessage ?? error.message}</p>}
            <button className="btn btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}
