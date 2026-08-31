// A self-signed, in-process OIDC issuer for local development.
//
// Every /api/* route is gated by requireAuth, which verifies an RS256 JWT
// against the JWKS published by AUTH0_ISSUER_BASE_URL. That makes the routes
// unreachable locally without either the real Auth0 tenant's credentials or a
// bypass. A bypass in the middleware would be a production-shaped risk, so
// instead this module stands up a throwaway issuer:
//
//   * an ephemeral RSA keypair, generated per process, never written to disk
//   * a tiny HTTP server on 127.0.0.1 serving /.well-known/jwks.json
//   * tokens minted with the same claim shape Auth0 produces for AI Connect,
//     including the namespaced email claim the Post Login Action adds
//
// The API only trusts it because the caller points AUTH0_ISSUER_BASE_URL at
// 127.0.0.1. Production points at the real tenant and can never be persuaded
// to trust a key that was generated on a developer's laptop.

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from "jose";

// The namespaced claim Auth0's Post Login Action puts on access tokens.
export const EMAIL_CLAIM = "https://aiconnect.macrotechtitan.com/email";

export const DEFAULT_AUDIENCE = "https://api.aiconnect.macrotechtitan.com";

export interface LocalIssuer {
  /** Issuer URL, always with a trailing slash (requireAuth normalizes to this). */
  issuer: string;
  audience: string;
  /** Mint an access token for an email. `sub` defaults to a stable fake id. */
  mint(email: string, sub?: string): Promise<string>;
  close(): Promise<void>;
}

export async function startLocalIssuer(
  audience: string = DEFAULT_AUDIENCE,
): Promise<LocalIssuer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const kid = randomUUID();
  const jwk = await exportJWK(publicKey as CryptoKey);
  const jwks = JSON.stringify({
    keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }],
  });

  const server: Server = createServer((req, res) => {
    if (req.url?.startsWith("/.well-known/jwks.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(jwks);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("local issuer failed to bind a port");
  }
  const issuer = `http://127.0.0.1:${address.port}/`;

  return {
    issuer,
    audience,
    async mint(email: string, sub?: string): Promise<string> {
      return new SignJWT({ [EMAIL_CLAIM]: email })
        .setProtectedHeader({ alg: "RS256", kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(sub ?? `local|${email}`)
        .setIssuedAt()
        .setExpirationTime("30m")
        .sign(privateKey as CryptoKey);
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
