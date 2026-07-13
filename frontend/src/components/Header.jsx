import { useEffect, useState } from "react";
import ConnectButton from "./ConnectButton";

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme || "light");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("restwise.theme", theme);
  }, [theme]);
  const dark = theme === "dark";
  return (
    <button
      className="theme-toggle"
      aria-label={`Switch to ${dark ? "light" : "dark"} theme`}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      <span className="theme-thumb">{dark ? "☾" : "☀"}</span>
    </button>
  );
}

export default function Header() {
  return (
    <header className="topbar">
      <div className="brand-group">
        <div className="brand-mark">◍</div>
        <div>
          <div className="brand-name">RESTWISE</div>
          <div className="brand-sub">autonomous stablecoin yield · Celo</div>
        </div>
        <div className="agent-pill">
          <span className="agent-dot" />
          agent live · rebalances every 6h
        </div>
      </div>
      <div className="topbar-actions">
        <ThemeToggle />
        <ConnectButton />
      </div>
    </header>
  );
}
