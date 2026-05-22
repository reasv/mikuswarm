const redactedValues = new Set<string>();

function shouldRegister(value: string): boolean {
  if (value.length <= 4) return false;
  return ![...value].every((char) => char === value[0]);
}

export function registerSecret(value: unknown): void {
  if (typeof value !== "string") return;
  if (shouldRegister(value)) redactedValues.add(value);
}

export function registeredSecrets(): string[] {
  return [...redactedValues].sort((a, b) => b.length - a.length);
}

export function redactSecrets(input: string): string {
  const secrets = registeredSecrets();
  if (secrets.length === 0) return input;
  return input.replace(new RegExp(secrets.map(escapeRegExp).join("|"), "g"), "[REDACTED]");
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactValue(child)]),
    ) as T;
  }
  return value;
}

export function resetRedactionRegistry(): void {
  redactedValues.clear();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
