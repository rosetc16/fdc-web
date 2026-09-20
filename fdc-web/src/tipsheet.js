/* ═══════════════════════════════════════════════════════════════════════════════════════════════════
   HOVER CARDS ON A DEVICE WITH NO POINTER — b164
   ───────────────────────────────────────────────────────────────────────────────────────────────────
   Trey, from his phone: "when I click a player in the trade calculator on mobile, it pulls up the hover
   on the player and takes up the whole page. I think we need to probably get rid of hovers for all
   mobile unless you can think of a better alternative."

   ⚠⚠⚠⚠⚠ THE BUG IS NOT THAT THE CARD OPENS. IT IS THAT NOTHING CLOSES IT. A touch browser synthesises
     `mouseenter` on a tap so that hover styles work, and our cards open on `mouseenter` — so a tap opens
     one. But there is no matching `mouseleave` until you tap something ELSE, and the mobile stylesheet
     gives the card `pointer-events:auto` and pins it across the full viewport width. So the card opens,
     covers the screen, swallows the next tap, and the only way out is to guess where its edge is. On a
     phone that reads as "the app is stuck", which is exactly what he described.

   ⚠⚠ AND IN THE TRADE CALCULATOR IT ALSO STEALS A REAL ACTION. Those player rows toggle a man into the
     deal on click AND open his card on hover. One tap does both: the player goes in, a card he did not
     ask for covers the screen, and the state he is trying to build is behind it.

   ⭐ SO: A CARD ON A TOUCH DEVICE IS A SHEET, NOT A HOVER.
     · it opens deliberately, and where a tap already has a job it does NOT open from that tap — the row
       gets its own ⓘ instead, so tapping the row does the one thing the row is for;
     · it is bounded, sitting against the bottom edge at a fraction of the screen rather than over it;
     · and it always closes: a close button, the backdrop, or Escape. `mouseleave` is ignored entirely,
       because on a touch device that event is noise and is what made the old behaviour unpredictable.

   ⚠ THE DETECTION IS `hover: none`, NOT A USER-AGENT STRING OR A WIDTH. A narrow desktop window still has
     a mouse and should keep hovering; a large tablet has no pointer and should get sheets. Width is the
     wrong question and has been every time anyone has asked it. `pointer: coarse` is included for the
     devices that report a touch pointer while claiming some hover capability (a laptop with a
     touchscreen answers both, and there the sheet is still the safer of the two behaviours).
   ══════════════════════════════════════════════════════════════════════════════════════════════════ */
import { useState, useEffect } from "react";

const QUERY = "(hover: none), (pointer: coarse)";

/* A live read, for event handlers — which run outside render and must not close over a stale value. */
export function isCoarsePointer() {
  try {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(QUERY).matches;
  } catch (_) { return false; }
}

/* The same fact, for render. Kept beside `useWide` in spirit: one implementation of one media query, so
   the app cannot end up with two different ideas of what a touch device is. */
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(() => isCoarsePointer());
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(QUERY);
    const read = () => setCoarse(mq.matches);
    read();
    if (mq.addEventListener) { mq.addEventListener("change", read); return () => mq.removeEventListener("change", read); }
    mq.addListener(read); return () => mq.removeListener(read);
  }, []);
  return coarse;
}

/* ⚠ WHICH EVENTS ARE "THE POINTER MOVED" RATHER THAN "SOMEBODY ASKED". On a touch device the first kind
   is synthesised noise and must never close a sheet; a click, a key, or a call with no event at all is a
   deliberate act and must always be obeyed. */
const POINTER_MOVE = /^(mouse(enter|leave|over|out|move)|pointer(enter|leave|over|out|move))$/;
export const isPointerMove = (e) => !!(e && e.type && POINTER_MOVE.test(e.type));

/**
 * Should `showTip` go ahead for this event?
 * @param {Event} e            the event that triggered it
 * @param {object} opts        the call site's options; `tapHasJob` marks an element whose tap already
 *                             does something else, and which therefore must not open a card on touch.
 */
export function tipShouldOpen(e, opts) {
  if (!isCoarsePointer()) return true;                 // a real pointer: nothing changes
  if (opts && opts.tapHasJob && isPointerMove(e)) return false;
  return true;
}

/**
 * Should `hideTip` go ahead for this event?
 * ⚠ ON TOUCH, NO. A sheet is closed on purpose — see the header. Returning false here is what turns an
 *   unpredictable card into a thing with a door on it.
 */
export function tipShouldClose(e) {
  if (!isCoarsePointer()) return true;
  return !isPointerMove(e);
}
