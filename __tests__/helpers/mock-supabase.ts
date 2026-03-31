/**
 * __tests__/helpers/mock-supabase.ts — Supabase query builder mock
 *
 * Creates a chainable mock that mimics the Supabase PostgREST client.
 * Usage: jest.mock("@/lib/supabase/server", () => mockSupabaseModule(responses));
 *
 * Sprint 7a, Task 7a.2
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MockResponse {
  data?: any;
  error?: { message: string } | null;
  count?: number;
}

/**
 * Create a chainable query builder that resolves to the given response.
 * Supports: .select(), .insert(), .update(), .upsert(), .delete(),
 * .eq(), .in(), .is(), .or(), .order(), .limit(), .range(), .single()
 */
export function createQueryBuilder(
  response: MockResponse = { data: null, error: null }
): any {
  const builder: any = {};

  const chainMethods = [
    "select",
    "insert",
    "update",
    "upsert",
    "delete",
    "eq",
    "in",
    "is",
    "or",
    "order",
    "limit",
    "range",
    "neq",
    "gt",
    "lt",
    "gte",
    "lte",
    "like",
    "ilike",
    "filter",
  ];

  for (const method of chainMethods) {
    builder[method] = jest.fn().mockReturnValue(builder);
  }

  // .single() resolves the query
  builder.single = jest.fn().mockResolvedValue(response);

  // Also make the builder itself thenable (for queries without .single())
  builder.then = (resolve: any) => resolve(response);

  return builder;
}

/**
 * Create a mock Supabase client with per-table response configuration.
 *
 * Usage:
 *   const mockClient = createMockSupabase({
 *     players: { data: [{ id: "p1", role_id: "r1" }], error: null },
 *     roles: { data: [{ id: "r1", name: "admin" }], error: null },
 *   });
 */
export function createMockSupabase(
  tableResponses: Record<string, MockResponse> = {}
): any {
  const fromCalls: { table: string; builder: any }[] = [];

  const client = {
    from: jest.fn((table: string) => {
      const response = tableResponses[table] || { data: null, error: null };
      const builder = createQueryBuilder(response);
      fromCalls.push({ table, builder });
      return builder;
    }),
    _fromCalls: fromCalls,
  };

  return client;
}

/**
 * Create a mock module replacement for @/lib/supabase/server.
 * Pass to jest.mock() factory function.
 *
 * Usage:
 *   jest.mock("@/lib/supabase/server", () =>
 *     mockSupabaseModule({ players: { data: [...], error: null } })
 *   );
 */
export function mockSupabaseModule(tableResponses: Record<string, MockResponse> = {}) {
  const client = createMockSupabase(tableResponses);
  return {
    getSupabaseServiceClient: jest.fn(() => client),
    _mockClient: client,
  };
}

/**
 * Create a sequential response mock — returns different data on each call.
 * Useful for testing modules that query the same table multiple times.
 */
export function createSequentialMockSupabase(
  callSequence: { table: string; response: MockResponse }[]
) {
  let callIndex = 0;
  const fromCalls: { table: string; builder: any }[] = [];

  const client = {
    from: jest.fn((table: string) => {
      const entry = callSequence[callIndex] || {
        table,
        response: { data: null, error: null },
      };
      callIndex++;
      const builder = createQueryBuilder(entry.response);
      fromCalls.push({ table, builder });
      return builder;
    }),
    _fromCalls: fromCalls,
    _resetCallIndex: () => {
      callIndex = 0;
    },
  };

  return client;
}
