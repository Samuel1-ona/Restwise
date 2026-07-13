import { useMemo, useState } from "react";

// Growth of $100 over 30 days at the live on-chain APYs. Line chart (change over
// time), four series max: Restwise (slot 1) vs the three Aave single-asset
// baselines, which reuse their venue's fixed categorical color. Crosshair +
// shared tooltip, legend + direct labels, data table fallback.
const W = 640, H = 260, M = { top: 16, right: 96, bottom: 28, left: 44 };
const DAYS = 30;

function useSeries(apys) {
  return useMemo(() => {
    const live = apys.venues.filter((v) => v.apyBps != null);
    if (live.length < 4) return null;
    const css = getComputedStyle(document.documentElement);
    const bestBps = Math.max(...live.map((v) => v.apyBps));
    const aave = apys.venues.filter((v) => v.protocol === "aave");
    const defs = [
      // Restwise sits in the best venue and nets out the 10% performance fee on yield.
      { name: "Restwise", varName: "--series-1", daily: (bestBps / 10_000) * 0.9 / 365 },
      ...aave.map((v) => ({
        name: `${v.symbol} only`,
        varName: v.colorVar,
        daily: v.apyBps / 10_000 / 365,
      })),
    ];
    return defs.map((s) => ({
      ...s,
      color: css.getPropertyValue(s.varName).trim(),
      points: Array.from({ length: DAYS + 1 }, (_, d) => 100 * (1 + s.daily) ** d),
    }));
  }, [apys.venues]);
}

export default function PerformanceChart({ apys }) {
  const series = useSeries(apys);
  const [hoverDay, setHoverDay] = useState(null);

  if (!series) {
    return (
      <section className="card">
        <h2>Restwise vs. single-asset baselines</h2>
        <p className="muted">Loading live APYs…</p>
      </section>
    );
  }

  const all = series.flatMap((s) => s.points);
  const yMin = Math.min(...all), yMax = Math.max(...all) || 1;
  const pad = (yMax - yMin) * 0.1 || 0.05;
  const xs = (d) => M.left + (d / DAYS) * (W - M.left - M.right);
  const ys = (v) => H - M.bottom - ((v - (yMin - pad)) / (yMax + pad - (yMin - pad))) * (H - M.top - M.bottom);

  // Nudge direct labels apart when series end close together.
  const labelYs = series
    .map((s, i) => ({ i, y: ys(s.points[DAYS]) }))
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < labelYs.length; k++) {
    if (labelYs[k].y - labelYs[k - 1].y < 12) labelYs[k].y = labelYs[k - 1].y + 12;
  }
  const labelY = new Map(labelYs.map(({ i, y }) => [i, y]));

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setHoverDay(Math.max(0, Math.min(DAYS, Math.round(((px - M.left) / (W - M.left - M.right)) * DAYS))));
  };

  return (
    <section className="card">
      <h2>Restwise vs. single-asset baselines</h2>
      <p className="muted">
        Growth of $100 over 30 days at the APYs live on-chain right now. Restwise sits in the
        best of the four venues each day and nets out its 10% performance fee on yield;
        baselines hold one Aave market and never move.
      </p>
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} ${H}`} onMouseMove={onMove} onMouseLeave={() => setHoverDay(null)}
          aria-label="Projected growth of $100 over 30 days">
          {Array.from({ length: 5 }, (_, i) => {
            const v = yMin - pad + ((yMax + pad - (yMin - pad)) * i) / 4;
            return (
              <g key={i}>
                <line x1={M.left} y1={ys(v)} x2={W - M.right} y2={ys(v)} className="gridline" />
                <text x={M.left - 6} y={ys(v) + 4} textAnchor="end" fontSize="10" className="axis-text">
                  ${v.toFixed(2)}
                </text>
              </g>
            );
          })}
          {[0, 10, 20, 30].map((d) => (
            <text key={d} x={xs(d)} y={H - 8} textAnchor="middle" fontSize="10" className="axis-text">day {d}</text>
          ))}
          {series.map((s, i) => (
            <g key={s.name}>
              <path
                d={s.points.map((v, d) => `${d ? "L" : "M"}${xs(d)},${ys(v)}`).join("")}
                fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round"
              />
              <text x={W - M.right + 8} y={labelY.get(i) + 4} fontSize="11" fill={s.color} fontWeight="600">
                {s.name}
              </text>
            </g>
          ))}
          {hoverDay != null && (
            <line x1={xs(hoverDay)} x2={xs(hoverDay)} y1={M.top} y2={H - M.bottom} className="crosshair" />
          )}
        </svg>
        {hoverDay != null && (
          <div className="tooltip" style={{ left: `${(xs(hoverDay) / W) * 100}%`, top: 40 }}>
            <div><strong>Day {hoverDay}</strong></div>
            {series.map((s) => (
              <div className="row" key={s.name}>
                <span><span className="swatch" style={{ background: s.color }} />{s.name}</span>
                <span className="num">${s.points[hoverDay].toFixed(3)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.name}><span className="swatch" style={{ background: s.color }} />{s.name}</span>
        ))}
      </div>
      <details>
        <summary className="muted">Data table</summary>
        <table>
          <thead>
            <tr><th>Day</th>{series.map((s) => <th className="num" key={s.name}>{s.name}</th>)}</tr>
          </thead>
          <tbody>
            {[0, 7, 14, 21, 30].map((d) => (
              <tr key={d}>
                <td>{d}</td>
                {series.map((s) => <td className="num" key={s.name}>${s.points[d].toFixed(3)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
