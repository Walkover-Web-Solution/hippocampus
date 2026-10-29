// Everything an agent reads from the memory MCP server: the server instructions, tool and parameter
// descriptions, and the wording of tool results. Agents decide whether to call the tools from this text
// alone, so versions are kept side by side and compared with the tool-call eval (eval/tool-calls).
// MEMORY_MCP_PROMPTS picks the version the server uses.

export interface PromptSet {
    serverName: (version: string) => string;
    instructions: string;
    remember: { description: string; userMessage: string; assistantMessage: string; inferred: string; wait: string };
    recall: { description: string; query: string; asOf: string; includeUnconfirmed: string; limit: string };
    team: string;
    list: string;
    whoami: string;
    // Tool results
    queued: (version: string, eventId: string) => string;
    noMemories: string;
    // Added under recall results that contain non-current memories; null to leave results bare.
    statusLegend: string | null;
}

// The first version, as deployed on 2026-10-29.
const v1: PromptSet = {
    serverName: (version) => `memory (${version})`,
    instructions: `Long-term memory shared between the user's apps and their teams.
- Before answering anything that may depend on what the user or their team said earlier (people, projects, deadlines, owners, decisions, preferences, rules), call \`recall\` with a short question.
- When the user states a fact, decision, plan, preference, rule or correction worth keeping, call \`remember\` with the user's exact words in \`user_message\`. Don't paraphrase: facts are only kept when the message contains them.
- Memories marked "superseded" are history, "proposed" are unconfirmed, "disputed" conflict: say so instead of picking one.
- In a team, what people say about their own work and availability is shared with that team; feelings, preferences and anything marked private stay personal.`,
    remember: {
        description: 'Store what the user just said so it can be recalled later, in this or other apps. Pass the user\'s exact words. Writes are processed in the background unless wait is true.',
        userMessage: "The user's message, verbatim.",
        assistantMessage: 'Your reply, if the user confirmed something in it.',
        inferred: 'True when this is your inference rather than something the user stated; it is stored as unconfirmed.',
        wait: 'Wait for processing (10-30 s) and report what was stored.',
    },
    recall: {
        description: 'Search memory (the user\'s personal memory plus the active team\'s) for facts relevant to a question.',
        query: 'A short question or topic, e.g. "When does the Phoenix launch?"',
        asOf: 'ISO date to ask what was true back then.',
        includeUnconfirmed: 'Also return unconfirmed (agent-inferred) memories.',
        limit: 'Maximum memories (default 8).',
    },
    team: 'Team id or name to act in. Omit for the default team; "none" for personal memory only.',
    list: 'List everything currently stored that the user can see (personal plus active team).',
    whoami: 'Show which person, team and memory version this connection uses, and the teams available.',
    queued: (version, eventId) => `Queued for memory (${version}); searchable in about 20 seconds. Event ${eventId}.`,
    noMemories: '(no memories)',
    statusLegend: null,
};

// The rewrite: the "when" lives in the tool descriptions too (many apps drop server instructions),
// writing is framed as a routine step the agent takes without being asked, each tool lists concrete
// triggers and what not to call it for, and results say what to do next.
const v2: PromptSet = {
    serverName: () => 'Team memory',
    instructions: `Team memory: the user's long-term memory, shared across all their AI apps and with their team. It is how you know what the user and their teammates said before. Use it without being asked.

Read with \`recall\`:
- At the start of any task about the user's work, and whenever they mention a person, project, client, system or deadline you have no context on.
- When they ask what was decided, who owns something, when something is due, or what someone said.
- Before asking the user something they may already have told you or a teammate.
- Not needed for general knowledge, generic how-to, coding or debugging questions, or when the user is only giving you an update to save.

Write with \`remember\`, in the same turn as your reply, without asking first or announcing it:
- Whenever the user states a decision, plan, date or deadline, owner or assignment, status change (done, blocked, on leave, back), preference, team rule, or a correction of something earlier.
- Pass the user's own words in \`user_message\`, not a summary.
- Never store secrets (passwords, keys, tokens), ideas that weren't decided, or content only needed for the current reply.

In results, "superseded" means no longer true, "proposed" unconfirmed and "disputed" conflicting reports: say so rather than picking one. If recall finds nothing, carry on normally.`,
    remember: {
        description: `Save what the user just told you to their long-term team memory, so they and their teammates can recall it later in any app. Call it proactively, without being asked, in the same turn as your reply, whenever the user states a decision, plan, date or deadline, owner or assignment, status change (done, blocked, on leave, back), preference, team rule, or a correction of something earlier. Examples: "Priya owns the billing migration now", "we're moving the launch to March 3", "I'm out on Friday". Don't call it for questions, generic requests, undecided ideas, small talk, or secrets (passwords, API keys). Returns immediately; processing happens in the background.`,
        userMessage: "The user's words, copied verbatim (not a summary). If the information spans several of their recent messages, include each of them.",
        assistantMessage: 'Your reply, only when the user confirmed something you said in it.',
        inferred: 'True when this is your own inference rather than something the user said; it is stored as unconfirmed.',
        wait: 'Wait for processing (10-30 s) and report what was stored. Leave unset in normal use.',
    },
    recall: {
        description: `Search the user's long-term memory and their team's: what they and their teammates told any AI app before (people, projects, clients, deadlines, owners, decisions, statuses, preferences, rules). Call it before you answer whenever the reply could depend on that context: at the start of a task about the user's work; when they mention a person, project, client or internal system you have no context on; when they ask what was decided, who owns something or when it is due; and before asking them something they may have said before. Not needed for general knowledge, generic how-to, coding or debugging questions, or when the user is only giving you an update (just save it with remember). An empty result just means nothing is stored yet.`,
        query: 'A short, specific question, e.g. "When is the billing migration due?" or "Who owns the mobile app?"',
        asOf: 'ISO date, to ask what was true back then.',
        includeUnconfirmed: 'Also return unconfirmed memories (inferred by an agent, not stated by a person).',
        limit: 'Maximum memories to return (default 8).',
    },
    team: 'Team id or name to act in. Omit for the default team; "none" for personal memory only.',
    list: 'List everything currently stored that the user can see (their personal memory plus the active team\'s). Prefer recall for questions.',
    whoami: 'Show which person and team this connection acts as, and the teams available.',
    queued: () => 'Saved to memory (processed in the background, searchable in about 20 seconds).',
    noMemories: 'Nothing in memory about this yet. If the user tells you about it, save it with remember.',
    statusLegend: 'superseded = no longer true (history); proposed = unconfirmed; disputed = conflicting reports. Say so rather than picking one.',
};

export const PROMPT_SETS: Record<string, PromptSet> = { v1, v2 };

// v2 won the tool-call eval on 2026-10-29 (held-out: 99% of needed saves vs 91%).
export function promptSet(name = process.env.MEMORY_MCP_PROMPTS || 'v2'): PromptSet {
    const set = PROMPT_SETS[name];
    if (!set) throw new Error(`Unknown MEMORY_MCP_PROMPTS "${name}". Known: ${Object.keys(PROMPT_SETS).join(', ')}`);
    return set;
}
