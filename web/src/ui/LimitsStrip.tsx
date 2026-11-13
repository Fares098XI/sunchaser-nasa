import { LIMITATIONS } from "../data/validation";

/**
 * The limits that apply to what a view shows, always on screen as short chips; opening it reads them in full.
 * (Project rule: limitations stay visible in the app, not only on the Validation page.)
 */
export function LimitsStrip({ ids, onAll }: { ids: string[]; onAll: () => void }) {
  const list = LIMITATIONS.filter((l) => ids.includes(l.id));
  return (
    <details className="limits-strip">
      <summary>
        <span className="limits-label">Limits</span>
        {list.map((l) => <span key={l.id} className="limit-chip">{l.short}</span>)}
      </summary>
      <ul>{list.map((l) => <li key={l.id}>{l.text}</li>)}</ul>
      <button className="link inline-link" onClick={onAll}>All limitations and checks →</button>
    </details>
  );
}
