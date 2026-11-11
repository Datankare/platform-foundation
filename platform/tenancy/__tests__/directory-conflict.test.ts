/**
 * @jest-environment node
 */
/**
 * A directory conflict is recognised across module copies (TASK-206).
 *
 * The admin console walk found an address already mapped answering 500 instead of
 * tenant.conflict: in a production build the directory boot installs (instrumentation's bundle)
 * and the route that catches its error load platform/tenancy/directory.ts separately, so
 * `instanceof TenantDirectoryConflictError` was false. A second module instance stands for the
 * other bundle here.
 */
import {
  InMemoryTenantDirectory,
  TenantDirectoryConflictError,
  isTenantDirectoryConflict,
} from "@/platform/tenancy/directory";

function otherBundle(): typeof import("@/platform/tenancy/directory") {
  let mod: typeof import("@/platform/tenancy/directory") | undefined;
  jest.isolateModules(() => {
    mod = jest.requireActual<typeof import("@/platform/tenancy/directory")>(
      "@/platform/tenancy/directory"
    );
  });
  return mod!;
}

describe("a directory conflict from another copy of the module (TASK-206)", () => {
  it("is a conflict by its name and code, though not an instance of this copy's class", async () => {
    const other = otherBundle();
    const directory = new other.InMemoryTenantDirectory();
    const err = await directory
      .addDomain("00000000-0000-4000-8000-000000000001", "localhost")
      .catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(TenantDirectoryConflictError);
    expect(isTenantDirectoryConflict(err)).toBe(true);
    expect((err as { code: string }).code).toBe("tenant.domain_taken");
  });

  it("[self-test] anything else is not one: a plain error, a stranger's code, null", async () => {
    const mine = await new InMemoryTenantDirectory()
      .addDomain("00000000-0000-4000-8000-000000000001", "localhost")
      .catch((e: unknown) => e);
    expect(isTenantDirectoryConflict(mine)).toBe(true);
    expect(isTenantDirectoryConflict(new Error("Host is mapped"))).toBe(false);
    expect(
      isTenantDirectoryConflict(
        Object.assign(new Error("x"), {
          name: "TenantDirectoryConflictError",
          code: "other",
        })
      )
    ).toBe(false);
    expect(isTenantDirectoryConflict(null)).toBe(false);
  });
});
