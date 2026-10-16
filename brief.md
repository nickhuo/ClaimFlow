# ClaimFlow project brief

Build a conversational insurance claims support agent that reliably executes a fixed business workflow. The agent interprets natural language, remembers useful information across phases, and handles frustration without bypassing identity, authorization, or consent requirements.

The implementation uses TypeScript throughout, with Bun for the backend runtime, package management, scripts, and tests. The same harness powers the interactive demo and automated evaluations.

## Deliverables

- A text chat UI demonstrating identity verification, intent resolution, claim support, and optional email follow-up.
- A configurable model API connection accepting an authentication token.
- A Docker image and repository with clear local setup instructions. A hosted demo is an optional additional delivery.
- An inspectable execution timeline showing phase changes, tool activity, and gate decisions.
- Automated tests and scenario evaluations with explicit evidence of workflow correctness.

## Workflow and authority

The business workflow is `VERIFY_ID -> RESOLVE_INTENT -> PROCESS_CASE -> POST_PROCESS`. Conversation completion and human handoff are explicit terminal outcomes rather than additional business phases. Clarification and follow-up turns may remain in the current phase. A single utterance may provide enough information to pass multiple consecutive phases, but every transition must satisfy its own gate.

| Phase | Model responsibilities | Harness responsibilities |
| --- | --- | --- |
| VERIFY_ID | Extract partial identity answers, clarify ambiguity, explain requirements, and respond empathetically. | Verify at least three distinct eligible PII fields against the same policyholder record before releasing protected information or advancing. |
| RESOLVE_INTENT | Interpret the request and combine current input with remembered intent and case hints. | Limit candidate cases to the verified customer's authorized records; require clarification when the evidence does not identify a case. |
| PROCESS_CASE | Explain grounded case facts and document guidance, interpret follow-ups, and propose a bounded support path. | Enforce case ownership, allowed tools, factual evidence, action preconditions, and escalation rules. |
| POST_PROCESS | Summarize the discussion, recorded claim status or service outcome, and follow-up items; ask whether to send an email. | Record an explicit send or skip decision, authorize the destination, prevent duplicate sends, and report the actual delivery result. |

The model can propose interpretations and actions. It cannot grant verification, authorization, consent, or phase transitions. These are calculated from validated inputs and trusted tool results.

## Business requirements

### Identity verification

- Default eligible fields are full name, date of birth, phone, email, and SSN last four digits. The policy number helps locate a candidate record but does not count toward the three-field requirement.
- Collect fields across turns and normalize them using documented rules. Support explicit aliases present in the identity fixtures; do not invent fuzzy matches for sensitive values.
- Three supplied fields are insufficient unless three distinct fields match the same record. Duplicate fields and conflicting values do not increase the match count.
- Keep stored identity records inside the verification tool. Before verification, model context contains user-provided information and generic verification guidance, not stored claim details or reference PII values.
- Explain why verification is necessary and offer remaining eligible fields when the caller declines one option.
- Bound failed verification attempts. Clarifying an incomplete answer is distinct from a failed verification attempt. Stop and offer human support when the configured failure limit is reached.
- Invalidate verification and case access if the caller changes the represented identity; a new identity must satisfy the gates again.
- Preserve the fixtures' `id_type` distinction. A national ID suffix must not silently be treated as an SSN suffix. Those records can use the other eligible fields unless an explicit business policy enables another identifier.

### Intent resolution and memory

- Extract useful identity information, intent hints, case hints, and preferences whenever they appear, including before their corresponding phase.
- Persist structured memory with source turn, provenance, and whether a fact is user-provided or tool-confirmed.
- A statement such as "my denied healthcare claim from January" is a lookup hint until authorized claim data confirms it.
- Reuse remembered information after verification instead of asking the caller to repeat the purpose of the call.
- Handle corrections and contradictory information explicitly. Clarify when multiple authorized cases still fit the request.

### Grounded case support

