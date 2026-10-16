# SOP rules and harness contract

This is the implementation contract for OPC-156. The original requirements remain in
[`brief.md`](brief.md). Values described as defaults are explicit demo assumptions,
not insurer policy. Pi SDK owns the agent loop; the application owns business state and permissions.

## Ownership and trust

- `src/domain/` defines phases, statements/facts, identity, representative authorization,
  email consent, cases and document guidance as separate business concepts. Domain modules
  have no imports from application, adapters, Pi, TypeBox, Bun or environment configuration.
- A user statement is a hint. Only a server-side verifier can produce active identity
  evidence. Pi messages, summaries, tool arguments, and client state never grant access.
- `src/application/tool-contracts.ts` owns executable input/output schemas and derives the business
  names and TypeScript contracts from them. Tool arguments cannot supply a trusted
  session, identity, state version, or authorization.
- `src/adapters/pi/` hosts Pi with explicit models, credentials, settings, resources,
  and in-memory conversation storage. SQLite business persistence and the running state
  machine are implemented in OPC-158; fixture matching is implemented in OPC-159.
- The factory starts with only explicitly registered business tools. Coding tools,
  filesystem discovery, project/global skills, prompt templates and context files are disabled.
- Business tool execution is sequential and calls a mandatory host authorization closure.
  The host must check the latest phase, identity, grant expiry and case ownership inside
  the same business transaction as the protected read/write. Exposure is an additional filter.
- `defineBusinessTool` selects schemas by business name. Authors return typed business
  outcomes; the Pi adapter validates arguments before authorization and validates outcomes
  before creating text, details and structured content. Invalid results produce a contract
  error without rejected values. Schemas cannot be overridden, and copied definitions
  cannot replace guarded execution during registration.
- `src/domain/claims.ts` owns case invariants and `factsAt(now)`; the fixture codec constructs
  a domain case and translates errors into safe fixture locations. `src/domain/documents.ts`
  owns material categories, original requirements and follow-up restrictions. The adapter
  only translates source keys, text and provenance into a domain guidance catalog.

## Identity evidence

At least **three distinct fields** must actually match the same subject: full name,
date of birth, phone, email, or SSN last four digits. A policy number only locates a record.
Repeating a field never adds evidence. Missing fields do not count as failed matching attempts.

Any unresolved field mismatch or mixed-subject evidence prevents verification even when
three other matches exist. Ask for clarification and rerun the verifier; never overwrite
a conflict merely because the model supplied a newer assertion. The verifier resolves active
evidence explicitly and retains the audit trail. Raw reference PII must not be returned as a hint.

`assessIdentityEvidence` evaluates already-checked evidence; it does not compare PII with fixtures.

## Identity, representative authorization, and email consent

| State | What it proves | What it does not prove |
| --- | --- | --- |
| Identity verification | Distinct supplied fields matched one subject, within session validity | Representative permission or email permission |
| Representative authorization | An unexpired, scoped grant for the identified representative and subject | A relationship record alone is insufficient |
| Email consent | The user explicitly agreed to a recipient and specific summary version | Access to claim data or representative authority |

The policyholder self-service path needs valid identity and uses `not_required` for representative
authorization. A representative also needs independently sufficient caller identity and a scoped
grant. `fixtures/representatives.json` alone supplies neither. Insufficient evidence leads to
human assistance. `fixtures/consent_scenarios.json` can simulate pending/approved/timeout, but its
status sequence does not specify an authorization purpose; simulated grants are marked `mock`.

Email consent is checked against the actual originating user turn, not a model-provided boolean.
Changes to the summary or recipient require fresh consent. Declining email is a normal completion.

## Phase rules

Fact capture and requested human assistance are available in every active phase.
The exposure vocabulary is executable data in `PHASE_TOOLS`; stage transitions remain
server decisions implemented by OPC-158.

| Phase | Entry and permitted work | Wait conditions | Completion and recovery |
| --- | --- | --- | --- |
| `VERIFY_ID` | New, reset or expired conversation. Capture all useful facts, verify identity, request representative authorization if relevant. No case reads. | Missing/contradictory identity evidence; pending authorization. Offer allowed alternate fields and explain the requirement. | Enter `RESOLVE_INTENT` only with valid identity and any required grant. Failure limit, refused/insufficient authorization or timeout requests human assistance without unlocking data. |
| `RESOLVE_INTENT` | Reuse saved intent and case hints. Resolve only among the authorized subject's cases. | Missing intent, no match or multiple matches. Ask only for the missing distinction. | Enter `PROCESS_CASE` with one authorized case. Preserve confirmed identity and useful hints. Never guess a case. |
| `PROCESS_CASE` | Read authorized facts and material guidance; answer grounded follow-ups. | Continue here while questions remain. Unknown answers require clarification or human help. | Enter `POST_PROCESS` after the request is handled and the user confirms completion/no further questions. Case changes recheck ownership and invalidate old case facts. |
| `POST_PROCESS` | Offer a grounded summary; record send/skip choice; send only with current consent. | No choice, failed/unknown delivery, or changed summary/recipient. Do not report unknown delivery as success. | Skip or recorded/submitted delivery completes the conversation. A new case question resumes `PROCESS_CASE`, invalidates old summary consent and needs a new choice later. |

When one utterance provides enough evidence and case hints, the harness may perform several
legal actions in one run. Preserve the phase order and enforce a run budget; do not force
redundant questions or derive verification from conversation fluency.

## Limits, recovery, and escalation

| Setting | Default | Environment override |
| --- | --- | --- |
| Distinct matching identity fields | 3, fixed | None |
| Failed identity matching attempts | 3 | `MAX_IDENTITY_FAILURES` |
| Consecutive out-of-scope turns | 3 | `MAX_CONSECUTIVE_OFF_TOPIC` |
| Authorization waiting time | 30,000 ms | `AUTHORIZATION_TIMEOUT_MS` |
| Session idle expiry | 1,800,000 ms | `SESSION_IDLE_TIMEOUT_MS` |

`src/application/config.ts` decodes policy overrides as positive safe integers; policy defaults
and identity matching rules belong to the domain. Incomplete identity collection is
not a mismatch. A successful verification resets its failure count. An in-scope turn resets the
consecutive off-topic count; a mixed turn handles the insurance part and rejects the unrelated part.

Empathy, explanations and alternate fields preserve all gates. Requests for a human, exhausted
attempts, unavailable authorization/material alternatives, or unavailable services enter an explicit
handoff-requested state. A simulated handoff must not claim a real representative is connected.
Handoff is a terminal side outcome, not a fifth SOP phase or authorization mechanism.

Pi's transcript/compaction is conversation context, not authoritative business memory. Each
customer gets an independent Pi session. Reset, expiry and restart must invalidate or explicitly
restore the business session before reuse; lifecycle persistence belongs to OPC-158.

The factory keeps SDK auto-retry, compaction and cache warming off for this foundation. OPC-163
may enable them with explicit budgets and lifecycle tests. Await `session.prompt()` (or the high-level
`agent_settled` event), not merely `agent_end`. Subscribe before prompting. The owner aborts active
work, waits for idle, unsubscribes and disposes when ending a session. Tool retries must share a
business idempotency key; cancellation never implies that an email was not sent.

## Verification and source

`bun test` checks identity evidence boundaries, policy values, tool exposure and real Pi sessions
with Pi's fake provider. `bun run smoke` creates a session, subscribes, executes a business tool
through Pi's actual loop, observes settlement and disposes. These commands need no API token.

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Explicit SDK host configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts)

The broader claims workflow, model integration, UI, delivery adapters and end-to-end validation
remain the subsequent issues linked from OPC-155.
