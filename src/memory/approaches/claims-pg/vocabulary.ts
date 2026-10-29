// Controlled vocabulary of predicates. The extractor must map every fact onto one of these, so
// "deadline", "due date" and "ends on" become the same property and conflicts become detectable.

export type ValueType = 'text' | 'date' | 'number' | 'money' | 'entity';

export interface PredicateDef {
    name: string;
    description: string;
    valueType: ValueType;
    // single: one current value per (scope, subject); a new value supersedes the old one.
    // multi: values accumulate (a person can know several languages).
    cardinality: 'single' | 'multi';
    // When the same subject+predicate exists in personal and team scope, which one leads.
    precedence: 'team_wins' | 'personal_wins';
    // Who may set a current value in team scope; others' claims are recorded as proposed.
    confirmRole: 'any' | 'admin';
    aliases: string[];
}

const predicate = (def: Omit<PredicateDef, 'precedence' | 'confirmRole'> & Partial<PredicateDef>): PredicateDef => ({
    precedence: 'team_wins',
    confirmRole: 'any',
    ...def,
});

export const PREDICATES: PredicateDef[] = [
    predicate({ name: 'launch_date', description: 'When a product/project launches or goes live', valueType: 'date', cardinality: 'single', aliases: ['go-live', 'ship date', 'release date', 'launch'] }),
    predicate({ name: 'code_freeze_date', description: 'Code freeze date of a project', valueType: 'date', cardinality: 'single', aliases: ['feature freeze', 'merge deadline'] }),
    predicate({ name: 'start_date', description: 'When something (pilot, phase, contract) starts', valueType: 'date', cardinality: 'single', aliases: ['kick-off date', 'begins'] }),
    predicate({ name: 'due_date', description: 'Deadline of a deliverable or task (subject is the deliverable); also personal target dates', valueType: 'date', cardinality: 'single', aliases: ['deadline', 'due by', 'target date'] }),
    predicate({ name: 'owner', description: 'Person who owns/is responsible for a service, module, integration or task', valueType: 'entity', cardinality: 'single', aliases: ['owns', 'responsible for', 'maintainer', 'handles'] }),
    predicate({ name: 'role', description: "A person's role, optionally on a project (value like 'delivery manager for the Northwind pilot')", valueType: 'text', cardinality: 'multi', aliases: ['position', 'title', 'leads'] }),
    predicate({ name: 'knows_language', description: 'Programming or human language a person knows', valueType: 'text', cardinality: 'multi', aliases: ['skills', 'speaks', 'programs in'] }),
    predicate({ name: 'learning', description: 'Something a person is currently learning', valueType: 'text', cardinality: 'multi', aliases: [] }),
    predicate({ name: 'preference', description: "A person's personal preference (tools, formatting, working style)", valueType: 'text', cardinality: 'multi', precedence: 'personal_wins', aliases: ['likes', 'prefers'] }),
    predicate({ name: 'policy', description: 'A rule or convention the team must follow (reviews, formatting, process)', valueType: 'text', cardinality: 'multi', aliases: ['rule', 'convention', 'standard', 'requirement'] }),
    predicate({ name: 'decision', description: 'A decision that was made (technology choice, approach)', valueType: 'text', cardinality: 'multi', aliases: ['decided', 'chose', 'standardize on'] }),
    predicate({ name: 'uses', description: 'Tools/technologies a project or team uses', valueType: 'text', cardinality: 'multi', aliases: ['stack', 'built with', 'tooling'] }),
    predicate({ name: 'depends_on', description: 'A service/component depends on another', valueType: 'entity', cardinality: 'multi', aliases: ['requires', 'calls', 'gets tokens from'] }),
    predicate({ name: 'contract_value', description: 'Monetary value of a signed contract or deal', valueType: 'money', cardinality: 'single', aliases: ['deal size', 'price'] }),
    predicate({ name: 'budget', description: 'Approved budget or spending limit (subject is what the budget is for; mention the period in the value if stated)', valueType: 'money', cardinality: 'single', aliases: ['spend limit', 'allocated funds'] }),
    predicate({ name: 'location', description: 'Where something takes place or is located', valueType: 'text', cardinality: 'single', aliases: ['site', 'where'] }),
    predicate({ name: 'contact', description: 'Contact person for a client/organization (value: name and function)', valueType: 'text', cardinality: 'multi', aliases: ['point of contact', 'liaison'] }),
    predicate({ name: 'count', description: 'A number of things (subject names what is counted, e.g. "Phoenix beta testers")', valueType: 'number', cardinality: 'single', aliases: ['number of', 'size', 'how many'] }),
    predicate({ name: 'status', description: 'Current status of a project/deal/task', valueType: 'text', cardinality: 'single', aliases: ['state', 'progress'] }),
    predicate({ name: 'note', description: 'Anything worth remembering that fits no other predicate (free text)', valueType: 'text', cardinality: 'multi', aliases: [] }),
];

export const PREDICATE_NAMES = PREDICATES.map((p) => p.name) as [string, ...string[]];

export function predicateDef(name: string): PredicateDef {
    const def = PREDICATES.find((p) => p.name === name);
    if (!def) throw new Error(`Unknown predicate ${name}`);
    return def;
}

export function describeVocabulary(): string {
    return PREDICATES.map((p) => `- ${p.name} (${p.valueType}, ${p.cardinality}): ${p.description}${p.aliases.length ? `; e.g. ${p.aliases.join(', ')}` : ''}`).join('\n');
}