- Support status inquiries, denial explanations, required documents, submission guidance, timing questions, and next steps from the supplied claim and guidance data.
- Scope every case lookup to a trusted verified party ID. A user-provided case ID alone never grants access.
- Treat amounts according to `claim_schema.json`. Preserve decimal precision; do not infer an insurer payment, patient liability, or approval from an unrelated amount field.
- A support conversation can explain or route an existing claim; it does not independently adjudicate coverage, approve an appeal, or guarantee reimbursement.
- Respect claim-specific deadlines and guidance precedence. If an appeal deadline has passed, explain the recorded deadline and route eligibility questions to a human rather than inventing an extension.
- Resolve document name variants through explicit mappings and retrieve relevant guidance before answering detailed follow-ups.
- When the data does not support an answer, explain the limitation and offer an authorized next step or human review.

### Scope and emotional recovery

- Evaluate scope on every turn while still retaining useful information from mixed utterances. Greetings, clarification, frustration, refusal, consent, and requests for human support are part of the service interaction.
- Politely decline unrelated requests such as "what is reinforcement learning?" and redirect to insurance support.
- Count repeated unrelated attempts using a configurable policy; after the threshold, offer a human representative. Do not count frustration about verification as an unrelated request.
- Recognize frustration, anxiety, anger, confusion, and refusal. Acknowledge the concern before requesting the next required step.
- Explain identity and consent requirements in plain language. Offer acceptable alternatives and stop persuasion when the caller asks for a human or continued attempts are unproductive.
- Human handoff includes authorized context and the reason for escalation. The demo must distinguish a simulated handoff from a real connected transfer.

### Authorization and email consent

- A representative relationship in fixture data is not sufficient authorization to disclose another person's claims. Any enabled representative path requires its own identity and authority checks.
- Representative authorization and permission to send a summary are separate state fields and separate gates.
- Offer email send and skip choices through natural conversation. Sending requires an explicit choice for the offered summary and an authorized recipient address; changing the destination requires a new authorization check.
- The summary includes discussion topics, confirmed claim status or service outcome, and major follow-up items. Exclude unnecessary identity information.
- Consent timeouts never become approval. Side-effect timeouts become an unknown or pending result until reconciled, not an automatic success or blind retry.
- Default demo delivery uses an inspectable outbox clearly labeled as simulated. A configurable delivery adapter can perform real sending; UI wording must reflect its actual result.

## TypeScript stack

| Area | Choice | Purpose |
| --- | --- | --- |
| Runtime and tooling | Bun and strict TypeScript | One language and toolchain for server, UI, contracts, tests, and eval scripts. |
| HTTP server | `Bun.serve` | Typed route handlers, session APIs, static assets, and server-sent execution events. |
| UI | React, TypeScript, and Vite | Chat, phase progress, a collapsible execution inspector, and summary choices. Run Vite through Bun. |
| Runtime contracts | Zod | Validate model outputs, API inputs, configuration, fixtures, and tool contracts; derive JSON Schema where supported. |
| SOP controller | Explicit TypeScript state machine and pure policy functions | Inspectable transitions and independently testable safety invariants. |
| Model adapter | Native `fetch` behind a narrow interface | Configurable model endpoint, API token, model name, capability checks, timeouts, and bounded retries. |
| Storage | `bun:sqlite` | Session snapshots, structured memory, ordered events, and email outbox records. |
| Fixtures and exports | `Bun.file` and `Bun.write` | Load starter data and export versioned evaluation traces. |
| Verification | `bun test`, TypeScript typecheck, and Playwright | Core policy tests, scenario tests, and meaningful browser interaction checks. |
| Packaging | Docker | Build UI assets and serve the application from one Bun container with a persistent data volume. |

Use `bun add/remove`, `bun run`, and `bun test` exclusively for the TypeScript project. Lock dependencies and the container runtime version. A graph framework, vector database, distributed job system, and model-training stack are outside the initial delivery; add them when a concrete requirement warrants them.

