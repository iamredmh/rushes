// §34: a command for the user to run themselves (install, update, or a sign-in where no terminal could be opened), with
// Copy and, for an install, the agent's own setup page. Rushes never runs these.
import { useState } from "preact/hooks";
import { HELP_WORDS, type AgentHelp } from "../../agent.js";

export function HelpLine({ help, lead }: { help: AgentHelp; lead?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(help.command).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  return (
    <div class="fshelp" data-kind={help.kind}>
      {lead && <p class="fshelp-lead">{lead}</p>}
      <div class="fshelp-cmd">
        <code>{help.command}</code>
        <button type="button" class="btn ghost" onClick={copy}>
          {copied ? HELP_WORDS.copied : HELP_WORDS.copy}
        </button>
      </div>
      {help.url && (
        <a href={help.url} target="_blank" rel="noreferrer noopener">
          {HELP_WORDS.setup}
        </a>
      )}
    </div>
  );
}
