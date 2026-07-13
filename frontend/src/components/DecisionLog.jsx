import { useDecisionLog } from "../hooks/useDecisionLog";
import { VAULT_ADDRESS } from "../config/contracts";

export default function DecisionLog() {
  const { data: rows, isLoading, error } = useDecisionLog();

  let body;
  if (!VAULT_ADDRESS) {
    body = <tr><td colSpan={4} className="muted">Append ?vault=0x… to the URL to point at a deployment.</td></tr>;
  } else if (isLoading) {
    body = <tr><td colSpan={4} className="muted">Loading events…</td></tr>;
  } else if (error) {
    body = <tr><td colSpan={4} className="muted">Could not load events: {error.message}</td></tr>;
  } else if (!rows?.length) {
    body = <tr><td colSpan={4} className="muted">No agent activity in the last 50k blocks yet.</td></tr>;
  } else {
    body = rows.map((r, i) => (
      <tr key={`${r.block}-${i}`}>
        <td className="num">{r.block}</td>
        <td>{r.action}</td>
        <td className="num">{r.amount}</td>
        <td>{r.why}</td>
      </tr>
    ));
  }

  return (
    <section className="card">
      <h2>Agent decision log</h2>
      <p className="muted">
        Every rebalance is recorded on-chain with the APYs the agent saw when it acted —
        read straight from <code>Rebalanced</code> events, nothing off-chain to trust.
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Block</th><th>Move</th><th>Amount</th><th>Why</th></tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </section>
  );
}
