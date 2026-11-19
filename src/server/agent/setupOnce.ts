// §32: Send to AI is set up once per Mac, not once per project. A project with no rules file of its own yet starts from
// the Mac-wide default (rules.ts AgentDefaultsFile): its rules file is written from it (set up, the default agent and
// permissions, no Always rules), and when the default names an agent the project's agent.json is turned on for that
// agent, so Send goes straight to it with no sheet. With no default yet, nothing happens and the sheet asks once.
//
// R10 holds: the default is the user's own file outside every project, the agent.json switch only counts when the
// user's rules file names the same agent (runner.ts switchedOn), and nothing in the project is read to decide anything.
// A default agent that isn't installed or signed in is not swapped for another: Send is refused, and the refused-Send
// banner and Send again (I3) say so.
import type { AgentDefaults, AgentRules } from "../../core/schema.js";
import type { Store } from "../../core/store.js";
import { agentDefaultsFile, agentRulesFor } from "./rules.js";

const adopted = new WeakMap<Store, Promise<AgentRules | null>>();

/**
 * Starts a new project from the Mac-wide default, once per store. Resolves to the rules it wrote, or null when the
 * project had rules already, or there is no default. Never rejects: a failure is logged and the sheet asks as before.
 */
export function adoptAgentDefaultsOnce(store: Store): Promise<AgentRules | null> {
  let run = adopted.get(store);
  if (!run) {
    run = adopt(store).catch((e: unknown) => {
      console.error(`Rushes: couldn't start Send to AI from your default: ${(e as Error).message}`);
      return null;
    });
    adopted.set(store, run);
  }
  return run;
}

async function adopt(store: Store): Promise<AgentRules | null> {
  const rules = await agentRulesFor(store).adopt(await agentDefaultsFile().read());
  const id = rules?.agent;
  if (!id) return rules;
  await store.update("agent", (f) => {
    // Another agent can't continue this one's conversation.
    if (f.agent !== id) {
      f.agent = id;
      f.session = null;
    }
    f.on = true;
  });
  return rules;
}

/**
 * §32: keeps the user's choice as the Mac-wide default (last choice wins). Never fails the change it follows: the
 * project's own rules are already written, so a default that can't be saved only means the next new project asks.
 */
export async function rememberDefault(change: Partial<AgentDefaults>, now: Pick<AgentRules, "agent" | "permissions">): Promise<void> {
  try {
    await agentDefaultsFile().set(change, { agent: now.agent, permissions: now.permissions });
  } catch (e) {
    console.error(`Rushes: couldn't save Send to AI as your default for new projects: ${(e as Error).message}`);
  }
}
