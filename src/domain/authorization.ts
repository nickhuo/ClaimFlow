/** A relationship alone supplies neither identity evidence nor an authorization grant. */
export interface RepresentativeRelationship {
  readonly subjectId: string;
  readonly fullName: string;
  readonly relationship: string;
  readonly policyholderName: string;
}

export type RepresentativeAuthorization =
  | { readonly status: "not_required" }
  | { readonly status: "pending"; readonly requestedAt: number }
  | { readonly status: "denied" | "expired" }
  | {
      readonly status: "approved";
      readonly subjectId: string;
      readonly representativeId: string;
      readonly grantId: string;
      readonly scope: "claims:read";
      readonly expiresAt: number;
      readonly source: "mock" | "external";
    };
