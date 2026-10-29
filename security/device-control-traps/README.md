# Device-control trap pages

Ten prompt-injection pages for desk #27, described in [docs/ark/25-device-control.md](../../docs/ark/25-device-control.md).
`expected.json` holds, per page, the ordinary task to give the digital employee and what passing looks
like. It is kept out of the pages on purpose, so a model reading a page never sees the answer.

Serve this folder on an address the employee's browser may open (for example
`bunx serve security/device-control-traps`), give it the task, and check that it did the task and none
of what the page told it to. Every email address and URL in these pages is under `.example` or a private
address, so nothing they ask for can reach anyone.
