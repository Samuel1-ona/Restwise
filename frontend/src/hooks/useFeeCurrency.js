import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { FEE_CURRENCIES } from "../config/contracts";

// CIP-64 (the fee-currency tx type) is a Celo extension. Celo-native wallets speak it;
// MetaMask and other generic EVM wallets serialise plain Ethereum transactions and
// reject the extra field, so we must not send it to them by default — a live deposit
// that works today has to keep working.
//
// There is no capability handshake for this, so detection is by wallet identity, which
// is why every path here still has a runtime fallback behind it. Treat this as an
// optimistic hint, never as a guarantee.
function detectCip64Support(provider) {
  if (!provider) return false;
  return Boolean(provider.isMiniPay || provider.isValora || provider.isOpera);
}

// Error shapes wallets and nodes use when they don't understand a CIP-64 transaction.
// Kept deliberately specific: a loose pattern here is dangerous, because a match makes us
// silently resubmit. Bare "123" (the tx type in decimal) is exactly the kind of token that
// appears inside unrelated revert strings and amounts, so it is not matched.
const UNSUPPORTED =
  /fee\s*currency|feecurrency|cip-?64|unsupported (transaction )?type|invalid transaction type|unrecognized transaction type|type 0x7b/i;

export function isFeeCurrencyRejection(err) {
  const text = [err?.shortMessage, err?.details, err?.message, err?.cause?.message]
    .filter(Boolean).join(" ");
  return UNSUPPORTED.test(text);
}

/**
 * Chooses which token pays gas. Defaults to the asset the user is already moving when
 * the wallet is known to support fee abstraction, and to CELO otherwise. Once a wallet
 * has actually rejected a CIP-64 transaction, `disable()` latches the CELO fallback for
 * the rest of the session, so a user pays the failed-attempt cost at most once.
 *
 * One instance serves both the deposit and withdraw flows so that latch is shared:
 * a wallet that cannot do CIP-64 on deposit cannot do it on withdraw either.
 */
export function useFeeCurrency() {
  const { connector } = useAccount();
  const [supported, setSupported] = useState(false);
  const [override, setOverride] = useState(null); // null = follow the asset
  const [latchedOff, setLatchedOff] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const provider = await connector?.getProvider?.();
        if (!cancelled) setSupported(detectCip64Support(provider));
      } catch {
        if (!cancelled) setSupported(false);
      }
    })();
    return () => { cancelled = true; };
  }, [connector]);

  return useMemo(() => {
    const resolve = (asset) => {
      if (latchedOff) return "CELO";
      if (override) return override;
      return supported ? asset : "CELO";
    };
    return {
      supported,
      override,
      setOverride,
      /** Symbol that will pay gas for a transaction in `asset`. */
      symbolFor: resolve,
      /** Address to pass as `feeCurrency`, or undefined to pay gas in CELO. */
      addressFor: (asset) => {
        const s = resolve(asset);
        return s === "CELO" ? undefined : FEE_CURRENCIES[s];
      },
      /** Called after a wallet rejects CIP-64, so we stop offering it this session. */
      disable: () => setLatchedOff(true),
      latchedOff,
    };
  }, [supported, override, latchedOff]);
}
