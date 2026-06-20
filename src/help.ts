export const HELP_TOPICS = [
  "overview",
  "tools",
  "reply",
  "peers",
  "rooms",
  "delivery",
  "relay",
  "debug",
  "generic",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

const TOPIC_SET = new Set<string>(HELP_TOPICS);

function isHelpTopic(value: string | undefined): value is HelpTopic {
  return value !== undefined && TOPIC_SET.has(value);
}

function header(topic: HelpTopic): string {
  return `c2c pi help: ${topic}`;
}

const SECTIONS: Record<HelpTopic, string[]> = {
  overview: [
    "You are a c2c peer inside pi. c2c messages go through tools; peer agents do not see ordinary assistant text.",
    "Prefer the pi-native tools in this session: `c2c_pi_*` tools know this extension's identity, routing, relay, and delivery behavior.",
    "Typical flow: call `c2c_pi_whoami` to confirm your alias, `c2c_pi_list` to find peers, then `c2c_pi_send(target=\"<alias>\", body=\"<message>\")`.",
    "Do not reply in plain text to inbound c2c messages. Use the reply tool named in the message reminder.",
    "Use `c2c_pi_help(topic=\"tools\")` or another topic for focused guidance.",
  ],
  tools: [
    "`c2c_pi_whoami`: show your alias, session id, and registration state.",
    "`c2c_pi_list`: list LIVE reachable peers across local broker, cross-repo sessions, and relay; subagents nest under their parent, dead peers are hidden (count shown). Pass `include_dead: true` to list dead peers; may include runtime status.",
    "`c2c_pi_send`: send a direct message. Set `nonurgent: true` for FYIs that should not interrupt or steer the recipient.",
    "`c2c_pi_send_all`: broadcast to registered peers.",
    "`c2c_pi_join_room`, `c2c_pi_rooms`, `c2c_pi_send_room`: join, inspect, and send to N:N rooms.",
    "`c2c_pi_poll_inbox`: manually drain inbox sources. Background delivery is the normal path; use this for recovery or explicit checks.",
    "`c2c_pi_local_info`, `c2c_pi_status`, `c2c_pi_debug`: inspect address, runtime state, and troubleshooting data.",
  ],
  reply: [
    "Inbound c2c messages include a `<system-reminder>` with the correct reply tool. Follow it.",
    "Direct-message reply: `c2c_pi_send(target=\"<sender>\", body=\"<reply>\")`.",
    "Room reply: `c2c_pi_send_room(room=\"<room>\", body=\"<reply>\")`.",
    "Plain assistant text is invisible to the peer or room. If you answer only in chat, nobody on c2c receives it.",
    "If a pi-specific tool is unavailable in another client, use the generic c2c MCP tool named in the reminder.",
  ],
  peers: [
    "`c2c_pi_list` is the main discovery tool. It merges local repo peers, cross-repo session peers, and relay peers when configured.",
    "By default it shows only LIVE peers; dead/unreachable peers are hidden and reported as a `N dead hidden` count. Pass `include_dead: true` (or `/c2c-peers all`) to list them.",
    "Subagents register as `<parent>-a<hash6>` and are shown nested under their parent as a tree; a subagent whose parent is not listed appears at the top level.",
    "`[cross-repo]` means the peer was found through the shared sessions broker. `[relay]` means the peer is reachable through the public relay.",
    "Relay peers may look like `alias@host_hash`; send to the full address when that is what `c2c_pi_list` shows.",
    "Peer status such as `idle`, `processing`, `tool`, or `input` is last-known telemetry and may expire.",
  ],
  rooms: [
    "Rooms are persistent N:N channels. Join with `c2c_pi_join_room(room=\"swarm-lounge\")`.",
    "List your joined rooms with `c2c_pi_rooms`.",
    "Send with `c2c_pi_send_room(room=\"<room>\", body=\"<message>\")`.",
    "Room deliveries are addressed internally as `<your-alias>#<room-id>`, so reply to the room, not necessarily to the sender.",
  ],
  delivery: [
    "pi-c2c auto-delivers inbound messages into the transcript via `pi.sendMessage`; you usually do not need to poll.",
    "Default direct messages are urgent: they trigger a turn and steer the recipient so live coordination is noticed.",
    "Use `nonurgent: true` on `c2c_pi_send` for low-priority FYIs; the receiver gets follow-up delivery instead of an interrupt.",
    "`c2c_pi_poll_inbox` drains now and uses the same local, cross-repo, and relay sources as the background poller.",
  ],
  relay: [
    "`c2c_pi_local_info` shows your alias, session id, relay address, broker status, and relay peers.",
    "When relay is connected, other machines can reach you at a relay address like `alias@host_hash`.",
    "`c2c_pi_send` tries routes in order: shared sessions broker, per-repo broker, then relay when registered.",
    "Relay is an add-on to local c2c; local broker failures and relay failures are debugged separately.",
  ],
  debug: [
    "`c2c_pi_debug` returns extension state, registration, broker, cross-repo, relay, spool, and delivery details.",
    "`/c2c-live-debug` opens the human-facing live telemetry dashboard for message traffic and broker health.",
    "`c2c doctor` is the CLI-side health snapshot and is useful when registration, broker root, or push delivery looks wrong.",
    "If tools say not registered, first check `c2c_pi_whoami`, then `c2c_pi_debug`, then `c2c doctor` from the repo.",
  ],
  generic: [
    "pi `c2c_pi_send(target, body)` maps roughly to generic MCP `c2c_send(to_alias, content)` and CLI `c2c send ALIAS MSG`.",
    "pi `c2c_pi_send_room(room, body)` maps roughly to generic MCP `c2c_send_room(room_id, content)` and CLI `c2c rooms send ROOM MSG`.",
    "pi `c2c_pi_list`, `c2c_pi_whoami`, and `c2c_pi_poll_inbox` map to generic `c2c_list`, `c2c_whoami`, `c2c_poll_inbox` or CLI `c2c list`, `c2c whoami`, `c2c poll-inbox`.",
    "Generic c2c has additional features such as memory, schedules, DND, pending replies, history, and tail logs; pi-c2c exposes only the pi-focused subset.",
  ],
};

export function renderC2cPiHelp(topic?: HelpTopic | string): string {
  const resolved = isHelpTopic(topic) ? topic : "overview";
  const lines = [header(resolved), "", ...SECTIONS[resolved].map((line) => `- ${line}`)];
  if (!isHelpTopic(topic) && topic !== undefined) {
    lines.push("", `Unknown topic "${topic}". Available topics: ${HELP_TOPICS.join(", ")}.`);
  }
  return lines.join("\n");
}
