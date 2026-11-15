/** The OpenHush mark: noise dots settle into the red point, which flows into one smooth wave. */
const WAVE = "M33 57 C43.6 30.6 54.2 30.6 63 50 S82.4 69.4 93 43";

export function LogoMark({ size = 22, simple = false, className }: { size?: number; simple?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true" className={className}>
      {simple ? (
        <>
          {/* small sizes: one dot, heavier line, bigger red point */}
          <circle cx="13" cy="57" r="6" fill="currentColor" opacity="0.45" />
          <path d={WAVE} fill="none" stroke="currentColor" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="33" cy="57" r="9" fill="var(--red)" />
        </>
      ) : (
        <>
          <circle cx="6.5" cy="57" r="3.5" fill="currentColor" opacity="0.3" />
          <circle cx="18" cy="57" r="4.5" fill="currentColor" opacity="0.55" />
          <path d={WAVE} fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="33" cy="57" r="7" fill="var(--red)" />
        </>
      )}
    </svg>
  );
}