## Execution design

The core harness is independent of HTTP, React, and a specific model provider. Inject the model client, tool gateway, session repository, clock, and trace recorder so the same logic can run in the demo, deterministic tests, or API-backed evaluations.

Each turn follows a bounded execution cycle:

1. Parse the input into a validated `ParsedTurn` containing identity slots, intent and case hints, scope, emotion, and explicit user choices.
2. Merge useful observations into structured memory without treating them as verified facts.
3. Compute the next allowed decision from the current state and policy. Execute consecutive phase transitions only when their gates pass.
4. Execute a bounded set of typed tools through a gateway that independently rechecks authorization and phase restrictions.
5. Build an evidence-limited response plan and generate natural language. Critical status, amount, deadline, and action-result statements must refer to validated facts.
6. Validate the response and persist the resulting state and ordered events before releasing the final reply. Use an approved fallback if validation fails.

Structured output validates shape and allowed values; it does not establish semantic truth. Free-text grounding needs dedicated scenario evaluations, and high-risk factual content should use constrained rendering where practical.

Stream progress and sanitized execution events through SSE. Release protected reply content only after its checks pass. Never rely on a later check to retract already streamed information.

Initial budgets are at most two normal model calls per turn, one additional schema-repair attempt, and six tool calls per turn. Timeouts, verification limits, unrelated-attempt limits, and handoff conditions are explicit configuration. Calls that are unnecessary for a decision can be skipped.

Serialize turns within a session, check state versions, and use request IDs to detect duplicate submissions. Commit state and events atomically. Give email operations a persistent idempotency key and reconcile delivery results before retrying side effects.

## Core contracts and tools

- `ConversationState`: phase, identity observations, trusted verification and authority results, selected intent and case, memory, consent decisions, attempt counters, state version, and terminal outcome.
- `ParsedTurn`: untrusted semantic observations extracted from the current utterance. It cannot contain an authoritative verification result or arbitrary state patch.
- `PolicyDecision`: allowed actions, missing prerequisites, transition reasons, and response constraints calculated by the controller.
- `ToolResult`: typed success, failure, pending, or unknown result with evidence references and a tool invocation ID.
- `TraceEvent`: sequence number, session and turn IDs, event type, policy/model/prompt/fixture versions, timing, and sanitized payload.

Initial tool interfaces are `verifyIdentity`, `findClaims`, `getClaim`, `getDocumentGuidance`, `checkRepresentativeAuthorization`, `requestHumanHandoff`, and `sendSummaryEmail`. Tools use local fixtures and simulated integrations in demo mode; adapters can later replace those implementations without changing the SOP controller.

API keys are backend-only. Diagnostic traces and the UI inspector redact PII and omit secrets. Authorized model context and persisted session state have explicit data boundaries; user content is never promoted to an instruction granting permissions.

## Starter data and time

Keep the supplied data under `insurance_claims/fixtures/`:

- `policyholders.json`: identity reference values and explicit aliases.
- `claims.json`: customer-linked cases, statuses, amounts, required documents, and deadlines.
- `claim_schema.json`: meanings of monetary fields.
- `required_document_guideline.json`: submission and document follow-up guidance.
- `representatives.json`: relationship records for the optional representative path.
- `consent_scenarios.json`: simulated pending, approved, and timeout sequences for configured authorization checks; these do not substitute for an email send choice.

Load and validate fixtures at startup. Treat them as reference data, not model instructions, and preserve their original monetary representations and identifier types.

Use an injectable clock. Evaluations fix an `asOf` date per scenario, such as `2026-03-01` for the baseline Margaret scenario. The interactive demo uses the current date unless an explicitly labeled scenario date is selected. Run separate expired-deadline evaluations.

## Acceptance scenarios

