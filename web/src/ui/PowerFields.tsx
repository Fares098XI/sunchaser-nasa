import type { PowerSystem } from "../engine/windows";

const FIELDS: { key: keyof PowerSystem; label: string; unit: string; min: number; max: number; step: number; scale?: number }[] = [
  { key: "panelM2", label: "Panel", unit: "m²", min: 0.1, max: 50, step: 0.1 },
  { key: "efficiency", label: "Efficiency", unit: "%", min: 1, max: 50, step: 1, scale: 100 },
  { key: "loadW", label: "Load", unit: "W", min: 1, max: 5000, step: 5 },
  { key: "batteryWh", label: "Battery", unit: "Wh", min: 10, max: 100000, step: 50 },
];

/** Lander power system inputs. The defaults are an example, editable to any design. */
export function PowerFields({ power, onChange }: { power: PowerSystem; onChange: (p: PowerSystem) => void }) {
  return (
    <div className="power" role="group" aria-label="Power system (example values, edit to your design)">
      {FIELDS.map((f) => (
        <label key={f.key}>
          <span>{f.label}</span>
          <input type="number" min={f.min} max={f.max} step={f.step} value={+(power[f.key] * (f.scale ?? 1)).toFixed(3)}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= f.min && v <= f.max) onChange({ ...power, [f.key]: v / (f.scale ?? 1) });
            }} />
          <small>{f.unit}</small>
        </label>
      ))}
      <p className="hint">Example values; Sun-tracking panel, battery starts full.</p>
    </div>
  );
}
