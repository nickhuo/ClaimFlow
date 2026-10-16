# ClaimFlow

Insurance claims support built with Bun, TypeScript, Pi SDK, React and Radix Themes. The domain controls the four-stage SOP, identity, authorization, case ownership and email consent. Pi owns the model/tool loop. The UI receives only approved business responses.

## Run locally

Requires **Bun 1.2.18+**. Pi SDK and Pi AI are pinned to **1.3.0**; install the checked-in lockfile.

```sh
bun install --frozen-lockfile
bun run dev:demo
```

Open **http://127.0.0.1:3000**. Demo mode runs a deterministic provider inside the actual Pi SDK; it makes no model API calls. The sample button fills the composer so you can inspect the demo identity before sending it.

For the selected testing model, **OpenAI `gpt-6-luna`**, copy `.env.example` to `.env` if you do not already have one, fill `MODEL_API_KEY` locally, and run:

```sh
bun run dev
```

Bun loads `.env`; it is ignored by Git and excluded from the Docker build. The server never uses ambient Pi login, global model settings or an `OPENAI_API_KEY` fallback. `MODEL_PROVIDER`, `MODEL_ID` and `MODEL_API_KEY` are explicit requirements in live mode. Keys stay server-side.

Models marked as reasoning-capable in the pinned catalog, including Luna, use Pi's `low` thinking level for reliable scope and refusal classification. Other models use `off`. Evaluation reports record this choice alongside token usage and latency.

| Setting | Purpose |
| --- | --- |
| `AGENT_MODE=live` / `demo` | Real model requests / explicitly scripted offline provider |
| `MODEL_PROVIDER=openai` | OpenAI Responses API; also supports `anthropic` and `openai-compatible` |
| `MODEL_ID=gpt-6-luna` | Selected testing model, present in the pinned Pi catalog |
| `MODEL_API_KEY` | Required server credential in live mode |
| `MODEL_BASE_URL` | Optional native-provider endpoint override; required for `openai-compatible` |
| `HOST`, `PORT` | Default `127.0.0.1:3000`; containers bind `0.0.0.0` |
| `SESSION_DB_PATH` | Private SQLite state and delivery ledger; default `.data/sessions.sqlite` |
| `EMAIL_MODE=mock` / `webhook` | Durable demo outbox / configured email gateway |
| `EMAIL_MOCK_FAILURES=0` | Fail the first N attempts for each logical mock delivery |
| `AUTHORIZATION_SCENARIO=default` / `timeout` | Explicit mock authorization sequence |

Policy limits are documented in [.env.example](.env.example) and [SOP rules](docs/sop-rules.md). Three distinct identity matches are mandatory and cannot be lowered through configuration.

## Verify

```sh
bun run check            # Typecheck + domain, application, API, SQLite and real-Pi regressions
bun run smoke            # Small offline Pi contract smoke
bun run eval             # Thirteen deterministic behavioral scenarios, same Pi harness
bun run build            # React/CSS browser bundles
bun run browser:install  # One-time Chromium installation
bun run test:browser     # Desktop + mobile workflows; starts its own demo server on port 3317
bun run eval:live        # Explicit real-model calls using .env; requires the selected model key
```

`bun run eval` writes `artifacts/eval-deterministic.json`; `bun run eval:live` writes `artifacts/eval-live.json`. Reports record provider/model, Bun/SDK versions, phase trajectories, business checks and event/tool names. They omit prompts, raw PII, credentials, model prose and tool results. A missing credential is an error, never a fake live pass. Evaluation uses an injected clock so the fixture's appeal date is reproducible.

If browser download is unavailable, `BROWSER_EXECUTABLE=/absolute/path/to/chromium bun run test:browser` uses an existing Chromium installation. `BROWSER_CHANNEL=chrome` uses installed Chrome. Normal test runs never depend on these machine-specific paths. Browser artifacts go to ignored `artifacts/` and `test-results/`.

The [validation record](docs/validation.md) describes executed checks and any pending live-model acceptance.

## Container

```sh
docker build -t claims-support:local .
docker run --rm --name claims-support -p 127.0.0.1:3000:3000 \
  -e AGENT_MODE=demo -v claims-data:/app/.data claims-support:local
```

For live mode, pass the local environment at runtime. Override `HOST` because the local example intentionally binds loopback:

```sh
docker run --rm --name claims-support -p 127.0.0.1:3000:3000 \
  --env-file .env -e AGENT_MODE=live -e HOST=0.0.0.0 \
  -e SESSION_DB_PATH=/app/.data/sessions.sqlite \
  -v claims-data:/app/.data claims-support:local
bun run smoke:http
```

`SMOKE_BASE_URL=http://127.0.0.1:3000` changes the smoke target. It runs identity → case answer → summary → skip through HTTP/SSE. `/health` checks the running service; it does not call the model. `docker stop claims-support` sends SIGTERM, aborts and settles active Pi work, then closes SQLite. The image uses the non-root `bun` user, builds the UI and runs unit/integration checks during its build. An allowlist excludes local secrets, databases, Git metadata, agent setup and research docs from its build context. No Pi CLI or interactive login is needed.

