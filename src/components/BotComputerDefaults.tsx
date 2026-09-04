// What a NEW bot is given, before anyone opens its settings.
//
// This is a default, not a policy: it fills in for a bot whose computers were
// never configured, and only then.  A bot that was explicitly turned off stays
// off, and a bot with destinations of its own keeps them — see resolveGrants
// in server/computer-grants.ts, which is the one place that rule lives.
import { useEffect, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { Card } from "./SettingsPrimitives";
import { cn } from "@/lib/cn";

type Destination = "cloud" | "vm" | "local";

export function BotComputerDefaults() {
  const { state, dispatch } = useStore();
  const saved = state.config?.botDefaults;
  const [computers, setComputers] = useState<Destination[]>([]);
  const [backend, setBackend] = useState<"box" | "vps">("box");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vpsConfigured = Boolean(state.config?.vps?.configured);

  useEffect(() => {
    setComputers(saved?.computers ?? []);
    setBackend(saved?.cloudBackend ?? "box");
  }, [saved?.computers, saved?.cloudBackend]);

  const save = (nextComputers: Destination[], nextBackend: "box" | "vps") => {
    setComputers(nextComputers);
    setBackend(nextBackend);
    setSaving(true);
    setError(null);
    api("/api/config", {
      method: "PUT",
      body: JSON.stringify({ botDefaults: { computers: nextComputers, cloudBackend: nextBackend } }),
    })
      .then((status: ConfigStatus) => dispatch({ type: "configStatus", config: status }))
      .catch((e) => setError(e.message))
      .finally(() => setSaving(false));
  };

  const cloudLabel = backend === "vps" ? "Self-hosted VPS" : "ASCII.dev Box";
  const options: Array<[Destination, string]> = [
    ["cloud", cloudLabel],
    ["vm", "Local VM"],
    ["local", "This Computer"],
  ];

  return (
    <Card
      title="New Bots"
      subtitle="Which computers a bot gets before anyone opens its settings.  Pick more than one and it chooses per task.  Leave all of them off to keep the shipped behavior: reuse whatever already exists, create nothing."
    >
      <div className="flex overflow-hidden rounded-lg border border-hairline/40">
        {options.map(([mode, label], i) => (
          <button
            key={mode}
            disabled={saving}
            onClick={() =>
              save(computers.includes(mode) ? computers.filter((c) => c !== mode) : [...computers, mode], backend)
            }
            className={cn(
              "flex-1 py-1.5 text-[13px]",
              i > 0 && "border-l border-hairline/40",
              saving && "opacity-60",
              computers.includes(mode)
                ? "bg-control text-ink"
                : "text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {computers.includes("cloud") && (
        <div className="mt-3 flex overflow-hidden rounded-lg border border-hairline/40">
          {(["box", "vps"] as const).map((option, i) => (
            <button
              key={option}
              disabled={saving || (option === "vps" && !vpsConfigured)}
              title={option === "vps" && !vpsConfigured ? "Add the VPS SSH alias under Connections first" : undefined}
              onClick={() => save(computers, option)}
              className={cn(
                "flex-1 py-1.5 text-[12px]",
                i > 0 && "border-l border-hairline/40",
                option === "vps" && !vpsConfigured && "cursor-not-allowed opacity-40",
                backend === option ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
              )}
            >
              {option === "vps" ? "Self-hosted VPS" : "ASCII.dev Box"}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 text-[11.5px] text-ink-secondary">
        {computers.length === 0
          ? "New bots use whatever computer already exists, and create nothing."
          : `New bots get ${computers.length > 1 ? "all of these" : "this"}. Bots you have already set up keep their own choice, and a bot you turned off stays off.`}
      </div>
      {error && <div className="mt-2 text-[11.5px] text-danger">{error}</div>}
    </Card>
  );
}
