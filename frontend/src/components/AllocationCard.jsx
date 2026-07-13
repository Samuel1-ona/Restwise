const fmt = (x, d = 2) => Number(x).toLocaleString(undefined, { maximumFractionDigits: d });

/** Four-venue allocation: stacked bar (2px surface gaps per mark spec) + a table
 *  pairing each venue's live APY with the vault's balance in it. */
export default function AllocationCard({ apys, vault }) {
  const { venueUsd, idleUsd, totalUsd, hasVault } = vault;
  const total = Math.max(totalUsd ?? 0, 1e-9);
  const best = apys.venues.reduce((a, b) => ((b.apyBps ?? -1) > (a.apyBps ?? -1) ? b : a), apys.venues[0]);

  return (
    <section className="card">
      <h2>Live venues &amp; allocation</h2>
      <div className="alloc-bar" role="img" aria-label="Vault allocation across venues">
        {apys.venues.map((v) => {
          const pct = venueUsd ? (venueUsd[v.id] / total) * 100 : 0;
          return pct > 0 ? (
            <div key={v.id} className="alloc-seg" style={{ width: `${pct}%`, background: `var(${v.colorVar})` }} />
          ) : null;
        })}
      </div>
      <table className="venue-table">
        <thead>
          <tr><th>Venue</th><th className="num">Supply APY</th><th className="num">Vault balance</th></tr>
        </thead>
        <tbody>
          {apys.venues.map((v) => (
            <tr key={v.id}>
              <td>
                <span className="dot" style={{ background: `var(${v.colorVar})` }} />
                {v.label}
                {v.id === best?.id && v.apyBps != null && <span className="best-chip">best</span>}
              </td>
              <td className="num">{v.apyBps != null ? `${(v.apyBps / 100).toFixed(2)}%` : "…"}</td>
              <td className="num">
                {hasVault && venueUsd
                  ? `$${fmt(venueUsd[v.id])} (${fmt((venueUsd[v.id] / total) * 100, 1)}%)`
                  : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasVault && idleUsd > 0.01 && <p className="muted">idle (not deployed): ${fmt(idleUsd)}</p>}
      {!hasVault && <p className="muted">Append ?vault=0x… to the URL to point at a deployment.</p>}
    </section>
  );
}
