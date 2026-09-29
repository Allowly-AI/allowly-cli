import { createPrivateKey, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";

export interface NativeAgentCredential {
  version: 1;
  provider: "allowly";
  workspace_id: string;
  agent_id: string;
  binding_id: string;
  key_id: string;
  private_key_jwk: JsonWebKey;
}

export interface PendingNativeEnrollment {
  version: 1;
  provider: "allowly";
  status: "pending";
  workspace_id: string;
  agent_id: string;
  public_key: string;
  private_key_jwk: JsonWebKey;
}

function encoded(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function createNativeEnrollment(workspaceId: string, agentId: string): {
  publicKey: string;
  possessionProof: string;
  privateKeyJwk: JsonWebKey;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateKeyJwk = privateKey.export({ format: "jwk" });
  if (!publicJwk.x || !privateKeyJwk.d) throw new Error("Could not create an Ed25519 agent key");
  const publicKeyValue = publicJwk.x;
  return {
    publicKey: publicKeyValue,
    possessionProof: nativeEnrollmentProof(workspaceId, agentId, publicKeyValue, privateKeyJwk),
    privateKeyJwk,
  };
}

export function nativeEnrollmentProof(
  workspaceId: string, agentId: string, publicKey: string, privateKeyJwk: JsonWebKey,
): string {
  const message = `allowly-agent-enroll-v1\n${workspaceId}\n${agentId}\n${publicKey}`;
  const privateKey = createPrivateKey({ key: privateKeyJwk, format: "jwk" });
  return encoded(sign(null, Buffer.from(message, "utf8"), privateKey));
}

export function nativeAgentToken(credential: NativeAgentCredential, now = Math.floor(Date.now() / 1000)): string {
  if (credential.version !== 1 || credential.provider !== "allowly"
      || !credential.workspace_id || !credential.agent_id || !credential.binding_id || !credential.key_id
      || credential.private_key_jwk.kty !== "OKP" || credential.private_key_jwk.crv !== "Ed25519"
      || !credential.private_key_jwk.d) {
    throw new Error("Invalid Allowly agent credential");
  }
  const header = encoded(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: credential.key_id }));
  const payload = encoded(JSON.stringify({
    iss: "allowly-agent",
    aud: credential.workspace_id,
    sub: credential.agent_id,
    bid: credential.binding_id,
    iat: now,
    nbf: now,
    exp: now + 60,
  }));
  const input = `${header}.${payload}`;
  const privateKey = createPrivateKey({ key: credential.private_key_jwk, format: "jwk" });
  return `${input}.${encoded(sign(null, Buffer.from(input, "ascii"), privateKey))}`;
}
