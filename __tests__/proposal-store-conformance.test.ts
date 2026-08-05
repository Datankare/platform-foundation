/**
 * __tests__/proposal-store-conformance.test.ts
 */

import { runProposalStoreContract } from "./contract/proposal-store-contract";
import { InMemoryProposalStore } from "@/platform/agents/proposal-store";

describe("InMemoryProposalStore — conformance", () => {
  runProposalStoreContract({ makeStore: () => new InMemoryProposalStore() });
});
