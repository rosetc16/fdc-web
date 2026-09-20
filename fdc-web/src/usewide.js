/* One media query, one implementation — 29q.
   Two screens now switch layout at the same breakpoint (Game Day's side-by-side root-for/against, and the
   review's column table), and two copies of a matchMedia effect is exactly the kind of thing that drifts:
   somebody moves one to 960 and the app has two different ideas of what "wide" means. */
import { useState, useEffect } from "react";

export function useWide(px = 900) {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const read = () => setWide(mq.matches);
    read();
    // Safari before 14 has no addEventListener on MediaQueryList; the deprecated form still works there.
    if (mq.addEventListener) { mq.addEventListener("change", read); return () => mq.removeEventListener("change", read); }
    mq.addListener(read); return () => mq.removeListener(read);
  }, [px]);
  return wide;
}
