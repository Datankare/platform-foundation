/**
 * __tests__/effect-ledger-conformance.test.ts
 */

import { runEffectLedgerContract } from "./contract/effect-ledger-contract";
import { InMemoryEffectLedger } from "@/platform/agents/effect-ledger";

describe("InMemoryEffectLedger — conformance", () => {
  runEffectLedgerContract({ makeLedger: () => new InMemoryEffectLedger() });
});
