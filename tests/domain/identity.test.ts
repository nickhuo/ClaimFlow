import { expect, test } from "bun:test";
import { matchIdentity, normalizeIdentity, type Policyholder } from "../../src/domain/identity.ts";

const holder: Policyholder = {
  subjectId: "P9",
  fullName: "Margaret Chen",
  nameAliases: [],
  policyNumber: "POL-9921",
  dateOfBirth: "1985-03-15",
  identifier: { type: "ssn_last4", last4: "4472" },
  phone: "+16505212836",
  phoneAliases: [],
  email: "margaret@email.com",
  emailAliases: [],
};

test.each([
  "1985-03-15",
  "1985/3/15",
  "March 15, 1985",
  "Mar. 15,1985",
  "15 March 1985",
  "March 15th, 1985",
  "15th of March 1985",
  "03/15/1985",
  "15/03/1985",
])("the same birthday matches across unambiguous formats: %s", (value) => {
  expect(normalizeIdentity("dateOfBirth", value)).toBe("1985-03-15");
  expect(matchIdentity({ dateOfBirth: value }, holder)[0]?.outcome).toBe("match");
});

test("ambiguous dates cannot match either interpretation, even when one is the reference", () => {
  for (const dateOfBirth of ["1985-03-04", "1985-04-03"])
    expect(
      matchIdentity({ dateOfBirth: "03/04/1985" }, { ...holder, dateOfBirth })[0]?.outcome,
    ).toBe("mismatch");
});

test("calendar validation rejects rollover, incomplete dates, and invalid reference dates", () => {
  for (const value of [
    "February 29, 1985",
    "February 30, 1984",
    "1985-13-15",
    "March 1985",
    "03/15/85",
  ])
    expect(
      matchIdentity({ dateOfBirth: value }, { ...holder, dateOfBirth: value })[0]?.outcome,
    ).toBe("mismatch");
  expect(normalizeIdentity("dateOfBirth", "February 29, 1984")).toBe("1984-02-29");
  expect(normalizeIdentity("dateOfBirth", "03/03/1985")).toBe("1985-03-03");
});
