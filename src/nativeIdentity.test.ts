import { createPublicKey, verify } from "node:crypto";
import { expect, test } from "vitest";

import { createNativeEnrollment, nativeAgentToken } from "./nativeIdentity.js";

test("enrollment proves possession and token binds the agent to the workspace", () => {
  const created = createNativeEnrollment("ws_123", "agent_123");
  const publicKey = createPublicKey({ key: created.privateKeyJwk, format: "jwk" });
  expect(verify(
    null,
    Buffer.from(`allowly-agent-enroll-v1\nws_123\nagent_123\n${created.publicKey}`),
    publicKey,
    Buffer.from(created.possessionProof, "base64url"),
  )).toBe(true);

  const token = nativeAgentToken({
    version: 1,
    provider: "allowly",
    workspace_id: "ws_123",
    agent_id: "agent_123",
    binding_id: "bind_123",
    key_id: "key_123",
    private_key_jwk: created.privateKeyJwk,
  }, 1000);
  const [first, second, third] = token.split(".");
  expect(JSON.parse(Buffer.from(first, "base64url").toString())).toEqual({
    alg: "EdDSA", typ: "JWT", kid: "key_123",
  });
  expect(JSON.parse(Buffer.from(second, "base64url").toString())).toEqual({
    iss: "allowly-agent", aud: "ws_123", sub: "agent_123", bid: "bind_123",
    iat: 1000, nbf: 1000, exp: 1060,
  });
  expect(verify(null, Buffer.from(`${first}.${second}`), publicKey, Buffer.from(third, "base64url"))).toBe(true);
});
