export const publicContractMapping = {
  verifyContracts: {
    relationship:
      "external public contracts are the source of truth for wire-level semantics",
    example: [
      "verification-result",
      "sandbox-job-request",
      "sandbox-job-result",
    ],
  },
  internalDomain: {
    relationship:
      "internal semantic model may evolve independently from public contracts",
    note: "Mappings must be explicit and version-aware.",
  },
} as const;

export type ContractMapping = typeof publicContractMapping;
