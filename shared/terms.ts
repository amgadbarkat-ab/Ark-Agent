/**
 * The version a terms-of-service text declares for itself.
 *
 * One line in the document, `**Version:** <token>`, because the version is a decision by whoever
 * edits the text: fixing a typo should not ask every customer to accept again, and changing what is
 * promised must. A hash of the text would decide neither.
 *
 * Refused rather than defaulted when the line is missing or repeated, since a version that quietly
 * became "unknown" would record acceptances against nothing.
 */
export function termsVersionOf(markdown: string): string {
  const found = [...markdown.matchAll(/^\*\*Version:\*\*[ \t]+(\S+)[ \t]*$/gm)];
  if (found.length !== 1 || !found[0]?.[1]) {
    throw new Error(
      `The terms must declare their version exactly once, as a line "**Version:** <version>" (found ${found.length}).`,
    );
  }
  return found[0][1];
}
