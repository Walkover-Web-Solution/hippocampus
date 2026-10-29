// What a person says about themselves: personal or shared with the active team? Two policies:
// - personal-default (the eval datasets' ground truth): self-statements stay personal unless explicitly shared.
// - team-context (MEMORY_SCOPE_POLICY=team-context; the Memory Lab's default): in a team, what people say
//   about their own work and availability is for the team; feelings, preferences and private things are not.
// Read at call time, so a process can choose before it starts working.

export type ScopePolicy = 'personal-default' | 'team-context';

export function scopePolicy(): ScopePolicy {
    return process.env.MEMORY_SCOPE_POLICY === 'team-context' ? 'team-context' : 'personal-default';
}

// The self-statement part of the extractors' scope rule.
export function selfFactsRule(): string {
    if (scopePolicy() === 'team-context') {
        return 'when there is an active team, what the user says about their own work there is "team": what they are working on, tasks they took on, assignments, plans, schedule, availability and status (e.g. "I\'m on the DB fix", "out for lunch for 30 minutes"). The user\'s preferences, feelings and opinions about people, personal targets, reminders, and anything they mark as private ("just for me", "not for the team") are "personal".';
    }
    return 'facts about the user themselves (their skills, languages, role, preferences, targets, reminders, opinions) are "personal" unless the user explicitly shares them with the team (an announcement to the team, a team wiki or team document, "tell the team"). Anything the user marks as private is "personal".';
}
