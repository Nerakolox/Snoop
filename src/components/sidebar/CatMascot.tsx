type Props = {
  eyeState: "open" | "squint" | "closed";
  className?: string;
};

export default function CatMascot({ eyeState, className }: Props) {
  return (
    <svg viewBox="0 0 48 48" width="32" height="32" className={className} aria-hidden>
      {/* 耳朵 */}
      <path d="M10 14 L16 4 L20 16 Z" fill="currentColor" opacity="0.85" />
      <path d="M38 14 L32 4 L28 16 Z" fill="currentColor" opacity="0.85" />
      {/* 头 */}
      <circle cx="24" cy="26" r="16" fill="currentColor" opacity="0.85" />
      {/* 眼睛：睁=圆点，眯=细横线，闭=弧线 */}
      {eyeState === "open" && (
        <>
          <circle cx="18" cy="25" r="2" fill="var(--color-surface)" />
          <circle cx="30" cy="25" r="2" fill="var(--color-surface)" />
        </>
      )}
      {eyeState === "squint" && (
        <>
          <rect x="15" y="24.5" width="6" height="1.5" rx="0.75" fill="var(--color-surface)" />
          <rect x="27" y="24.5" width="6" height="1.5" rx="0.75" fill="var(--color-surface)" />
        </>
      )}
      {eyeState === "closed" && (
        <>
          <path d="M15 25 Q18 27.5 21 25" stroke="var(--color-surface)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          <path d="M27 25 Q30 27.5 33 25" stroke="var(--color-surface)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}
