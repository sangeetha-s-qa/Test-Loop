/**
 * The Testloop mark.
 *
 * The geometry is `public/testloop-icon.svg` exactly — an open loop that turns back on itself,
 * which is the product in one stroke: test, find, fix, test again. The path data is inline rather
 * than an `<img src>` so the mark renders with the page instead of arriving as a second network
 * request that can be late or blocked.
 *
 * `tone` exists because the mark sits on two very different grounds in this product: the navy
 * sidebar, where it has to be light enough to read, and white surfaces, where the brand violet is
 * the right weight. A single colour would fade into one of them.
 */
export function Logo({ size = 28, tone = "brand" }: { size?: number; tone?: "brand" | "light" }) {
  const stroke = tone === "light" ? "#c4b5fd" : "#8b5cf6";
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} fill="none" aria-hidden="true" className="shrink-0">
      <g transform="translate(12.1,10.21) scale(0.2105)">
        <path d="M -40,10 A 42,42 0 1 1 34,34" stroke={stroke} strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M 34,34 L 34,10 L 58,10" stroke={stroke} strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Mark plus wordmark, used in the sidebar and the landing header. */
export function Wordmark({ tone = "brand", size = 28 }: { tone?: "brand" | "light"; size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <Logo size={size} tone={tone} />
      <span className={`font-display text-lg font-bold tracking-tight ${tone === "light" ? "text-white" : "text-slate-900"}`}>
        test<span className={tone === "light" ? "text-violet-300" : "text-violet-600"}>loop</span>
      </span>
    </span>
  );
}
