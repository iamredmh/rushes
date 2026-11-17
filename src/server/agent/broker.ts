/** A permission ask waiting for the user's answer, as the desk shows it (§28.4). The broker itself comes in Task 6. */
export interface PendingAsk {
  id: string;
  title: string;
  kind: string | null;
  command: string | null;
  always: string;
  at: string;
}
