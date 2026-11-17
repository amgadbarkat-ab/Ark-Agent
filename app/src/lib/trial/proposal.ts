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

/** Hands the file to the browser as a download. Plain DOM, no request. */
export function downloadProposalFile(file: { name: string; text: string }) {
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
