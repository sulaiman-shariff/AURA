import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { attachTile } from "../engine/animator";
import {
  layout,
  PATCH,
  type Box,
  type OverlayItem,
  type Size,
} from "../engine/labelLayout";

export type { OverlayItem };

/*
 * The overlay drawn on the live video.
 *
 * Three rules shape this, in priority order:
 *
 * 1. The flickering patch may not move. It is the stimulus: the user
 *    foveates it, and its position on its object is the whole premise of the
 *    interface. Tidying the patches into a rail would turn this back into a
 *    menu of the kind the design exists to replace.
 *
 * 2. Labels must never overlap. A label is how the operator knows what a
 *    patch means; three labels piled on one another is worse than none. Since
 *    the patch cannot move, the label does -- displaced until it is clear and
 *    joined back to its patch by a hairline.
 *
 * 3. The object must stay visible. A filled box or a heavy outline hides the
 *    thing being chosen, so objects are marked with corner brackets: enough
 *    to say "this, precisely" without covering it. The device is a
 *    rangefinder, and it should look like one.
 *
 * Rule 2 is why chips are *measured* rather than assumed. Presentation mode
 * restyles them to a larger size in CSS, so any constant baked in here would
 * be wrong in exactly the mode that matters most -- which is what previously
 * made fullscreen the worst case rather than the best one.
 */

function Patch({
  hz,
  state,
  report,
}: {
  hz: number;
  state: string;
  report: (element: HTMLDivElement | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    report(element);
    // Keyed by frequency so a tag keeps its identity across re-detections.
    return attachTile(`scene-${hz.toFixed(2)}`, element, hz, 0);
  }, [hz]);

  // The animator writes `background` only; the ring is a border, so it is
  // never overwritten and the flicker stays a clean uniform field.
  return <div ref={ref} className={`reticle reticle--${state}`} />;
}

export function SceneOverlay({
  items,
  width,
  height,
  obstacles,
}: {
  items: OverlayItem[];
  width: number;
  height: number;
  /** HUD furniture labels must dodge, in overlay-local px. */
  obstacles: Box[];
}) {
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  // CSS resizes the patch between windowed and presentation mode, and the
  // layout clamps against it, so it is measured rather than assumed.
  const [patchSize, setPatchSize] = useState(PATCH);
  const patchSizeRef = useRef(patchSize);
  patchSizeRef.current = patchSize;
  const patchNode = useRef<HTMLDivElement | null>(null);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  const nodes = useRef(new Map<string, HTMLDivElement>());

  const register = useCallback((key: string, element: HTMLDivElement | null) => {
    if (element) nodes.current.set(key, element);
    else nodes.current.delete(key);
  }, []);

  const signature = items.map((item) => item.object.label).join("|");

  /*
   * Measure after paint, and again whenever CSS resizes a chip -- which is
   * what entering presentation mode does. Only differences above half a pixel
   * are written back, so this settles in one extra pass instead of
   * oscillating.
   */
  useLayoutEffect(() => {
    const measure = () => {
      const next = { ...sizesRef.current };
      let changed = false;

      nodes.current.forEach((element, key) => {
        const w = element.offsetWidth;
        const h = element.offsetHeight;
        if (w === 0 || h === 0) return;
        const previous = next[key];
        if (!previous || Math.abs(previous.w - w) > 0.5 || Math.abs(previous.h - h) > 0.5) {
          next[key] = { w, h };
          changed = true;
        }
      });

      if (changed) {
        sizesRef.current = next;
        setSizes(next);
      }

      const patch = patchNode.current?.offsetWidth ?? 0;
      if (patch > 0 && Math.abs(patch - patchSizeRef.current) > 0.5) {
        patchSizeRef.current = patch;
        setPatchSize(patch);
      }
    };

    measure();

    const observer = new ResizeObserver(measure);
    nodes.current.forEach((element) => observer.observe(element));
    if (patchNode.current) observer.observe(patchNode.current);
    return () => observer.disconnect();
  }, [signature]);

  const placed = useMemo(
    () => layout(items, width, height, sizes, obstacles, patchSize),
    [items, width, height, sizes, obstacles, patchSize],
  );

  return (
    <>
      {placed.map((item) => {
        const [x0, y0, x1, y1] = item.object.box;
        const label = item.object.displayLabel || item.object.label;
        const enriched = item.object.origin === "gemini";
        const selectable = item.hz !== null;

        // The hairline runs from the patch's edge to the chip's near edge, at
        // the chip's vertical centre -- so a displaced label stays legibly
        // tied to the thing it names.
        let leader: { left: number; top: number; length: number; angle: number } | null = null;
        if (item.chip) {
          const chipMidY = item.chip.y + item.chip.h / 2;
          const fromX =
            item.side === "right" ? item.patchX + PATCH / 2 : item.patchX - PATCH / 2;
          const toX = item.side === "right" ? item.chip.x : item.chip.x + item.chip.w;
          const dx = toX - fromX;
          const dy = chipMidY - item.patchY;
          const length = Math.hypot(dx, dy);
          if (length > 2) {
            leader = {
              left: fromX,
              top: item.patchY,
              length,
              angle: (Math.atan2(dy, dx) * 180) / Math.PI,
            };
          }
        }

        return (
          <div key={item.key}>
            {/* Corner brackets: mark the object without hiding it. */}
            <div
              className={`bracket bracket--${item.state}${enriched ? " bracket--enriched" : ""}${
                selectable ? "" : " bracket--muted"
              }`}
              style={{
                left: `${x0 * 100}%`,
                top: `${y0 * 100}%`,
                width: `${(x1 - x0) * 100}%`,
                height: `${(y1 - y0) * 100}%`,
              }}
            >
              <i className="bracket__c bracket__c--tl" />
              <i className="bracket__c bracket__c--tr" />
              <i className="bracket__c bracket__c--bl" />
              <i className="bracket__c bracket__c--br" />
            </div>

            {leader && (
              <div
                className="leader"
                style={{
                  left: `${leader.left}px`,
                  top: `${leader.top}px`,
                  width: `${leader.length}px`,
                  transform: `rotate(${leader.angle}deg)`,
                  transformOrigin: "left center",
                }}
              />
            )}

            {selectable && (
              <div
                className="reticle-wrap"
                style={{ left: `${item.patchX}px`, top: `${item.patchY}px` }}
              >
                <Patch
                  hz={item.hz as number}
                  state={item.state}
                  report={(element) => {
                    patchNode.current = element;
                  }}
                />
              </div>
            )}

            <div
              ref={(element) => register(item.key, element)}
              className={`tgt tgt--${item.state}${enriched ? " tgt--enriched" : ""}${
                selectable ? "" : " tgt--muted"
              }`}
              style={
                item.chip
                  ? { left: `${item.chip.x}px`, top: `${item.chip.y}px` }
                  : // Nowhere to put it: keep it mounted so it can still be
                    // measured, but out of sight rather than piled on a
                    // neighbour.
                    { left: 0, top: 0, visibility: "hidden" }
              }
            >
              <span className="tgt__label">{label}</span>
              {selectable && (
                <span className="tgt__hz">
                  {(item.hz as number).toFixed(1)}
                  <i>Hz</i>
                </span>
              )}
              {item.evidence !== null && (
                <span className="tgt__db">{item.evidence.toFixed(1)}</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
