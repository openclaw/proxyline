# Proxyline Vision

Proxyline makes Node.js proxy routing explicit, observable, and difficult to bypass accidentally. It is a process runtime for applications that need one coherent egress policy across Node HTTP(S), global fetch/Undici, compatible WebSocket clients, and explicit CONNECT tunnels.

## Product principles

1. **Managed mode fails closed.** Missing or unsupported managed proxy configuration is an error. Covered traffic must not fall back to a direct connection because proxy setup failed.
2. **Ambient mode is predictable compatibility.** It follows the conventional proxy environment captured at install time, including `NO_PROXY`, and remains inactive when no supported proxy is configured.
3. **Bypasses are explicit and auditable.** Direct routing in managed mode requires a narrow `bypassPolicy`, `registerBypass()`, or `withBypass()` decision. Do not add hidden hostname, loopback, or error-based bypasses.
4. **Security boundaries stay honest.** Documentation and diagnostics must distinguish covered surfaces from raw sockets, pre-captured functions, private/native transports, DNS, and other out-of-process behavior that Proxyline cannot enforce.
5. **TLS identity and trust remain scoped.** Preserve destination TLS options and identity checks. Trust for a private proxy CA applies only to the proxy connection; never require process-wide verification disablement or global CA mutation.
6. **Every routing decision is explainable without leaking credentials.** New surfaces and failure modes should integrate with structured decisions, lifecycle events, and proxy URL redaction.
7. **Installation is reversible and singular.** Proxyline owns one process-wide runtime, rejects accidental competing installs, and restores every captured global it replaces.

## Scope

Proxyline owns proxy policy for Node-process transports it can patch safely or expose through explicit helpers. It should deepen correctness and coverage for those surfaces before expanding into unrelated networking infrastructure.

Supported proxy endpoints remain HTTP and HTTPS. SOCKS, PAC evaluation, raw `net`/`tls` interception, operating-system enforcement, DNS policy, and arbitrary native transport rewriting are separate product decisions, not implicit compatibility work.

New public APIs should provide a clear improvement in routing safety, observability, lifecycle control, or integration coverage. Avoid convenience wrappers that do not strengthen the core policy.

## Compatibility

- The documented public API, error codes, mode semantics, event shapes, and package exports are compatibility contracts.
- Node and Undici support must match the declared engine and peer ranges and be exercised at the minimum supported versions.
- Process-global behavior is intentional. New patches must define install order, singleton interaction, ownership, and exact cleanup behavior.
- Prefer removing obsolete internal paths over carrying aliases or fallbacks without a documented tagged upgrade need.
- Keep runtime dependencies small. Shared transport state, especially Undici's global dispatcher, must come from the host-compatible dependency rather than a hidden second runtime.

## Verification policy

Routing changes require proof through the real in-process proxy lab at the changed boundary: HTTP or CONNECT shape, TLS identity, authentication, denial, bypass, cleanup, and observability as applicable. Mocks and type checks supplement that proof but do not replace it.

Before landing runtime changes:

- add focused regression coverage;
- run the coverage-gated check and full package tests;
- verify built package and docs artifacts;
- test the declared Node matrix in CI;
- audit dependency and workflow-action freshness;
- record exact-head proof and any boundary that could not be exercised.

External-provider or platform-specific integrations require a real live path when one exists. If that proof is unavailable, keep the limitation explicit rather than weakening the managed-mode guarantee.

## Release policy

User-visible behavior changes belong in the unreleased changelog. Patch releases cover compatible fixes, security maintenance, and tooling updates; additive public API work normally requires a minor release; breaking contracts require explicit major-version approval. A GitHub Release is the npm publication trigger, and its notes must carry the complete changelog plus exact CI, package, registry, tarball, and integrity proof.
