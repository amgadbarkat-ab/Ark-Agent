import {
  buildInstructionProposal,
  proposalFileName,
  proposalFileText,
} from "../../../../shared/instruction-proposal";

/**
 * The "Propose a change" file for a trial employee's standing instruction (#116), in the shared
 * format BlackArk's `ark-eval run --proposed` reads (shared/instruction-proposal.ts). Made in the
 * browser and nowhere else: nothing is sent and nothing on this computer changes. Throws a
 * `ProposalFormatError`, in words a person reads, when the proposal is not complete.
 */
export function proposalFile(input: {
  employee: { id: string; name: string };
  current: string;
  proposed: string;
  reason: string;
  appVersion: string;
}): { name: string; text: string } {
  const proposal = buildInstructionProposal(input);
  return { name: proposalFileName(proposal), text: proposalFileText(proposal) };
}

type Invoke = (command: string, args: unknown) => Promise<unknown>;

/**
 * Saves the file, and says whether it was saved. Inside ArkAgent Desktop (v0.1.49) through its one
 * Save As command: a dialog with the file's name in Downloads, where Cancel saves nothing. In a
 * browser, or a desktop older than that command, as a plain download.
 */
export async function downloadProposalFile(file: {
  name: string;
  text: string;
}): Promise<boolean> {
  const invoke = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke?: Invoke } }
  ).__TAURI_INTERNALS__?.invoke;
  if (typeof invoke === "function") {
    try {
      return (
        (await invoke("plugin:ark-save|save_download", {
          name: file.name,
          text: file.text,
        })) === true
      );
    } catch {
      // No Save As in this desktop: the download below, to Downloads with "Show in folder".
    }
  }
  browserDownload(file);
  return true;
}

/** Hands the file to the browser as a download. Plain DOM, no request. */
function browserDownload(file: { name: string; text: string }) {
  const url = URL.createObjectURL(
    new Blob([file.text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  // After the click has been handled, so the download still has its address.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
