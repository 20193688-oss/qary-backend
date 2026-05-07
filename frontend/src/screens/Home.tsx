import { Link } from 'react-router-dom';

const TILES = [
  { to: '/legacy/map', icon: '🚖', label: 'Pedir taxi' },
  { to: '/legacy/services', icon: '🛒', label: 'Delivery' },
  { to: '/legacy/explore', icon: '🔎', label: 'Explorar' },
  { to: '/legacy/ai-panel', icon: '🤖', label: 'Asistente IA' },
  { to: '/legacy/historial', icon: '🧾', label: 'Historial' },
  { to: '/legacy/profile', icon: '👤', label: 'Perfil' },
];

export default function Home() {
  return (
    <div className="flex-1 bg-bg text-navy overflow-y-auto">
      <header className="bg-navy text-white p-5">
        <h1 className="text-xl font-extrabold">Hola 👋</h1>
        <p className="text-white/60 text-sm">¿Qué necesitas hoy?</p>
      </header>
      <div className="grid grid-cols-3 gap-3 p-4">
        {TILES.map((t) => (
          <Link key={t.to} to={t.to}
                className="bg-white rounded-2xl p-4 flex flex-col items-center gap-2 shadow active:scale-95 transition-transform">
            <span className="text-3xl">{t.icon}</span>
            <span className="text-xs font-semibold text-center">{t.label}</span>
          </Link>
        ))}
      </div>
      <p className="text-xs text-muted text-center px-4 py-2">
        Pantallas marcadas como <em>legacy</em> usan el HTML v9 importado mientras se migran fase por fase.
      </p>
    </div>
  );
}
