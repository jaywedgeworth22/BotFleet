// Building the text a driver actually receives. Two situations force an
// inline replay of the active branch: a rewind (the visible branch
// changed) and a fresh engine (this instance has no session here — the
// user switched the bot's model mid-thread). They coincide today but are
// distinct markers on purpose: rewound also invalidates OTHER instances'
// cursors, fresh does not.
export interface TurnContextInput {
  /** the user's new message */
  text: string;
  /** settled text turns on the active branch, oldest first, capped upstream */
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
  /** the visible branch changed (edit / version switch) */
  rewound: boolean;
  /** this driver instance has no session cursor for this thread */
  fresh: boolean;
  /** transcript-replay drivers get history via SendTurnInput.transcript instead */
  replaysNatively: boolean;
}

/** Does this engine need the thread replayed to it? True when a DIFFERENT
 * instance ran the last turn here — a cursor of our own is not enough,
 * because it only proves we once had a session covering some prefix of the
 * thread; every turn another engine took since is missing from it. Tasks
 * from before `lastInstanceId` existed fall back to the cursor map: a lone
 * cursor that is ours means a single-engine thread we can keep resuming;
 * anything else is ambiguous, and replaying is the safe side of ambiguous.
 * Gated on a prior USER turn: a new bot's thread is seeded with its own
 * greeting, and that alone is nothing to join. */
export function engineIsFresh(input: {
  instanceId: string;
  lastInstanceId: string | undefined;
  resumeCursors: Record<string, unknown>;
  transcript: Array<{ role: "user" | "assistant"; text: string }>;
}): boolean {
  const { instanceId, lastInstanceId, resumeCursors, transcript } = input;
  if (!transcript.some((m) => m.role === "user")) return false;
  if (lastInstanceId !== undefined) return lastInstanceId !== instanceId || resumeCursors[instanceId] === undefined;
  const cursorIds = Object.keys(resumeCursors);
  return !(cursorIds.length === 1 && cursorIds[0] === instanceId);
}

const REWOUND_PREAMBLE =
  "[The user rewound this conversation (edited a message or switched to another version). Everything before this point was replaced by the following history:]";
const FRESH_PREAMBLE =
  "[You are joining this conversation mid-thread (the user switched this bot over to you). The conversation so far:]";

const MAX_REPLAY_BYTES = 128 * 1024;

export function buildTurnContext(input: TurnContextInput): {
  turnText: string;
  /** false when the native session must not be resumed */
  resume: boolean;
} {
  const { text, transcript, rewound, fresh, replaysNatively } = input;
  const resume = !rewound && !fresh;
  const replay = !resume && !replaysNatively && transcript.length > 0;
  if (!replay) return { turnText: text, resume };

  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = `${transcript[i].role === "user" ? "User" : "Assistant"}: ${transcript[i].text}`;
    const entryBytes = Buffer.byteLength(entry, "utf8");
    if (bytes + entryBytes > MAX_REPLAY_BYTES && lines.length > 0) {
      truncated = true;
      break;
    }
    lines.unshift(entry);
    bytes += entryBytes;
  }

  const preamble = rewound ? REWOUND_PREAMBLE : FRESH_PREAMBLE;
  return {
    turnText: [
      preamble,
      ...(truncated ? ["[Earlier conversation omitted for length]", ""] : [""]),
      ...lines,
      "",
      "[Now reply to the user's latest message:]",
      "",
      text,
    ].join("\n"),
    resume,
  };
}
