import { Route, Routes, Navigate } from 'react-router-dom';
import Splash from './screens/Splash';
import Onboarding from './screens/Onboarding';
import Otp from './screens/Otp';
import Home from './screens/Home';
import LegacyEmbed from './screens/LegacyEmbed';
import VoicePay from './screens/VoicePay';

// Pantallas aún migrándose: se sirven desde legacy/ vía iframe en LegacyEmbed.
// Conforme entran PRs siguientes, cada ruta se reemplaza por un componente nativo.
const LEGACY_ANCHORS = [
  'explore', 'map', 'services', 'cart', 'checkout', 'payment',
  'booking', 'chat', 'camera', 'profile', 'worker', 'driver',
  'login', 'register', 'forgot', 'edit-profile', 'my-places',
  'premium', 'soporte', 'historial', 'recarga',
  'conductor-form', 'repartidor-form', 'empresa-form',
  'ai-panel', 'ofertas', 'bcp-transfer',
];

export default function App() {
  return (
    <div className="shell">
      <Routes>
        <Route path="/" element={<Splash />} />
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/auth/otp" element={<Otp />} />
        <Route path="/home" element={<Home />} />
        <Route path="/pay/:orderId" element={<VoicePay />} />
        {LEGACY_ANCHORS.map((id) => (
          <Route key={id} path={`/legacy/${id}`} element={<LegacyEmbed anchor={`s-${id}`} />} />
        ))}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
