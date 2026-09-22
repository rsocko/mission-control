export function redactPushText(value: string, maxLength: number): string {
  const redacted = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '******')
    .replace(
      /\bAuthorization\s*:\s*(?:Basic|Bearer)\s+[^\s,;]+/gi,
      'Authorization: [redacted]',
    )
    .replace(
      /["']?\b(access[_-]?token|api[_-]?key|password|secret|token|credential|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      '$1=[redacted]',
    );
  return redacted.slice(0, maxLength);
}
