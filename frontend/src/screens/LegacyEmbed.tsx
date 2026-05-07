import { useNavigate } from 'react-router-dom';

export default function LegacyEmbed({ anchor }: { anchor: string }) {
  const nav = useNavigate();
  return (
    <div className="flex-1 flex flex-col bg-black">
      <div className="bg-navy text-white flex items-center gap-3 p-3">
        <button onClick={() => nav(-1)} className="rounded-lg bg-white/10 px-3 py-1 text-sm">←</button>
        <span className="text-sm font-semibold">{anchor} (legacy)</span>
      </div>
      <iframe
        title={`legacy-${anchor}`}
        src={`/legacy.html#${anchor}`}
        className="flex-1 w-full border-0"
        allow="camera; microphone; geolocation; clipboard-read; clipboard-write"
      />
    </div>
  );
}
