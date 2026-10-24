/**
 * @jest-environment node
 */
/**
 * platform/auth/__tests__/aws-sigv4.test.ts — the signature matches AWS's own signer
 *
 * The expected signatures were produced by botocore's SigV4Auth (1.43) for the same request,
 * credentials and time — an independent implementation, so a mistake here cannot agree with
 * itself.
 */

import { amzDate, signAwsJsonPost } from "../aws-sigv4";

const body =
  '{"UserPoolId":"us-east-1_AbC123","Username":"u","UserAttributes":[{"Name":"custom:tenant_id","Value":"t"}]}';
const base = {
  service: "cognito-idp",
  region: "us-east-1",
  host: "cognito-idp.us-east-1.amazonaws.com",
  headers: {
    "Content-Type": "application/x-amz-json-1.1",
    "X-Amz-Target": "AWSCognitoIdentityProviderService.AdminUpdateUserAttributes",
  },
  body,
  now: new Date(Date.UTC(2026, 9, 23, 12, 34, 56)),
};
const keys = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("signAwsJsonPost", () => {
  it("matches botocore without a session token", async () => {
    const h = await signAwsJsonPost({ ...base, credentials: keys });
    expect(h["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261023/us-east-1/cognito-idp/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date;x-amz-target, " +
        "Signature=97b9a66d49733842373d1d2da221cf73effafc09cc7b14e45993c6da36d32464"
    );
    expect(h["x-amz-date"]).toBe("20261023T123456Z");
    expect(h["host"]).toBeUndefined();
    expect(h["x-amz-security-token"]).toBeUndefined();
  });

  it("matches botocore with a session token, which it signs and sends", async () => {
    const h = await signAwsJsonPost({
      ...base,
      credentials: { ...keys, sessionToken: "SESSIONTOKEN" },
    });
    expect(h["authorization"]).toContain(
      "SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target"
    );
    expect(h["authorization"]).toContain(
      "Signature=637480bccdd4f35f7e10e450f8bd4ec835d3515099a7145ab6cb2ccd3b4ec799"
    );
    expect(h["x-amz-security-token"]).toBe("SESSIONTOKEN");
  });

  it("changes with the body (the payload hash is signed)", async () => {
    const a = await signAwsJsonPost({ ...base, credentials: keys });
    const b = await signAwsJsonPost({ ...base, body: body + " ", credentials: keys });
    expect(a["authorization"]).not.toBe(b["authorization"]);
  });

  it("never puts the secret key in a header", async () => {
    const h = await signAwsJsonPost({ ...base, credentials: keys });
    expect(JSON.stringify(h)).not.toContain(keys.secretAccessKey);
  });

  it("formats the amz date in UTC", () => {
    expect(amzDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toEqual({
      amzDate: "20260102T030405Z",
      dateStamp: "20260102",
    });
  });
});
