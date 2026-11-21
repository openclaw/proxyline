<!--
Write for a reader who uses Proxyline but does not know its implementation.
Start with the affected workflow, the current problem or need, and why the change
matters. Explain unfamiliar terms before naming internal functions or files.
Keep the description proportional to the change; do not invent test results.

In 1–3 plain sentences, say who is affected, what happens today, and why it
matters to them. For a bug, name the trigger if known. For a feature or internal
work, describe the need in the actual workflow without inventing harm.
Could a reader understand the problem without knowing your proposed fix?

Good: "Background checks can use up a new user's model allowance before they've
asked the assistant to monitor anything."
Bad: "Turn off periodic checks on fresh installs."

For unpatched security issues, use a private advisory instead of a public PR:
https://github.com/openclaw/proxyline/security/advisories
-->

## Summary

<!--
Explain what someone is trying to do, what happens today, and what will improve.
For example, a routing fix might describe a Node application using an HTTPS proxy
and the request that fails, before explaining the transport code being changed.
For documentation or tooling, describe the reader's task or contributor workflow.
Link related issues or context when useful.
-->

## Changes

<!--
Describe the approach and the observable before/after behavior. Put implementation
details after that explanation. Name affected modes or surfaces when relevant
(e.g. managed routing, ambient NO_PROXY matching, fetch, HTTP(S), or CONNECT).
Call out what intentionally stays the same and any scope limits.
-->

## Validation

<!--
Lead with observed results, then give commands, test names, environments, or links
that let a reviewer inspect or reproduce them. A command list alone does not say
what worked. Separate passed, failed, skipped, and not-run checks and explain gaps.

For a routing change, describe the real proxy-lab behavior observed at the changed
boundary, such as whether an HTTPS request reached the proxy and whether stop()
restored the original networking globals. For a template or docs-only change,
describe the structure, links, examples, or rendering actually checked instead.
These are examples, not claimed results or extra required checks. Follow the
existing verification policy in VISION.md and the commands in docs/testing.md.
-->

## Risks and limitations

<!--
Describe relevant compatibility, routing, TLS, credential-redaction, or lifecycle
risks, plus untested boundaries. Distinguish Proxyline's covered Node APIs from
raw sockets or other transports outside its security boundary. For docs-only
changes, state whether runtime behavior is affected. Say when no risk is known
rather than leaving a reader to infer that nothing was considered.
-->
