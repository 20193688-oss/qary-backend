import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, getAccessToken } from '../lib/api';
import voice from '../lib/voice';

interface VoiceConfirmResponse {
  ok: boolean;
  paymentId: string;
  status: string;
  voicePinVerified: boolean;
  receiptUrl: string | null;
  ttsConfirmation: string;
}

interface JwtPayload { sub: string; email: string; role: string }
function decodeJwtSub(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return (JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as JwtPayload).sub;
  } catch { return null; }
}

export default function VoicePay() {
  const { orderId } = useParams();
  const [status, setStatus] = useState<'idle' | 'listening' | 'confirming' | 'done' | 'error'>('idle');
  const [transcript, setTranscript] = useState('');
  const [pin, setPin] = useState('');
  const [result, setResult] = useState<VoiceConfirmResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const userId = (() => {
    const t = getAccessToken();
    return t ? decodeJwtSub(t) : null;
  })();

  const listen = async () => {
    setErr(null);
    if (!voice.supported()) {
      setErr('Voz no soportada. Usa el PIN manual.');
      return;
    }
    try {
      setStatus('listening');
      voice.speak('Di tu PIN de cuatro dígitos.');
      const text = await voice.listenOnce();
      setTranscript(text);
      const detected = voice.extractPin(text) ?? voice.wordsToDigits(text);
      if (!detected) {
        setStatus('error'); setErr('No detecté un PIN válido. Intenta con teclado.');
        return;
      }
      setPin(detected);
      await confirm(detected);
    } catch (e) {
      setStatus('error'); setErr((e as Error).message);
    }
  };

  const confirm = async (confirmPin: string) => {
    if (!orderId || !userId) {
      setErr('Falta orderId o sesión.');
      setStatus('error');
      return;
    }
    try {
      setStatus('confirming');
      const res = await api<VoiceConfirmResponse>('/api/voice-confirm', {
        method: 'POST',
        body: JSON.stringify({ orderId, userId, confirmPin }),
      });
      setResult(res);
      setStatus('done');
      voice.speak(res.ttsConfirmation);
    } catch (e) {
      setErr((e as Error).message);
      setStatus('error');
    }
  };

  return (
    <div className="flex-1 bg-bg p-6 text-navy overflow-y-auto">
      <h2 className="text-2xl font-extrabold mb-1">Confirmar pago por voz</h2>
      <p className="text-muted text-sm mb-6">Pedido <code>{orderId}</code></p>

      <button onClick={listen} disabled={status === 'listening' || status === 'confirming'}
        className="btn-pry mb-3 disabled:opacity-50">
        {status === 'listening' ? '🎙️ Escuchando…' : '🎙️ Decir mi PIN'}
      </button>

      <div className="bg-white rounded-2xl p-4 my-4 shadow">
        <p className="text-xs text-muted mb-2">¿Voz no detecta? Ingresa el PIN:</p>
        <div className="flex gap-2">
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric" maxLength={4}
            className="flex-1 rounded-xl border-2 border-gray-200 p-3 text-center font-mono text-xl tracking-[8px]" />
          <button onClick={() => confirm(pin)} disabled={pin.length !== 4 || status === 'confirming'}
            className="btn-pry !w-auto px-5 disabled:opacity-50">Confirmar</button>
        </div>
      </div>

      {transcript && (
        <p className="text-xs text-muted">Escuché: <em>"{transcript}"</em></p>
      )}
      {err && (
        <div className="mt-4 bg-red-50 text-red-700 border border-red-200 rounded-xl p-3 text-sm">
          {err}
        </div>
      )}
      {result?.ok && (
        <div className="mt-6 bg-green-50 border border-green-200 rounded-xl p-4">
          <p className="font-extrabold text-green-700">{result.ttsConfirmation}</p>
          {result.receiptUrl && (
            <a href={result.receiptUrl} className="text-blue underline text-sm" target="_blank" rel="noreferrer">
              Ver recibo
            </a>
          )}
        </div>
      )}
    </div>
  );
}
