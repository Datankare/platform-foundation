/**
 * __tests__/rv11-valkey.test.ts — VALKEY_URL, every form the reviewer tried (review 11 L-6)
 *
 * The reviewer's table (review11/__tests__/rv11-valkey.test.ts printed what each URL became): a
 * malformed percent-escape threw a bare URIError, and a user without a password was passed on.
 * Each is now refused with the coded error (ValkeyUrlError, config.valkey_url_invalid), as the
 * environment contract refuses it at boot; every other form keeps its review 10 meaning.
 */

import { valkeyConnectionOptions } from "@/platform/cache/valkey-cache";
import { ValkeyUrlError } from "@/platform/cache/valkey-url";

const opts = (url: string) =>
  valkeyConnectionOptions({ url, allowPlaintext: false }).options as Record<
    string,
    unknown
  >;

const refusal = (url: string): ValkeyUrlError => {
  try {
    opts(url);
  } catch (err) {
    return err as ValkeyUrlError;
  }
  throw new Error(`${url} was accepted`);
};

describe("rv11 L-6: VALKEY_URL", () => {
  it.each([
    ["rediss://[::1]:6380/2", { host: "::1", port: 6380, db: 2 }],
    ["rediss://:p%40ss%3F%23@h", { host: "h", port: 6379, password: "p@ss?#", db: 0 }],
    ["rediss://u:p@h/", { host: "h", username: "u", password: "p", db: 0 }],
    ["rediss://h:6380/00", { host: "h", port: 6380, db: 0 }],
    ["REDISS://H", { host: "H", db: 0 }],
  ])("%s is used as %j, over verify-full TLS", (url, expected) => {
    const o = opts(url);
    expect(o).toMatchObject(expected);
    expect((o.tls as { servername: string }).servername).toBe(o.host);
  });

  it.each([
    ["rediss://u:p%zz@h", /malformed percent-escape in its password/],
    ["rediss://%E0%A4%A@h", /malformed percent-escape in its user name/],
    ["rediss://user@h:6380", /names a user without a password/],
    ["rediss://h/%30", /path must be a database number/],
    ["rediss://h:6380/1/", /path must be a database number/],
    ["rediss://h#x", /query string or fragment/],
    ["rediss://u:p#w@h", /query string or fragment/],
    ["rediss://h?", /query string or fragment/],
    ["rediss://h/1%3Ftls=false", /path must be a database number/],
    ["rediss://h:99999", /is not a URL/],
    ["redis://h", /must use rediss:\/\//],
    ["https://h", /must start with rediss:\/\//],
  ])("%s is refused with the coded error", (url, message) => {
    const err = refusal(url);
    expect(err).toBeInstanceOf(ValkeyUrlError);
    expect(err.code).toBe("config.valkey_url_invalid");
    expect(err.message).toMatch(message);
    // Never the secret.
    expect(err.message).not.toMatch(/p%zz|:p@/);
  });
});
