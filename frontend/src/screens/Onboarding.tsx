import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

const STEPS = [
  {
    icon: '📍',
    title: 'Ubicación',
    desc: 'Necesitamos tu ubicación para conectarte con servicios y conductores cercanos.',
    why: 'Para mostrarte servicios a menos de 5 km y calcular tiempos de llegada.',
    request: async () => new Promise<void>((res) => {
      if (!navigator.geolocation) return res();
      navigator.geolocation.getCurrentPosition(() => res(), () => res());
    }),
  },
  {
    icon: '🔔',
    title: 'Notificaciones',
    desc: 'Te avisaremos cuando tu conductor llegue o tu pedido esté listo.',
    why: 'Sin notificaciones podrías perderte alertas importantes.',
    request: async () => {
      if (!('Notification' in window)) return;
      try { await Notification.requestPermission(); } catch {}
    },
  },
  {
    icon: '📷',
    title: 'Cámara y micrófono',
    desc: 'Necesarios para chat multimedia, evidencias, voz y la linterna de emergencia.',
    why: 'Cámara para evidencias y QR; mic para comandos de voz.',
    request: async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch {}
    },
  },
];

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const nav = useNavigate();
  const s = STEPS[step]!;

  const allow = async () => {
    await s.request();
    if (step + 1 < STEPS.length) setStep(step + 1);
    else nav('/auth/otp', { replace: true });
  };
  const skip = () => {
    if (step + 1 < STEPS.length) setStep(step + 1);
    else nav('/auth/otp', { replace: true });
  };

  return (
    <div className="flex-1 flex items-center justify-center p-6"
         style={{ background: 'linear-gradient(155deg,#0D0B2E 0%,#1A1660 60%,#1E2080 100%)' }}>
      <div className="w-full bg-white/5 border border-white/10 rounded-3xl p-7 backdrop-blur text-center">
        <div className="text-5xl mb-4">{s.icon}</div>
        <h2 className="text-2xl font-extrabold text-white mb-2">{s.title}</h2>
        <p className="text-white/65 text-sm leading-relaxed mb-5">{s.desc}</p>
        <div className="bg-sky-400/10 border border-sky-400/25 rounded-xl p-3 mb-5 text-left">
          <p className="text-white/70 text-xs leading-relaxed">
            <strong className="text-sky-300">¿Por qué?</strong> {s.why}
          </p>
        </div>
        <div className="flex gap-1.5 justify-center mb-6">
          {STEPS.map((_, i) => (
            <div key={i} className={`w-2 h-2 rounded-full transition-all ${i === step ? 'bg-white w-6' : 'bg-white/20'}`} />
          ))}
        </div>
        <button onClick={allow} className="btn-pry mb-2">Permitir</button>
        <button onClick={skip} className="btn-sec">Más tarde</button>
      </div>
    </div>
  );
}