| Scenario | Required behavior |
| --- | --- |
| Margaret baseline | Given name, policy `POL-9921`, denied-healthcare-January hint, DOB `1985-03-15`, and SSN suffix `4472`, verify three eligible matches and reuse the remembered hint to resolve `CL-2048`. |
| Baseline gate order | Verification success precedes every protected lookup, disclosure, and phase advance, including when one utterance provides all required information. |
| Partial identity | Accumulate fields across turns; stay in VERIFY_ID while evidence is insufficient. |
| Incorrect or conflicting identity | Do not verify from supplied-field count or mismatched values; explain available next steps without revealing reference values. |
| Alternate fields and aliases | Honor explicit aliases and eligible alternative fields, with correct identifier-type handling. |
| Verification pressure | Respond empathetically to "just tell me why it was denied" without disclosing claim details or bypassing the gate. |
| Early intent and correction | Remember later-phase information, apply explicit corrections, and avoid restarting discovery after verification. |
| Ambiguous case | Ask a focused question when multiple authorized cases fit; do not silently choose an arbitrary record. |
| Cross-customer lookup | Reject access to another customer's case even when the caller supplies its ID. |
| Grounded follow-ups | Explain only supported denial, document, amount, timing, and next-step facts; make no invented approval or payment promise. |
| Expired deadline | Use the scenario clock to detect expiration and route eligibility questions appropriately. |
| Unrelated questions | Decline politely, retain any useful mixed-turn information, and offer human support after repeated unrelated attempts. |
| Emotional refusal and handoff | Offer acceptable alternatives, stop persuasion when appropriate, and provide an accurately labeled handoff. |
| Representative consent | Relationship alone does not unlock protected access; pending or timeout never counts as approved authority. |
| Email send | Explicitly authorized send creates one matching outbox or delivery operation; the summary and recipient are correct. |
| Email skip | Complete POST_PROCESS without invoking the send tool. |
| Failure and duplicate requests | Bound retries, preserve consistent state, and prevent duplicate side effects or false success messages. |
| Recovery and replay | Restore saved state and replay recorded decisions and tool results with the correct versions. |

## Evaluation and observability

Deterministic tests check phase gates, tool permissions, identity matching, memory updates, ownership, consent, concurrency, and idempotency. Seeded event-sequence tests explore alternative ordering and repeated inputs while asserting that the invariants still hold.

Model-backed scenario evaluations measure intent/case resolution, grounded responses, emotional recovery, refusal quality, and unnecessary repeated questions. Hard safety checks determine pass/fail; an optional model judge can assess conversational quality but cannot override a failed gate.

Export results and traces as versioned JSONL. Record the scenario, fixed clock, model and prompt versions, fixture version, tool results, state changes, validation results, and available token usage. Replaying recorded outputs is distinct from rerunning the model, which creates a new evaluation run.

Measure safety violations, supported task resolution, appropriate handoff, grounding failures, unnecessary turns, latency, and model usage. Distinguish workflow failures from infrastructure failures. Completion speed or reduced human handoff must not reward bypassing a gate.

The environment boundary consists of a scenario definition, replaceable tool simulator, and outcome verifier. Keep these usable without the UI so a later adapter can connect them to rollout or training infrastructure. Training a model and deploying GPU inference are outside this demo's scope.

## Delivery sequence

1. Establish the brief, repository, and starter data baseline.
2. Implement shared contracts, fixture validation, policy functions, and core safety tests.
3. Implement the model adapter, harness loop, SQLite persistence, and simulated tools.
4. Build the chat UI, execution inspector, scenario controls, and email follow-up flow.
5. Add model-backed evals, browser checks, Docker packaging, and setup documentation.

The implementation is ready for delivery when the required deterministic checks pass, the baseline and adverse conversations have recorded evaluation results, the Docker application runs with the documented API-token configuration, and the UI demonstrates all four phases plus email send and skip. Every reported capability must have command output, a checked condition, an evaluation trace, or a screenshot as evidence.
