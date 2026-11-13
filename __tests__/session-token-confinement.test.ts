/**
 * __tests__/session-token-confinement.test.ts — a session's provider tokens are stored, opened and
 * handed out by one module (ADR-057 D2, D7; docs/SECURITY_DEBT.md SEC-018)
 *
 * @guard a file outside the allowed few that imports the session vault, reads its key, reads a session's token, or asks for the enrolment token
 *
 * The server keeps a Cognito access token that carries the `aws.cognito.signin.user.admin` scope
 * (SEC-018). What limits it is that the token is encrypted at rest and used for one call. That
 * holds only while every use goes through platform/auth/session-vault.ts by a named purpose, so
 * each place a token can leave the vault is listed here, with why — and a new one fails:
 *
 *   the vault            imported only by the session modules (and the store, for a type);
 *   the key              read only by the vault (the environment contract declares it);
 *   identityToken        a live session's token for verifying who it is: read only by the guard
 *                        (verifyToken, which with the administrative key does not send it to the
 *                        provider) and the guest route's standing check;
 *   totpEnrolmentToken   the one use Cognito offers no administrative form for: called only by
 *                        the MFA routes;
 *   openForProvider      called only by the session modules, and only with a literal purpose.
 *
 * Parsed (TypeScript's parser): a name in a comment or a string is not a use. Shared by both
 * repositories; an app adds no reader.
 */
import * as ts from "typescript";
import { productionSources, read } from "./helpers/route-policy";

const VAULT = "platform/auth/session-vault.ts";

/** Who may import the vault, and what for. */
export const VAULT_IMPORTERS: Readonly<Record<string, string>> = {
  "platform/auth/session.ts":
    "seals at sign-in, opens to verify and renew, hands out the enrolment token",
  "platform/auth/session-revocation.ts":
    "opens the refresh token to revoke it at the provider",
  "platform/auth/session-store.ts": "the SealedTokens type only (import type)",
};
/** Who may read the key's settings. */
export const KEY_READERS: Readonly<Record<string, string>> = {
  [VAULT]: "derives the sealing key",
  "platform/providers/environment-contract.ts":
    "declares the settings and checks them at boot",
};
/** Who may read a live session's identity token. */
export const IDENTITY_TOKEN_READERS: Readonly<Record<string, string>> = {
  "platform/auth/session.ts": "builds the live session",
  "platform/auth/middleware.ts":
    "verifies the session's user (verifyToken / verifyGuestToken)",
  "app/api/auth/guest/route.ts":
    "reads a signed-in caller's standing before a guest session starts",
};
/** Who may ask for the enrolment token. */
export const ENROLMENT_TOKEN_CALLERS: Readonly<Record<string, string>> = {
  "platform/auth/session.ts": "defines it",
  "platform/auth/mfa-routes.ts":
    "AssociateSoftwareToken / VerifySoftwareToken take the user's token",
};
const PURPOSES = new Set(["identity", "renewal", "revocation", "totp_enrolment"]);

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** Whether an identifier names the thing (a use, a call, an import) rather than declaring a like-named property type. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertySignature(p) || ts.isMethodSignature(p)) return false;
  return true;
}

