/* ⭐⭐⭐⭐⭐ THE HOVER CARD, ONCE — 29ae.
   ==================================================================================================
   29ad built this inside MyWeek.jsx for the summary's two hovers. 29ae needs the same thing on the home
   strip's to-do list and in three places on Game Day, and the choice at that point is to export it or to
   write it twice more. This project has paid for the second option enough times (the rebuild/win-now rule
   in 29aa, the power ranking in 29y, four copies of the platform config patch in 29p) that it is not a
   close call: a card that positions itself slightly differently on two screens is a bug nobody reports
   and everybody notices.

   ⚠ DECLARED AT MODULE LEVEL, NOT INSIDE A SCREEN. A component defined in a render body is a NEW TYPE on
     every render, so React unmounts and remounts it — which in 29d made tooltips vanish from under a
     moving pointer, because the browser only fires mouseover on movement ONTO an element and the element
     kept being replaced. A hover card is precisely the component that cannot survive that mistake.
   ⚠ AND IT IS POSITIONED FROM THE TRIGGER'S BOX, NEVER THE CURSOR (29p). Anchored to the pointer it lands
     on the row it describes, which on every one of these screens is the context you were reading.
   ================================================================================================== */
import React, { useState } from "react";

/* A card is: a title, an optional block of labelled lines, an optional table, and an optional footnote.
   Game Day's player card is mostly lines with a small table under it; My Week's are mostly table. One
   shape covers both, and a screen that needs neither half simply omits it. */
export function HoverTable({ card }) {
  if (!card) return null;
  const { x, y, above, title, subtitle, note, cols, rows, lines } = card;
  const wide = !!(cols && cols.length > 4);
  return (
    <div data-wkcard={card.key} role="tooltip" style={{
      position: "fixed", left: x, top: y,
      transform: `translate(${card.anchor === "left" ? "-100%" : card.anchor === "right" ? "0" : "-50%"},${above ? "-100%" : "0"})`,
      zIndex: 95, pointerEvents: "none", maxWidth: wide ? 560 : 460,
      background: "var(--panel)", border: "1px solid var(--line2)", borderRadius: 10,
      boxShadow: "0 10px 30px rgba(0,0,0,.45)", padding: "9px 11px" }}>
      <div className="disp" style={{ fontSize: 11.5, fontWeight: 800, marginBottom: subtitle ? 2 : 6 }}>{title}</div>
      {subtitle ? <div className="mut" style={{ fontSize: 10.5, marginBottom: 6 }}>{subtitle}</div> : null}
      {lines && lines.length ? (
        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr)", gap: "2px 10px",
          fontSize: 11.5, marginBottom: cols && rows && rows.length ? 7 : 0 }}>
          {lines.map((l, i) => (
            <React.Fragment key={i}>
              <span className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em", paddingTop: 1 }}>{l.k}</span>
              <span data-wkcardline={l.k} style={{ color: l.tone || "var(--ink)", fontWeight: l.strong ? 700 : 400 }}>{l.v}</span>
            </React.Fragment>
          ))}
        </div>
      ) : null}
      {cols && rows && rows.length ? (
        <table style={{ borderCollapse: "collapse", fontSize: 11.5, width: "100%" }}>
          <thead>
            <tr className="mut" style={{ fontSize: 9.5, textTransform: "uppercase", letterSpacing: ".05em" }}>
              {cols.map((c) => (
                <th key={c.k} style={{ textAlign: c.right ? "right" : "left", fontWeight: 600, padding: "0 10px 3px 0" }}>{c.k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ borderTop: "1px solid var(--line)" }}>
                {cols.map((c) => (
                  <td key={c.k} style={{ textAlign: c.right ? "right" : "left", padding: "3px 10px 3px 0",
                    whiteSpace: "nowrap", color: r.tone && c.tint ? r.tone : "var(--ink)",
                    fontWeight: c.strong ? 700 : 400 }}>{r[c.k]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {note ? <div className="mut" style={{ fontSize: 10, marginTop: 5, lineHeight: 1.4 }}>{note}</div> : null}
    </div>
  );
}

/* The state and the placement. A screen calls `show(e, payload)` on mouseenter and `hide` on mouseleave,
   and renders one <HoverTable card={card} /> at its root.
   ⚠ `prefer: "left"` EXISTS BECAUSE OF THE TRADE SCREEN (29ac): a card centred on a trigger in the
     left-hand column covers the right-hand one, which is the column you are comparing it against. The
     caller knows which side it is on; this cannot work it out. */
export function useHoverCard() {
  const [card, setCard] = useState(null);
  const show = (e, payload) => {
    if (!payload) return;
    try {
      const r = e.currentTarget.getBoundingClientRect();
      /* Above when there is no room below AND there is room above — checking only the first put cards
         off the top of the window on short viewports. Estimated height rather than measured, because the
         card does not exist yet at the moment we have to decide where to put it. */
      const above = r.bottom + 240 > window.innerHeight && r.top > 260;
      const anchor = payload.prefer === "left" ? "left" : payload.prefer === "right" ? "right" : "center";
      const x = anchor === "left" ? Math.max(200, r.right) : anchor === "right" ? Math.min(r.left, window.innerWidth - 200)
        : Math.min(Math.max(r.left + r.width / 2, 180), Math.max(180, window.innerWidth - 180));
      setCard({ ...payload, anchor, x, y: above ? r.top - 8 : r.bottom + 8, above });
    } catch (_) { /* a card that cannot be placed is simply not shown */ }
  };
  return { card, show, hide: () => setCard(null) };
}
