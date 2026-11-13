/** GO / MARGINAL / NO-GO as a filled pill: a shape and a word, never colour alone. */
export type StatusKind = "go" | "marginal" | "nogo" | "none";

const WORD: Record<StatusKind, string> = { go: "GO", marginal: "MARGINAL", nogo: "NO-GO", none: "No data" };
const MARK: Record<StatusKind, string> = { go: "", marginal: "◐", nogo: "✕", none: "–" };

export function Status({ kind, size = "md" }: { kind: StatusKind; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`status ${kind} ${size}`}>
      <span className="status-mark" aria-hidden>{MARK[kind]}</span>{WORD[kind]}
    </span>
  );
}