/** What `file` does that only a listed file may do. */
export function findingsIn(file: string, text: string): Finding[] {
  const sf = parse(file, text);
  const out: Finding[] = [];
  const at = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier &&
      ts.isStringLiteralLike(n.moduleSpecifier) &&
      /(?:^|\/)session-vault$/.test(n.moduleSpecifier.text) &&
      file !== VAULT &&
      !(file in VAULT_IMPORTERS)
    ) {
      out.push({ file, line: at(n), what: "imports the session vault" });
    }
    if (
      ts.isCallExpression(n) &&
      ts.isStringLiteralLike(n.arguments[0] ?? n) &&
      (n.expression.getText(sf) === "require" ||
        n.expression.kind === ts.SyntaxKind.ImportKeyword) &&
      /(?:^|\/)session-vault$/.test((n.arguments[0] as ts.StringLiteralLike).text) &&
      file !== VAULT &&
      !(file in VAULT_IMPORTERS)
    ) {
      out.push({ file, line: at(n), what: "imports the session vault" });
    }
    if (ts.isIdentifier(n) && isReference(n)) {
      if (
        (n.text === "getSessionEncryptionKey" ||
          n.text === "getPreviousSessionEncryptionKey") &&
        !(file in KEY_READERS)
      ) {
        out.push({
          file,
          line: at(n),
          what: `reads the session-encryption key (${n.text})`,
        });
      }
      if (n.text === "identityToken" && !(file in IDENTITY_TOKEN_READERS)) {
        out.push({ file, line: at(n), what: "reads a session's identity token" });
      }
      if (n.text === "totpEnrolmentToken" && !(file in ENROLMENT_TOKEN_CALLERS)) {
        out.push({ file, line: at(n), what: "asks for the enrolment token" });
      }
    }
    if (
      ts.isStringLiteralLike(n) &&
      /^SESSION_ENCRYPTION_KEY(?:_PREVIOUS)?$/.test(n.text)
    ) {
      if (!(file in KEY_READERS)) {
        out.push({ file, line: at(n), what: "names the session-encryption key setting" });
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "openForProvider"
    ) {
      const purpose = n.arguments[2];
      if (!purpose || !ts.isStringLiteral(purpose) || !PURPOSES.has(purpose.text)) {
        out.push({
          file,
          line: at(n),
          what: "opens a token without a literal, known purpose",
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Files that only name the setting to describe or document it to an operator — not to read it. */
const SETTING_NAMERS = new Set<string>([]);

describe("a session's provider tokens stay behind the vault (ADR-057 D2, D7; SEC-018)", () => {
  const sources = productionSources().filter((f) => /\.tsx?$/.test(f));

  it("scans the production sources, the vault and its users among them", () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const f of [
      VAULT,
      ...Object.keys(VAULT_IMPORTERS),
      ...Object.keys(IDENTITY_TOKEN_READERS),
      ...Object.keys(ENROLMENT_TOKEN_CALLERS),
    ]) {
      expect(sources).toContain(f);
    }
  });

  it("no file outside the listed ones reaches a token or the key", () => {
    const found = sources
      .filter((f) => !SETTING_NAMERS.has(f))
      .flatMap((f) => findingsIn(f, read(f)));
    expect(found).toEqual([]);
  });

  it("the enrolment token is asked for in exactly one place, and the vault opens one for exactly one purpose there", () => {
    const calls = (file: string, name: string) => {
      const sf = parse(file, read(file));
      let n = 0;
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === name
        )
          n++;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return n;
    };
    expect(calls("platform/auth/mfa-routes.ts", "totpEnrolmentToken")).toBe(1);
    const purposes = (file: string) =>
      [...read(file).matchAll(/openForProvider\([^)]*?"([a-z_]+)"\s*\)/g)]
        .map((m) => m[1])
        .sort();
    expect(purposes("platform/auth/session.ts")).toEqual(["renewal", "totp_enrolment"]);
    expect(purposes("platform/auth/session-revocation.ts")).toEqual(["revocation"]);
  });

  it("only the vault decrypts", () => {
    const users = sources.filter((f) => /\bcreateDecipheriv\b/.test(read(f)));
    // The vault, and whatever else decrypted before this task — none of which may hold a session.
    expect(users).toContain(VAULT);
    for (const f of users.filter((u) => u !== VAULT)) {
      expect({
        file: f,
        sessions: /sealed_?[Tt]okens|auth_sessions/.test(read(f)),
      }).toEqual({
        file: f,
        sessions: false,
      });
    }
  });

  describe("the scan itself", () => {
    const whats = (file: string, text: string) =>
      findingsIn(file, text).map((f) => f.what);

    it("[self-test] sees a new importer of the vault — static, re-exported, required or dynamic", () => {
      for (const text of [
        'import { openForProvider } from "@/platform/auth/session-vault";',
        'export { openIdentity } from "./session-vault";',
        'const v = require("@/platform/auth/session-vault");',
        'const v = await import("@/platform/auth/session-vault");',
      ]) {
        expect(whats("app/api/thing/route.ts", text)).toContain(
          "imports the session vault"
        );
      }
      expect(
        whats(
          "platform/auth/session.ts",
          'import { sealTokens } from "@/platform/auth/session-vault";'
        )
      ).toEqual([]);
    });

    it("[self-test] sees a new reader of the key, by getter or by the setting's name", () => {
      expect(whats("lib/thing.ts", "const k = getSessionEncryptionKey();")).toContain(
        "reads the session-encryption key (getSessionEncryptionKey)"
      );
      expect(
        whats("lib/thing.ts", 'const k = process.env["SESSION_ENCRYPTION_KEY"];')
      ).toContain("names the session-encryption key setting");
      expect(
        whats("lib/thing.ts", "// SESSION_ENCRYPTION_KEY is the vault's\nconst a = 1;")
      ).toEqual([]);
    });

    it("[self-test] sees a route that reads a session's token or asks for the enrolment token", () => {
      expect(
        whats("app/api/thing/route.ts", "const t = auth.session.identityToken;")
      ).toContain("reads a session's identity token");
      expect(
        whats("app/api/thing/route.ts", "const t = totpEnrolmentToken(auth.session);")
      ).toContain("asks for the enrolment token");
      // A type that merely has a like-named member is not a read.
      expect(whats("lib/types.ts", "interface X { identityToken: string }")).toEqual([]);
    });

    it("[self-test] sees a token opened for a purpose that is not a literal, or not a known one", () => {
      expect(
        whats("platform/auth/session.ts", "openForProvider(sealed, idHash, purpose);")
      ).toContain("opens a token without a literal, known purpose");
      expect(
        whats("platform/auth/session.ts", 'openForProvider(sealed, idHash, "anything");')
      ).toContain("opens a token without a literal, known purpose");
      expect(
        whats("platform/auth/session.ts", 'openForProvider(sealed, idHash, "renewal");')
      ).toEqual([]);
    });
  });
});
