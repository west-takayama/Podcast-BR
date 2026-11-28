import { useEffect, useState } from "react";
import { summarize, type BudgetState } from "./ledger";
import { scale, warning } from "./pricing";
import { readBudget, subscribeBudget } from "./store";

export function useBudgetState() {
  const [state, setState] = useState<BudgetState>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void readBudget().then(snapshot => {
        if (request === generation) { setState(snapshot); setUnavailable(false); }
      }).catch(() => { if (request === generation) setUnavailable(true); });
    };
    refresh();
    const unsubscribe = subscribeBudget(refresh);
    window.addEventListener("focus", refresh);
    return () => { ++generation; unsubscribe(); window.removeEventListener("focus", refresh); };
  }, []);
  return { state, unavailable };
}

export function BudgetNotice({ open }: { open: () => void }) {
  const { state } = useBudgetState();
  if (!state) return null;
  const totals = summarize(state);
  const insufficient = state.settings.mode === "prepaid" && state.settings.planned > (totals.balanceRemaining ?? 0);
  return totals.warned || insufficient ? <p className="card" role="status">
    {totals.warned && `月間予算の警告額 ${(warning / scale).toLocaleString("ja-JP")}円 に達しました。 `}
    {insufficient && "制作予定額が前払い残高の目安を超えています。 "}
    <button type="button" onClick={open}>予算管理を開く</button>
  </p> : null;
}

