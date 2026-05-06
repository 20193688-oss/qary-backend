import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Otp() {
  const nav = useNavigate();
  const [digits, setDigits] = useState(['', '', '', '']);
  const [loading, setLoading] = useState(false);
  const complete = digits.every((d) => d !== '');

  const set = (i: number, v: string) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 3) (document.getElementById(`otp-${i + 1}`) as HTMLInputElement)?.focus();
  };

  const submit = async () => {
    setLoading(true);
    // TODO PR 3: POST /api/auth/otp/verify
    await new Promise((r) => setTimeout(r, 600));
    setLoading(false);
    nav('/home', { replace: true });
  };

  return (
    <div className="flex-1 bg-bg p-6 text-navy">
      <h2 className="text-2xl font-extrabold mb-2">Verifica tu número</h2>
      <p className="text-muted text-sm mb-6">Ingresa el código de 4 dígitos que enviamos a tu teléfono.</p>
      <div className="flex gap-3 justify-center mb-6">
        {digits.map((d, i) => (
          <input key={i} id={`otp-${i}`} value={d} onChange={(e) => set(i, e.target.value)}
                 inputMode="numeric" maxLength={1}
                 className="w-14 h-16 rounded-xl border-2 border-gray-200 text-center text-2xl font-bold focus:border-blue outline-none" />
        ))}
      </div>
      <button onClick={submit} disabled={!complete || loading} className="btn-pry disabled:opacity-50">
        {loading ? 'Verificando…' : 'Continuar'}
      </button>
    </div>
  );
}
