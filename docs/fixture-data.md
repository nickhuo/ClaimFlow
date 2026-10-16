# Fixture data contract

OPC-157 implements `BusinessData` in `src/application/ports.ts` through
`src/adapters/fixtures/index.ts`. The interface is re-exported from
`src/application/tool-contracts.ts`. It can be replaced without changing the Pi harness.

```ts
import { loadFixtureData } from "../src/adapters/fixtures/index.ts";

const data = await loadFixtureData({
  clock: { now: () => Date.parse("2026-10-15T12:00:00.000Z") },
});
// The subject must come from trusted server session state after authorization.
const claim = await data.getCase("P9", "CL-2048");
// claim.value.appealDeadline === "2026-03-18"
// claim.value.appealDeadlineStatus === "past"
// claim.sources === [{ adapter: "fixtures", resource: "claims.json", pointer: "/0" }]
```

`loadFixtureData()` reads all six files with Bun. The default directory is resolved
relative to the adapter, independent of the process working directory. Hosts can
pass `directory`; tests can pass unknown in-memory samples to `createFixtureData`.
Loading is atomic: invalid data never creates a partial service. Reads use a
validated snapshot and return detached copies.

Inside the adapter, `src/adapters/fixtures/schema.ts` owns the complete
`prepareFixtures` step: snapshot, structure, uniqueness, references and indexes,
plus construction of domain `Case` models. The domain validates case dates, timeline
and amounts; the codec translates a domain failure into a safe fixture location.
The query implementation consumes that result; callers continue using
`createFixtureData` / `loadFixtureData`. Existing behavior tests cross that same
interface.

## Data and trust

- `getCase(subjectId, caseId)`, `listCases(subjectId)` and
  `getDocumentGuidance(subjectId, caseId)` return only that subject's cases. Missing
  records and ownership mismatches both return `null`; lists can be empty. There
  is no all-subject query or dataset property.
- `DataFact<T>` carries `value`, `observedAt` and `sources` with resource names and
  JSON Pointers. `ToolFact<T>` adds the tool name and operation ID when a guarded
  business tool uses the data. Reference PII is not a model tool result.
- `getPolicyholder` and `findPolicyholderByPolicyNumber` are server-only reference
  lookups returning domain `Policyholder` reference data. They preserve aliases, DOB, contact details and the explicit identifier
  type. A national ID last four is never relabeled as SSN. Normalization, matching
  and safe identity evidence are OPC-159.
- `getRepresentatives` returns domain `RepresentativeRelationship` records only. `getConsentScenario`
  returns the named sequence marked `simulation: "mock"`, not a permission grant.
  No default scenario is selected for an unknown name.
- This data port checks ownership against the supplied subject; the business
  tools must still obtain that subject from the server and enforce phase,
  identity and authorization. It is not exposed directly as a Pi tool or API.

## Missing values, amounts and dates

Required fields, types, duplicate subject/policy/case IDs, unresolved subject
references and inconsistent representative names are rejected. Dates must be
real calendar dates; an appeal deadline before case creation is rejected.
`FixtureDataError` reports a resource, JSON Pointer and code, without rejected
values, PII, filesystem paths or raw parser errors.

Optional absent/null denial reasons and appeal dates remain `null`. Missing/null
document requirements remain `null`; an explicit empty list remains `[]`.
Missing amounts are omitted rather than filled with zero or schema examples.
Amounts must be decimal strings with two fractional digits and are copied
without numeric conversion, rounding or formatting. Amount definitions expose
the descriptions and examples from `claim_schema.json` separately from case data.

Fixture dates retain their original strings. `appealDeadlineStatus` is computed
at each read using the injected clock and UTC calendar days: `past`, `today`,
`future` or `not_provided`. A date without a time has no inferred local cutoff.
The adapter's default clock is `Date.now`; domain `Case.factsAt(now)` receives the
time explicitly. No fixture date is moved relative to the clock.

## Documents and follow-up

| Requested material | Guideline key | Original requirement |
| --- | --- | --- |
| pathology report | original pathology report | not specified |
| original pathology report | original pathology report | required |
| office note | treating provider office note | not specified |
| treating provider office note | treating provider office note | not specified |
| supplemental accident scene photos | supplemental accident scene photos | not specified |
| repair estimate | repair estimate | not specified |

The domain owns material categories (`pathology_report`, `office_note`,
`accident_scene_photos`, `repair_estimate`), name equivalence and original requirements.
The adapter translates the fixture's guide keys into those categories and supplies
their source references. Domain behavior is also tested with a catalog unrelated to fixtures.

Mapping is exact and explicit, with no fuzzy clinical substitution. The requested
name is preserved. An explicit `original ` prefix in an unknown requested label
also stays required. `diagnosis report` has no dedicated guide: it returns
`mapping: "unmapped"`, no specific guidance, and a labeled general alternative.
A known category whose guide is absent returns `mapping: "unavailable"` and no guide reference.
General alternatives never count as approval that a substitute will be accepted.

General, case-type, document, alternative and follow-up guidance retain their
own source pointers. Follow-up templates remain unrendered; processing time is
labeled as an estimate. The fixture's `submission_timing` rule says "within a
week" without an anchor. Its template is withheld and its limitation is
`unanchored_relative_deadline`, so it cannot create a new future deadline or
override an expired appeal date. Answer selection, rendering and permission
checks belong to OPC-161.

`bun run check` covers real fixtures, minimal/invalid samples, ownership,
provenance, mappings, input/output isolation and UTC clock boundaries.
