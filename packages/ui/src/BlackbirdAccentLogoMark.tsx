// Blackbird 18×18 tile logo with the glyph bound to the accent token.
// The static asset (logo-blackbird.svg) hardcodes #F5AE4D and, consumed through
// <img>, cannot inherit page CSS variables — sites that want the glyph to follow
// Appearance → Accent render this inline variant instead.
export function BlackbirdAccentLogoMark({ className }: { className?: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect width="18" height="18" rx="4" fill="#0A0A0E" />
      <g transform="translate(3.4,2.2) scale(0.046875)">
        <rect x="78" y="14" width="100" height="190" rx="18" fill="var(--color-brand, #F5AE4D)" />
        <rect x="78" y="14" width="100" height="92" rx="18" fill="var(--color-brand, #F5AE4D)" />
        <rect x="78" y="112" width="108" height="92" rx="20" fill="var(--color-brand, #F5AE4D)" />
        <rect x="106" y="34" width="44" height="52" rx="10" fill="#0A0A0E" />
        <rect x="106" y="132" width="52" height="52" rx="12" fill="#0A0A0E" />
        <circle cx="162" cy="62" r="7" fill="#0A0A0E" />
      </g>
    </svg>
  );
}
