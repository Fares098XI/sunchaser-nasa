/** Line icons, 1.6 px stroke, currentColor. Meaning is never carried by colour alone. */
type P = { size?: number; title?: string };

const svg = (size: number, title: string | undefined, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}
    strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
    {title && <title>{title}</title>}
    {children}
  </svg>
);

export const SunIcon = ({ size = 16, title }: P) =>
  svg(size, title, <>
    <circle cx="12" cy="12" r="4" />
    {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
      <line key={a} x1="12" y1="2.5" x2="12" y2="5" transform={`rotate(${a} 12 12)`} />
    ))}
  </>);

export const EarthIcon = ({ size = 16, title }: P) =>
  svg(size, title, <>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5M12 3.5C9.4 5.9 8.2 8.7 8.2 12s1.2 6.1 3.8 8.5" />
  </>);

export const PlayIcon = ({ size = 16 }: P) => svg(size, undefined, <path d="M8 5.5v13l10.5-6.5z" fill="currentColor" />);
export const PauseIcon = ({ size = 16 }: P) =>
  svg(size, undefined, <><rect x="7" y="5.5" width="3.2" height="13" rx="1" fill="currentColor" /><rect x="13.8" y="5.5" width="3.2" height="13" rx="1" fill="currentColor" /></>);

export const PinIcon = ({ size = 16 }: P) =>
  svg(size, undefined, <><path d="M12 21s-6.5-6.2-6.5-11a6.5 6.5 0 0 1 13 0c0 4.8-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></>);

export const CheckIcon = ({ size = 14 }: P) => svg(size, undefined, <path d="M5 12.5l4.2 4.2L19 7" />);

export const CalendarIcon = ({ size = 14 }: P) =>
  svg(size, undefined, <><rect x="4" y="5.5" width="16" height="14.5" rx="2.5" /><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" /></>);
