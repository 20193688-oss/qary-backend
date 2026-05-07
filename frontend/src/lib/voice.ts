// Web Speech API wrapper. STT (SpeechRecognition) y TTS (speechSynthesis).
// Fallback noop si el navegador no soporta. PR 6 lo amplía con streaming.

type Listener = (text: string) => void;

interface SpeechRecognitionResultLike { 0: { transcript: string } }
interface SpeechRecognitionEventLike { results: SpeechRecognitionResultLike[] }
interface SpeechRecognitionLike {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function getSR(): { new (): SpeechRecognitionLike } | null {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return (w.SpeechRecognition ?? w.webkitSpeechRecognition) as { new (): SpeechRecognitionLike } | null;
}

export const voice = {
  supported() { return !!getSR() && 'speechSynthesis' in window; },
  async listenOnce(lang = 'es-ES'): Promise<string> {
    return new Promise((resolve, reject) => {
      const SR = getSR();
      if (!SR) return reject(new Error('SpeechRecognition no soportado'));
      const r = new SR();
      r.lang = lang; r.interimResults = false; r.continuous = false;
      r.onresult = (e) => {
        const t = e.results[0]?.[0]?.transcript ?? '';
        resolve(t.trim());
      };
      r.onerror = (e) => reject(new Error(e.error));
      r.onend = () => { /* noop */ };
      r.start();
    });
  },
  speak(text: string, lang = 'es-ES') {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang; u.rate = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  },
  // Heurística simple para extraer 4 dígitos del transcript (fallback al PIN UI)
  extractPin(text: string): string | null {
    const m = /\b(\d{4})\b/.exec(text);
    return m ? m[1]! : null;
  },
  // Normaliza palabras → dígitos para "uno dos tres cuatro" → "1234"
  wordsToDigits(text: string): string | null {
    const map: Record<string, string> = {
      cero: '0', uno: '1', dos: '2', tres: '3', cuatro: '4',
      cinco: '5', seis: '6', siete: '7', ocho: '8', nueve: '9',
    };
    const tokens = text.toLowerCase().split(/\s+/).map((t) => map[t]).filter((d): d is string => !!d);
    return tokens.length === 4 ? tokens.join('') : null;
  },
};

export default voice;
