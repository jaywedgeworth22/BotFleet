import { randomUUID } from "node:crypto";

export const proxyTokens = new Set<string>();

export function generateProxyToken() {
  const token = randomUUID();
  proxyTokens.add(token);
  return token;
}
