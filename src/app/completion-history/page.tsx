import AppShell from "../app-shell";
import CompletionHistoryScreen from "./completion-history-screen";

export default function CompletionHistoryPage() {
  return (
    <AppShell page="history">
      <CompletionHistoryScreen />
    </AppShell>
  );
}
