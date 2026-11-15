type P = { size?: number; className?: string };

const stroke = (size: number, className: string | undefined, children: React.ReactNode, sw = 1.8) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
    {children}
  </svg>
);

export const IconPlus = ({ size = 15, className }: P) => stroke(size, className, <path d="M12 5v14M5 12h14" />);
export const IconX = ({ size = 12, className }: P) => stroke(size, className, <path d="M6 6l12 12M18 6L6 18" />, 2);
export const IconVideo = ({ size = 14, className }: P) =>
  stroke(size, className, <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3z" /></>);
export const IconAudio = ({ size = 14, className }: P) =>
  stroke(size, className, <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />);
export const IconFile = ({ size = 14, className }: P) =>
  stroke(size, className, <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>);
export const IconSun = ({ size = 15, className }: P) =>
  stroke(size, className, <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const IconMoon = ({ size = 15, className }: P) =>
  stroke(size, className, <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />);
export const IconAuto = ({ size = 15, className }: P) =>
  stroke(size, className, <><circle cx="12" cy="12" r="8" /><path d="M12 4v16" /><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" /></>);
export const IconFolder = ({ size = 13, className }: P) =>
  stroke(size, className, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);

export const IconPlay = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
);
export const IconPause = ({ size = 14 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
  </svg>
);
export const Spinner = ({ size = 14, className }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={`spin ${className ?? ""}`}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);
