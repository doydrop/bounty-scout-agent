const SECRET_KEY =
  /(token|secret|authorization|api[-_]?key|jwt|password|cookie|private[-_]?key|passkey|session[-_]?key)/i;

export function stripSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[max-depth]";
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : stripSecrets(inner, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

export function redactString(value: string, extraSecrets: readonly string[] = []): string {
  let out = value.replace(/bearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]");
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function errorMessage(err: unknown, extraSecrets: readonly string[] = []): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactString(message, extraSecrets);
}
