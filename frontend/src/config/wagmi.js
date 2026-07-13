import { http, createConfig } from "wagmi";
import { celo, celoSepolia } from "wagmi/chains";
import { injected, metaMask, walletConnect } from "wagmi/connectors";

const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;

// WalletConnect needs a Reown project ID; the app stays fully usable with
// injected wallets (MiniPay, browser extensions) when it isn't configured.
const connectors = [injected(), metaMask()];
if (projectId) {
  connectors.push(
    walletConnect({
      projectId,
      metadata: {
        name: "Restwise",
        description: "Autonomous stablecoin yield on Celo",
        url: window.location.origin,
        icons: [],
      },
    })
  );
}

export const config = createConfig({
  chains: [celo, celoSepolia],
  connectors,
  transports: {
    [celo.id]: http("https://forno.celo.org"),
    [celoSepolia.id]: http(),
  },
});
