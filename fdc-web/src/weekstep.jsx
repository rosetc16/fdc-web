/* ⭐⭐⭐⭐ ONE WEEK STEPPER, USED BY EVERY IN-SEASON SCREEN — 29w.
   ==================================================================================================
   Trey asked for a week toggle on My Week and again on Game Day, and the home strip already had one. Three
   copies of a control this small is how two of them end up disagreeing about what "this week" means — which
   is precisely the class of bug b143 just fixed on the server side, where Sleeper's idea of the current week
   and the football calendar's had quietly diverged.

   ⚠ "THIS WEEK" IS A STATE, NOT A NUMBER. The stepper hands back NULL to mean "whatever the backend says is
     current", and a number only once the user has actually stepped. That distinction is load-bearing: null
     lets the Tuesday roll-forward happen, while a number is an explicit instruction that must be obeyed even
     when it points at a finished week. Collapsing them — storing today's number instead of null — would
     pin the screen to whatever week it first loaded on and quietly break the roll.
   ⚠ AND THE RESET IS ALWAYS OFFERED once you have stepped away, because getting back to "now" by pressing
     an arrow the right number of times is not navigation.
*/
import React from "react";

export default function WeekStep({ week, current, min = 1, max = 18, onPick, label = "Week", busy }) {
  const shown = Number.isFinite(week) ? week : null;
  const atDefault = shown == null || (Number.isFinite(current) && shown === current);
  const go = (w) => {
    if (!onPick) return;
    const clamped = Math.min(max, Math.max(min, w));
    // Stepping back onto the backend's own current week restores AUTO rather than pinning that number.
    onPick(Number.isFinite(current) && clamped === current ? null : clamped);
  };
  const base = Number.isFinite(shown) ? shown : (Number.isFinite(current) ? current : min);
  const btn = {
    cursor: "pointer", fontFamily: "inherit", border: "1px solid var(--line2)", background: "var(--panel2)",
    color: "var(--ink)", borderRadius: 7, padding: "3px 9px", fontSize: 12, fontWeight: 800, lineHeight: 1.3,
  };
  return (
    <span data-weekstep={String(base)} data-weekstepauto={atDefault ? "1" : "0"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <button type="button" data-weekstepprev aria-label="Previous week" disabled={busy || base <= min}
        onClick={() => go(base - 1)} style={{ ...btn, opacity: base <= min ? .4 : 1 }}>‹</button>
      <span className="num" style={{ fontSize: 12.5, fontWeight: 800, minWidth: 62, textAlign: "center" }}>
        {label} {base}
      </span>
      <button type="button" data-weekstepnext aria-label="Next week" disabled={busy || base >= max}
        onClick={() => go(base + 1)} style={{ ...btn, opacity: base >= max ? .4 : 1 }}>›</button>
      {/* Only offered once it would do something — a permanently visible "this week" next to week 4 when
          you are already on week 4 is a control that teaches you to ignore controls. */}
      {!atDefault && (
        <button type="button" data-weekstepnow onClick={() => onPick && onPick(null)}
          style={{ ...btn, borderColor: "var(--gold)", color: "var(--gold)", background: "transparent", fontSize: 11 }}>
          ↵ this week
        </button>
      )}
    </span>
  );
}
