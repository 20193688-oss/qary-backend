import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

export default function Splash() {
  const nav = useNavigate();
  useEffect(() => {
    const t = setTimeout(() => nav('/onboarding', { replace: true }), 1800);
    return () => clearTimeout(t);
  }, [nav]);

  return (
    <div className="flex-1 flex items-center justify-center text-center"
         style={{ background: 'linear-gradient(155deg,#0D0B2E 0%,#1A1660 55%,#2B2FD9 100%)' }}>
      <div>
        <img src="/icons/icon-512.png" alt="QARY" className="w-24 h-24 mx-auto rounded-3xl shadow-2xl" />
        <h1 className="mt-6 text-3xl font-extrabold tracking-tight text-white">QARY</h1>
        <p className="mt-2 text-xs uppercase tracking-[3px] text-white/60">Super-App</p>
        <div className="mt-12 mx-auto w-12 h-1 bg-white/15 rounded overflow-hidden">
          <div className="h-full bg-gradient-to-r from-sky-400 to-pink-500 splash-fill" />
        </div>
      </div>
      <style>{`@keyframes spLoad{from{width:0}to{width:100%}}.splash-fill{animation:spLoad 1.6s ease forwards;}`}</style>
    </div>
  );
}
