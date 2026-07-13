import Header from "./components/Header";
import StatTiles from "./components/StatTiles";
import DepositWithdraw from "./components/DepositWithdraw";
import AllocationCard from "./components/AllocationCard";
import PerformanceChart from "./components/PerformanceChart";
import DecisionLog from "./components/DecisionLog";
import { useVenueApys, useVault } from "./hooks/useVault";

export default function App() {
  const apys = useVenueApys();
  const vault = useVault();

  return (
    <>
      <Header />
      <main>
        <StatTiles apys={apys} vault={vault} />
        <div className="grid">
          <DepositWithdraw vault={vault} />
          <AllocationCard apys={apys} vault={vault} />
        </div>
        <PerformanceChart apys={apys} />
        <DecisionLog />
      </main>
      <footer className="muted">
        Restwise · non-custodial USDT/USDC/USDm vault · fees settle via x402 · agent registered in the ERC-8004 Identity Registry
      </footer>
    </>
  );
}
