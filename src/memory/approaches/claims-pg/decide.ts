// Pure write policy for one claim stream: given the stream's current state and an incoming claim,
// decide what event to append. Kept free of I/O so the consistency rules are unit-testable.

export type ClaimStatus = 'current' | 'superseded' | 'proposed' | 'disputed' | 'retracted';

export interface StreamHead {
    version: number;
    status: ClaimStatus;
    valueNorm: string;
    // Values in a disputed head, so a dispute can name every contender.
    disputedValues: string[];
    actorPerson: string;
    // When the head's value became known (scenario time).
    recordedAt: Date;
}

export interface IncomingClaim {
    valueNorm: string;
    operation: 'assert' | 'retract';
    // Proposed claims never displace a current value.
    proposed: boolean;
    actorPerson: string;
    recordedAt: Date;
}

export type WriteDecision =
    | { kind: 'noop'; reason: string }
    | { kind: 'append'; status: ClaimStatus; disputedValues: string[] };

// Writes from different people within this window, on the same single-valued fact, are treated as
// racing each other: neither wins silently; the fact becomes disputed until someone settles it.
export const CONCURRENT_WINDOW_MS = 60 * 1000;

export function decideWrite(head: StreamHead | null, incoming: IncomingClaim, cardinality: 'single' | 'multi'): WriteDecision {
    if (incoming.operation === 'retract') {
        if (!head || head.status === 'retracted') return { kind: 'noop', reason: 'nothing to retract' };
        if (cardinality === 'single' && head.valueNorm !== incoming.valueNorm && incoming.valueNorm !== '') {
            return { kind: 'noop', reason: 'retraction names a different value than the current one' };
        }
        return { kind: 'append', status: 'retracted', disputedValues: [] };
    }

    if (incoming.proposed) {
        if (head && head.status !== 'retracted' && head.valueNorm === incoming.valueNorm) return { kind: 'noop', reason: 'already known' };
        return { kind: 'append', status: 'proposed', disputedValues: [] };
    }

    if (!head || head.status === 'retracted' || head.status === 'proposed') {
        return { kind: 'append', status: 'current', disputedValues: [] };
    }
    if (head.valueNorm === incoming.valueNorm && head.status !== 'disputed') {
        return { kind: 'noop', reason: 'same value already current' };
    }
    if (cardinality === 'multi') {
        // Multi-valued streams are keyed by value, so a different value never reaches the same stream.
        return { kind: 'append', status: 'current', disputedValues: [] };
    }

    const racing =
        head.actorPerson !== incoming.actorPerson &&
        Math.abs(incoming.recordedAt.getTime() - head.recordedAt.getTime()) <= CONCURRENT_WINDOW_MS;
    if (racing) {
        const values = [...new Set([...(head.status === 'disputed' ? head.disputedValues : [head.valueNorm]), incoming.valueNorm])];
        return { kind: 'append', status: 'disputed', disputedValues: values };
    }
    if (incoming.recordedAt.getTime() < head.recordedAt.getTime()) {
        // An older statement arriving late must not overwrite newer knowledge.
        return { kind: 'noop', reason: 'older than the current value' };
    }
    return { kind: 'append', status: 'current', disputedValues: [] };
}
