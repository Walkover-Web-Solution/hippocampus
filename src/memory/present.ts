import { Connection, linkPhrase } from './prompt';
import { LearnChange, SaveResult } from './store/learn';
import { DocumentRow, EntityLink, EntityNode, NoteRow, SearchHit, VersionRow } from './types';

/**
 * How notes, versions, hits and the graph look in API replies and tool results: the same shape everywhere.
 */
export const presentNote = (note: NoteRow, withBody = false) => ({
    space: note.space,
    path: note.path,
    kind: note.kind,
    slot: note.slot,
    title: note.title,
    summary: note.summary,
    labels: note.labels,
    version: note.version,
    status: note.status,
    valid_from: note.valid_from,
    valid_to: note.valid_to,
    source: note.source,
    written_by: note.version_written_by ?? note.written_by,
    change: note.change,
    confidence: note.confidence,
    // How many times this was said or confirmed.
    confirmed: note.evidence_count,
    created_at: note.created_at,
    updated_at: note.updated_at,
    ...(withBody && { body: note.body ?? '' }),
});

export const presentDocument = (document: DocumentRow | null | undefined) => (document ? {
    url: document.url, filename: document.filename, mime: document.mime, bytes: document.bytes, status: document.status, error: document.error, extracted_at: document.extracted_at,
} : null);

export const presentVersion = (version: VersionRow, withBody = true) => ({
    version: version.version,
    title: version.title,
    summary: version.summary,
    written_by: version.written_by,
    change: version.change,
    created_at: version.created_at,
    ...(withBody && { body: version.body }),
});

export const presentHit = (hit: SearchHit) => ({
    ...presentNote(hit.note),
    excerpt: hit.excerpt,
    chunk: hit.ordinal,
    distance: Number(hit.distance.toFixed(3)),
    score: Number(hit.score.toFixed(3)),
});

export const presentLink = (link: EntityLink) => ({
    subject: link.subject, relation: link.relation, object: link.object, space: link.space, path: link.path, as_of: link.asOf, until: link.until,
});

export const presentConnection = (connection: Connection) => ({
    name: connection.name,
    links: connection.links.map(presentLink),
    // The links read from the name's side, one phrase each: "→ uses hubspot".
    phrases: connection.links.map((link) => linkPhrase(connection.name, link)),
});

export const presentEntity = (node: EntityNode) => ({
    name: node.name,
    type: node.type,
    notes: node.notes.map((note) => presentNote(note)),
    links: node.links.map(presentLink),
    // The names one hop away, most linked first: where to travel next.
    connected: node.connected,
});

export const presentSave = (result: SaveResult) => ({
    outcome: result.outcome,
    note: presentNote(result.note, true),
    ...(result.previous && { previous: result.previous }),
    indexed: result.indexed,
});

export const presentChange = (change: LearnChange) => ({
    action: change.action,
    note: presentNote(change.note, true),
    ...(change.previous && { previous: change.previous }),
});
