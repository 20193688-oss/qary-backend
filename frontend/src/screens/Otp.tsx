import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setAccessToken } from '../lib/api';

interface VerifyResponse { accessToken: string; refreshToken: string; user: { email: string; id: string } }
interface RegisterResponse { ok: boolean; userId: string; debugOtp?: string }

export default function Otp() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [digits, setDigits] = useState(['', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [debug, setDebug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const complete = digits.every((d) => d !== '');

  const set = (i: number, v: string) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 3) (document.getElementById(`otp-${i + 1}`) as HTMLInputElement)?.focus();
  };

  const requestOtp = async () => {
    if (!email) return;
    setLoading(true); setError(null);
    try {
      const r = await api<RegisterResponse>('/api/auth/register', {
        method: 'POST', body: JSON.stringify({ email }),
      });
      if (r.debugOtp) setDebug(r.debugOtp);
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  const submit = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api<VerifyResponse>('/api/auth/verify-otp', {
        method: 'POST', body: JSON.stringify({ email, code: digits.join('') }),
      });
      setAccessToken(r.accessToken);
      localStorage.setItem('qary_refresh', r.refreshToken);
      nav('/home', { replace: true });
    } catch (e) { setError((e as Error).message); }
    setLoading(false);
  };

  return (
    <div className="flex-1 bg-bg p-6 text-navy">
      <h2 className="text-2xl font-extrabold mb-2">Verifica tu correo</h2>
      <p className="text-muted text-sm mb-4">Te enviamos un código de 4 dígitos.</p>
      <input value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="tu@email.com" type="email"
        className="w-full rounded-xl border-2 border-gray-200 p-3 mb-3" />
      <button onClick={requestOtp} disabled={!email || loading} className="btn-sec mb-6 disabled:opacity-50">
        {loading ? 'Enviando…' : 'Enviar código'}
      </button>
      {debug && (
        <p className="text-xs bg-amber-50 border border-amber-200 rounded p-2 mb-4">
          [dev] OTP: <b>{debug}</b>
        </p>
      )}
      <div className="flex gap-3 justify-center mb-6">
        {digits.map((d, i) => (
          <input key={i} id={`otp-${i}`} value={d} onChange={(e) => set(i, e.target.value)}
                 inputMode="numeric" maxLength={1}
                 className="w-14 h-16 rounded-xl border-2 border-gray-200 text-center text-2xl font-bold focus:border-blue outline-none" />
        ))}
      </div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      <button onClick={submit} disabled={!complete || loading} className="btn-pry disabled:opacity-50">
        {loading ? 'Verificando…' : 'Continuar'}
      </button>
    </div>
  );
}
