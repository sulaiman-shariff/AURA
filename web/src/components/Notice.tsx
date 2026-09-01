import { dismissNotice, useStore } from "../engine/store";

export function Notice() {
  const notice = useStore((s) => s.notice);

  if (!notice) return null;

  return (
    <div className="notice" role="status">
      <span>{notice}</span>
      <button type="button" className="notice__close" onClick={dismissNotice} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
