// Safety filters previos al LLM y posteriores a la transcripción.
// PR 6 cablea esto al pipeline.

const PAN_REGEX = /\b(?:\d[ -]?){13,19}\b/;
const OTP_LIKE = /\b\d{4,6}\b/;
const ABUSE_KEYWORDS = ['matar', 'arma', 'bomba', 'suicidio'];

export function preFilter(transcript: string): { ok: boolean; reason?: string; redacted?: string } {
  if (PAN_REGEX.test(transcript)) {
    return { ok: false, reason: 'pan_detected', redacted: transcript.replace(PAN_REGEX, '[REDACTED_PAN]') };
  }
  if (ABUSE_KEYWORDS.some((k) => transcript.toLowerCase().includes(k))) {
    return { ok: false, reason: 'abuse_keywords' };
  }
  // OTP en transcripción no es bloqueo absoluto pero se redacta antes de logs/LLM.
  const redacted = transcript.replace(OTP_LIKE, '[REDACTED_NUM]');
  return { ok: true, redacted };
}
