import { cn } from '@/lib/utils';

/**
 * The PrunerrXT mark: open shears forming an X with a sprig between the
 * blades, on a dark tile. The same drawing as assets/icon.svg, inlined so it
 * scales crisply at every size the UI needs. The tile and the glow are part of
 * the mark, so it needs no coloured container around it.
 */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg viewBox="0 0 256 256" className={cn('shrink-0', className)} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} fill="none">
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id="pxt-tile" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1b2740" />
          <stop offset="1" stopColor="#090e1a" />
        </linearGradient>
        <radialGradient id="pxt-glow" cx="0.5" cy="0.45" r="0.62">
          <stop offset="0" stopColor="#f59e0b" stopOpacity="0.3" />
          <stop offset="1" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="pxt-amber" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fcd34d" />
          <stop offset="1" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
      <rect width="256" height="256" rx="56" fill="url(#pxt-tile)" />
      <rect width="256" height="256" rx="56" fill="url(#pxt-glow)" />
      <rect x="3" y="3" width="250" height="250" rx="53" stroke="#ffffff" strokeOpacity="0.06" strokeWidth="2" />
      <g stroke="#2dd4bf" strokeWidth="12" strokeLinecap="round">
        <path d="M128 104 V40" />
        <path d="M128 76 C119 70 110 70 100 58" />
        <path d="M128 60 C137 52 146 52 156 40" />
      </g>
      <g stroke="url(#pxt-amber)" strokeLinecap="round" strokeLinejoin="round">
        <path d="M128 128 L66 46" strokeWidth="24" />
        <path d="M128 128 L190 46" strokeWidth="24" />
        <path d="M128 128 L106 170" strokeWidth="20" />
        <path d="M128 128 L150 170" strokeWidth="20" />
        <circle cx="90" cy="196" r="26" strokeWidth="16" />
        <circle cx="166" cy="196" r="26" strokeWidth="16" />
      </g>
      <circle cx="128" cy="128" r="9" fill="#090e1a" />
    </svg>
  );
}

/** The name, with the XT in the accent colour. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('font-display font-bold tracking-tight text-surface-50', className)}>
      Prunerr<span className="text-accent-500">XT</span>
    </span>
  );
}
