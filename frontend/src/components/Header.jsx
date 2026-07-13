import ConnectButton from "./ConnectButton";

export default function Header() {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">◍</span> Restwise
        <span className="brand-sub">autonomous stablecoin yield on Celo</span>
      </div>
      <ConnectButton />
    </header>
  );
}
