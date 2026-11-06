"use client";

import { useQuestStore } from "./quest-store";
import { describeSaveStatus } from "./storage-messages";

/**
 * A small note in the top bar saying where saving stands: saving, saved, retrying, not saved, or paused
 * after a conflict. What to do about an error or a conflict is in the notice below the bar. The live
 * region always exists, so screen readers hear each change.
 */
export default function SaveStatusIndicator() {
  const { storage } = useQuestStore();
  const view = describeSaveStatus(storage);

  return (
    <div className={`save-status${view ? ` is-${view.tone}` : ""}`} data-save-status={view?.tone ?? "none"} title={view?.detail}>
      <span className="save-status-text" role="status">
        {view && (
          <>
            <span className="save-status-dot" aria-hidden="true" />
            <span aria-hidden="true">{view.label}</span>
            <span className="visually-hidden">{view.detail}</span>
          </>
        )}
      </span>
    </div>
  );
}
