import { useState, useEffect, useCallback } from "react";
import { getCharacters } from "../api.js";
import type { Character } from "../types.js";

function ColorSwatch({ hex, label }: { hex: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        className="h-6 w-6 rounded-full border border-surface-600 shadow-sm"
        style={{ backgroundColor: hex }}
        title={`${label}: ${hex}`}
      />
      <span className="text-[10px] text-gray-500 font-mono leading-none">{hex}</span>
    </div>
  );
}

function CharacterCard({ character }: { character: Character }) {
  const created = new Date(character.created_at * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="rounded-xl bg-surface-800 p-4 shadow flex flex-col gap-2">
      <div>
        <p className="font-bold text-base truncate">{character.name}</p>
        <p className="text-xs text-gray-400 mt-0.5 line-clamp-3">{character.description}</p>
      </div>

      {/* Palette swatches */}
      <div className="flex gap-4 pt-1">
        {character.palette_skin && (
          <ColorSwatch hex={character.palette_skin} label="Skin" />
        )}
        {character.palette_hair && (
          <ColorSwatch hex={character.palette_hair} label="Hair" />
        )}
        {character.palette_robe && (
          <ColorSwatch hex={character.palette_robe} label="Robe" />
        )}
      </div>

      <p className="text-[11px] text-gray-600 mt-auto pt-1">Added {created}</p>
    </div>
  );
}

export default function Characters() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getCharacters();
      setCharacters(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-bold">Characters</h2>
        <button
          className="rounded-lg bg-surface-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-surface-600"
          onClick={load}
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-red-900/40 p-4 text-sm text-red-300">{error}</div>
      )}

      {!loading && !error && characters.length === 0 && (
        <div className="rounded-xl bg-surface-800 p-8 text-center">
          <p className="text-sm text-gray-400">No characters yet — run your first episode to populate the library</p>
          <p className="mt-1 text-xs text-gray-600">Characters are extracted automatically from each episode's story.</p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {characters.map((c) => (
          <CharacterCard key={c.id} character={c} />
        ))}
      </div>
    </div>
  );
}
