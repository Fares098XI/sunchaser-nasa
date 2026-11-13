import { CHECKS, LIMITATIONS, type Status } from "../data/validation";
import { CheckIcon } from "../ui/icons";

const LABEL: Record<Status, string> = { pass: "Pass", fail: "Fail", resolved: "Failed, resolved", pending: "Pending" };

export function ValidationView() {
  const count = (s: Status) => CHECKS.filter((c) => c.status === s).length;
  const mark = (s: Status) => (s === "pass" ? <CheckIcon size={12} /> : s === "pending" ? "…" : "✕");
  return (
    <section className="sheet glass validation" aria-label="Validation and limitations">
      <header className="sheet-head">
        <div>
          <div className="eyebrow">Evidence</div>
          <h2>How do we know the numbers are right?</h2>
          <p className="dim">Every check has its pass rule written down <em>before</em> it runs. Failures stay on this page with what we
            learned from them. Full record: <span className="num">docs/VALIDATION.md</span> in the repository.</p>
        </div>
        <div className="tally" aria-label="Summary">
          <span className="pill pass"><CheckIcon size={12} /> {count("pass")} pass</span>
          {count("resolved") > 0 && <span className="pill resolved">✕ {count("resolved")} failed, then resolved</span>}
          {count("fail") > 0 && <span className="pill fail">✕ {count("fail")} fail</span>}
          {count("pending") > 0 && <span className="pill pending">… {count("pending")} pending</span>}
        </div>
      </header>

      <div className="checks">
        {CHECKS.map((c) => (
          <article key={c.id} className={`check ${c.status}`}>
            <div className="check-head">
              <span className="check-id num">{c.id}</span>
              <h3>{c.title}</h3>
              <span className={`pill ${c.status}`}>{mark(c.status)} {LABEL[c.status]}{c.resolvedBy ? ` by ${c.resolvedBy}` : ""}</span>
            </div>
            <dl>
              <div><dt>Reference</dt><dd>{c.reference}</dd></div>
              <div><dt>Pass rule</dt><dd>{c.criterion}</dd></div>
              <div><dt>Result</dt><dd>{c.result}</dd></div>
            </dl>
            {c.note && <p className="check-note">{c.note}</p>}
          </article>
        ))}
      </div>

      <h3 className="limits-title" id="limitations">Limitations</h3>
      <ul className="limits">
        {LIMITATIONS.map((l) => <li key={l.id}>{l.text}</li>)}
      </ul>
    </section>
  );
}
