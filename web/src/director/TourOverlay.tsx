import { useEffect, useState } from "react";
import { TOUR, activeCaption, tourCurtain } from "./tour";

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Director tour layer: subtitles / title and end cards, a shield so stray clicks cannot steer the cameras (a click
 * pauses, like a video), and a small control pill that hides after 2.5 s without mouse movement (clean recordings).
 */
export function TourOverlay({ t, paused, ended, fill, low, onPause, onExit, onReplay }: {
  t: number; paused: boolean; ended: boolean; fill: (s: string) => string; low: boolean;
  onPause: () => void; onExit: () => void; onReplay: () => void;
}) {
  const [awake, setAwake] = useState(true);
  useEffect(() => {
    let tm = setTimeout(() => setAwake(false), 2500);
    const wake = () => { setAwake(true); clearTimeout(tm); tm = setTimeout(() => setAwake(false), 2500); };
    addEventListener("pointermove", wake);
    return () => { clearTimeout(tm); removeEventListener("pointermove", wake); };
  }, []);
  const c = ended ? null : activeCaption(t);
  return (
    <div className="tour" aria-live="polite">
      {!ended && <div className="tour-shield" onClick={onPause} aria-hidden />}
      <div className="tour-curtain" style={{ opacity: ended ? 0 : tourCurtain(t) }} aria-hidden />
      {c && (
        <div key={c.from} className={`tour-cap ${c.kind ?? ""} ${low ? "low" : ""}`}>
          {c.kind === "title" && <div className="tour-title">SUNCHASER</div>}
          <p>{fill(c.text)}</p>
          {c.kind === "end" && <div className="tour-sign">Team Eternal Light · NASA Space Apps Challenge 2026</div>}
        </div>
      )}
      {ended ? (
        <div className="tour-end glass">
          <div className="tour-title small">SUNCHASER</div>
          <p>Other tools tell you where to land. Sunchaser tells you how to survive.</p>
          <div className="tour-end-actions">
            <button className="cta small" onClick={onReplay}>Watch again</button>
            <button className="cta ghost small" onClick={onExit}>Explore on your own</button>
          </div>
        </div>
      ) : (
        <div className={`tour-bar glass ${awake || paused ? "" : "asleep"}`}>
          <span className="tour-dot" aria-hidden /> Director tour
          <span className="num">{clock(Math.min(t, TOUR.length))} / {clock(TOUR.length)}</span>
          <i className="tour-prog" aria-hidden><b style={{ width: `${(100 * Math.min(t, TOUR.length)) / TOUR.length}%` }} /></i>
          <button className="link" onClick={onPause}>{paused ? "Resume" : "Pause"} <kbd>Space</kbd></button>
          <button className="link" onClick={onExit}>Exit <kbd>Esc</kbd></button>
        </div>
      )}
    </div>
  );
}
