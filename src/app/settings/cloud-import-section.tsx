"use client";

import { summarizeGarden } from "../browser-save-preview";
import { GardenSummaryCard, useImportFlow } from "../import-flow-provider";
import { useQuestStore } from "../quest-store";

/**
 * Settings → Account, for a verified sign-in: compares the garden in this browser with the account's
 * cloud garden and offers to import the first into the second. The cloud summary is only ever the
 * signed-in account's own cloud garden, while it's the one on screen; never this browser's garden.
 */
export default function CloudImportSection({ accountId }: { accountId: string }) {
  const { storage, canPlay, getDataForExport } = useQuestStore();
  const importFlow = useImportFlow();
  const { availability } = importFlow;
  const ownCloudGarden = storage.mode === "cloud" && storage.account?.id === accountId;
  const cloudSummary = ownCloudGarden && canPlay ? summarizeGarden(getDataForExport()) : null;

  let note: string | null = null;
  if (storage.mode === "browser") {
    note = "You're playing with the garden in this browser, so there's nothing to import here. To bring it to your account, switch to your cloud garden first.";
  } else if (!ownCloudGarden) {
    note = "Your cloud garden is getting ready.";
  } else if (storage.phase === "choose") {
    note = "Your account doesn't have a cloud garden yet. Use the choice at the top of the page to import this browser's garden or start fresh.";
  } else if (storage.phase === "importing" || storage.phase === "import-unresolved") {
    note = "An import is in progress. Follow the notice at the top of the page.";
  } else if (storage.phase !== "ready" || !canPlay) {
    note = "Your cloud garden needs to finish loading before you can import.";
  } else if (!availability.available) {
    note = availability.message;
  }
  const canImport = note === null && availability.available;

  return (
    <div className="cloud-import" role="group" aria-labelledby="cloud-import-heading">
      <h3 id="cloud-import-heading">Bring this browser&apos;s garden to your account</h3>
      <p className="settings-description">
        Importing replaces your cloud garden with the one saved in this browser. A backup of your cloud garden is kept
        in your account first, and the garden in this browser stays as it is.
      </p>
      <div className="import-comparison">
        <GardenSummaryCard title="This browser" summary={availability.summary} emptyText="No garden saved" />
        <GardenSummaryCard
          title="Your cloud garden"
          summary={cloudSummary}
          emptyText={storage.phase === "choose" ? "No cloud garden yet" : "Not loaded"}
        />
      </div>
      {note && <p className="settings-description import-note">{note}</p>}
      {canImport && (
        <div className="settings-form-row">
          <span />
          <button className="settings-action-button" type="button" disabled={importFlow.busy} onClick={importFlow.openImport}>
            Review and import…
          </button>
        </div>
      )}
    </div>
  );
}
