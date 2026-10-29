import { IdentityDirectory } from './identity';
import { IngestContext, Scope, personalScope, teamScope } from './types';

// Reads see the reader's personal scope plus the active team only; there is no cross-team read.
export function readableScopes(dir: IdentityDirectory, personId: string, activeTeamId: string | null, at: Date): Scope[] {
    const scopes = [personalScope(personId)];
    if (activeTeamId && dir.isMember(personId, activeTeamId, at)) scopes.push(teamScope(activeTeamId));
    return scopes;
}

export function writableScopes(dir: IdentityDirectory, personId: string, activeTeamId: string | null, at: Date): Scope[] {
    return readableScopes(dir, personId, activeTeamId, at);
}

export function defaultScope(dir: IdentityDirectory, personId: string, activeTeamId: string | null, at: Date): Scope {
    const scopes = writableScopes(dir, personId, activeTeamId, at);
    return scopes.find((s) => s.startsWith('team:')) ?? scopes[0];
}

export type ScopeHint = 'personal' | 'team';

export type ScopeDecision = { scope: Scope } | { rejected: string };

// Turns an LLM's personal/team hint into a concrete scope. A team write the actor isn't allowed
// to make is rejected, never silently downgraded to personal (that would create wrong personal memories).
export function decideScope(hint: ScopeHint, ctx: Pick<IngestContext, 'writableScopes'>): ScopeDecision {
    const prefix = hint === 'team' ? 'team:' : 'personal:';
    const scope = ctx.writableScopes.find((s) => s.startsWith(prefix));
    if (scope) return { scope };
    return { rejected: hint === 'team' ? 'actor has no writable team scope (no active team or not a member)' : 'no personal scope' };
}
