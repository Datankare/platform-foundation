/**
 * embedding-store-conformance.test.ts — ADR-042 L21: the one no-leak kit, run against
 * every store. Both the in-memory and the durable (Supabase) reference stores earn trust
 * by passing the identical behavioural contract; an adopter store runs the same kit.
 */
import { runEmbeddingStoreContract } from "./contract/embedding-store-contract";
import { InMemoryEmbeddingStore } from "@/platform/rag";
import { SupabaseEmbeddingStore } from "@/platform/rag";
import { makeFakeSupabase } from "./helpers/fake-embedding-supabase";
import type { SupabaseClient } from "@supabase/supabase-js";

runEmbeddingStoreContract({
  name: "InMemoryEmbeddingStore",
  makeStore: () => new InMemoryEmbeddingStore(),
});

runEmbeddingStoreContract({
  name: "SupabaseEmbeddingStore",
  makeStore: () =>
    new SupabaseEmbeddingStore(makeFakeSupabase() as unknown as SupabaseClient),
});
