import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AMOUNT_FIELDS } from "../../domain/claims.ts";
import { assertTimestamp } from "../../domain/calendar.ts";
import type { DataFact } from "../../domain/facts.ts";
import { matchIdentity, type Policyholder } from "../../domain/identity.ts";
import type { RepresentativeRelationship } from "../../domain/authorization.ts";
import type { BusinessData, Clock } from "../../application/ports.ts";
import { documentGuidance } from "./documents.ts";
import { FIXTURE_SCHEMAS, FixtureDataError, fact, pointerKey, prepareFixtures } from "./schema.ts";
import type { FixtureFile, FixtureInput, FixtureRecords } from "./schema.ts";

export { FixtureDataError } from "./schema.ts";
export type { FixtureInput } from "./schema.ts";

const DEFAULT_DIRECTORY = fileURLToPath(new URL("../../../fixtures/", import.meta.url));

export interface FixtureOptions {
  readonly clock?: Clock;
}

function policyholder(record: FixtureRecords["policyholders.json"][number]): Policyholder {
  return {
    subjectId: record.party_id,
    fullName: record.name,
    nameAliases: record.name_aliases ?? [],
    policyNumber: record.policy_number,
    dateOfBirth: record.dob,
    identifier: { type: record.id_type, last4: record.id_last4 },
    phone: record.phone,
    phoneAliases: record.phone_aliases ?? [],
    email: record.email,
    emailAliases: record.email_aliases ?? [],
  };
}

/** Atomic validation: invalid structure or references never produce a partial service. */
export function createFixtureData(input: FixtureInput, options: FixtureOptions = {}): BusinessData {
  const { records, holders, policies, cases } = prepareFixtures(input);
  const clock = options.clock ?? { now: Date.now };
  const now = () => {
    const timestamp = clock.now();
    assertTimestamp(timestamp);
    return timestamp;
  };
  const holderFact = (entry: ReturnType<typeof holders.get>) =>
    entry ? fact("policyholders.json", `/${entry.index}`, policyholder(entry.record), now()) : null;
  const ownedCase = (subjectId: string, caseId: string) => {
    const entry = cases.get(caseId);
    return entry?.record.belongsTo(subjectId) ? entry : undefined;
  };

  return {
    async getPolicyholder(subjectId) {
      return holderFact(holders.get(subjectId));
    },
    async findPolicyholderByPolicyNumber(policyNumber) {
      return holderFact(policies.get(policyNumber));
    },
    async findPolicyholderByIdentity(identity) {
      const field = identity.fullName
        ? "fullName"
        : identity.email
          ? "email"
          : identity.phone
            ? "phone"
            : null;
      if (!field) return null;
      const matches = [...holders.values()].filter(
        (entry) =>
          matchIdentity({ [field]: identity[field] }, policyholder(entry.record))[0]?.outcome ===
          "match",
      );
      return matches.length === 1 ? holderFact(matches[0]) : null;
    },
    async getRepresentatives(subjectId) {
      const observedAt = now();
      return records["representatives.json"].flatMap(
        (record, index): DataFact<RepresentativeRelationship>[] => {
          if (record.buyer_party_id !== subjectId) return [];
          return [
            fact(
              "representatives.json",
              `/${index}`,
              {
                subjectId: record.buyer_party_id,
                fullName: record.rep_name,
                relationship: record.relationship,
                policyholderName: record.buyer_name,
              },
              observedAt,
            ),
          ];
        },
      );
    },
    async getConsentScenario(name) {
      const scenarios = records["consent_scenarios.json"];
      const scenario = Object.hasOwn(scenarios, name) ? scenarios[name] : undefined;
      return scenario
        ? fact(
            "consent_scenarios.json",
            `/${pointerKey(name)}`,
            {
              simulation: "mock" as const,
              statusSequence: scenario.status_sequence,
            },
            now(),
          )
        : null;
    },
    async listCases(subjectId) {
      const observedAt = now();
      return [...cases.values()]
        .filter(({ record }) => record.belongsTo(subjectId))
        .map(({ record, index }) =>
          fact("claims.json", `/${index}`, record.factsAt(observedAt), observedAt),
        );
    },
    async getCase(subjectId, caseId) {
      const entry = ownedCase(subjectId, caseId);
      if (!entry) return null;
      const observedAt = now();
      return fact("claims.json", `/${entry.index}`, entry.record.factsAt(observedAt), observedAt);
    },
    async getDocumentGuidance(subjectId, caseId) {
      const entry = ownedCase(subjectId, caseId);
      if (!entry) return null;
      const observedAt = now();
      return documentGuidance(
        records["required_document_guideline.json"],
        entry.record.factsAt(observedAt),
        entry.index,
        observedAt,
      );
    },
    async getAmountDefinition(field) {
      if (!(AMOUNT_FIELDS as readonly string[]).includes(field))
        throw new Error("Unknown amount field");
      const definition = records["claim_schema.json"].field_descriptions[field];
      return fact(
        "claim_schema.json",
        `/field_descriptions/${field}`,
        {
          field,
          currency: "USD" as const,
          example: definition.example,
          description: definition.description,
        },
        now(),
      );
    },
  };
}

export async function loadFixtureData(
  options: FixtureOptions & { readonly directory?: string } = {},
): Promise<BusinessData> {
  const directory = options.directory ?? DEFAULT_DIRECTORY;
  const entries = await Promise.all(
    (Object.keys(FIXTURE_SCHEMAS) as FixtureFile[]).map(async (file) => {
      let text: string;
      try {
        text = await Bun.file(join(directory, file)).text();
      } catch {
        throw new FixtureDataError(file, "", "read_failed");
      }
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new FixtureDataError(file, "", "invalid_json");
      }
      return [file, value] as const;
    }),
  );
  return createFixtureData(Object.fromEntries(entries) as FixtureInput, options);
}
