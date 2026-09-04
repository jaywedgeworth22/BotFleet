// Every bot's engine choices on one screen.
//
// Each bot's own profile can already change its models, but one at a time
// and behind a click, which makes the only question that matters hard to
// answer: what is everything else set to?  Choosing where a bot should run
// is a comparison — you want two on the expensive engine and the rest
// somewhere cheaper, or you want to move a whole tier off a provider that
// is rate-limiting you.  This is that comparison, and it edits in place.
import { useState } from "react";
import { Plus, X } from "lucide-react";

import { useStore, type Bot, type ModelSelection } from "@/state/store";
import { cn } from "@/lib/cn";
import { BotAvatar } from "./Avatar";
import { ModelPicker } from "./ModelPicker";

/** The most fallbacks a bot may carry, matching the per-bot profile. */
const MAX_FALLBACKS = 2;

function BotModelRow({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const fallbacks = bot.modelSelection.fallbacks ?? [];

  const save = (selection: ModelSelection) =>
    dispatch({ type: "setModel", botId: bot.id, selection });

  const setFallback = (index: number, selection: ModelSelection) => {
    const next = [...fallbacks];
    next[index] = selection;
    save({ ...bot.modelSelection, fallbacks: next });
  };

  const removeFallback = (index: number) => {
    const next = fallbacks.filter((_, i) => i !== index);
    save({ ...bot.modelSelection, fallbacks: next });
  };

  const addFallback = () =>
    save({
      ...bot.modelSelection,
      // Seeded from the primary, because the picker opens on something
      // real rather than on an empty control.
      fallbacks: [
        ...fallbacks,
        { instanceId: bot.modelSelection.instanceId, model: bot.modelSelection.model },
      ],
    });

  return (
    <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3 border-t border-hairline/40 py-3 first:border-t-0">
      <div className="flex min-w-0 items-center gap-2">
        <BotAvatar bot={bot} size={28} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium text-ink">{bot.name}</div>
          {bot.title && (
            <div className="truncate text-[12px] text-ink-secondary">{bot.title}</div>
          )}
        </div>
      </div>

      <ModelPicker bot={bot} contained selection={bot.modelSelection} onChange={save} />

      {Array.from({ length: MAX_FALLBACKS }, (_, index) => {
        const fallback = fallbacks[index];
        if (!fallback) {
          // Only the next empty slot offers to fill itself, so the row does
          // not sprout two identical buttons.
          const isNext = index === fallbacks.length;
          return (
            <div key={index}>
              {isNext ? (
                <button
                  type="button"
                  onClick={addFallback}
                  className="flex w-full items-center gap-1.5 rounded-lg border border-dashed border-hairline/60 px-2.5 py-1.5 text-[13px] text-ink-secondary hover:border-hairline hover:text-ink"
                >
                  <Plus size={13} />
                  Add Fallback
                </button>
              ) : (
                <div className="px-2.5 py-1.5 text-[13px] text-ink-secondary/50">&mdash;</div>
              )}
            </div>
          );
        }
        return (
          <div key={index} className="flex items-start gap-1">
            <div className="min-w-0 flex-1">
              <ModelPicker
                bot={bot}
                contained
                selection={fallback}
                onChange={(selection) => setFallback(index, selection)}
              />
            </div>
            <button
              type="button"
              onClick={() => removeFallback(index)}
              aria-label={`Remove fallback ${index + 1} from ${bot.name}`}
              title={`Remove fallback ${index + 1}`}
              className="mt-1 shrink-0 rounded-md p-1 text-ink-secondary hover:bg-raised/70 hover:text-ink"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function FleetModelsSection() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const bots = state.bots
    .filter((bot) => !bot.hidden)
    .filter(
      (bot) =>
        !needle ||
        bot.name.toLowerCase().includes(needle) ||
        (bot.title ?? "").toLowerCase().includes(needle) ||
        bot.modelSelection.model.toLowerCase().includes(needle) ||
        (bot.modelSelection.fallbacks ?? []).some((fallback) =>
          fallback.model.toLowerCase().includes(needle),
        ),
    );

  // How many bots sit on each engine, so the shape of the fleet is legible
  // without reading every row.
  const perInstance = new Map<string, number>();
  for (const bot of state.bots.filter((b) => !b.hidden)) {
    const id = bot.modelSelection.instanceId;
    perInstance.set(id, (perInstance.get(id) ?? 0) + 1);
  }
  const spread = [...perInstance.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-ink">Models</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">
          Every bot's primary engine and its fallbacks, together.&nbsp; A turn that fails
          because a provider is capped moves down this list, so the fallbacks matter most
          when a provider is having a bad day.
        </p>
      </div>

      {spread.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {spread.map(([instanceId, count]) => {
            const instance = state.instances.find((entry) => entry.instanceId === instanceId);
            return (
              <span
                key={instanceId}
                className="rounded-full border border-hairline/50 bg-inset px-2.5 py-1 text-[12px] text-ink-secondary"
              >
                {instance?.displayName ?? instanceId} · {count}
              </span>
            );
          })}
        </div>
      )}

      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by bot or model"
        aria-label="Filter bots by name or model"
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:border-hairline focus:outline-none"
      />

      <div className="rounded-xl border border-hairline/40 bg-card px-3 py-1">
        <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-3 border-b border-hairline/40 py-2 text-[12px] font-medium uppercase tracking-[0.06em] text-ink-secondary">
          <div>Bot</div>
          <div>Primary</div>
          <div>Fallback 1</div>
          <div>Fallback 2</div>
        </div>
        {bots.length === 0 ? (
          <div className={cn("px-1 py-6 text-center text-[13px] text-ink-secondary")}>
            {needle ? `Nothing matches “${query}”` : "No bots yet"}
          </div>
        ) : (
          bots.map((bot) => <BotModelRow key={bot.id} bot={bot} />)
        )}
      </div>
    </div>
  );
}