Run **one application process per SQLite file**. Startup revokes earlier business sessions because their in-memory Pi conversations cannot be restored. Outstanding delivery receipts become `unknown`, and are never blindly resent. The ledger stays on the volume for operator reconciliation. This demo does not provide cross-process locking or an operator reconciliation console. Delete demo volumes when their data is no longer needed.

## Demonstration

1. Choose **Try a sample conversation**, then send. Three actual distinct identity matches locate Margaret's denied January healthcare claim. The answer cites requested materials and the original, now-past appeal deadline.
2. Ask **What is the reimbursement amount?** or **What documents do I need?** Follow-ups remain in case processing.
3. Choose **Finish & review summary**. Choose **Save to demo outbox** or **Skip email**. Outbox status explicitly says that no real email was sent.
4. Choose **Ask another question**. The old summary consent is invalidated; a new summary needs a new choice.
5. Start a new conversation. Try a wrong date with other identity details, then correct it; mismatches do not reveal the right answer. Repeating the same field never counts twice.
6. Try **This is ridiculous. Why was my claim denied?** for empathy with identity gates intact. Ask **What is RL?** three times to reach a simulated handoff, or choose **Request human assistance** directly.

The supplied David Chen relationship has no independent reference identity record. It therefore cannot demonstrate successful representative access. The representative pending/approved/timeout regressions use a separate explicit test identity; the original fixtures are unchanged.

## Email and simulated services

Authorization is simulated. Human handoff records a request; no agent is connected. `EMAIL_MODE=mock` stores a summary in the session outbox and sends no email. Delivery success in webhook mode means provider acceptance, not recipient receipt.

`EMAIL_MODE=webhook` requires `EMAIL_WEBHOOK_URL` and `EMAIL_WEBHOOK_TOKEN`. The configured gateway must implement:

- `POST {base}/deliveries`, bearer authentication, `Idempotency-Key: <delivery-id>`, JSON `{ id, to, subject, text }`.
- `GET {base}/deliveries/{delivery-id}`, returning the status of that same logical request.
- A successful JSON response `{ "status": "submitted" }` or `{ "status": "failed" }`. A definite failure means it is safe to retry the same ID. Timeouts, malformed responses and ambiguous HTTP failures remain `unknown`.

Fresh sends and retries after definite failure need explicit consent in that caller turn. Unknown/pending receipts are checked without sending again. Cancellation does not imply that delivery was prevented. Changing the recipient or summary requires new consent.

## Domain-first architecture

Start business changes with [GLOSSARY.md](GLOSSARY.md), concrete scenarios and domain invariants. Implement domain behavior first, then application use cases and adapters. [ADR-0001](docs/adr/0001-domain-first.md) records dependency direction; [ADR-0002](docs/adr/0002-session-authority-and-delivery.md) records authority and lifecycle decisions. `tests/architecture.test.ts` enforces domain/application boundaries.

```text
src/
  domain/          Pure identity, authorization, case, document and conversation rules
  application/     Business operations, guarded tool contracts, replies and session orchestration
  adapters/
    fixtures/      Validated source data with provenance and subject-scoped queries
    sqlite/        Session authority, optimistic versions, request and delivery ledgers
    pi/            Explicit Pi session, model configuration, guards and context projection
    authorization/ Explicit mock grants
    email/         Mock and HTTP gateway adapters
    http/          Session credential checks, strict request schemas, safe SSE
  ui/              React + Radix Themes, TanStack Query, Lucide, eventsource-parser
  server.ts        Composition and lifecycle
scripts/           Build and smoke entrypoints
tests/             Domain, integration and browser regressions
evals/             Deterministic and live-model behavioral evaluation
fixtures/          Six supplied data files, unchanged
```

Pi runs one isolated in-memory conversation per customer; SQLite is the sole business authority. Every model request receives a fresh authorized memory projection. Coding tools, automatic filesystem resources, global skills, credentials, compaction and production SDK auto-retry are disabled. Only canonical business tools can run; SDK interception and each execute path recheck current authority. Requests serialize within a customer session; different sessions run independently. Limits are 12 model requests, 24 tool calls, 8 phase changes and 60 seconds per turn.

SSE carries only `waiting`, `progress`, `result` and safe `error` events. The host renders replies from verified records, so raw model text, thinking and internal tool results never stream to the UI. HTTP clients provide only user text/actions and a request ID, never phase or verification. Lost transports retry the same request ID; reset revokes the old credential. Browser storage contains only the session credential; transcripts and identity inputs are not persisted there.

Radix Themes supplies styled controls and accessible dialog/focus behavior. TanStack Query manages requests without automatically retrying mutations; the SSE parser handles stream framing. UI polish follows `emil-design-eng`: instant chat updates and keyboard actions, restrained press feedback, reduced-motion support and touch-safe hover behavior.

The final brief acceptance map and public Goaly research alignment are in [validation.md](docs/validation.md) and [goaly-alignment.md](docs/goaly-alignment.md). Reproduce one evaluation with `bun run eval --scenario single-turn-and-send`; repeat the fixed suite with `bun run eval --repeat 3`. Reports separate safety, task and runtime failures and include version hashes, latency, model/tool calls, token usage and available SDK catalog cost estimates. Missing prices remain null.
