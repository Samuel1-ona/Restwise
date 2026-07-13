import { useAccount } from "wagmi";
import { usePosition } from "../hooks/useVault";

const fmt = (x, d = 2) => Number(x).toLocaleString(undefined, { maximumFractionDigits: d });

function Tile({ label, value }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
    </div>
  );
}

export default function StatTiles({ apys, vault }) {
  const { isConnected } = useAccount();
  const { usd: positionUsd } = usePosition();
  const { hasVault, venueUsd, totalUsd, pps } = vault;

  // Blended APY = balance-weighted venue APYs; before deposits, the best venue.
  let blended = null;
  const live = apys.venues.filter((v) => v.apyBps != null);
  if (live.length) {
    if (venueUsd && totalUsd > 0) {
      blended = live.reduce((s, v) => s + v.apyBps * (venueUsd[v.id] ?? 0), 0) / totalUsd;
    } else {
      blended = Math.max(...live.map((v) => v.apyBps));
    }
  }

  return (
    <section className="stats">
      <Tile label="Total value" value={!hasVault ? "no vault set" : totalUsd != null ? `$${fmt(totalUsd)}` : "…"} />
      <Tile label="Blended APY" value={blended != null ? `${(blended / 100).toFixed(2)}%` : "…"} />
      <Tile label="Your position" value={isConnected && positionUsd != null ? `$${fmt(positionUsd)}` : "—"} />
      <Tile label="Yield / share" value={pps != null ? `${fmt((Number(pps) / 1e18 - 1) * 100, 4)}%` : "—"} />
    </section>
  );
}
