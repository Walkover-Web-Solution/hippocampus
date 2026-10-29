import { PersonRef } from './types';

export type Role = 'admin' | 'member';

export interface Team {
    id: string;
    name: string;
}

export interface Membership {
    personId: string;
    teamId: string;
    role: Role;
    validFrom: Date;
    validTo: Date | null;
}

// In-memory identity layer, seeded per scenario. Access control is not what the POC compares,
// so it is computed once here instead of inside each approach.
export class IdentityDirectory {
    private people = new Map<string, PersonRef>();
    private teams = new Map<string, Team>();
    private memberships: Membership[] = [];

    constructor(people: PersonRef[], teams: Team[], memberships: Membership[]) {
        people.forEach((p) => this.people.set(p.id, p));
        teams.forEach((t) => this.teams.set(t.id, t));
        this.memberships = memberships.map((m) => ({ ...m }));
    }

    person(id: string): PersonRef {
        const person = this.people.get(id);
        if (!person) throw new Error(`Unknown person ${id}`);
        return person;
    }

    team(id: string): Team {
        const team = this.teams.get(id);
        if (!team) throw new Error(`Unknown team ${id}`);
        return team;
    }

    directory(): PersonRef[] {
        return [...this.people.values()];
    }

    roleIn(personId: string, teamId: string, at: Date): Role | null {
        const membership = this.memberships.find(
            (m) => m.personId === personId && m.teamId === teamId && m.validFrom <= at && (m.validTo === null || at < m.validTo)
        );
        return membership ? membership.role : null;
    }

    isMember(personId: string, teamId: string, at: Date): boolean {
        return this.roleIn(personId, teamId, at) !== null;
    }

    join(personId: string, teamId: string, role: Role, at: Date) {
        this.person(personId);
        this.team(teamId);
        if (this.isMember(personId, teamId, at)) return;
        this.memberships.push({ personId, teamId, role, validFrom: at, validTo: null });
    }

    // Close the membership instead of deleting it, so history still makes sense.
    leave(personId: string, teamId: string, at: Date) {
        this.memberships
            .filter((m) => m.personId === personId && m.teamId === teamId && m.validTo === null)
            .forEach((m) => (m.validTo = at));
    }

    resolvePerson(mention: string): PersonRef | null {
        const needle = mention.trim().toLowerCase();
        for (const person of this.people.values()) {
            const names = [person.id, person.name, ...person.aliases].map((n) => n.toLowerCase());
            if (names.includes(needle)) return person;
        }
        return null;
    }
}
