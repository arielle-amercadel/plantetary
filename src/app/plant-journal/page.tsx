import AppShell from "../app-shell";
import PlantJournalScreen from "./plant-journal-screen";

export default function PlantJournalPage() {
  return (
    <AppShell page="journal">
      <PlantJournalScreen />
    </AppShell>
  );
}
